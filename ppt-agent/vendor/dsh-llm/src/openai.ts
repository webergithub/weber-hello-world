/**
 * PPT_Agent：OpenAI 兼容（Chat Completions）协议的流式请求，复用 DeepSeek Harness 接入层的同一套机制——
 * 空闲看门狗（upstream/timeout）、SSE 分帧（eventsource-parser，与 upstream sse.ts 相同）、错误分类（upstream transport.ts
 * 的 providerError：HTTP 状态 + error.type / message）与整次请求重试（client.ts complete）。只做纯文本对话。
 * 适用：OpenAI、通义千问 DashScope 兼容模式、智谱、Kimi、豆包（火山方舟）、硅基流动、Ollama / vLLM / LM Studio 等。
 */
import { EventSourceParserStream } from 'eventsource-parser/stream'
import { LlmError } from './shims/dsh-llm.ts'
import { idleWatchdog, timeoutOf } from '../upstream/timeout/index.ts'
import { providerError } from '../upstream/llm-deepseek/transport.ts'
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS } from '../upstream/llm-deepseek/defaults.ts'
import type { ChatInput, ClientOptions } from './client.ts'

/** baseURL 已带 /chat/completions 时原样使用，否则补上（用户通常填到 /v1 为止） */
export function chatCompletionsUrl(baseURL: string): string {
  const base = baseURL.replace(/\/+$/u, '')
  return /\/chat\/completions$/u.test(base) ? base : `${base}/chat/completions`
}

function body(opts: ClientOptions, input: ChatInput) {
  const effort = opts.reasoningEffort ?? 'off'
  const messages = [
    ...input.system ? [{ role: 'system', content: input.system }] : [],
    ...input.messages.map((m) => ({ role: m.role, content: m.text })),
  ]
  return {
    model: opts.model, stream: true, messages,
    max_tokens: input.maxTokens ?? opts.maxTokens ?? 4096,
    stream_options: { include_usage: true },
    ...effort === 'off' ? {} : { reasoning_effort: effort === 'max' ? 'high' : effort },
    ...input.temperature === undefined ? {} : { temperature: input.temperature },
  }
}

/** 一次流式请求（不重试），产出与 Messages 翻译结果相同形状的块：text-delta / reasoning-delta / usage / finish */
export async function* streamOpenAI(opts: ClientOptions, input: ChatInput): AsyncGenerator<any> {
  const doFetch = opts.fetch ?? fetch
  const consumer = new AbortController()
  const signal = input.signal === undefined ? consumer.signal : AbortSignal.any([consumer.signal, input.signal])
  const watchdog = idleWatchdog(signal, opts.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS, 'MESSAGES_IDLE')
  const activity = () => { watchdog.pulse() }
  async function* request(): AsyncGenerator<any> {
    watchdog.signal.throwIfAborted()
    const response = await doFetch(chatCompletionsUrl(opts.baseURL || ''), {
      method: 'POST', signal: watchdog.signal, body: JSON.stringify(body(opts, input)), redirect: 'error',
      headers: {
        'user-agent': opts.userAgent ?? 'PPT_Agent',
        'content-type': 'application/json', 'accept': 'text/event-stream',
        ...opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {},
      },
    })
    if (!response.ok) {
      const text = await response.text()
      let raw: unknown
      try { raw = JSON.parse(text) } catch (_nonJsonGatewayError) { /* HTTP status is authoritative */ }
      const failure = providerError(raw, response.status, response.headers)
      throw new LlmError(failure.message.replace('DeepSeek Messages request failed', 'Model request failed'), failure.code, { ...failure.failure, cause: new Error(text.slice(0, 2000)) })
    }
    if (response.body === null) throw new LlmError('Model API returned no response body', 'EMPTY_RESPONSE')
    const events = (response.body as ReadableStream<BufferSource>).pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream({ onComment: activity }))
    let finish = 'stop'
    for await (const frame of events) {
      activity()
      if (frame.data.trim() === '[DONE]') break
      let ev: any
      try { ev = JSON.parse(frame.data) } catch (_invalidSseJson) { throw new LlmError('Model API SSE contains invalid JSON', 'MALFORMED_RESPONSE') }
      if (ev && ev.error) throw providerError(ev, undefined)
      const choice = ev && Array.isArray(ev.choices) ? ev.choices[0] : undefined
      const delta = choice && choice.delta ? choice.delta : {}
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) yield { type: 'reasoning-delta', text: delta.reasoning_content }
      if (typeof delta.content === 'string' && delta.content) yield { type: 'text-delta', text: delta.content }
      if (choice && choice.finish_reason) finish = String(choice.finish_reason)
      if (ev && ev.usage) yield { type: 'usage', usage: { inputTokens: ev.usage.prompt_tokens || 0, outputTokens: ev.usage.completion_tokens || 0, totalTokens: ev.usage.total_tokens } }
    }
    yield { type: 'finish', reason: { kind: finish } }
  }
  const iterator = request()
  try {
    while (true) {
      const next = await watchdog.next(iterator)
      if (next.done) return
      yield next.value
    }
  } catch (error) {
    if (timeoutOf(watchdog.signal, 'MESSAGES_IDLE') !== undefined) throw new LlmError('Model API stream idle timeout', 'TIMEOUT', { cause: error })
    if (input.signal?.aborted) throw new LlmError('Model API request aborted', 'ABORTED', { cause: error })
    if (error instanceof LlmError) throw error
    throw new LlmError('Model API transport failed', 'TRANSPORT', { cause: error })
  } finally {
    consumer.abort()
    watchdog[Symbol.dispose]()
    void iterator.return(undefined).catch(() => {})
  }
}

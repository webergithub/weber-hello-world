/**
 * PPT_Agent model client — a text-only cut of DeepSeek Harness `DeepSeekAdapter`
 * (`packages/llm/llm-deepseek/src/adapter.ts`, `generate()` + `request()`):
 * same Messages endpoint, headers, idle watchdog, SSE parsing (`sse.ts`), event translation (`translate.ts`)
 * and error classification (`transport.ts`), all copied verbatim under ../upstream.
 * Removed versus upstream: cordis plugin wiring, Files API / image offload, request extensions, tool calls,
 * replay of previous assistant turns, account auth. Added: a whole-request retry loop using the upstream retry policy.
 */
import { LlmError } from './shims/dsh-llm.ts'
import { idleWatchdog, timeoutOf } from '../upstream/timeout/index.ts'
import { messagesApiRoot } from '../upstream/llm-deepseek/messages-api.ts'
import { parseSse } from '../upstream/llm-deepseek/sse.ts'
import { translate } from '../upstream/llm-deepseek/translate.ts'
import { providerError } from '../upstream/llm-deepseek/transport.ts'
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS } from '../upstream/llm-deepseek/defaults.ts'
import type { WireMessage, WireRequest } from '../upstream/llm-deepseek/wire-types.ts'
import { DEFAULT_RETRY_POLICY, localDelay } from './retry.ts'
import type { ResolvedRetryPolicy } from './retry.ts'

/** Upstream default endpoint (`llm-deepseek` README: baseURL default). */
export const DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic'
/** Upstream default catalog (`llm-deepseek` README: models default). */
export const DEFAULT_MODELS = ['deepseek-flash', 'deepseek-v4-pro']

export type ReasoningEffort = 'off' | 'low' | 'high' | 'max'

export interface ClientOptions {
  baseURL?: string
  apiKey: string
  model: string
  /** Injected transport; PPT_Agent passes Electron `net.fetch` (system proxy) in the app. */
  fetch?: typeof fetch
  userAgent?: string
  streamIdleTimeoutMs?: number
  maxTokens?: number
  reasoningEffort?: ReasoningEffort
  retry?: Partial<ResolvedRetryPolicy>
  random?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

export interface ChatInput {
  system?: string
  messages: { role: 'user' | 'assistant'; text: string }[]
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
  onDelta?: (text: string) => void
}

export interface ChatResult {
  text: string
  reasoning: string
  finish: string
  usage?: { inputTokens: number; outputTokens: number; totalTokens?: number }
  attempts: number
  ms: number
}

function body(opts: ClientOptions, input: ChatInput): WireRequest {
  const effort = opts.reasoningEffort ?? 'off'
  const messages: WireMessage[] = []
  for (const m of input.messages) {
    const previous = messages.at(-1)
    if (previous?.role === m.role) previous.content.push({ type: 'text', text: m.text })
    else messages.push({ role: m.role, content: [{ type: 'text', text: m.text }] })
  }
  return {
    model: opts.model, stream: true, messages,
    max_tokens: input.maxTokens ?? opts.maxTokens ?? 4096,
    thinking: { type: effort === 'off' ? 'disabled' : 'enabled' },
    ...effort === 'off' ? {} : { output_config: { effort } },
    ...input.system ? { system: input.system } : {},
    ...input.temperature === undefined ? {} : { temperature: input.temperature },
  }
}

/** One streamed request (no retry): yields upstream `StreamChunk`s. */
export async function* stream(opts: ClientOptions, input: ChatInput): AsyncGenerator<any> {
  if (!opts.apiKey) throw new LlmError('DeepSeek API key is not configured', 'MISSING_CREDENTIAL')
  const doFetch = opts.fetch ?? fetch
  const consumer = new AbortController()
  const signal = input.signal === undefined ? consumer.signal : AbortSignal.any([consumer.signal, input.signal])
  const watchdog = idleWatchdog(signal, opts.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS, 'MESSAGES_IDLE')
  const activity = () => { watchdog.pulse() }
  async function* request(): AsyncGenerator<any> {
    watchdog.signal.throwIfAborted()
    const response = await doFetch(`${messagesApiRoot(opts.baseURL || DEFAULT_BASE_URL)}/messages`, {
      method: 'POST', signal: watchdog.signal, body: JSON.stringify(body(opts, input)), redirect: 'error',
      headers: {
        'user-agent': opts.userAgent ?? 'PPT_Agent',
        'content-type': 'application/json', 'accept': 'text/event-stream',
        'x-api-key': opts.apiKey,
        'anthropic-version': '2023-06-01',
      },
    })
    if (!response.ok) {
      const text = await response.text()
      let raw: unknown
      try { raw = JSON.parse(text) } catch (_nonJsonGatewayError) { /* HTTP status is authoritative */ }
      const failure = providerError(raw, response.status, response.headers)
      throw new LlmError(failure.message, failure.code, { ...failure.failure, cause: new Error(text.slice(0, 2000)) })
    }
    if (response.body === null) throw new LlmError('DeepSeek Messages returned no response body', 'EMPTY_RESPONSE')
    yield* translate(parseSse(response.body as ReadableStream<BufferSource>, activity), opts.model)
  }
  const iterator = request()
  try {
    while (true) {
      const next = await watchdog.next(iterator)
      if (next.done) return
      yield next.value
    }
  } catch (error) {
    if (timeoutOf(watchdog.signal, 'MESSAGES_IDLE') !== undefined) throw new LlmError('DeepSeek Messages stream idle timeout', 'TIMEOUT', { cause: error })
    if (input.signal?.aborted) throw new LlmError('DeepSeek Messages request aborted', 'ABORTED', { cause: error })
    if (error instanceof LlmError) throw error
    throw new LlmError('DeepSeek Messages transport failed', 'TRANSPORT', { cause: error })
  } finally {
    consumer.abort()
    watchdog[Symbol.dispose]()
    void iterator.return(undefined).catch(() => {})
  }
}

const defaultSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
  const onAbort = () => { clearTimeout(t); reject(new LlmError('DeepSeek Messages request aborted', 'ABORTED')) }
  signal?.addEventListener('abort', onAbort, { once: true })
})

/** Complete one chat: collects text, retries transient failures with the upstream policy. */
export async function complete(opts: ClientOptions, input: ChatInput): Promise<ChatResult> {
  const policy = { ...DEFAULT_RETRY_POLICY, ...(opts.retry || {}) }
  const sleep = opts.sleep ?? defaultSleep
  const t0 = Date.now()
  for (let attempt = 1; ; attempt++) {
    let text = '', reasoning = '', finish = '', usage
    try {
      for await (const chunk of stream(opts, input)) {
        if (chunk.type === 'text-delta') { text += chunk.text; input.onDelta?.(chunk.text) }
        else if (chunk.type === 'reasoning-delta') reasoning += chunk.text
        else if (chunk.type === 'usage') usage = chunk.usage
        else if (chunk.type === 'finish') finish = chunk.reason.kind
      }
      if (!text.trim()) throw new LlmError('DeepSeek Messages returned no text', 'EMPTY_RESPONSE')
      return { text, reasoning, finish, usage, attempts: attempt, ms: Date.now() - t0 }
    } catch (error) {
      const code = error instanceof LlmError ? error.code : 'TRANSPORT'
      if (attempt > policy.maxRetries || !policy.retryableCodes.includes(code) || input.signal?.aborted) throw error
      const after = error instanceof LlmError ? error.failure.providerRetryAfterMs : undefined
      const delay = after !== undefined ? Math.min(after, policy.maxDelayMs) : localDelay(policy, attempt, opts.random ?? Math.random)
      await sleep(delay, input.signal)
    }
  }
}

/** Entry bundled into electron/core/ppt_agent/dsh-llm.cjs by scripts/build-dsh-llm.mjs. */
export { complete, stream, DEFAULT_BASE_URL, DEFAULT_MODELS } from './src/client.ts'
export { DEFAULT_RETRY_POLICY, localDelay } from './src/retry.ts'
export { LlmError, HarnessError, errorChain, isContextWindowExceededError, isQuotaExceededError } from './src/shims/dsh-llm.ts'
export { messagesApiRoot } from './upstream/llm-deepseek/messages-api.ts'
export { providerError } from './upstream/llm-deepseek/transport.ts'
export { translate } from './upstream/llm-deepseek/translate.ts'
export { parseSse } from './upstream/llm-deepseek/sse.ts'
export { idleWatchdog } from './upstream/timeout/index.ts'

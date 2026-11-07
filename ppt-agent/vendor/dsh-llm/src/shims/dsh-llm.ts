/**
 * Vendor shim for `@deepseek-ai/dsh-llm`: re-exports only the runtime symbols the copied
 * `llm-deepseek` files import. Everything here comes verbatim from upstream files in ../../upstream.
 */
export { LlmError } from '../../upstream/llm/llm-error.ts'
export type { LlmErrorOptions } from '../../upstream/llm/llm-error.ts'
export { HarnessError, isContextWindowExceededError, isQuotaExceededError, errorChain, EMPTY_RESPONSE_CODE, CONTEXT_WINDOW_EXCEEDED_CODE, QUOTA_EXCEEDED_CODE } from '../../upstream/llm/error.ts'
export { ProviderRequestId, ToolCallId } from '../../upstream/llm/brand.ts'

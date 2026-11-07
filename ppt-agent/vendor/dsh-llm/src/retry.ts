/**
 * Retry policy for PPT_Agent model requests.
 * Defaults are copied from DeepSeek Harness `packages/llm/llm/src/retry-policy.ts`
 * (DEFAULT_MAX_RETRIES / DEFAULT_INITIAL_DELAY_MS / DEFAULT_MAX_DELAY_MS / DEFAULT_JITTER_RATIO / DEFAULT_RETRYABLE_CODES);
 * `localDelay` is copied verbatim from `packages/llm/llm-retry/src/index.ts`.
 * The upstream retry plugin runs at agent-step boundaries inside a cordis context; PPT_Agent has no agent loop,
 * so the same policy is applied around one whole request (see ../src/client.ts).
 */
import { EMPTY_RESPONSE_CODE } from './shims/dsh-llm.ts'

export interface ResolvedRetryPolicy {
  mode: 'normal'
  maxRetries: number
  retryableCodes: readonly string[]
  initialDelayMs: number
  maxDelayMs: number
  jitterRatio: number
}

export const DEFAULT_RETRY_POLICY: ResolvedRetryPolicy = Object.freeze({
  mode: 'normal',
  maxRetries: 5,
  retryableCodes: Object.freeze([EMPTY_RESPONSE_CODE, 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  jitterRatio: 0.1,
})

export function localDelay(config: ResolvedRetryPolicy, retry: number, random: () => number): number {
  const exponent = Math.min(retry - 1, 1024)
  const exponential = Math.min(config.initialDelayMs * 2 ** exponent, config.maxDelayMs)
  const jitter = 1 - config.jitterRatio + 2 * config.jitterRatio * random()
  return Math.min(exponential * jitter, config.maxDelayMs)
}

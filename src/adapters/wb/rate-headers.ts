// Парсинг rate-limit headers из WB API.
// Реальный X-RateLimit-Retry / X-RateLimit-Reset имеет приоритет
// над статическим профилем (basic=12min, personal=400ms).

export interface RateLimitHeaders {
  /** X-RateLimit-Retry: сколько секунд ждать до следующего запроса. */
  retryAfterSec: number | null
  /** X-RateLimit-Reset: epoch (sec) когда окно сбросится. */
  resetAtMs: number | null
  /** Remaining: сколько осталось запросов. */
  remaining: number | null
}

export function parseRateHeaders(response: Response): RateLimitHeaders {
  const retryAfter = response.headers.get('X-RateLimit-Retry')
  const reset = response.headers.get('X-RateLimit-Reset')
  const remaining = response.headers.get('X-RateLimit-Remaining')

  let retryAfterSec: number | null = null
  if (retryAfter !== null) {
    const n = Number(retryAfter)
    if (Number.isFinite(n) && n >= 0) retryAfterSec = n
  }

  let resetAtMs: number | null = null
  if (reset !== null) {
    const n = Number(reset)
    if (Number.isFinite(n)) {
      // WB отдаёт в секундах (epoch)
      resetAtMs = n > 1e12 ? n : n * 1000
    }
  }

  let remainingNum: number | null = null
  if (remaining !== null) {
    const n = Number(remaining)
    if (Number.isFinite(n) && n >= 0) remainingNum = Math.floor(n)
  }

  return { retryAfterSec, resetAtMs, remaining: remainingNum }
}

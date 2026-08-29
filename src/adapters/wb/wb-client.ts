// Единый WB API клиент.
// - Authorization: Bearer <token>
// - Host allowlist (production/sandbox)
// - AbortSignal timeout 12s
// - Парсит rate-limit headers
// - Возвращает typed Result; сам НЕ retry и НЕ sleep.
// - 4xx/5xx → Result.err() с категорией.

import { assertAllowedWbUrl } from './allowlist.js'
import { parseRateHeaders, type RateLimitHeaders } from './rate-headers.js'

const DEFAULT_TIMEOUT_MS = 12_000
const MAX_BODY_BYTES = 256 * 1024 // 256 KB — больше, чем любой ответ WB

export type WbError =
  | { kind: 'http'; status: number; bodyText: string; rateLimit: RateLimitHeaders }
  | { kind: 'timeout'; ms: number }
  | { kind: 'network'; message: string }
  | { kind: 'host_blocked'; host: string }
  | { kind: 'parse'; message: string }

export type WbResult<T> =
  | { ok: true; data: T; rateLimit: RateLimitHeaders; status: number }
  | { ok: false; error: WbError }

export interface WbClientOptions {
  token: string
  baseUrl?: string
  timeoutMs?: number
}

export class WbClient {
  private readonly token: string
  private readonly baseUrl: string
  private readonly timeoutMs: number

  constructor(opts: WbClientOptions) {
    if (!opts.token) {
      throw new Error('WbClient: token is required')
    }
    this.token = opts.token
    this.baseUrl = opts.baseUrl ?? 'https://feedbacks-api.wildberries.ru'
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    // Валидируем baseUrl сразу
    assertAllowedWbUrl(this.baseUrl)
  }

  /** GET /api/v1/feedbacks с isAnswered=false. */
  async listUnanswered(opts: {
    take?: number
    skip?: number
    dateFrom?: number
  } = {}): Promise<WbResult<{ feedbacks: WbFeedback[] }>> {
    const params = new URLSearchParams()
    params.set('isAnswered', 'false')
    if (opts.take !== undefined) params.set('take', String(Math.min(opts.take, 5000)))
    if (opts.skip !== undefined) params.set('skip', String(Math.max(opts.skip, 0)))
    if (opts.dateFrom !== undefined) {
      // dateFrom — YYYY-MM-DDTHH:mm:ss
      params.set('dateFrom', new Date(opts.dateFrom).toISOString().slice(0, 19))
    }
    return this.request<{ feedbacks: WbFeedback[] }>('GET', `/api/v1/feedbacks?${params.toString()}`)
  }

  /** GET /api/v1/feedbacks/{id} — для reconcile. */
  async getFeedback(id: string): Promise<WbResult<{ feedback: WbFeedback }>> {
    return this.request<{ feedback: WbFeedback }>('GET', `/api/v1/feedbacks/${encodeURIComponent(id)}`)
  }

  /** POST /api/v1/feedbacks/answer. Возвращает 204 при успехе. */
  async postReply(id: string, text: string): Promise<WbResult<null>> {
    return this.request<null>('POST', '/api/v1/feedbacks/answer', { id, text })
  }

  /** Универсальный request с auth + timeout + parsing. */
  private async request<T>(method: string, path: string, body?: unknown): Promise<WbResult<T>> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : '/' + path}`
    // path уже содержит query string для listUnanswered, но всё равно проверим
    try {
      assertAllowedWbUrl(url)
    } catch (e) {
      return { ok: false, error: { kind: 'host_blocked', host: (e as Error).message } }
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs)

    let res: Response
    try {
      const init: RequestInit = {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      }
      if (body !== undefined) {
        init.body = JSON.stringify(body)
      }
      res = await fetch(url, init)
    } catch (e) {
      clearTimeout(timeoutId)
      if (e instanceof DOMException && e.name === 'AbortError') {
        return { ok: false, error: { kind: 'timeout', ms: this.timeoutMs } }
      }
      return { ok: false, error: { kind: 'network', message: (e as Error).message } }
    } finally {
      clearTimeout(timeoutId)
    }

    const rateLimit = parseRateHeaders(res)

    // 204 No Content — успех, без тела
    if (res.status === 204) {
      return { ok: true, data: null as T, rateLimit, status: 204 }
    }

    // 4xx/5xx — body нужен для диагностики
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '').then((t) => t.slice(0, 4096))
      return {
        ok: false,
        error: { kind: 'http', status: res.status, bodyText, rateLimit },
      }
    }

    // Успех — парсим JSON
    const text = await res.text().catch(() => '')
    if (text.length > MAX_BODY_BYTES) {
      return { ok: false, error: { kind: 'parse', message: `Body too large: ${text.length} bytes` } }
    }
    if (text.length === 0) {
      return { ok: true, data: null as T, rateLimit, status: res.status }
    }
    try {
      const data = JSON.parse(text) as T
      return { ok: true, data, rateLimit, status: res.status }
    } catch (e) {
      return { ok: false, error: { kind: 'parse', message: (e as Error).message } }
    }
  }
}

/** Subset полей отзыва WB. */
export interface WbFeedback {
  id: string
  text?: string
  pros?: string
  cons?: string
  productValuation?: number
  userName?: string
  subjectName?: string
  productDetails?: {
    nmId?: number
    productName?: string
  }
  photoLinks?: string[]
  video?: { src?: string; preview?: string } | null
  createdDate?: string
  answer?: { text?: string } | null
}

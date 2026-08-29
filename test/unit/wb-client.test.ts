import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WbClient, type WbFeedback } from '../../src/adapters/wb/wb-client.js'

// Mock fetch
const originalFetch = globalThis.fetch
let mockFetch: ReturnType<typeof vi.fn>

beforeEach(() => {
  mockFetch = vi.fn()
  globalThis.fetch = mockFetch as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

function mockResponse(opts: {
  status: number
  body?: string
  headers?: Record<string, string>
}) {
  // ResponseInit.body в Node 24+ lib.dom.d.ts не имеет body — используем new Response(body, init)
  const init: ResponseInit = { status: opts.status }
  if (opts.headers !== undefined) init.headers = opts.headers
  return new Response(opts.body ?? null, init)
}

describe('WbClient: construction', () => {
  it('без токена — throw', () => {
    expect(() => new WbClient({ token: '' })).toThrow(/token is required/)
  })

  it('с правильным токеном — host check проходит', () => {
    expect(() => new WbClient({ token: 'test-token' })).not.toThrow()
  })

  it('с неправильным baseUrl — throw', () => {
    expect(() => new WbClient({ token: 'x', baseUrl: 'https://evil.com' })).toThrow(/not in allowlist/)
  })

  it('baseUrl=sandbox — OK', () => {
    expect(() => new WbClient({ token: 'x', baseUrl: 'https://feedbacks-api-sandbox.wildberries.ru' })).not.toThrow()
  })
})

describe('WbClient: Authorization header', () => {
  it('GET отправляет Bearer token', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ status: 200, body: '{"feedbacks":[]}' }))
    const client = new WbClient({ token: 'my-secret-token-abc' })
    await client.listUnanswered()

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('https://feedbacks-api.wildberries.ru/api/v1/feedbacks')
    expect(init.method).toBe('GET')
    const headers = init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer my-secret-token-abc')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('не добавляет Bearer дважды (sanity)', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ status: 200, body: '{"feedbacks":[]}' }))
    const client = new WbClient({ token: 'foo' })
    await client.listUnanswered()
    const headers = (mockFetch.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer foo')
    expect(headers['Authorization']).not.toMatch(/Bearer Bearer/)
  })
})

describe('WbClient: listUnanswered', () => {
  it('парсит ответ с отзывами', async () => {
    const body = JSON.stringify({
      feedbacks: [
        { id: 'fb1', text: 'Great!', productValuation: 5 },
        { id: 'fb2', text: 'Bad', productValuation: 2 },
      ] satisfies WbFeedback[],
    })
    mockFetch.mockResolvedValueOnce(mockResponse({ status: 200, body }))
    const client = new WbClient({ token: 'x' })
    const r = await client.listUnanswered()
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.feedbacks).toHaveLength(2)
      expect(r.data.feedbacks[0]?.id).toBe('fb1')
    }
  })

  it('take ограничен 5000', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ status: 200, body: '{"feedbacks":[]}' }))
    const client = new WbClient({ token: 'x' })
    await client.listUnanswered({ take: 10000 })
    const url = (mockFetch.mock.calls[0] as [string])[0]
    expect(url).toContain('take=5000')
  })
})

describe('WbClient: postReply', () => {
  it('204 → success, body=null', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ status: 204 }))
    const client = new WbClient({ token: 'x' })
    const r = await client.postReply('fb1', 'Спасибо!')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data).toBe(null)
      expect(r.status).toBe(204)
    }
  })

  it('отправляет JSON {id, text}', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ status: 204 }))
    const client = new WbClient({ token: 'x' })
    await client.postReply('fb-123', 'Спасибо за отзыв!')
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/v1/feedbacks/answer')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ id: 'fb-123', text: 'Спасибо за отзыв!' })
  })

  it('429 → http error с rateLimit', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ status: 429, body: 'rate limit', headers: { 'X-RateLimit-Retry': '720' } }),
    )
    const client = new WbClient({ token: 'x' })
    const r = await client.postReply('fb1', 'test')
    expect(r.ok).toBe(false)
    if (!r.ok && r.error.kind === 'http') {
      expect(r.error.status).toBe(429)
      expect(r.error.rateLimit.retryAfterSec).toBe(720)
    }
  })
})

describe('WbClient: timeout', () => {
  it('AbortController срабатывает', async () => {
    // fetch который "висит" (никогда не резолвится)
    mockFetch.mockImplementation(
      () => new Promise<Response>((_resolve, reject) => {
        setTimeout(() => {
          const e = new DOMException('Aborted', 'AbortError')
          reject(e)
        }, 50)
      }),
    )
    const client = new WbClient({ token: 'x', timeoutMs: 10 })
    const r = await client.listUnanswered()
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe('timeout')
    }
  })
})

describe('WbClient: 4xx/5xx → http error', () => {
  it('401 — token invalid', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ status: 401, body: 'unauthorized' }))
    const client = new WbClient({ token: 'bad' })
    const r = await client.listUnanswered()
    expect(r.ok).toBe(false)
    if (!r.ok && r.error.kind === 'http') {
      expect(r.error.status).toBe(401)
      expect(r.error.bodyText).toBe('unauthorized')
    }
  })

  it('5xx — server error', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ status: 500, body: 'oops' }))
    const client = new WbClient({ token: 'x' })
    const r = await client.listUnanswered()
    expect(r.ok).toBe(false)
  })

  it('422 — validation error', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ status: 422, body: 'too long' }))
    const client = new WbClient({ token: 'x' })
    const r = await client.postReply('fb', 'a'.repeat(6000))
    expect(r.ok).toBe(false)
    if (!r.ok && r.error.kind === 'http') {
      expect(r.error.status).toBe(422)
    }
  })
})

describe('WbClient: parse errors', () => {
  it('невалидный JSON → parse error', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ status: 200, body: 'not json{' }))
    const client = new WbClient({ token: 'x' })
    const r = await client.listUnanswered()
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe('parse')
    }
  })
})

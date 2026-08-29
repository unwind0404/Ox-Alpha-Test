// Тест fetch-handler через miniflare-style mock (без Cloudflare runtime).

import { describe, it, expect } from 'vitest'
import { fetch, type Env } from '../../src/index.js'

const baseEnv: Env = {
  ACCESS_CLIENT_ID: 'cid-123',
  ACCESS_CLIENT_SECRET: 'sec-abc',
  ENVIRONMENT: 'production',
  DB: {} as D1Database,
  DEPLOYMENT_MODE: 'cloud',
  DEFAULT_STRATEGY: 'drafts',
  WB_API_BASE: 'https://feedbacks-api.wildberries.ru',
  OPENROUTER_API_KEY: 'sk-or-test',
  MASTER_KEY: 'master-test',
  FINGERPRINT_KEY: 'fingerprint-test',
}

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext

function makeRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`https://example.com${path}`, init)
}

describe('index: fetch handler', () => {
  it('GET /health — 200 без auth', async () => {
    const res = await fetch(makeRequest('/health'), baseEnv, ctx)
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  it('GET /health — security headers', async () => {
    const res = await fetch(makeRequest('/health'), baseEnv, ctx)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'")
  })

  it('неизвестный admin путь без Access — 401 (auth первая)', async () => {
    // Без Access-headers любой admin путь возвращает 401, даже несуществующий.
    // Это безопаснее: не раскрываем структуру URL.
    const res = await fetch(makeRequest('/unknown-admin-path'), baseEnv, ctx)
    expect(res.status).toBe(401)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('admin путь без Access headers — 401', async () => {
    const res = await fetch(makeRequest('/api/admin/status'), baseEnv, ctx)
    expect(res.status).toBe(401)
  })

  it('admin путь с неверным Access — 403', async () => {
    const res = await fetch(
      makeRequest('/api/admin/status', {
        headers: {
          'Cf-Access-Client-Id': 'wrong',
          'Cf-Access-Client-Secret': 'wrong',
        },
      }),
      baseEnv,
      ctx,
    )
    expect(res.status).toBe(403)
  })

  it('admin путь с валидным Access — 200', async () => {
    const res = await fetch(
      makeRequest('/api/admin/status', {
        headers: {
          'Cf-Access-Client-Id': 'cid-123',
          'Cf-Access-Client-Secret': 'sec-abc',
        },
      }),
      baseEnv,
      ctx,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; deployment: string }
    expect(body.ok).toBe(true)
    expect(body.deployment).toBe('cloud')
  })

  it('admin путь с Access но неизвестный URL — 404', async () => {
    const res = await fetch(
      makeRequest('/api/admin/unknown-route', {
        headers: {
          'Cf-Access-Client-Id': 'cid-123',
          'Cf-Access-Client-Secret': 'sec-abc',
        },
      }),
      baseEnv,
      ctx,
    )
    expect(res.status).toBe(404)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('dev mode без секретов — admin пускает всех', async () => {
    const devEnv: Env = { ...baseEnv, ACCESS_CLIENT_ID: '', ACCESS_CLIENT_SECRET: '', ENVIRONMENT: 'dev' }
    const res = await fetch(makeRequest('/api/admin/status'), devEnv, ctx)
    expect(res.status).toBe(200)
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { publishOne, reconcileJob } from '../../src/coordinator/publish-replies.js'
import type { Env } from '../../src/index.js'

const T0 = 1_700_000_000_000


function makeEnv(): Env {
  // Универсальный D1 mock: first возвращает shop+token, run() — ok
  const prepare = vi.fn().mockReturnValue({
    bind: vi.fn().mockReturnValue({
      run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
      first: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue({ results: [] }),
    }),
  })
  return {
    DB: { prepare } as unknown as D1Database,
    ACCESS_CLIENT_ID: 'cid',
    ACCESS_CLIENT_SECRET: 'sec',
    ENVIRONMENT: 'production',
    DEPLOYMENT_MODE: 'cloud',
    DEFAULT_STRATEGY: 'drafts',
    WB_API_BASE: 'https://feedbacks-api.wildberries.ru',
    OPENROUTER_API_KEY: 'sk',
    MASTER_KEY: 'k'.repeat(43) + '=',
    FINGERPRINT_KEY: 'f'.repeat(43) + '=',
  }
}

let originalFetch: typeof fetch
let mockFetch: ReturnType<typeof vi.fn>

beforeEach(() => {
  originalFetch = globalThis.fetch
  mockFetch = vi.fn()
  globalThis.fetch = mockFetch as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('publishOne: smoke', () => {
  it('public API surface', () => {
    expect(typeof publishOne).toBe('function')
    expect(typeof reconcileJob).toBe('function')
  })
})

describe('publishOne: logic через public types', () => {
  it('возвращает PublishResult с правильными полями', async () => {
    const env = makeEnv()
    // Мок: пустой D1 — нет shop, нет job
    const r = await publishOne({ shopId: 'x', env, nowMs: T0 })
    expect(r).toHaveProperty('outcome')
    expect(r).toHaveProperty('jobId')
    expect(r).toHaveProperty('text')
    expect(r).toHaveProperty('attempts')
    expect(r).toHaveProperty('detail')
    expect(['no_jobs', 'shop_disabled', 'failed', 'rate_limited', 'posted', 'reconcile_needed', 'dead']).toContain(r.outcome)
  })
})

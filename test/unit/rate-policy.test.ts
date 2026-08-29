import { describe, it, expect } from 'vitest'
import { canSendNow, nextAllowedAt, isDailyLimitReached, maxOpsPerWake } from '../../src/core/rate-policy.js'

const T0 = 1_700_000_000_000 // произвольный epoch

const emptyState = {
  lastWbRequestAtMs: null,
  cooldownUntilMs: 0,
  rollingDaySuccessCount: 0,
}

describe('core/rate-policy: nextAllowedAt', () => {
  it('basic: если ничего не было, можно сейчас', () => {
    expect(nextAllowedAt(T0, 'basic', emptyState)).toBe(T0)
  })

  it('basic: после запроса 12 минут нельзя', () => {
    const state = { ...emptyState, lastWbRequestAtMs: T0 - 100_000 } // 100 сек назад
    expect(nextAllowedAt(T0, 'basic', state)).toBe(T0 + 620_000) // 12 мин - 100 сек = 11:20 ещё ждать
  })

  it('basic: после запроса 13 минут — можно', () => {
    const state = { ...emptyState, lastWbRequestAtMs: T0 - 13 * 60_000 }
    expect(nextAllowedAt(T0, 'basic', state)).toBe(T0)
  })

  it('personal: 400ms interval', () => {
    const state = { ...emptyState, lastWbRequestAtMs: T0 - 100 }
    expect(nextAllowedAt(T0, 'personal', state)).toBe(T0 + 300) // ещё 300мс
  })

  it('cooldown имеет приоритет над интервалом', () => {
    const state = { ...emptyState, lastWbRequestAtMs: T0 - 1_000_000, cooldownUntilMs: T0 + 60_000 }
    expect(nextAllowedAt(T0, 'basic', state)).toBe(T0 + 60_000)
  })

  it('job.nextAttemptAtMs имеет приоритет', () => {
    const state = { ...emptyState, lastWbRequestAtMs: null, cooldownUntilMs: 0 }
    const jobNext = T0 + 30_000
    expect(nextAllowedAt(T0, 'basic', state, jobNext)).toBe(T0 + 30_000)
  })
})

describe('core/rate-policy: isDailyLimitReached', () => {
  it('basic: 99 — нет, 100 — да', () => {
    expect(isDailyLimitReached('basic', 99)).toBe(false)
    expect(isDailyLimitReached('basic', 100)).toBe(true)
  })

  it('personal: лимит не достигается (MAX_SAFE_INTEGER)', () => {
    expect(isDailyLimitReached('personal', 1_000_000_000)).toBe(false)
  })
})

describe('core/rate-policy: canSendNow', () => {
  it('basic, fresh state, ready_to_send — allowed', () => {
    const r = canSendNow(T0, 'basic', emptyState, 'ready_to_send')
    expect(r.allowed).toBe(true)
    expect(r.reason).toBe(null)
  })

  it('basic, jobState = draft_ready — НЕ allowed', () => {
    const r = canSendNow(T0, 'basic', emptyState, 'draft_ready')
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('job_not_ready')
  })

  it('basic, daily limit reached — НЕ allowed', () => {
    const state = { ...emptyState, rollingDaySuccessCount: 100 }
    const r = canSendNow(T0, 'basic', state, 'ready_to_send')
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('daily_limit')
  })

  it('basic, recently used — НЕ allowed (rate_limit)', () => {
    const state = { ...emptyState, lastWbRequestAtMs: T0 - 60_000 }
    const r = canSendNow(T0, 'basic', state, 'ready_to_send')
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('rate_limit')
    expect(r.nextAllowedAtMs).toBeGreaterThan(T0)
  })
})

describe('core/rate-policy: maxOpsPerWake', () => {
  it('basic: 1', () => {
    expect(maxOpsPerWake('basic')).toBe(1)
  })
  it('personal: 10', () => {
    expect(maxOpsPerWake('personal')).toBe(10)
  })
  it('service: 10', () => {
    expect(maxOpsPerWake('service')).toBe(10)
  })
})

import { describe, it, expect } from 'vitest'
import {
  WB_RATE_PROFILES,
  ALLOWED_TRANSITIONS,
  ALLOWED_MATRIX,
  isTokenAllowed,
  type JobState,
} from '../../src/core/types.js'

describe('core/types: WB_RATE_PROFILES', () => {
  it('basic: 720s interval, 1 op/wake, 100/day', () => {
    expect(WB_RATE_PROFILES.basic.minIntervalMs).toBe(720_000)
    expect(WB_RATE_PROFILES.basic.maxWbOpsPerWake).toBe(1)
    expect(WB_RATE_PROFILES.basic.safeRepliesPerRollingDay).toBe(100)
  })

  it('personal: 400ms interval, 10 ops/wake, unlimited', () => {
    expect(WB_RATE_PROFILES.personal.minIntervalMs).toBe(400)
    expect(WB_RATE_PROFILES.personal.maxWbOpsPerWake).toBe(10)
    expect(WB_RATE_PROFILES.personal.safeRepliesPerRollingDay).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('service: 400ms interval, 10 ops/wake, unlimited', () => {
    expect(WB_RATE_PROFILES.service.minIntervalMs).toBe(400)
    expect(WB_RATE_PROFILES.service.maxWbOpsPerWake).toBe(10)
  })
})

describe('core/types: ALLOWED_MATRIX (fail-closed)', () => {
  it('cloud + basic — разрешено', () => {
    expect(isTokenAllowed('cloud', 'basic')).toBe(true)
  })

  it('cloud + personal — ЗАПРЕЩЕНО (WB ToS)', () => {
    expect(isTokenAllowed('cloud', 'personal')).toBe(false)
  })

  it('cloud + service — ЗАПРЕЩЕНО', () => {
    expect(isTokenAllowed('cloud', 'service')).toBe(false)
  })

  it('self_managed + personal — разрешено', () => {
    expect(isTokenAllowed('self_managed', 'personal')).toBe(true)
  })

  it('self_managed + basic — ЗАПРЕЩЕНО (production profile)', () => {
    expect(isTokenAllowed('self_managed', 'basic')).toBe(false)
  })

  it('self_managed + service — ЗАПРЕЩЕНО', () => {
    expect(isTokenAllowed('self_managed', 'service')).toBe(false)
  })

  it('матрица содержит ровно 2 разрешённых комбинации', () => {
    expect(ALLOWED_MATRIX).toHaveLength(2)
  })
})

describe('core/types: ALLOWED_TRANSITIONS (state machine)', () => {
  it('discovered -> generating, draft_ready, ready_to_send, manual_review, waiting_llm_quota', () => {
    const allowed = ALLOWED_TRANSITIONS.discovered
    expect(allowed).toContain('generating')
    expect(allowed).toContain('draft_ready')
    expect(allowed).toContain('ready_to_send')
    expect(allowed).toContain('manual_review')
    expect(allowed).toContain('waiting_llm_quota')
  })

  it('draft_ready -> ready_to_send, rejected, generating', () => {
    const allowed = ALLOWED_TRANSITIONS.draft_ready
    expect(allowed).toContain('ready_to_send')
    expect(allowed).toContain('rejected')
    expect(allowed).toContain('generating')
    expect(allowed).not.toContain('posted') // нельзя пропустить отправку
  })

  it('ready_to_send -> sending (только)', () => {
    expect(ALLOWED_TRANSITIONS.ready_to_send).toEqual(['sending'])
  })

  it('sending -> posted, retry_wait, reconcile_pending, manual_review, dead', () => {
    const allowed = ALLOWED_TRANSITIONS.sending
    expect(allowed).toContain('posted')
    expect(allowed).toContain('retry_wait')
    expect(allowed).toContain('reconcile_pending')
    expect(allowed).toContain('manual_review')
    expect(allowed).toContain('dead')
  })

  it('terminal states не имеют переходов', () => {
    const terminal: JobState[] = ['posted', 'rejected', 'dead']
    for (const state of terminal) {
      expect(ALLOWED_TRANSITIONS[state]).toEqual([])
    }
  })

  it('manual_review может возобновить работу', () => {
    const allowed = ALLOWED_TRANSITIONS.manual_review
    expect(allowed).toContain('generating')
    expect(allowed).toContain('ready_to_send')
    expect(allowed).toContain('draft_ready')
    expect(allowed).toContain('rejected')
  })
})

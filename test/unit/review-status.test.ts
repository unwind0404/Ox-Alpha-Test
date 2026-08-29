import { describe, it, expect } from 'vitest'
import { deriveReviewStatus } from '../../src/core/review-status.js'

describe('core/review-status: deriveReviewStatus', () => {
  const baseInput = {
    hasShopPaused: false,
    oldestReadyAgeMs: null,
    scheduledSendAtMs: null,
    queuePosition: null,
    queueSize: null,
    effectiveAtMs: null,
  }

  it('discovered -> new', () => {
    const v = deriveReviewStatus({ ...baseInput, state: 'discovered' })
    expect(v.code).toBe('new')
    expect(v.label).toBe('Новый')
    expect(v.tone).toBe('info')
  })

  it('generating -> preparing_reply', () => {
    const v = deriveReviewStatus({ ...baseInput, state: 'generating' })
    expect(v.code).toBe('preparing_reply')
  })

  it('waiting_llm_quota -> waiting_llm_quota', () => {
    const v = deriveReviewStatus({ ...baseInput, state: 'waiting_llm_quota' })
    expect(v.code).toBe('waiting_llm_quota')
    expect(v.tone).toBe('warning')
  })

  it('draft_ready -> awaiting_approval', () => {
    const v = deriveReviewStatus({ ...baseInput, state: 'draft_ready' })
    expect(v.code).toBe('awaiting_approval')
  })

  it('ready_to_send -> scheduled', () => {
    const v = deriveReviewStatus({
      ...baseInput,
      state: 'ready_to_send',
      scheduledSendAtMs: 1735689600000,
      queuePosition: 4,
      queueSize: 26,
      effectiveAtMs: 1735689600000,
    })
    expect(v.code).toBe('scheduled')
    expect(v.queuePosition).toBe(4)
    expect(v.queueSize).toBe(26)
    expect(v.effectiveAtMs).toBe(1735689600000)
  })

  it('sending -> sending', () => {
    const v = deriveReviewStatus({ ...baseInput, state: 'sending' })
    expect(v.code).toBe('sending')
  })

  it('posted -> published_on_wb (success)', () => {
    const v = deriveReviewStatus({
      ...baseInput,
      state: 'posted',
      effectiveAtMs: 1735689700000,
    })
    expect(v.code).toBe('published_on_wb')
    expect(v.tone).toBe('success')
  })

  it('retry_wait -> retry_scheduled (warning)', () => {
    const v = deriveReviewStatus({ ...baseInput, state: 'retry_wait' })
    expect(v.code).toBe('retry_scheduled')
    expect(v.tone).toBe('warning')
  })

  it('reconcile_pending -> checking_delivery (warning)', () => {
    const v = deriveReviewStatus({ ...baseInput, state: 'reconcile_pending' })
    expect(v.code).toBe('checking_delivery')
    expect(v.tone).toBe('warning')
  })

  it('manual_review -> manual_review (warning)', () => {
    const v = deriveReviewStatus({ ...baseInput, state: 'manual_review' })
    expect(v.code).toBe('manual_review')
    expect(v.tone).toBe('warning')
  })

  it('rejected -> rejected (neutral, terminal)', () => {
    const v = deriveReviewStatus({ ...baseInput, state: 'rejected' })
    expect(v.code).toBe('rejected')
    expect(v.tone).toBe('neutral')
  })

  it('dead -> failed (danger)', () => {
    const v = deriveReviewStatus({ ...baseInput, state: 'dead' })
    expect(v.code).toBe('failed')
    expect(v.tone).toBe('danger')
  })

  it('paused shop overrides state', () => {
    const v = deriveReviewStatus({ ...baseInput, state: 'ready_to_send', hasShopPaused: true })
    expect(v.code).toBe('paused')
    expect(v.tone).toBe('warning')
  })

  it('oldest ready > 24h triggers failed', () => {
    const v = deriveReviewStatus({
      ...baseInput,
      state: 'ready_to_send',
      oldestReadyAgeMs: 25 * 60 * 60 * 1000,
    })
    expect(v.code).toBe('failed')
  })
})

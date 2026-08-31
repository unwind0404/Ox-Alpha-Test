import { describe, it, expect, vi } from 'vitest'
import { runRetention, DEFAULT_RETENTION } from '../../src/coordinator/retention.js'
import type { Env } from '../../src/index.js'

const T0 = 1_700_000_000_000

function makeD1(opts: {
  reviewsDeleted: number
  auditsDeleted: number
  jobsDeleted: number
}) {
  const deleteResults = [opts.reviewsDeleted, opts.auditsDeleted, opts.jobsDeleted]
  let callIdx = 0
  const run = vi.fn().mockImplementation(() => {
    const changes = deleteResults[callIdx] ?? 0
    callIdx++
    return Promise.resolve({ success: true, meta: { changes, duration: 1 } })
  })
  return {
    DB: { prepare: vi.fn().mockReturnValue({ bind: () => ({ run }) }) } as unknown as D1Database,
  } as Env
}

describe('retention', () => {
  it('DEFAULT_RETENTION — 90/180 дней', () => {
    expect(DEFAULT_RETENTION.reviewRetentionDays).toBe(90)
    expect(DEFAULT_RETENTION.auditRetentionDays).toBe(180)
  })

  it('runRetention: возвращает количество удалённых', async () => {
    const env = makeD1({ reviewsDeleted: 12, auditsDeleted: 100, jobsDeleted: 5 })
    const result = await runRetention(env, T0)
    expect(result.reviewsDeleted).toBe(12)
    expect(result.auditsDeleted).toBe(100)
    expect(result.jobsDeleted).toBe(5)
    expect(result.executedAtMs).toBe(T0)
    expect(result.config).toEqual(DEFAULT_RETENTION)
  })

  it('runRetention: кастомный config', async () => {
    const env = makeD1({ reviewsDeleted: 0, auditsDeleted: 0, jobsDeleted: 0 })
    const result = await runRetention(env, T0, { reviewRetentionDays: 30, auditRetentionDays: 60 })
    expect(result.config.reviewRetentionDays).toBe(30)
    expect(result.config.auditRetentionDays).toBe(60)
  })

  it('runRetention: 0 удалений — корректно', async () => {
    const env = makeD1({ reviewsDeleted: 0, auditsDeleted: 0, jobsDeleted: 0 })
    const result = await runRetention(env, T0)
    expect(result.reviewsDeleted).toBe(0)
    expect(result.auditsDeleted).toBe(0)
    expect(result.jobsDeleted).toBe(0)
  })

  it('runRetention: использует D1 prepare 4 раза (3 delete + 1 insert audit)', async () => {
    const env = makeD1({ reviewsDeleted: 0, auditsDeleted: 0, jobsDeleted: 0 })
    const db = env.DB as unknown as { prepare: ReturnType<typeof vi.fn> }
    await runRetention(env, T0)
    expect(db.prepare).toHaveBeenCalledTimes(4)
  })
})

import { describe, it, expect } from 'vitest'
import { rebuildSendForecast, totalForecastDurationMs } from '../../src/core/send-forecast.js'

const T0 = 1_700_000_000_000 // Friday, Aug 29 2026 12:26:40 UTC

const emptyRate = {
  lastWbRequestAtMs: null,
  cooldownUntilMs: 0,
  rollingDaySuccessCount: 0,
}

const recentRate = (lastWbAt: number) => ({
  lastWbRequestAtMs: lastWbAt,
  cooldownUntilMs: 0,
  rollingDaySuccessCount: 0,
})

describe('send-forecast: rebuildSendForecast', () => {
  it('пустой список → пустой результат', () => {
    const r = rebuildSendForecast({
      nowMs: T0,
      profile: 'basic',
      rateState: emptyRate,
      readyJobs: [],
      dailySyncUtcHour: 7,
    })
    expect(r).toEqual([])
  })

  it('1 ready job → ETA в ближайшем слоте', () => {
    const r = rebuildSendForecast({
      nowMs: T0,
      profile: 'basic',
      rateState: emptyRate,
      readyJobs: [{ id: 'j1', nextAttemptAtMs: 0 }],
      dailySyncUtcHour: 7,
    })
    expect(r).toHaveLength(1)
    expect(r[0]!.queuePosition).toBe(1)
    // ETA >= nowMs (после сдвига для jitter)
    expect(r[0]!.scheduledSendAtMs).toBeGreaterThanOrEqual(T0)
    // ETA в пределах interval от nowMs
    expect(r[0]!.scheduledSendAtMs).toBeLessThanOrEqual(T0 + 12 * 60_000 + 5_000)
  })

  it('26 ready jobs → 26 уникальных 12-мин слотов', () => {
    const jobs = Array.from({ length: 26 }, (_, i) => ({
      id: `j${i}`,
      nextAttemptAtMs: 0,
    }))
    const r = rebuildSendForecast({
      nowMs: T0,
      profile: 'basic',
      rateState: emptyRate,
      readyJobs: jobs,
      dailySyncUtcHour: 7,
    })
    expect(r).toHaveLength(26)
    // Позиции 1..26
    expect(r.map(x => x.queuePosition)).toEqual(Array.from({ length: 26 }, (_, i) => i + 1))
    // Все ETA уникальны
    const etas = r.map(x => x.scheduledSendAtMs)
    expect(new Set(etas).size).toBe(26)
  })

  it('recent WB-запрос (basic 12 min) → ETA сдвинут на 12 мин', () => {
    const r = rebuildSendForecast({
      nowMs: T0,
      profile: 'basic',
      rateState: recentRate(T0 - 60_000), // 1 мин назад
      readyJobs: [{ id: 'j1', nextAttemptAtMs: 0 }],
      dailySyncUtcHour: 7,
    })
    // ETA >= T0 + 12 мин - 1 мин
    expect(r[0]!.scheduledSendAtMs).toBeGreaterThanOrEqual(T0 + 11 * 60_000)
  })

  it('nextAttemptAtMs > now → ETA сдвинут на nextAttemptAtMs', () => {
    const future = T0 + 60 * 60_000 // +1 час
    const r = rebuildSendForecast({
      nowMs: T0,
      profile: 'basic',
      rateState: emptyRate,
      readyJobs: [{ id: 'j1', nextAttemptAtMs: future }],
      dailySyncUtcHour: 7,
    })
    expect(r[0]!.scheduledSendAtMs).toBeGreaterThanOrEqual(future)
  })

  it('personal: 400ms интервал (с учётом jitter ≤ 60 сек на 10 jobs)', () => {
    const jobs = Array.from({ length: 10 }, (_, i) => ({ id: `j${i}`, nextAttemptAtMs: 0 }))
    const r = rebuildSendForecast({
      nowMs: T0,
      profile: 'personal',
      rateState: emptyRate,
      readyJobs: jobs,
      dailySyncUtcHour: 7,
    })
    expect(r).toHaveLength(10)
    // personal интервал = 400ms. 10 jobs × 400ms = 4 sec baseline.
    // С jitter (5 сек) span может быть до ~50 сек.
    const span = r[r.length - 1]!.scheduledSendAtMs - r[0]!.scheduledSendAtMs
    expect(span).toBeLessThan(60_000)
  })

  it('dailySyncUtcHour резервирует слот если cursor попадает на 07:00 UTC', () => {
    // 7:00 UTC = T0 - 5*60*60*1000 (если T0 = 12:00 UTC)
    // cursor = T0 (пустой rate) попадает ПОСЛЕ daily sync → reply сдвигается
    const dailySyncAt = new Date(T0)
    dailySyncAt.setUTCHours(7, 0, 0, 0)
    const dailySyncMs = dailySyncAt.getTime() < T0
      ? dailySyncAt.getTime() + 24 * 60 * 60 * 1000
      : dailySyncAt.getTime()

    // Если cursor + 1 sec окажется в окне daily_sync ± interval → сдвиг
    const r = rebuildSendForecast({
      nowMs: dailySyncMs - 1000, // за 1 сек до 07:00 UTC
      profile: 'basic',
      rateState: emptyRate,
      readyJobs: [{ id: 'j1', nextAttemptAtMs: 0 }],
      dailySyncUtcHour: 7,
    })
    // ETA должен быть ПОСЛЕ daily sync (т.е. >= 07:00 + 12 min)
    expect(r[0]!.scheduledSendAtMs).toBeGreaterThanOrEqual(dailySyncMs + 12 * 60_000)
  })
})

describe('send-forecast: totalForecastDurationMs', () => {
  it('basic: 100 jobs × 12 min = 20 hours', () => {
    expect(totalForecastDurationMs('basic', 100)).toBe(100 * 12 * 60_000)
  })

  it('basic: 0 jobs → 0 ms', () => {
    expect(totalForecastDurationMs('basic', 0)).toBe(0)
  })

  it('personal: 1000 jobs × 400ms = 400 sec', () => {
    expect(totalForecastDurationMs('personal', 1000)).toBe(400_000)
  })
})

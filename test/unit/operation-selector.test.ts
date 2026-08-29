import { describe, it, expect } from 'vitest'
import {
  selectNextWbOperation,
  isDailySyncDue,
  rateLimitHeadroom,
  type OperationSelectorInput,
} from '../../src/core/operation-selector.js'

const T0 = 1_700_000_000_000

const emptyRate = {
  lastWbRequestAtMs: null,
  cooldownUntilMs: 0,
  rollingDaySuccessCount: 0,
}

const baseInput: OperationSelectorInput = {
  nowMs: T0,
  profile: 'basic',
  rateState: emptyRate,
  todayUtc: '2026-08-29',
  lastSyncDayUtc: '2026-08-29',
  hasReconcileJobs: false,
  oldestReadyJob: null,
  hasMorePages: false,
  currentSkip: 0,
}

describe('selectNextWbOperation: приоритеты', () => {
  it('1. daily_sync_due имеет приоритет над всем', () => {
    const op = selectNextWbOperation({
      ...baseInput,
      lastSyncDayUtc: '2026-08-28', // вчера — пора синкать
      hasReconcileJobs: true,
      oldestReadyJob: { id: 'j1', nextAttemptAtMs: T0 - 1000 },
    })
    expect(op.kind).toBe('daily_sync')
  })

  it('daily_sync_due даже когда есть reconcile и reply', () => {
    const op = selectNextWbOperation({
      ...baseInput,
      lastSyncDayUtc: '2026-08-28',
      hasReconcileJobs: true,
      oldestReadyJob: { id: 'j1', nextAttemptAtMs: T0 - 1000 },
      hasMorePages: true,
    })
    expect(op.kind).toBe('daily_sync')
  })

  it('2. reconcile > reply', () => {
    const op = selectNextWbOperation({
      ...baseInput,
      hasReconcileJobs: true,
      oldestReadyJob: { id: 'j1', nextAttemptAtMs: T0 - 1000 },
    })
    expect(op.kind).toBe('reconcile')
  })

  it('3. reply когда есть ready job', () => {
    const op = selectNextWbOperation({
      ...baseInput,
      oldestReadyJob: { id: 'j1', nextAttemptAtMs: T0 - 1000 },
    })
    expect(op.kind).toBe('reply')
  })

  it('3. НЕ reply если rate limit ещё не прошёл', () => {
    const op = selectNextWbOperation({
      ...baseInput,
      rateState: { ...emptyRate, lastWbRequestAtMs: T0 - 60_000 }, // 1 минута назад
      oldestReadyJob: { id: 'j1', nextAttemptAtMs: T0 - 1000 },
    })
    expect(op.kind).toBe('none')
  })

  it('4. fetch_next_page когда предыдущая страница заполнена', () => {
    const op = selectNextWbOperation({
      ...baseInput,
      hasMorePages: true,
      currentSkip: 5000,
    })
    expect(op.kind).toBe('fetch_next_page')
    if (op.kind === 'fetch_next_page') {
      expect(op.skip).toBe(10000)
    }
  })

  it('5. none когда нет задач', () => {
    expect(selectNextWbOperation(baseInput).kind).toBe('none')
  })
})

describe('isDailySyncDue', () => {
  it('сегодня ещё не было sync → due', () => {
    expect(isDailySyncDue({ nowMs: T0, lastSyncDayUtc: '2026-08-28', todayUtc: '2026-08-29' })).toBe(true)
  })

  it('сегодня уже синкали → not due', () => {
    expect(isDailySyncDue({ nowMs: T0, lastSyncDayUtc: '2026-08-29', todayUtc: '2026-08-29' })).toBe(false)
  })

  it('никогда не синкали → due', () => {
    expect(isDailySyncDue({ nowMs: T0, lastSyncDayUtc: null, todayUtc: '2026-08-29' })).toBe(true)
  })
})

describe('rateLimitHeadroom', () => {
  it('basic, fresh — можно сейчас', () => {
    const r = rateLimitHeadroom(T0, 'basic', emptyRate)
    expect(r.canDoNow).toBe(true)
    expect(r.nextAllowedAtMs).toBe(T0)
  })

  it('basic, 1 мин назад — нужно 11 мин ждать', () => {
    const r = rateLimitHeadroom(T0, 'basic', { ...emptyRate, lastWbRequestAtMs: T0 - 60_000 })
    expect(r.canDoNow).toBe(false)
    expect(r.nextAllowedAtMs).toBe(T0 + 660_000) // 12 мин - 1 мин
  })
})

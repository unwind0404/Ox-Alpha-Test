import { describe, it, expect, vi } from 'vitest'
import { syncUnanswered } from '../../src/coordinator/sync-reviews.js'
import type { WbClient, WbFeedback, WbResult } from '../../src/adapters/wb/wb-client.js'
import type { ReviewRepository, JobRepository } from '../../src/ports/repositories.js'
import type { Review } from '../../src/core/types.js'

const T0 = 1_700_000_000_000

function makeFeedback(overrides: Partial<WbFeedback> = {}): WbFeedback {
  return {
    id: 'fb-' + Math.random().toString(36).slice(2, 8),
    text: 'Good product',
    productValuation: 5,
    userName: 'Test',
    createdDate: '2026-08-29T10:00:00Z',
    productDetails: { nmId: 123, productName: 'Test Product' },
    ...overrides,
  }
}

function makeWbResult(feedbacks: WbFeedback[]): WbResult<{ feedbacks: WbFeedback[] }> {
  return {
    ok: true,
    data: { feedbacks },
    rateLimit: { retryAfterSec: null, resetAtMs: null, remaining: null },
    status: 200,
  }
}

function makeMockReviewRepo(): ReviewRepository & { upsert: ReturnType<typeof vi.fn> } {
  const upsert = vi.fn().mockResolvedValue(true)
  return {
    upsert,
    getById: vi.fn(),
    getByWbFeedbackId: vi.fn(),
    listByShopAfter: vi.fn(),
  } as unknown as ReviewRepository & { upsert: ReturnType<typeof vi.fn> }
}

function makeMockJobRepo(): JobRepository & { createOnce: ReturnType<typeof vi.fn> } {
  const createOnce = vi.fn().mockResolvedValue(true)
  return {
    createOnce,
    getById: vi.fn(),
    transition: vi.fn(),
    listReadyToSend: vi.fn(),
    listActiveByShop: vi.fn(),
    listByShopForQueue: vi.fn(),
    bumpScheduleRevision: vi.fn(),
  } as unknown as JobRepository & { createOnce: ReturnType<typeof vi.fn> }
}

function makeMockWb(feedbacks: WbFeedback[]): WbClient {
  return {
    listUnanswered: vi.fn().mockResolvedValue(makeWbResult(feedbacks)),
  } as unknown as WbClient
}

describe('sync-reviews: happy path', () => {
  it('100 новых отзывов → 100 reviews + 100 jobs', async () => {
    const feedbacks = Array.from({ length: 100 }, (_, i) =>
      makeFeedback({ id: `fb-${i}` }),
    )
    const wb = makeMockWb(feedbacks)
    const reviewRepo = makeMockReviewRepo()
    const jobRepo = makeMockJobRepo()

    const r = await syncUnanswered('shop-1', wb, reviewRepo, jobRepo, 'drafts', T0)

    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.totalFromWb).toBe(100)
      expect(r.data.newCount).toBe(100)
      expect(r.data.duplicateCount).toBe(0)
      expect(r.data.jobsCreated).toBe(100)
      expect(reviewRepo.upsert).toHaveBeenCalledTimes(100)
      expect(jobRepo.createOnce).toHaveBeenCalledTimes(100)
    }
  })

  it('пустой ответ — ничего не создаёт', async () => {
    const wb = makeMockWb([])
    const reviewRepo = makeMockReviewRepo()
    const jobRepo = makeMockJobRepo()
    const r = await syncUnanswered('shop-1', wb, reviewRepo, jobRepo, 'drafts', T0)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.totalFromWb).toBe(0)
      expect(r.data.newCount).toBe(0)
      expect(r.data.jobsCreated).toBe(0)
    }
  })
})

describe('sync-reviews: idempotency', () => {
  it('повторный sync тех же отзывов → duplicates, no new jobs', async () => {
    const feedbacks = [makeFeedback({ id: 'fb-1' }), makeFeedback({ id: 'fb-2' })]
    const wb = makeMockWb(feedbacks)
    const reviewRepo = makeMockReviewRepo()
    const jobRepo = makeMockJobRepo()

    // Симулируем что все upsert возвращают false (уже в БД)
    reviewRepo.upsert.mockResolvedValue(false)

    const r = await syncUnanswered('shop-1', wb, reviewRepo, jobRepo, 'drafts', T0)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.newCount).toBe(0)
      expect(r.data.duplicateCount).toBe(2)
      expect(r.data.jobsCreated).toBe(0)
    }
  })

  it('mixed: 1 new + 1 existing', async () => {
    const wb = makeMockWb([makeFeedback({ id: 'fb-1' }), makeFeedback({ id: 'fb-2' })])
    const reviewRepo = makeMockReviewRepo()
    const jobRepo = makeMockJobRepo()
    reviewRepo.upsert
      .mockResolvedValueOnce(true)  // fb-1 new
      .mockResolvedValueOnce(false) // fb-2 existing

    const r = await syncUnanswered('shop-1', wb, reviewRepo, jobRepo, 'drafts', T0)
    if (r.ok) {
      expect(r.data.newCount).toBe(1)
      expect(r.data.duplicateCount).toBe(1)
      expect(r.data.jobsCreated).toBe(1)
    }
  })
})

describe('sync-reviews: hasMorePages', () => {
  it('take=5000 && len=5000 → hasMorePages=true', async () => {
    const feedbacks = Array.from({ length: 5000 }, (_, i) => makeFeedback({ id: `fb-${i}` }))
    const wb = makeMockWb(feedbacks)
    const reviewRepo = makeMockReviewRepo()
    const jobRepo = makeMockJobRepo()
    const r = await syncUnanswered('shop-1', wb, reviewRepo, jobRepo, 'drafts', T0, 0, 5000)
    if (r.ok) {
      expect(r.data.hasMorePages).toBe(true)
    }
  })

  it('len=4999 → hasMorePages=false', async () => {
    const feedbacks = Array.from({ length: 4999 }, (_, i) => makeFeedback({ id: `fb-${i}` }))
    const wb = makeMockWb(feedbacks)
    const reviewRepo = makeMockReviewRepo()
    const jobRepo = makeMockJobRepo()
    const r = await syncUnanswered('shop-1', wb, reviewRepo, jobRepo, 'drafts', T0, 0, 5000)
    if (r.ok) {
      expect(r.data.hasMorePages).toBe(false)
    }
  })
})

describe('sync-reviews: errors', () => {
  it('WB вернул http error → result.err пробрасывается', async () => {
    const wb = {
      listUnanswered: vi.fn().mockResolvedValue({
        ok: false,
        error: { kind: 'http', status: 429, bodyText: 'rate limit', rateLimit: { retryAfterSec: 720, resetAtMs: null, remaining: null } },
      }),
    } as unknown as WbClient
    const reviewRepo = makeMockReviewRepo()
    const jobRepo = makeMockJobRepo()
    const r = await syncUnanswered('shop-1', wb, reviewRepo, jobRepo, 'drafts', T0)
    expect(r.ok).toBe(false)
    if (!r.ok && r.error.kind === 'http') {
      expect(r.error.status).toBe(429)
    }
    expect(reviewRepo.upsert).not.toHaveBeenCalled()
  })

  it('WB вернул timeout → result.err пробрасывается', async () => {
    const wb = {
      listUnanswered: vi.fn().mockResolvedValue({
        ok: false,
        error: { kind: 'timeout', ms: 12000 },
      }),
    } as unknown as WbClient
    const reviewRepo = makeMockReviewRepo()
    const jobRepo = makeMockJobRepo()
    const r = await syncUnanswered('shop-1', wb, reviewRepo, jobRepo, 'drafts', T0)
    expect(r.ok).toBe(false)
  })
})

describe('sync-reviews: validation', () => {
  it('отзыв без id пропускается', async () => {
    const wb = makeMockWb([
      makeFeedback({ id: 'fb-valid' }),
      { text: 'no id', productValuation: 5 } as WbFeedback, // без id
    ])
    const reviewRepo = makeMockReviewRepo()
    const jobRepo = makeMockJobRepo()
    const r = await syncUnanswered('shop-1', wb, reviewRepo, jobRepo, 'drafts', T0)
    if (r.ok) {
      expect(r.data.totalFromWb).toBe(2)
      expect(r.data.newCount).toBe(1) // только один с id
      expect(r.data.jobsCreated).toBe(1)
    }
  })
})

describe('sync-reviews: rating clamping', () => {
  it('rating=5 → Review.rating=5', async () => {
    const wb = makeMockWb([makeFeedback({ id: 'fb-1', productValuation: 5 })])
    const reviews: Review[] = []
    const reviewRepo = {
      ...makeMockReviewRepo(),
      upsert: vi.fn().mockImplementation(async (r: Review) => { reviews.push(r); return true }),
    } as unknown as ReviewRepository & { upsert: ReturnType<typeof vi.fn> }
    const jobRepo = makeMockJobRepo()
    await syncUnanswered('shop-1', wb, reviewRepo, jobRepo, 'drafts', T0)
    expect(reviews).toHaveLength(1)
    expect(reviews[0]!.rating).toBe(5)
  })

  it('rating=null (нет productValuation) → Review.rating=null', async () => {
    const fb = makeFeedback({ id: 'fb-1' })
    delete fb.productValuation
    const wb = makeMockWb([fb])
    const reviews: Review[] = []
    const reviewRepo = {
      ...makeMockReviewRepo(),
      upsert: vi.fn().mockImplementation(async (r: Review) => { reviews.push(r); return true }),
    } as unknown as ReviewRepository & { upsert: ReturnType<typeof vi.fn> }
    const jobRepo = makeMockJobRepo()
    await syncUnanswered('shop-1', wb, reviewRepo, jobRepo, 'drafts', T0)
    expect(reviews).toHaveLength(1)
    expect(reviews[0]!.rating).toBe(null)
  })
})

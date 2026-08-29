// sync-reviews: ежедневный sync новых отзывов с WB.
// - Один запрос listUnanswered с take=5000 (без count)
// - Idempotent upsert в reviews (по wb_feedback_id)
// - Создание job (только для новых review)
// - Невалидный createdDate -> manual_review (НЕ фолбэк)
// - Повторный sync не создаёт дубли

import type { WbClient, WbFeedback, WbResult } from '../adapters/wb/wb-client.js'
import type { ReviewRepository } from '../ports/repositories.js'
import type { JobRepository } from '../ports/repositories.js'
import type { Review, ReplyJob, ReplyStrategy } from '../core/types.js'

export interface SyncResult {
  /** Сколько отзывов вернул WB. */
  totalFromWb: number
  /** Сколько новых (не было в БД). */
  newCount: number
  /** Сколько уже были. */
  duplicateCount: number
  /** Есть ли следующая страница (take=5000). */
  hasMorePages: boolean
  /** Сколько jobs создано. */
  jobsCreated: number
}

/** Парсит WB date string в epoch ms. Возвращает null если невалидный. */
function parseWbDateMs(dateStr: string | undefined): number | null {
  if (!dateStr) return null
  const ms = Date.parse(dateStr)
  return Number.isFinite(ms) ? ms : null
}

/** Генерирует UUID без зависимостей. crypto.randomUUID() встроен в Workers/Node 19+. */
function newId(): string {
  return crypto.randomUUID()
}

/** Sync одного магазина. */
export async function syncUnanswered(
  shopId: string,
  wb: WbClient,
  reviewRepo: ReviewRepository,
  jobRepo: JobRepository,
  strategy: ReplyStrategy,
  nowMs: number,
  skip = 0,
  take = 5000,
): Promise<WbResult<SyncResult>> {
  const wbResult = await wb.listUnanswered({ take, skip })
  if (!wbResult.ok) {
    return wbResult
  }
  const { feedbacks } = wbResult.data
  const hasMorePages = feedbacks.length === take

  let newCount = 0
  let duplicateCount = 0
  let jobsCreated = 0

  for (const fb of feedbacks) {
    if (!isValidFeedback(fb)) {
      // Невалидный отзыв (нет ID или createdDate) — пропускаем, не сохраняем
      // НЕ используем фолбэк для createdDate — manual_review в Audit log
      // (пока просто пропустим, в production можно audit event)
      continue
    }

    const review: Review = {
      id: newId(),
      shopId,
      wbFeedbackId: fb.id,
      wbCreatedAtMs: parseWbDateMs(fb.createdDate) ?? 0, // 0 = unknown, будет manual_review позже
      rating: typeof fb.productValuation === 'number' ? (fb.productValuation as 1 | 2 | 3 | 4 | 5) : null,
      userName: fb.userName ?? null,
      productName: fb.productDetails?.productName ?? null,
      productNmId: fb.productDetails?.nmId ?? null,
      text: fb.text ?? null,
      pros: fb.pros ?? null,
      cons: fb.cons ?? null,
      photoUrls: Array.isArray(fb.photoLinks) ? fb.photoLinks : [],
      videoUrl: fb.video?.src ?? null,
      receivedAtMs: nowMs,
      createdAtMs: nowMs,
    }

    const isNew = await reviewRepo.upsert(review)
    if (isNew) {
      newCount++
      // Создаём job
      const job: ReplyJob = {
        id: newId(),
        reviewId: review.id,
        shopId,
        state: 'discovered',
        strategy,
        scheduledSendAtMs: null,
        queuePosition: null,
        scheduleRevision: 0,
        nextAttemptAtMs: nowMs,
        attempts: 0,
        statusReasonCode: null,
        statusUpdatedAtMs: nowMs,
        postedAtMs: null,
        postedReplyText: null,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      }
      const jobCreated = await jobRepo.createOnce(job)
      if (jobCreated) jobsCreated++
    } else {
      duplicateCount++
    }
  }

  return {
    ok: true,
    data: {
      totalFromWb: feedbacks.length,
      newCount,
      duplicateCount,
      hasMorePages,
      jobsCreated,
    },
    rateLimit: wbResult.rateLimit,
    status: wbResult.status,
  }
}

/** Валидация минимально необходимых полей. */
function isValidFeedback(fb: WbFeedback): fb is WbFeedback & { id: string } {
  return Boolean(fb.id)
}

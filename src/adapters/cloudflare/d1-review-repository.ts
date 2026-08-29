// D1 adapter для ReviewRepository.

import type { D1Database } from '@cloudflare/workers-types'
import type { Review, Rating } from '../../core/types.js'
import type { ReviewRepository } from '../../ports/repositories.js'

interface ReviewRow {
  id: string
  shop_id: string
  wb_feedback_id: string
  wb_created_at_ms: number
  rating: number | null
  user_name: string | null
  product_name: string | null
  product_nm_id: number | null
  text: string | null
  pros: string | null
  cons: string | null
  photo_urls_json: string
  video_url: string | null
  received_at_ms: number
  created_at_ms: number
}

function rowToReview(row: ReviewRow): Review {
  let photoUrls: ReadonlyArray<string> = []
  try {
    const parsed: unknown = JSON.parse(row.photo_urls_json)
    if (Array.isArray(parsed)) {
      photoUrls = parsed.filter((x): x is string => typeof x === 'string')
    }
  } catch {
    photoUrls = []
  }
  return {
    id: row.id,
    shopId: row.shop_id,
    wbFeedbackId: row.wb_feedback_id,
    wbCreatedAtMs: row.wb_created_at_ms,
    rating: row.rating as Rating | null,
    userName: row.user_name,
    productName: row.product_name,
    productNmId: row.product_nm_id,
    text: row.text,
    pros: row.pros,
    cons: row.cons,
    photoUrls,
    videoUrl: row.video_url,
    receivedAtMs: row.received_at_ms,
    createdAtMs: row.created_at_ms,
  }
}

export class D1ReviewRepository implements ReviewRepository {
  constructor(private readonly db: D1Database) {}

  async upsert(review: Review): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO reviews (
          id, shop_id, wb_feedback_id, wb_created_at_ms, rating, user_name,
          product_name, product_nm_id, text, pros, cons, photo_urls_json,
          video_url, received_at_ms, created_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
        ON CONFLICT(shop_id, wb_feedback_id) DO NOTHING`,
      )
      .bind(
        review.id,
        review.shopId,
        review.wbFeedbackId,
        review.wbCreatedAtMs,
        review.rating,
        review.userName,
        review.productName,
        review.productNmId,
        review.text,
        review.pros,
        review.cons,
        JSON.stringify(review.photoUrls),
        review.videoUrl,
        review.receivedAtMs,
        review.createdAtMs,
      )
      .run()
    // D1 meta.changes > 0 = row was inserted
    return (result.meta?.changes ?? 0) > 0
  }

  async getById(id: string): Promise<Review | null> {
    const row = await this.db
      .prepare('SELECT * FROM reviews WHERE id = ?1')
      .bind(id)
      .first<ReviewRow>()
    return row ? rowToReview(row) : null
  }

  async getByWbFeedbackId(shopId: string, wbFeedbackId: string): Promise<Review | null> {
    const row = await this.db
      .prepare('SELECT * FROM reviews WHERE shop_id = ?1 AND wb_feedback_id = ?2')
      .bind(shopId, wbFeedbackId)
      .first<ReviewRow>()
    return row ? rowToReview(row) : null
  }

  async listByShopAfter(shopId: string, afterMs: number, limit: number): Promise<Review[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM reviews
         WHERE shop_id = ?1 AND wb_created_at_ms >= ?2
         ORDER BY wb_created_at_ms ASC
         LIMIT ?3`,
      )
      .bind(shopId, afterMs, limit)
      .all<ReviewRow>()
    return result.results.map(rowToReview)
  }
}

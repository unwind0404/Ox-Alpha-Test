// reply-policy: классификация отзыва для выбора стратегии.
// Возвращает category: low_risk | needs_review | injection_detected
// plus human-readable reason (не хранится в БД, используется для audit/log).

import type { Review } from './types.js'

export type ReviewCategory = 'low_risk' | 'needs_review' | 'injection_detected'

/** Триггеры, по которым отзыв уходит в manual_review. */
const INJECTION_PATTERNS: RegExp[] = [
  // EN: system prompts / instruction override
  /\bignore\s+(?:all\s+)?(?:previous|prior|above|my)?\s*(?:instructions?|prompts?|rules?)\b/i,
  /\bsystem\s*:\s*\b/i,
  /\b(?:you\s+are\s+now|act\s+as|ignore\s+the\s+prompt)\b/i,
  /\b(?:disregard|forget)\b.{0,40}(?:instructions?|rules?|guidelines?)\b/i,
  /\b(?:role\s*:\s*(?:assistant|system|admin|developer))\b/i,
  // EN: instruction override (без \b — кириллица не поддерживает \b в JS RegExp)
  /игнор(ируй|ить)/i,
  /как\s+систем/i,
  /систем[аы]\s*:/i,
  /предыдущ\w+\s+инструкц/i,
  /забудь\s+(вс[её]|про)\s+правил/i,
  /забудь\s+(вс[её]|про)\s+инструкц/i,
  // Mixed EN+RU (обход через пробел): ignore + все + инструкции
  /ignore\s+вс[её]\s+инструкц/i,
]

/** Триггеры для needs_review (не инъекция, но 1-3 звезды / опасные темы). */
const SENSITIVE_KEYWORDS: RegExp[] = [
  // RU: возврат/обмен/брак
  /(возврат|верните\s+деньги|обмен\s+товар|бракованн)/i,
  // RU: суд/жалобы
  /(суд|жалоб|роспотребнадзор|защит\s+прав\s+потребител)/i,
  // RU: аллергия/вред
  /(аллерг|отравлен|вред\s+здоров)/i,
  // EN: refund/return/broken
  /\b(return|refund|broken|defective)\b/i,
  // EN: lawsuit/legal
  /\b(lawsuit|attorney|small\s+claims|consumer\s+protection)\b/i,
  // EN: allergy/poison
  /\b(allergy|allergic|poisoning|health\s+risk)\b/i,
]

export interface ClassifyResult {
  category: ReviewCategory
  reason: string
}

/** Классифицировать отзыв по риску. */
export function classifyReview(review: Pick<Review, 'rating' | 'text' | 'pros' | 'cons'>): ClassifyResult {
  const text = `${review.text ?? ''} ${review.pros ?? ''} ${review.cons ?? ''}`

  // 1. Injection detection — ВЫСШИЙ приоритет
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      return { category: 'injection_detected', reason: `injection pattern: ${pattern.source}` }
    }
  }

  // 2. Sensitive topics — manual_review независимо от rating
  for (const pattern of SENSITIVE_KEYWORDS) {
    if (pattern.test(text)) {
      return { category: 'needs_review', reason: `sensitive topic: ${pattern.source}` }
    }
  }

  // 3. Low rating → manual_review
  const rating = review.rating
  if (rating !== null && rating <= 3) {
    return { category: 'needs_review', reason: `low rating: ${rating}` }
  }

  // 4. Default: low_risk (4-5 звёзд, no sensitive keywords)
  return { category: 'low_risk', reason: 'no concerns' }
}

/** Решить, может ли стратегия auto (`llm`) применяться к отзыву. */
export function canAutoReply(category: ReviewCategory): boolean {
  return category === 'low_risk'
}

/** Решить, нужен ли хотя бы draft (для стратегии `llm`) или полный manual. */
export function needsDraft(category: ReviewCategory): boolean {
  // draft создаётся для low_risk и needs_review; injection_detected — manual_review (без draft)
  return category !== 'injection_detected'
}

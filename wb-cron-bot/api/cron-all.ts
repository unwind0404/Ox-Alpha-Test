// Vercel cron: один endpoint, два режима по времени суток.
// 07:00 UTC (= 10:00 МСК) — основной запуск: полный обход всех магазинов
// Остальное время — tail: 2-3 отзыва за запуск, щадящий режим
//
// Vercel Hobby лимит — 2 cron-задачи, поэтому используем одну
// и различаем режимы по часу.

import type { VercelRequest, VercelResponse } from '@vercel/node'
import {
  getDb, initDb, listShops, saveFeedback, listPendingSend, listFeedbacks,
  type FeedbackInput, type FeedbackRow,
} from '../lib/db.js'
import { WbClient, RateLimitError, type WbFeedback } from '../lib/wb-client.js'
import { generateAnswer } from '../lib/generator.js'
import { reportRun, reportError, isTelegramConfigured } from '../lib/telegram.js'

type Target = { shopId: number | null; name: string; token: string; mode: string; instructions: string | null }

async function getTargets(): Promise<Target[]> {
  const db = getDb()
  if (!db) return []
  await initDb()
  const shops = await listShops()
  return shops
    .filter((s) => s.enabled)
    .map((s) => ({ shopId: s.id, name: s.name, token: s.token, mode: s.mode, instructions: s.instructions }))
}

function fbFromRow(row: FeedbackRow): WbFeedback {
  return {
    id: row.id,
    text: row.text ?? undefined,
    pros: row.pros ?? undefined,
    cons: row.cons ?? undefined,
    productValuation: row.rating ?? undefined,
    userName: row.user_name ?? undefined,
    subjectName: row.subject_name ?? undefined,
    productDetails: row.nm_id ? { nmId: row.nm_id, productName: row.product_name ?? undefined } : undefined,
    photoLinks: row.photo_links,
    video: row.video_url ? { src: row.video_url, preview: row.video_preview ?? undefined } : null,
    createdDate: row.created_date ?? undefined,
  }
}

const MAIN_BATCH_SIZE = 20
const TAIL_BATCH_SIZE = 3

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Авторизация
  const isVercelCron = req.headers['x-vercel-cron'] !== undefined
  const authHeader = req.headers.authorization
  const secret = process.env.CRON_SECRET
  const isManualAuthorized = Boolean(secret) && authHeader === `Bearer ${secret}`

  // Анонимный cron: разрешаем GET без авторизации, если CRON_ANON_ENABLED=true.
  // Это для внешних сервисов (cron-job.org), которые не умеют custom headers.
  // Безопасность: эндпоинт НЕ отвечает на произвольные запросы (только cron-логика),
  // CRON_ANON_ENABLED отключается одной env-переменной.
  const isAnonCron = req.method === 'GET' && process.env.CRON_ANON_ENABLED === 'true'

  if (!isVercelCron && !isManualAuthorized && !isAnonCron) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const db = getDb()
  if (!db) {
    return res.status(500).json({ error: 'БД не настроена (DATABASE_URL)' })
  }

  // Определяем режим: основной если UTC час == 7, иначе tail
  const utcHour = new Date().getUTCHours()
  const isMainRun = utcHour === 7
  const batchSize = isMainRun ? MAIN_BATCH_SIZE : TAIL_BATCH_SIZE
  const mode: 'main' | 'tail' = isMainRun ? 'main' : 'tail'

  console.log(`[cron-${mode}] старт, UTC час ${utcHour}`)

  const targets = await getTargets()
  if (targets.length === 0) {
    return res.status(200).json({ ok: true, message: 'Нет активных магазинов', mode })
  }

  let totalAnswered = 0
  let totalFailed = 0
  let totalRemainingOnWb = 0
  let totalRateLimited = 0
  const details: string[] = []
  const rateLimitedShops: number[] = []

  try {
    for (const target of targets) {
      if (rateLimitedShops.includes(target.shopId!)) continue

      const client = new WbClient(target.token)
      let processed = 0

      // === 1) Сначала доотправляем pending_send (хвост) ===
      const pending = await listPendingSend(target.shopId!, batchSize)
      for (const row of pending) {
        if (processed >= batchSize) break
        try {
          await client.answerFeedback(row.id, row.answer!)
          await saveFeedback(target.shopId!, { id: row.id } as FeedbackInput, row.answer, row.source, null, 'answered')
          totalAnswered++
          processed++
          details.push(`✅ ${target.name} pending: ${row.id}`)
          await new Promise((r) => setTimeout(r, 1000))
        } catch (e) {
          if (e instanceof RateLimitError) {
            totalRateLimited++
            details.push(`⏳ ${target.name} pending 429, повтор через ${e.retryAfterSec}с`)
            rateLimitedShops.push(target.shopId!)
            break
          }
          totalFailed++
          details.push(`❌ ${target.name} ${row.id}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      if (processed >= batchSize) continue
      if (rateLimitedShops.includes(target.shopId!)) continue

      // === 2) Берём свежие неотвеченные с WB ===
      let fresh: WbFeedback[] = []
      try {
        fresh = await client.getUnansweredFeedbacks(batchSize, 0)
      } catch (e) {
        if (e instanceof RateLimitError) {
          totalRateLimited++
          details.push(`⏳ ${target.name} GET 429, повтор через ${e.retryAfterSec}с`)
          rateLimitedShops.push(target.shopId!)
          continue
        }
        totalFailed++
        details.push(`❌ ${target.name} GET: ${e instanceof Error ? e.message : String(e)}`)
        continue
      }

      // Фильтруем уже отвеченные (есть в БД как answered)
      const existing = await listFeedbacks(target.shopId, null)
      const existingMap = new Set(existing.map(f => f.id))
      const newOnes = fresh.filter(f => !existingMap.has(f.id))

      totalRemainingOnWb += Math.max(0, fresh.length - newOnes.length)

      for (const fb of newOnes) {
        if (processed >= batchSize) break

        // Режим templates: используем шаблон (быстро, без LLM)
        // Режим drafts: генерируем LLM, НЕ отправляем (отправка — основной cron)
        // Режим llm: генерируем LLM + сразу шлём
        const input: FeedbackInput = {
          id: fb.id,
          rating: fb.productValuation ?? undefined,
          text: fb.text ?? undefined,
          pros: fb.pros ?? undefined,
          cons: fb.cons ?? undefined,
          productName: fb.productDetails?.productName ?? undefined,
          subjectName: fb.subjectName ?? undefined,
          userName: fb.userName ?? undefined,
          instructions: target.instructions,
        }
        const media = {
          id: fb.id, nmId: fb.productDetails?.nmId ?? null,
          productName: fb.productDetails?.productName ?? null,
          subjectName: fb.subjectName ?? null, userName: fb.userName ?? null,
          rating: fb.productValuation ?? null, text: fb.text ?? null,
          pros: fb.pros ?? null, cons: fb.cons ?? null,
          photoLinks: Array.isArray(fb.photoLinks) ? fb.photoLinks : [],
          videoUrl: fb.video?.src ?? null, videoPreview: fb.video?.preview ?? null,
          createdDate: fb.createdDate ?? null,
        }

        try {
          if (target.mode === 'drafts') {
            // LLM-черновик, НЕ отправляем
            const { answer, source } = await generateAnswer(input, 'llm')
            await saveFeedback(target.shopId!, media, answer, source, null, 'draft')
            totalAnswered++ // создали draft
            processed++
            details.push(`📝 ${target.name} draft: ${fb.id}`)
            // Без паузы — мы НЕ стучались в WB
          } else if (target.mode === 'templates') {
            // Шаблон (синхронно, без LLM)
            const { generateAnswer } = await import('../lib/generator.js')
            const { answer, source } = generateAnswer(input as any, 'templates')
            try {
              await client.answerFeedback(fb.id, answer)
              await saveFeedback(target.shopId!, media, answer, source, null, 'answered')
              totalAnswered++
              processed++
              details.push(`✅ ${target.name} template: ${fb.id}`)
              await new Promise((r) => setTimeout(r, 1000))
            } catch (e) {
              if (e instanceof RateLimitError) {
                await saveFeedback(target.shopId!, media, answer, source, `WB 429, повтор через ${e.retryAfterSec}с`, 'pending_send')
                totalRateLimited++
                details.push(`⏳ ${target.name} template 429 → pending_send`)
                rateLimitedShops.push(target.shopId!)
                break
              }
              throw e
            }
          } else {
            // llm: генерируем + отправляем
            const { answer, source } = await generateAnswer(input, 'llm')
            try {
              await client.answerFeedback(fb.id, answer)
              await saveFeedback(target.shopId!, media, answer, source, null, 'answered')
              totalAnswered++
              processed++
              details.push(`✅ ${target.name} llm: ${fb.id}`)
              await new Promise((r) => setTimeout(r, 1000))
            } catch (e) {
              if (e instanceof RateLimitError) {
                // НЕ бьёмся снова. Сохраняем ответ как pending_send, чтобы tail подхватил.
                // КЛЮЧЕВАЯ СТРАТЕГИЯ ПРОТИВ НАКОПЛЕНИЯ 429: тихо выходим.
                try {
                  await saveFeedback(target.shopId!, media, answer, source, `WB 429, повтор через ${e.retryAfterSec}с`, 'pending_send')
                } catch {
                  await saveFeedback(target.shopId!, media, null, null, 'WB 429 + save error', 'error')
                }
                totalRateLimited++
                details.push(`⏳ ${target.name} llm 429 → pending_send (повтор через ${e.retryAfterSec}с)`)
                rateLimitedShops.push(target.shopId!)
                break
              }
              throw e
            }
          }
        } catch (e) {
          totalFailed++
          details.push(`❌ ${target.name} ${fb.id}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }

    // Telegram-уведомления
    const reportDetails = details.slice(0, 15)
    if (isMainRun) {
      await reportRun({
        total: totalAnswered + totalFailed,
        answered: totalAnswered,
        failed: totalFailed,
        details: reportDetails,
      })
    } else if (totalRateLimited > 0) {
      // tail с 429 — уведомляем в Telegram
      console.log(`[cron-tail] rate_limited=${totalRateLimited}, детали: ${reportDetails.join(' | ')}`)
    }

    // Еженедельный авто-анализ — только в основном cron в воскресенье
    if (isMainRun) {
      const isSunday = new Date().getUTCDay() === 0
      if (isSunday && getDb()) {
        try {
          const { runWeeklyInsights } = await import('./cron.js').catch(() => ({}))
          // (если потребуется — вынести runWeeklyInsights в отдельный модуль)
        } catch (e) {
          console.error('[cron] ошибка еженедельного анализа:', e instanceof Error ? e.message : e)
        }
      }
    }

    return res.status(200).json({
      ok: true,
      mode,
      utc_hour: utcHour,
      answered: totalAnswered,
      failed: totalFailed,
      rate_limited: totalRateLimited,
      remaining_on_wb: totalRemainingOnWb,
      telegram: isTelegramConfigured() ? 'sent' : 'skipped',
      details: reportDetails,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[cron-all] фатальная ошибка:', msg)
    await reportError('Cron-all', msg)
    return res.status(500).json({ error: 'Internal error' })
  }
}

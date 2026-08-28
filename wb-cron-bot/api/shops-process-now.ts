// API: запустить обработку неотвеченных отзывов для ОДНОГО магазина прямо сейчас.
// Аналог /api/cron, но:
//   - только для указанного shop_id
//   - без недельного авто-анализа (только по запросу)
//   - без общего отчёта в Telegram (только детали по этому магазину)
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireAuth } from '../lib/auth.js'
import { getDb, initDb, saveFeedback, listShops, type FeedbackInput } from '../lib/db.js'
import { WbClient, RateLimitError, type WbFeedback } from '../lib/wb-client.js'
import { generateAnswer } from '../lib/generator.js'

type Target = { shopId: number; name: string; token: string; mode: string }

async function loadTarget(shopId: number): Promise<Target | null> {
  const db = getDb()
  if (!db) return null
  await initDb()
  const shops = await listShops()
  const s = shops.find((x) => x.id === shopId)
  if (!s) return null
  return { shopId: s.id, name: s.name, token: s.token, mode: s.mode }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireAuth(req, res)) return
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const { shop_id } = req.body as { shop_id?: number }
  if (!shop_id) return res.status(400).json({ error: 'Нужен shop_id' })

  const target = await loadTarget(shop_id)
  if (!target) return res.status(404).json({ error: 'Магазин не найден' })

  const client = new WbClient(target.token)
  let feedbacks: WbFeedback[]
  try {
    feedbacks = await client.getUnansweredFeedbacks()
  } catch (e) {
    if (e instanceof RateLimitError) {
      return res.status(429).json({
        error: `WB временно ограничил запросы. Попробуйте через ${e.retryAfterSec} сек.`,
        retryAfterSec: e.retryAfterSec,
      })
    }
    return res.status(502).json({ error: e instanceof Error ? e.message : String(e) })
  }

  // Лимит на обработку: используем тот же env, что и в cron
  const maxRaw = Number(process.env.MAX_ANSWERS_PER_RUN)
  const MAX_ANSWERS_PER_RUN = Number.isFinite(maxRaw) && maxRaw > 0 ? Math.floor(maxRaw) : 1
  const toAnswer = feedbacks.slice(0, MAX_ANSWERS_PER_RUN)
  const remainingOnWb = Math.max(0, feedbacks.length - toAnswer.length)

  let answered = 0
  let draft = 0
  let failed = 0
  const details: string[] = []

  for (const fb of toAnswer) {
    const video = fb.video ?? null
    const media = {
      id: fb.id,
      nmId: fb.productDetails?.nmId ?? null,
      productName: fb.productDetails?.productName ?? null,
      subjectName: fb.subjectName ?? null,
      userName: fb.userName ?? null,
      rating: fb.productValuation ?? null,
      text: fb.text ?? null,
      pros: fb.pros ?? null,
      cons: fb.cons ?? null,
      photoLinks: Array.isArray(fb.photoLinks) ? fb.photoLinks : [],
      videoUrl: typeof video?.src === 'string' ? video.src : null,
      videoPreview: typeof video?.preview === 'string' ? video.preview : null,
      createdDate: fb.createdDate ?? null,
    }
    const input: FeedbackInput = {
      rating: fb.productValuation ?? undefined,
      text: fb.text ?? undefined,
      pros: fb.pros ?? undefined,
      cons: fb.cons ?? undefined,
      productName: fb.productDetails?.productName ?? undefined,
      subjectName: fb.subjectName ?? undefined,
      userName: fb.userName ?? undefined,
    }
    try {
      if (target.mode === 'drafts') {
        // Генерируем, НЕ отправляем
        const { answer, source } = await generateAnswer(input, 'llm')
        await saveFeedback(target.shopId, media, answer, source, null, 'draft')
        draft++
        details.push(`📝 черновик для ${fb.id}`)
      } else {
        // templates или llm — генерируем и отправляем
        const { answer, source } = await generateAnswer(input, target.mode)
        try {
          await client.answerFeedback(fb.id, answer)
          await saveFeedback(target.shopId, media, answer, source, null, 'answered')
          answered++
          details.push(`✅ ${source === 'template' ? 'шаблон' : 'LLM'} → ${fb.id}`)
        } catch (e) {
          if (e instanceof RateLimitError) {
            // 429 на ответе — сохраняем черновиком и выходим
            await saveFeedback(target.shopId, media, answer, source, `WB 429: повторите через ${e.retryAfterSec}с`, 'draft')
            details.push(`⏳ WB 429, сохранено как черновик: ${fb.id}`)
            break
          }
          throw e
        }
      }
    } catch (e) {
      failed++
      const msg = e instanceof Error ? e.message : String(e)
      details.push(`❌ ${fb.id}: ${msg.slice(0, 80)}`)
      try {
        await saveFeedback(target.shopId, media, null, null, msg.slice(0, 400), 'error')
      } catch (dbErr) {
        console.error(`[shops-process-now] не удалось сохранить ошибку:`, dbErr instanceof Error ? dbErr.message : dbErr)
      }
    }
    // пауза, если лимит разрешает больше 1
    if (MAX_ANSWERS_PER_RUN > 1) {
      await new Promise((r) => setTimeout(r, 1500))
    }
  }

  return res.status(200).json({
    ok: true,
    shop: { id: target.shopId, name: target.name, mode: target.mode },
    total_on_wb: feedbacks.length,
    answered,
    draft,
    failed,
    remaining_on_wb: remainingOnWb,
    details: details.slice(0, 15),
  })
}

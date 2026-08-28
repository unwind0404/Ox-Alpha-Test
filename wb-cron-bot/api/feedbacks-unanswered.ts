// API: живые неотвеченные отзывы с WB + approve-and-send
// GET  /api/feedbacks-unanswered?shop_id=N&take=20   — список с WB, помечаем уже обработанные
// POST /api/feedbacks-unanswered {shop_id, feedback_ids, action}
//   action: 'approve' (сгенерить LLM + отправить) | 'preview' (только LLM-превью)
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireAuth } from '../lib/auth.js'
import { getDb, initDb, saveFeedback, listFeedbacks } from '../lib/db.js'
import { WbClient, RateLimitError } from '../lib/wb-client.js'
import { generateAnswer, llmAnswer } from '../lib/generator.js'
import type { FeedbackInput } from '../lib/db.js'

/** Берёт у WB список неотвеченных, склеивает с БД (какие уже отвечены/черновики/ошибки). */
async function getUnanswered(req: VercelRequest, res: VercelResponse) {
  const shopId = req.query.shop_id ? Number(req.query.shop_id) : null
  if (!shopId) return res.status(400).json({ error: 'Нужен shop_id' })

  const take = Math.min(Number(req.query.take) || 100, 100) // WB max 5000, берём 100 за раз

  const db = getDb()
  if (!db) return res.status(500).json({ error: 'БД не настроена' })

  const shops = await db`SELECT id, name, token, mode, enabled, instructions FROM shops WHERE id = ${shopId}` as
    { id: number; name: string; token: string; mode: string; enabled: boolean; instructions: string | null }[]
  if (!shops[0]) return res.status(404).json({ error: 'Магазин не найден' })
  if (!shops[0].enabled) return res.status(400).json({ error: 'Магазин выключен' })

  // 1) живой запрос к WB
  let wbList: import('../lib/wb-client.js').WbFeedback[]
  try {
    wbList = await new WbClient(shops[0].token).getUnansweredFeedbacks(take, 0)
  } catch (e) {
    if (e instanceof RateLimitError) {
      return res.status(429).json({
        error: `WB временно ограничил запросы. Попробуйте через ${e.retryAfterSec} сек.`,
        retryAfterSec: e.retryAfterSec,
      })
    }
    return res.status(502).json({
      error: e instanceof Error ? e.message : String(e),
    })
  }

  // 2) смотрим, какие из них уже есть в БД (на случай, если cron уже ответил,
  //    а WB ещё не обновил список)
  const existing = await listFeedbacks(shopId, null)
  const existingMap = new Map(existing.map((f) => [f.id, f]))

  const items = wbList.map((fb) => {
    const ex = existingMap.get(fb.id)
    return {
      id: fb.id,
      rating: fb.productValuation ?? null,
      text: fb.text ?? null,
      pros: fb.pros ?? null,
      cons: fb.cons ?? null,
      user_name: fb.userName ?? null,
      product_name: fb.productDetails?.productName ?? null,
      subject_name: fb.subjectName ?? null,
      nm_id: fb.productDetails?.nmId ?? null,
      photo_links: Array.isArray(fb.photoLinks) ? fb.photoLinks : [],
      video_url: fb.video?.src ?? null,
      video_preview: fb.video?.preview ?? null,
      created_date: fb.createdDate ?? null,
      // помечаем, если уже что-то есть в БД
      in_db: ex
        ? {
            status: ex.status,
            answer: ex.answer,
            processed_at: ex.processed_at,
            error: ex.error,
          }
        : null,
    }
  })

  // Опциональный auto-preview: если ?auto_preview=1, сразу генерируем LLM-превью для всех.
  // НЕ отправляем на WB — только пишем в БД со status='draft' (чтобы видно в UI).
  if (req.query.auto_preview === '1' && shops[0].mode === 'drafts') {
    const limit = Math.min(items.length, 50) // чтобы влезть в 60с Vercel
    const toPreview = items.slice(0, limit).filter(i => !i.in_db)
    for (const item of toPreview) {
      const fb = wbList.find(f => f.id === item.id)
      if (!fb) continue
      try {
        const input = {
          rating: fb.productValuation ?? undefined,
          text: fb.text ?? undefined,
          pros: fb.pros ?? undefined,
          cons: fb.cons ?? undefined,
          productName: fb.productDetails?.productName ?? undefined,
          userName: fb.userName ?? undefined,
          instructions: shops[0].instructions,
        } as Parameters<typeof llmAnswer>[0]
        const answer = await llmAnswer(input)
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
        await saveFeedback(shopId, media, answer, 'llm', null, 'draft')
        const ex = items.find(i => i.id === fb.id)
        if (ex) ex.in_db = { status: 'draft', answer, processed_at: new Date().toISOString(), error: null }
      } catch (e) {
        // Один упал — продолжаем остальные
        console.error(`[auto-preview] ${fb.id}: ${e instanceof Error ? e.message : e}`)
      }
    }
  }

  return res.status(200).json({
    shop: { id: shops[0].id, name: shops[0].name, mode: shops[0].mode, instructions: shops[0].instructions },
    total_on_wb: wbList.length,
    items,
  })
}

async function previewOrApprove(req: VercelRequest, res: VercelResponse) {
  const { shop_id, feedback_ids, action } = req.body as {
    shop_id?: number
    feedback_ids?: string[]
    action?: 'preview' | 'approve'
  }
  if (!shop_id) return res.status(400).json({ error: 'Нужен shop_id' })
  if (!Array.isArray(feedback_ids) || feedback_ids.length === 0) {
    return res.status(400).json({ error: 'Нужен непустой feedback_ids' })
  }
  if (action !== 'preview' && action !== 'approve') {
    return res.status(400).json({ error: 'action: preview или approve' })
  }
  // Клиент дробит выбранные на батчи, чтобы влезть в 60с Vercel free. Жёсткого серверного
  // лимита нет, но >10 — уже рискованно: WB требует ~3с на каждый POST + 1с пауза + LLM.
  if (feedback_ids.length > 10) {
    return res.status(400).json({
      error: 'За один запрос — не больше 10 отзывов. Клиент должен дробить.',
    })
  }

  const db = getDb()
  if (!db) return res.status(500).json({ error: 'БД не настроена' })

  const shops = await db`SELECT id, name, token, mode, enabled, instructions FROM shops WHERE id = ${shop_id}` as
    { id: number; name: string; token: string; mode: string; enabled: boolean; instructions: string | null }[]
  if (!shops[0]) return res.status(404).json({ error: 'Магазин не найден' })
  if (!shops[0].enabled) return res.status(400).json({ error: 'Магазин выключен' })

  const client = new WbClient(shops[0].token)

  const results: Array<{
    id: string
    ok: boolean
    answer?: string
    source?: 'template' | 'llm'
    sent?: boolean
    error?: string
    retryAfterSec?: number
  }> = []

  // Берём каждый отзыв по id: 1 GET к WB + 1 LLM + 1 POST к WB
  // (если approve). В сумме на 3 отзыва = 3 GET + 3 LLM + 3 POST = 9 запросов.
  for (const fid of feedback_ids) {
    try {
      // Ищем отзыв среди неотвеченных через фильтр
      const fb = await findFeedbackById(client, fid)
      if (!fb) {
        results.push({ id: fid, ok: false, error: 'Отзыв не найден среди неотвеченных (возможно, уже отвечен)' })
        continue
      }

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
        videoUrl: fb.video?.src ?? null,
        videoPreview: fb.video?.preview ?? null,
        createdDate: fb.createdDate ?? null,
      }
      const input = {
        rating: fb.productValuation ?? undefined,
        text: fb.text ?? undefined,
        pros: fb.pros ?? undefined,
        cons: fb.cons ?? undefined,
        productName: fb.productDetails?.productName ?? undefined,
        userName: fb.userName ?? undefined,
        instructions: shops[0].instructions,
      }

      if (action === 'preview') {
        // Только LLM-превью, ничего не отправляем и не сохраняем
        const { answer, source } = await generateAnswer(input, 'llm')
        results.push({ id: fid, ok: true, answer, source, sent: false })
        continue
      }

      // approve: генерим + отправляем + сохраняем
      const { answer, source } = await generateAnswer(input, 'llm')

      try {
        await client.answerFeedback(fid, answer)
        await saveFeedback(shop_id, media, answer, source, null, 'answered')
        results.push({ id: fid, ok: true, answer, source, sent: true })
      } catch (e) {
        if (e instanceof RateLimitError) {
          // WB 429: сохраняем как черновик, чтобы пользователь увидел в панели
          await saveFeedback(shop_id, media, answer, source, `WB 429: повторите через ${e.retryAfterSec}с`, 'draft')
          results.push({
            id: fid,
            ok: false,
            answer,
            source,
            sent: false,
            error: `WB 429, сохранено как черновик (повторите через ${e.retryAfterSec}с)`,
            retryAfterSec: e.retryAfterSec,
          })
          // Прерываем весь батч — следующие отзывы тоже упрутся в лимит
          break
        }
        await saveFeedback(shop_id, media, null, null, e instanceof Error ? e.message : String(e), 'error')
        results.push({ id: fid, ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    } catch (e) {
      results.push({ id: fid, ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  return res.status(200).json({ shop_id, action, results })
}

/** Ищет один отзыв среди неотвеченных. Тянет все за один запрос (WB max 5000). */
async function findFeedbackById(
  client: WbClient,
  id: string,
): Promise<import('../lib/wb-client.js').WbFeedback | null> {
  // Один запрос с максимальным take — быстрее, чем пагинация, и помещаемся в 60с.
  const list = await client.getUnansweredFeedbacks(5000, 0)
  return list.find((f) => f.id === id) ?? null
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireAuth(req, res)) return
  await initDb()

  if (req.method === 'GET') return getUnanswered(req, res)
  if (req.method === 'POST') return previewOrApprove(req, res)
  return res.status(405).json({ error: 'GET или POST' })
}

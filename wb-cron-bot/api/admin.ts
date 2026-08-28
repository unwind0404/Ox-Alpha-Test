// Объединённый API: locks (GET/POST) + audit (GET) + insights-history и пр.
// Хак для Vercel Hobby: лимит 12 serverless functions, объединяем мелкие API в один.
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireAuth, getClientIp } from '../lib/auth.js'
import {
  getShopLock, acquireShopLock, releaseShopLock, logAction, listActions, listInsights,
} from '../lib/db.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireAuth(req, res)) return

  const action = req.query.action as string | undefined

  // ----- locks -----
  if (action === 'lock' || action === 'lock-acquire' || action === 'lock-release' || action === 'lock-get') {
    const cookies = req.headers.cookie ?? ''
    const cookieVal = cookies.split(';').map(c => c.trim()).find(c => c.startsWith('wb_session='))
    const userToken = cookieVal ? cookieVal.slice('wb_session='.length).slice(0, 32) : 'unknown'
    const ip = getClientIp(req)

    if (req.method === 'GET' && action === 'lock-get') {
      const shopId = req.query.shop_id ? Number(req.query.shop_id) : null
      if (!shopId) return res.status(400).json({ error: 'Нужен shop_id' })
      const lock = await getShopLock(shopId)
      return res.status(200).json({ lock })
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
    const { shop_id, user_name, subaction } = req.body as { shop_id?: number; user_name?: string; subaction?: string }
    if (!shop_id) return res.status(400).json({ error: 'Нужен shop_id' })
    const safeName = (user_name || 'Аноним').slice(0, 50).replace(/[^\w\sа-яА-ЯёЁ-]/g, '')

    if (subaction === 'acquire' || action === 'lock-acquire') {
      const current = await getShopLock(shop_id)
      if (current && current.user_token !== userToken) {
        return res.status(409).json({
          error: `Магазин сейчас работает: ${current.user_name} (с ${new Date(current.locked_at).toLocaleTimeString('ru-RU')})`,
          lock: current,
        })
      }
      await acquireShopLock(shop_id, userToken, safeName)
      await logAction(userToken, safeName, 'lock.acquire', 'shop', String(shop_id), null, ip)
      return res.status(200).json({ ok: true })
    }
    if (subaction === 'release' || action === 'lock-release') {
      await releaseShopLock(shop_id, userToken)
      await logAction(userToken, safeName, 'lock.release', 'shop', String(shop_id), null, ip)
      return res.status(200).json({ ok: true })
    }
    return res.status(400).json({ error: 'subaction: acquire или release' })
  }

  // ----- audit -----
  if (action === 'audit') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })
    const limit = Math.min(Number(req.query.limit) || 100, 1000)
    const items = await listActions(limit)
    return res.status(200).json({ items })
  }

  return res.status(400).json({ error: 'Unknown action. Use ?action=lock-get|lock-acquire|lock-release|audit' })
}

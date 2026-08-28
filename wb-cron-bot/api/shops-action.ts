// API: изменить/удалить магазин (POST с action: mode | toggle | delete | instructions)
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireAuth } from '../lib/auth.js'
import { updateShopMode, toggleShop, deleteShop, updateShopInstructions } from '../lib/db.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireAuth(req, res)) return
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const { id, action, mode, enabled, instructions } = req.body as {
    id?: number
    action?: string
    mode?: string
    enabled?: boolean
    instructions?: string
  }
  if (!id || !action) return res.status(400).json({ error: 'Нужны id и action' })

  try {
    if (action === 'mode') {
      if (mode !== 'templates' && mode !== 'drafts' && mode !== 'llm') {
        return res.status(400).json({ error: 'mode: templates, drafts или llm' })
      }
      await updateShopMode(id, mode)
    } else if (action === 'toggle') {
      await toggleShop(id, Boolean(enabled))
    } else if (action === 'instructions') {
      if (typeof instructions !== 'string') {
        return res.status(400).json({ error: 'instructions: строка' })
      }
      if (instructions.length > 4000) {
        return res.status(400).json({ error: 'Слишком длинный текст (макс. 4000 символов)' })
      }
      await updateShopInstructions(id, instructions)
    } else if (action === 'delete') {
      await deleteShop(id)
    } else {
      return res.status(400).json({ error: 'Неизвестный action' })
    }
    res.status(200).json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
}

// API: вход/выход/статус авторизации
import type { VercelRequest, VercelResponse } from '@vercel/node'
import {
  checkPassword, createSessionToken, setSessionCookie, clearSessionCookie, isAuthed,
  getClientIp, isIpBlocked, recordFailedLogin, clearFailedLogins,
} from '../lib/auth.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const action = req.query.action

  if (action === 'status') {
    return res.status(200).json({ authed: isAuthed(req), configured: Boolean(process.env.ADMIN_PASSWORD) })
  }

  if (action === 'logout') {
    clearSessionCookie(res)
    return res.status(200).json({ ok: true })
  }

  // login
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  const ip = getClientIp(req)

  // Rate-limit: блокируем IP после 5 неудачных попыток за 15 минут
  const block = isIpBlocked(ip)
  if (block.blocked) {
    res.setHeader('Retry-After', String(block.retryAfterSec))
    return res.status(429).json({
      error: `Слишком много неудачных попыток. Попробуйте через ${block.retryAfterSec} сек.`,
      retryAfterSec: block.retryAfterSec,
    })
  }

  const { password } = req.body as { password?: string }
  if (!checkPassword(password)) {
    // Небольшая задержка + регистрация попытки
    await new Promise((r) => setTimeout(r, 800))
    const status = recordFailedLogin(ip)
    if (status.blocked) {
      res.setHeader('Retry-After', String(status.retryAfterSec))
      return res.status(429).json({
        error: `Слишком много неудачных попыток. Попробуйте через ${status.retryAfterSec} сек.`,
        retryAfterSec: status.retryAfterSec,
      })
    }
    return res.status(401).json({ error: 'Неверный пароль' })
  }
  // Успех: сбрасываем счётчик неудач
  clearFailedLogins(ip)
  setSessionCookie(res, createSessionToken())
  res.status(200).json({ ok: true })
}

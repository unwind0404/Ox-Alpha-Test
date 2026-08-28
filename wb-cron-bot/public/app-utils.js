// Общие утилиты, доступные и app.js, и app-unanswered.js.
// Загружается первым <script type="module">.

// Глобальные селекторы/функции (window.*), чтобы обойти module-scope изоляцию.
window.$ = (sel) => document.querySelector(sel)

window.api = async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || `Ошибка ${res.status}`)
    err.status = res.status
    // Пробрасываем дополнительные поля (retryAfterSec и пр.) из JSON-ответа
    if (data && typeof data === 'object') {
      for (const k of ['retryAfterSec']) {
        if (data[k] !== undefined) err[k] = data[k]
      }
    }
    throw err
  }
  return data
}

window.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]))

window.stars = (n) => '★'.repeat(n || 0) + '☆'.repeat(5 - (n || 0))

window.fmtDate = function fmtDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

window.toast = function toast(msg, type = '') {
  let el = document.getElementById('toast')
  if (!el) {
    el = Object.assign(document.createElement('div'), { id: 'toast' })
    document.body.appendChild(el)
  }
  el.textContent = msg
  el.className = `show ${type}`
  clearTimeout(el._t)
  el._t = setTimeout(() => (el.className = ''), 3500)
}

// Admin UI — vanilla JS, no framework.
// Все user-input данные вставляются через textContent (не innerHTML)
// для защиты от XSS (CSP уже настроен, но defense-in-depth).
// Polling каждые 30 сек, обновляется только активная вкладка.

const $ = (sel) => document.querySelector(sel)
const $$ = (sel) => Array.from(document.querySelectorAll(sel))

const STATUS_LABEL = {
  new: 'Новый',
  preparing_reply: 'Готовим ответ',
  waiting_llm_quota: 'Ожидает LLM',
  awaiting_approval: 'Черновик готов',
  scheduled: 'Запланирован',
  sending: 'Отправляется',
  published_on_wb: 'Опубликован',
  retry_scheduled: 'Повтор',
  checking_delivery: 'Проверка',
  manual_review: 'Нужна проверка',
  rejected: 'Отклонён',
  paused: 'Пауза',
  failed: 'Ошибка',
}

const STATUS_TONE = {
  new: 'info', preparing_reply: 'info', waiting_llm_quota: 'warning',
  awaiting_approval: 'info', scheduled: 'info', sending: 'info',
  published_on_wb: 'success', retry_scheduled: 'warning',
  checking_delivery: 'warning', manual_review: 'warning',
  rejected: 'neutral', paused: 'warning', failed: 'danger',
}

function statusBadge(code) {
  const label = STATUS_LABEL[code] ?? code
  const tone = STATUS_TONE[code] ?? 'neutral'
  return { label, tone }
}

function fmtDate(ms) {
  if (!ms) return ''
  return new Date(ms).toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

function fmtEta(ms) {
  if (!ms) return ''
  const now = Date.now()
  if (ms < now) return 'просрочено'
  const diff = ms - now
  if (diff < 60_000) return 'через <1 мин'
  if (diff < 60 * 60_000) return `через ${Math.round(diff / 60_000)} мин`
  if (diff < 24 * 60 * 60_000) return `через ${Math.round(diff / 60 / 60_000)} ч`
  return fmtDate(ms)
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v
    else if (k === 'data') {
      for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = dv
    } else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v)
    } else if (k === 'text') {
      node.textContent = String(v)
    } else {
      node.setAttribute(k, String(v))
    }
  }
  for (const c of children) {
    if (c == null) continue
    if (typeof c === 'string' || typeof c === 'number') {
      node.appendChild(document.createTextNode(String(c)))
    } else {
      node.appendChild(c)
    }
  }
  return node
}

function stars(n) {
  if (!n) return '☆☆☆☆☆'
  return '★'.repeat(n) + '☆'.repeat(5 - n)
}

async function api(path) {
  const res = await fetch(path, {
    headers: {
      'Cf-Access-Client-Id': window.__CF_ACCESS_CID || '',
      'Cf-Access-Client-Secret': window.__CF_ACCESS_SECRET || '',
    },
  })
  if (res.status === 401) {
    location.reload()
    throw new Error('unauthorized')
  }
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
}

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cf-Access-Client-Id': window.__CF_ACCESS_CID || '',
      'Cf-Access-Client-Secret': window.__CF_ACCESS_SECRET || '',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`${res.status}: ${t.slice(0, 200)}`)
  }
  return res.json()
}

// --- Tabs ---
$$('nav button').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('nav button').forEach((b) => b.classList.remove('active'))
    btn.classList.add('active')
    const tab = btn.dataset.tab
    $$('main > section').forEach((s) => { s.hidden = true; s.classList.remove('active') })
    const sec = $(`#tab-${tab}`)
    if (sec) { sec.hidden = false; sec.classList.add('active') }
    if (tab === 'shops') loadShops()
    else if (tab === 'audit') loadAudit()
    else if (tab === 'queue') loadQueue()
  })
})

// --- Queue tab ---
let currentReviews = []
let currentShops = []

async function loadShops() {
  try {
    currentShops = await api('/api/admin/shops')
    // populate filter
    const sel = $('#filter-shop')
    while (sel.options.length > 1) sel.remove(1)
    for (const s of currentShops) {
      const opt = el('option', { value: s.id, text: s.name })
      sel.appendChild(opt)
    }
  } catch (e) { console.error('loadShops', e) }
}

async function loadQueue() {
  await loadShops()
  const shopFilter = $('#filter-shop').value
  const statusFilter = $('#filter-status').value
  const params = new URLSearchParams()
  if (shopFilter) params.set('shop_id', shopFilter)
  if (statusFilter) params.set('status', statusFilter)
  try {
    const data = await api(`/api/admin/reviews?${params.toString()}`)
    currentReviews = data.reviews
    renderReviews(data.reviews)
    renderMetrics(data.metrics)
  } catch (e) {
    console.error('loadQueue', e)
  }
}

function renderMetrics(m) {
  const row = $('#metrics-row')
  row.innerHTML = ''
  const items = [
    { label: 'Новые', value: m.fetched, tone: 'info' },
    { label: 'Черновики', value: m.drafted, tone: 'info' },
    { label: 'Запланированы', value: m.queued, tone: 'info' },
    { label: 'Опубликованы', value: m.posted, tone: 'ok' },
    { label: 'Manual', value: m.manual, tone: 'warn' },
    { label: 'Rate limit', value: m.rate_limited, tone: 'warn' },
    { label: 'Ошибки', value: m.failed, tone: 'danger' },
    { label: 'Возраст oldest', value: m.oldestAgeMs ? `${Math.round(m.oldestAgeMs / 60_000)} мин` : '—' },
    { label: 'Следующий слот', value: m.nextSlotMs ? fmtEta(m.nextSlotMs) : '—' },
  ]
  for (const it of items) {
    row.appendChild(el('div', { class: `metric ${it.tone}` },
      el('div', { class: 'label', text: it.label }),
      el('div', { class: 'value', text: String(it.value) }),
    ))
  }
}

function renderReviews(reviews) {
  const list = $('#review-list')
  list.innerHTML = ''
  if (reviews.length === 0) {
    list.appendChild(el('div', { class: 'empty' },
      el('span', { class: 'icon', text: '📭' }),
      el('div', { text: 'Нет отзывов в выбранной категории.' }),
    ))
    return
  }
  for (const r of reviews) {
    list.appendChild(renderReviewCard(r))
  }
}

function renderReviewCard(r) {
  const badge = statusBadge(r.status)
  const card = el('div', { class: 'card' },
    el('div', { class: 'review-head' },
      el('span', { class: 'stars', text: stars(r.rating) }),
      el('span', { class: 'user', text: r.userName || 'Аноним' }),
      el('span', { class: 'shop', text: r.shopName }),
      el('span', { class: `badge ${badge.tone}`, text: badge.label }),
      el('span', { class: 'badge', text: fmtDate(r.receivedAtMs) }),
    ),
    el('div', { class: 'review-product', text: r.productName || '—' }),
  )
  if (r.text) {
    card.appendChild(el('div', { class: 'review-text', text: r.text }))
  }
  if (r.postedReplyText && r.status === 'published_on_wb') {
    card.appendChild(el('div', { class: 'review-text', text: `✅ ${r.postedReplyText}` }))
  }
  if (r.scheduledSendAtMs && r.status === 'scheduled') {
    card.appendChild(el('div', { class: 'review-text', text: `📅 Плановая отправка: ${fmtEta(r.scheduledSendAtMs)} (позиция ${r.queuePosition})` }))
  }
  // Actions
  const actions = el('div', { class: 'review-actions' })
  if (r.status === 'awaiting_approval') {
    const approveBtn = el('button', { class: 'primary', text: 'Одобрить и отправить' })
    approveBtn.addEventListener('click', () => approveReview(r))
    actions.appendChild(approveBtn)
  }
  if (['scheduled', 'sending', 'sending_failed', 'failed', 'rejected'].includes(r.status)) {
    const retryBtn = el('button', { text: 'Перегенерировать' })
    retryBtn.addEventListener('click', () => regenerateReview(r))
    actions.appendChild(retryBtn)
  }
  if (actions.children.length > 0) card.appendChild(actions)
  return card
}

async function approveReview(r) {
  try {
    await post(`/api/admin/reviews/${r.id}/approve`, { text: r.postedReplyText || '' })
    toast('Одобрено', 'ok')
    await loadQueue()
  } catch (e) { toast(String(e), 'error') }
}

async function regenerateReview(r) {
  try {
    await post(`/api/admin/reviews/${r.id}/regenerate`, {})
    toast('Готовим новый вариант', 'ok')
    await loadQueue()
  } catch (e) { toast(String(e), 'error') }
}

// --- Shops tab ---
async function loadShopsTab() {
  try {
    const data = await api('/api/admin/shops')
    renderShops(data.shops)
  } catch (e) { console.error(e) }
}

function renderShops(shops) {
  const list = $('#shop-list')
  list.innerHTML = ''
  if (shops.length === 0) {
    list.appendChild(el('div', { class: 'empty' },
      el('span', { class: 'icon', text: '🏪' }),
      el('div', { text: 'Нет магазинов. Добавьте через Worker.' }),
    ))
    return
  }
  for (const s of shops) {
    const card = el('div', { class: 'card shop-card' },
      el('div', {},
        el('strong', { text: s.name }),
        el('div', { class: 'review-product', text: `Token: ${s.tokenProfile} | Mode: ${s.mode}` }),
        el('div', { class: 'review-product', text: `Last sync: ${s.lastSyncDayUtc || '—'}` }),
      ),
      el('div', { class: `shop-status ${s.enabled ? 'on' : 'off'}`, text: s.enabled ? 'Включён' : 'Выключен' }),
    )
    list.appendChild(card)
  }
}

// --- Audit tab ---
async function loadAudit() {
  try {
    const data = await api('/api/admin/audit?limit=200')
    renderAudit(data.events)
  } catch (e) { console.error(e) }
}

function renderAudit(events) {
  const list = $('#audit-list')
  list.innerHTML = ''
  for (const a of events) {
    list.appendChild(el('div', { class: 'audit-entry' },
      el('div', {},
        el('strong', { text: a.action }),
        a.reasonCode ? el('span', { class: 'badge', text: a.reasonCode }) : null,
      ),
      el('div', { class: 'ts', text: fmtDate(a.createdAtMs) }),
      a.detail ? el('div', { text: a.detail }) : null,
    ))
  }
}

// --- Toast ---
function toast(msg, type = '') {
  let el2 = document.getElementById('toast')
  if (!el2) {
    el2 = document.createElement('div')
    el2.id = 'toast'
    document.body.appendChild(el2)
  }
  el2.textContent = msg
  el2.className = `show ${type}`
  clearTimeout(el2._t)
  el2._t = setTimeout(() => { el2.className = '' }, 3500)
}

// --- Init ---
$('#connection-status').textContent = 'Готов'
$('#connection-status').classList.add('ok')
$('#refresh-btn').addEventListener('click', () => {
  const active = $$('nav button').find((b) => b.classList.contains('active'))
  if (active?.dataset.tab === 'shops') loadShopsTab()
  else if (active?.dataset.tab === 'audit') loadAudit()
  else loadQueue()
})
$$('#filter-shop, #filter-status').forEach((s) => s.addEventListener('change', loadQueue))

loadQueue()
setInterval(() => {
  const active = $$('nav button').find((b) => b.classList.contains('active'))
  if (active?.dataset.tab === 'shops') loadShopsTab()
  else if (active?.dataset.tab === 'audit') loadAudit()
  else loadQueue()
}, 30_000)

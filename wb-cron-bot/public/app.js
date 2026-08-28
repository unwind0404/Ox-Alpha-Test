// Утилиты $, api, esc, stars, fmtDate, toast живут в app-utils.js (window.*).
// Здесь — алиасы для удобства и обратной совместимости с уже написанным кодом.
const $ = window.$
const api = window.api
const esc = window.esc
const stars = window.stars
const fmtDate = window.fmtDate
const toast = window.toast

let me = { authed: false, configured: false }
let shopsCache = []
// Экспорт для app-unanswered.js (module-scope не виден между <script type="module">)
if (typeof window !== 'undefined') window.__shopsCache = () => shopsCache

// ---------- auth ----------

async function checkAuth() {
  me = await api('/api/auth?action=status')
  if (me.authed) showApp()
  else {
    $('#auth-screen').hidden = false
    if (!me.configured) {
      $('#auth-error').textContent = 'ADMIN_PASSWORD не задан в настройках Vercel'
    }
  }
}

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  try {
    // Сохраняем имя пользователя ДО логина (для audit log)
    const nameEl = $('#auth-name')
    if (nameEl && nameEl.value.trim()) window.setUserName(nameEl.value)
    await api('/api/auth', { method: 'POST', body: { password: $('#auth-password').value } })
    $('#auth-screen').hidden = true
    showApp()
  } catch (err) {
    $('#auth-error').textContent = err.message
  }
})

$('#logout-btn').addEventListener('click', () =>
  api('/api/auth?action=logout', { method: 'POST' }).then(() => location.reload()),
)

function showApp() {
  $('#auth-screen').hidden = true
  $('#app-screen').hidden = false
  loadShops()
  loadFeedbacks()
  loadDrafts()
}

// ---------- tabs ----------

document.querySelectorAll('nav button[data-tab]').forEach((btn) =>
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav button[data-tab]').forEach((b) => b.classList.remove('active'))
    btn.classList.add('active')
    document.querySelectorAll('main section').forEach((s) => (s.hidden = true))
    $(`#tab-${btn.dataset.tab}`).hidden = false
  }),
)

// ---------- shops ----------

async function loadShops() {
  try {
    shopsCache = await api('/api/shops')
    renderShops()
    renderShopFilter()
    // Хук для app-unanswered.js — обновить селект магазинов в новой вкладке
    if (typeof window.__onUnansweredShopsLoaded === 'function') {
      window.__onUnansweredShopsLoaded()
    }
  } catch (err) {
    if (err.status === 401) location.reload()
  }
}

function renderShops() {
  const el = $('#shops-list')
  el.innerHTML = ''
  if (shopsCache.length === 0) {
    el.innerHTML = `<div class="empty"><span class="icon">🏪</span>Магазинов пока нет.<br>Добавьте первый выше — понадобится WB API токен.</div>`
    return
  }
  const modeNames = { templates: 'Шаблоны', drafts: 'Черновики LLM', llm: 'LLM-авто' }
  const modeHints = {
    templates: 'Авто-режим: cron отвечает шаблонами по звёздам. Без вашего участия.',
    drafts: 'Полуавто: cron генерирует LLM-ответ и кладёт в черновики. Одобряете во вкладке «Черновики» или «Неотвеченные».',
    llm: 'Авто-режим: cron раз в день генерирует LLM-ответ и сразу отправляет на WB. Без вашего участия.',
  }
  for (const s of shopsCache) {
    const card = document.createElement('div')
    card.className = 'card shop-card'
    card.innerHTML = `
      <div class="shop-info">
        <strong>${esc(s.name)}</strong>
        <span class="badge">${modeNames[s.mode] || s.mode}</span>
        ${s.enabled ? '' : '<span class="badge off">выключен</span>'}
        <div class="meta">токен: ${esc(s.tokenMask)}</div>
        <div class="hint" style="margin-top:6px">${esc(modeHints[s.mode] || '')}</div>
      </div>
      <div class="shop-actions">
        <select class="mode-select" data-id="${s.id}">
          <option value="templates" ${s.mode === 'templates' ? 'selected' : ''}>Шаблоны</option>
          <option value="drafts" ${s.mode === 'drafts' ? 'selected' : ''}>Черновики LLM</option>
          <option value="llm" ${s.mode === 'llm' ? 'selected' : ''}>LLM-авто</option>
        </select>
        <button class="ghost process-now" data-id="${s.id}" ${s.enabled ? '' : 'disabled'}>Обработать сейчас</button>
        <button class="ghost toggle" data-id="${s.id}">${s.enabled ? 'Выключить' : 'Включить'}</button>
        <button class="danger del" data-id="${s.id}" data-name="${esc(s.name)}">Удалить</button>
      </div>
      <div class="shop-instructions" style="margin-top:14px; padding-top:14px; border-top:1px solid var(--border)">
        <label class="hint" style="display:block; margin-bottom:6px">
          <strong>Правила для LLM</strong> — что бот может/не должен использовать в ответе.
          Например: <em>«Не упоминай название товара»</em>, <em>«Добавляй промокод WB-2026 в конце»</em>.
        </label>
        <textarea class="instructions" data-id="${s.id}" rows="4" placeholder="Оставьте пустым, если правил нет"
          style="width:100%; padding:10px 14px; border-radius:10px; border:1px solid var(--border); background:var(--bg); color:var(--text); font:inherit; font-size:0.88rem; outline:none; resize:vertical;">${esc(s.instructions || '')}</textarea>
        <div style="margin-top:8px; display:flex; gap:8px; align-items:center">
          <button class="primary save-instructions" data-id="${s.id}">Сохранить правила</button>
          <span class="hint" data-role="instructions-status-${s.id}"></span>
        </div>
      </div>`
    card.querySelector('.mode-select').addEventListener('change', async (e) => {
      try {
        await api('/api/shops-action', { method: 'POST', body: { id: s.id, action: 'mode', mode: e.target.value } })
        toast('Режим обновлён', 'ok')
        loadShops()
      } catch (err) { toast(err.message, 'error') }
    })
    card.querySelector('.process-now').addEventListener('click', async (e) => {
      const btn = e.target
      const shopId = Number(btn.dataset.id)
      btn.disabled = true
      btn.textContent = 'Обрабатываю…'
      try {
        const r = await api('/api/shops-process-now', { method: 'POST', body: { shop_id: shopId } })
        let msg = `«${r.shop.name}»: отвечено ${r.answered}, черновиков ${r.draft}, ошибок ${r.failed}`
        if (r.remaining_on_wb > 0) msg += `. В очереди WB ещё ${r.remaining_on_wb}`
        toast(msg, r.failed > 0 ? 'error' : 'ok')
        loadFeedbacks()
        loadDrafts()
      } catch (err) {
        if (err.status === 429) {
          toast(`WB ограничил запросы. Попробуйте через ${err.retryAfterSec || 900} сек.`, 'error')
        } else {
          toast(err.message, 'error')
        }
      } finally {
        btn.disabled = false
        btn.textContent = 'Обработать сейчас'
      }
    })
    card.querySelector('.toggle').addEventListener('click', async () => {
      try {
        await api('/api/shops-action', { method: 'POST', body: { id: s.id, action: 'toggle', enabled: !s.enabled } })
        loadShops()
      } catch (err) { toast(err.message, 'error') }
    })
    card.querySelector('.del').addEventListener('click', async (e) => {
      if (!confirm(`Удалить магазин «${e.target.dataset.name}»? История его отзывов тоже удалится.`)) return
      try {
        await api('/api/shops-action', { method: 'POST', body: { id: s.id, action: 'delete' } })
        toast('Магазин удалён', 'ok')
        loadShops()
        loadFeedbacks()
      } catch (err) { toast(err.message, 'error') }
    })
    card.querySelector('.save-instructions').addEventListener('click', async (e) => {
      const btn = e.target
      const shopId = Number(btn.dataset.id)
      const text = card.querySelector('.instructions').value
      btn.disabled = true
      btn.textContent = 'Сохраняю…'
      try {
        await api('/api/shops-action', { method: 'POST', body: { id: shopId, action: 'instructions', instructions: text } })
        toast('Правила сохранены', 'ok')
      } catch (err) { toast(err.message, 'error') }
      finally {
        btn.disabled = false
        btn.textContent = 'Сохранить правила'
      }
    })
    el.appendChild(card)
  }
}

function renderShopFilter() {
  const sel = $('#filter-shop')
  const current = sel.value
  sel.innerHTML = '<option value="">Все магазины</option>' +
    shopsCache.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')
  sel.value = current

  // селектор аналитики — только активные магазины
  const insSel = $('#insights-shop')
  const insCurrent = insSel.value
  insSel.innerHTML = '<option value="">Выберите магазин</option>' +
    shopsCache.filter((s) => s.enabled).map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')
  insSel.value = insCurrent
  $('#analyze-btn').disabled = !insSel.value

  // селектор черновиков
  const drSel = $('#drafts-shop')
  const drCurrent = drSel.value
  drSel.innerHTML = '<option value="">Все магазины</option>' +
    shopsCache.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')
  drSel.value = drCurrent
}

$('#shop-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const msg = $('#shop-msg')
  msg.textContent = 'Проверяю токен…'
  msg.className = 'hint'
  try {
    await api('/api/shops-add', {
      method: 'POST',
      body: {
        name: $('#shop-name').value.trim(),
        token: $('#shop-token').value.trim(),
        mode: $('#shop-mode').value,
      },
    })
    e.target.reset()
    msg.textContent = 'Магазин добавлен ✓'
    msg.className = 'hint ok'
    loadShops()
  } catch (err) {
    msg.textContent = err.message
    msg.className = 'hint error'
  }
})

// ---------- Черновики ----------

async function loadDrafts() {
  const shopId = $('#drafts-shop').value
  const params = shopId ? `?shop_id=${shopId}` : ''
  try {
    const drafts = await api(`/api/drafts${params}`)
    $('#drafts-count').textContent = `На одобрение: ${drafts.length}`
    renderDrafts(drafts)
  } catch (err) {
    if (err.status === 401) location.reload()
  }
}

function renderDrafts(drafts) {
  const el = $('#drafts-list')
  el.innerHTML = ''
  if (drafts.length === 0) {
    // Подсказка: если ни один магазин не в режиме drafts — объясняем почему пусто.
    const draftsShops = shopsCache.filter((s) => s.mode === 'drafts' && s.enabled)
    let hint = ''
    if (shopsCache.length > 0 && draftsShops.length === 0) {
      hint = `<br><br><span class="hint">Сейчас ни один магазин не работает в режиме «Черновики LLM».<br>Переключите режим магазина во вкладке «Магазины», чтобы черновики появлялись.</span>`
    }
    el.innerHTML = `<div class="empty"><span class="icon">📝</span>Черновиков нет.${hint}</div>`
    return
  }
  for (const fb of drafts) {
    const card = document.createElement('div')
    card.className = 'card'
    card.innerHTML = `
      <div class="fb-head">
        <span class="stars">${stars(fb.rating)}</span>
        <span class="fb-user">${esc(fb.user_name || 'Покупатель')}</span>
        <span class="fb-shop">${esc(fb.shop_name || '')}</span>
        <span class="fb-date">${fmtDate(fb.processed_at)}</span>
      </div>
      <div class="fb-product">${esc(fb.product_name || 'Товар')}</div>
      <div class="fb-text">${esc(fb.text || '(отзыв без текста)')}</div>
      <textarea class="draft-answer">${esc(fb.answer || '')}</textarea>
      <div class="draft-actions">
        <button class="primary approve">Одобрить и отправить</button>
        <button class="ghost regen">Перегенерировать</button>
        <button class="danger reject">Отклонить</button>
      </div>`
    card.querySelector('.approve').addEventListener('click', async () => {
      try {
        await api('/api/drafts', {
          method: 'POST',
          body: {
            shop_id: fb.shop_id,
            feedback_id: fb.id,
            action: 'approve',
            answer: card.querySelector('.draft-answer').value,
          },
        })
        toast('Ответ отправлен на WB', 'ok')
        loadDrafts()
      } catch (err) { toast(err.message, 'error') }
    })
    card.querySelector('.regen').addEventListener('click', async () => {
      try {
        const r = await api('/api/drafts', {
          method: 'POST',
          body: { shop_id: fb.shop_id, feedback_id: fb.id, action: 'regenerate' },
        })
        card.querySelector('.draft-answer').value = r.answer
        toast('Новый вариант готов', 'ok')
      } catch (err) { toast(err.message, 'error') }
    })
    card.querySelector('.reject').addEventListener('click', async () => {
      try {
        await api('/api/drafts', {
          method: 'POST',
          body: { shop_id: fb.shop_id, feedback_id: fb.id, action: 'reject' },
        })
        toast('Черновик отклонён')
        loadDrafts()
      } catch (err) { toast(err.message, 'error') }
    })
    el.appendChild(card)
  }
}

$('#drafts-shop').addEventListener('change', loadDrafts)

// ---------- feedbacks ----------

async function loadFeedbacks() {
  const shopId = $('#filter-shop').value
  const status = $('#filter-status').value
  const params = new URLSearchParams()
  if (shopId) params.set('shop_id', shopId)
  if (status) params.set('status', status)
  try {
    const list = await api(`/api/feedbacks?${params}`)
    renderFeedbacks(list)
  } catch (err) {
    if (err.status === 401) location.reload()
  }
}

function renderFeedbacks(list) {
  const el = $('#feedbacks-list')
  el.innerHTML = ''
  if (list.length === 0) {
    el.innerHTML = `<div class="empty"><span class="icon">💬</span>Пока нет обработанных отзывов.<br>Они появятся после первого запуска бота (кнопка «Запустить сейчас» или ежедневно в 10:00 МСК).</div>`
    return
  }
  for (const fb of list) {
    const card = document.createElement('div')
    card.className = 'card fb-card'

    // Медиа: фото и видео покупателя
    const photos = Array.isArray(fb.photo_links) ? fb.photo_links : []
    const mediaHtml = (photos.length || fb.video_preview || fb.video_url)
      ? `<div class="fb-media">${
          photos.map((src) =>
            `<a href="${esc(src)}" target="_blank" rel="noopener"><img src="${esc(src)}" loading="lazy" alt="фото отзыва" /></a>`
          ).join('')
        }${
          fb.video_url
            ? fb.video_preview
              ? `<a href="${esc(fb.video_url)}" target="_blank" rel="noopener" class="video-thumb"><img src="${esc(fb.video_preview)}" loading="lazy" alt="видео отзыва" /><span class="play">▶</span></a>`
              : `<a href="${esc(fb.video_url)}" target="_blank" rel="noopener" class="video-link">🎬 Видео</a>`
            : ''
        }</div>`
      : ''

    // Характеристики товара
    const specs = [
      fb.nm_id ? `Артикул: <b>${fb.nm_id}</b>` : '',
      fb.subject_name ? `Категория: ${esc(fb.subject_name)}` : '',
    ].filter(Boolean)
    const specsHtml = specs.length
      ? `<div class="fb-specs">${specs.map((s) => `<span>${s}</span>`).join('')}</div>`
      : ''

    // Плюсы/минусы
    const prosCons = [
      fb.pros ? `<span class="pc pros">+ ${esc(fb.pros)}</span>` : '',
      fb.cons ? `<span class="pc cons">− ${esc(fb.cons)}</span>` : '',
    ].filter(Boolean).join('')

    const answerHtml = fb.answer
      ? `<div class="fb-answer"><span class="label">Ответ бота (${fb.source === 'template' ? 'шаблон' : 'LLM'})</span>${esc(fb.answer)}</div>`
      : ''
    const errorHtml = fb.error
      ? `<div class="fb-error">⚠️ ${esc(fb.error)}</div>`
      : ''

    card.innerHTML = `
      <div class="fb-head">
        <span class="stars">${stars(fb.rating)}</span>
        <span class="fb-user">${esc(fb.user_name || 'Покупатель')}</span>
        <span class="fb-shop">${esc(fb.shop_name || '')}</span>
        <span class="fb-date">${fmtDate(fb.processed_at)}</span>
      </div>
      <div class="fb-product">${esc(fb.product_name || 'Товар')}</div>
      ${specsHtml}
      ${prosCons ? `<div class="fb-pc">${prosCons}</div>` : ''}
      <div class="fb-text">${esc(fb.text || '(отзыв без текста)')}</div>
      ${mediaHtml}
      ${answerHtml}
      ${errorHtml}
    `
    el.appendChild(card)
  }
}

$('#filter-shop').addEventListener('change', loadFeedbacks)
$('#filter-status').addEventListener('change', loadFeedbacks)
$('#refresh-btn').addEventListener('click', () => { loadShops(); loadFeedbacks() })

$('#run-now-btn').addEventListener('click', async (e) => {
  const btn = e.target
  btn.disabled = true
  btn.textContent = 'Запускаю…'
  try {
    const r = await api('/api/cron-run', { method: 'POST' })
    let msg = `Готово: отвечено ${r.answered}, ошибок ${r.failed}`
    if (typeof r.remaining_on_wb === 'number' && r.remaining_on_wb > 0) {
      msg += `. В очереди WB ещё ${r.remaining_on_wb} — обработаются в следующем запуске`
    }
    toast(msg, r.failed ? 'error' : 'ok')
    loadFeedbacks()
  } catch (err) {
    toast(err.message, 'error')
  } finally {
    btn.disabled = false
    btn.textContent = 'Запустить сейчас'
  }
})

// ---------- Аналитика (insights) ----------

function renderInsightCard(insight) {
  const card = document.createElement('div')
  card.className = 'card insight-card'

  const periodNames = { month: 'Месяц', quarter: '3 месяца' }
  const sentimentIcons = { negative: '🔴', positive: '🟢', neutral: '⚪' }

  const themesHtml = (insight.themes || [])
    .map((t) => {
      const rec = t.recommendation
        ? `<div class="theme-rec">💡 ${esc(t.recommendation)}</div>`
        : ''
      const quotes = (t.quotes || []).length
        ? `<div class="theme-quotes">${t.quotes.map((q) => `«${esc(q)}»`).join('<br>')}</div>`
        : ''
      return `
        <div class="theme theme-${t.sentiment}">
          <div class="theme-head">
            <span>${sentimentIcons[t.sentiment] || '⚪'}</span>
            <strong>${esc(t.title)}</strong>
            <span class="theme-count">${t.count} отз.</span>
          </div>
          <div class="theme-summary">${esc(t.summary)}</div>
          ${quotes}
          ${rec}
        </div>`
    })
    .join('')

  card.innerHTML = `
    <div class="fb-head">
      <strong>Анализ: ${esc(insight.shop_name || '')}</strong>
      <span class="badge">${periodNames[insight.period] || insight.period}</span>
      <span class="fb-date">${fmtDate(insight.created_at)} · отзывов: ${insight.feedbacks_count}</span>
    </div>
    <div class="insight-overview">${esc(insight.overview)}</div>
    ${themesHtml || '<p class="hint">Тем не найдено.</p>'}
  `
  return card
}

async function loadInsights() {
  const shopId = $('#insights-shop').value
  const list = $('#insights-list')
  if (!shopId) {
    list.innerHTML = `<div class="empty"><span class="icon">📊</span>Выберите магазин для анализа.</div>`
    return
  }
  try {
    const insights = await api(`/api/insights?shop_id=${shopId}`)
    list.innerHTML = ''
    if (insights.length === 0) {
      list.innerHTML = `<div class="empty"><span class="icon">📊</span>Анализов пока нет.<br>Нажмите «Анализировать» — LLM сгруппирует отзывы по темам.</div>`
      return
    }
    insights.forEach((i) => list.appendChild(renderInsightCard(i)))
  } catch (err) {
    toast(err.message, 'error')
  }
}

// ---------- Журнал действий (audit) ----------

async function loadAudit() {
  const list = $('#audit-list')
  try {
    const data = await api('/api/audit?limit=200')
    if (data.items.length === 0) {
      list.innerHTML = `<div class="empty"><span class="icon">📝</span>Журнал пуст. Действия появятся здесь после первого approve/reject.</div>`
      return
    }
    const actionNames = {
      'draft.approve': '✅ Одобрил ответ',
      'draft.approve.429': '⏳ Rate limit WB',
      'draft.reject': '🗑️ Отклонил черновик',
      'draft.regenerate': '🔄 Перегенерировал',
      'lock.acquire': '🔒 Взял магазин',
      'lock.release': '🔓 Отпустил магазин',
    }
    list.innerHTML = data.items.map(a => {
      const label = actionNames[a.action] || a.action
      const target = a.target_id ? ` (${a.target_type || ''}: ${a.target_id.slice(0, 16)}…)` : ''
      return `<div class="card" style="padding:10px 14px">
        <div><strong>${esc(label)}</strong>${target}</div>
        <div class="hint" style="margin-top:4px">${fmtDate(a.created_at)} · IP: ${esc(a.ip || '-')}</div>
      </div>`
    }).join('')
  } catch (err) {
    toast(err.message, 'error')
  }
}

$('#audit-refresh').addEventListener('click', loadAudit)

// Дёргаем loadAudit при заходе на вкладку
document.querySelectorAll('nav button[data-tab]').forEach((btn) =>
  btn.addEventListener('click', () => {
    if (btn.dataset.tab === 'audit') loadAudit()
  }),
)

$('#insights-shop').addEventListener('change', loadInsights)

$('#analyze-btn').addEventListener('click', async (e) => {
  const shopId = $('#insights-shop').value
  if (!shopId) return toast('Сначала выберите магазин', 'error')
  const btn = e.target
  btn.disabled = true
  btn.textContent = 'Анализирую… (до минуты)'
  try {
    const r = await api('/api/insights', {
      method: 'POST',
      body: { shop_id: Number(shopId), period: $('#insights-period').value },
    })
    if (r.empty) {
      toast(r.message, 'error')
    } else {
      toast(`Анализ готов: тем найдено ${r.themes?.length ?? 0}`, 'ok')
      loadInsights()
    }
  } catch (err) {
    toast(err.message, 'error')
  } finally {
    btn.disabled = false
    btn.textContent = 'Анализировать'
  }
})

// ---------- init ----------

checkAuth()

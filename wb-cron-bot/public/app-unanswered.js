// Логика вкладки «Неотвеченные» — живой WB + превью/approve.
// Утилиты $, api, esc, stars, fmtDate, toast берём с window.* (app-utils.js).
// shopsCache из app.js доступен через window.__shopsCache().

const $ = window.$
const api = window.api
const esc = window.esc
const stars = window.stars
const fmtDate = window.fmtDate
const toast = window.toast

let unansweredState = { items: [], shopId: null, shopName: '' }

function renderUnansweredShopSelect() {
  const sel = $('#unanswered-shop')
  const current = sel.value
  // shopsCache из app.js доступен через window.__shopsCache()
  const cache = window.__shopsCache ? window.__shopsCache() : []
  sel.innerHTML = '<option value="">Выберите магазин</option>' +
    cache.filter((s) => s.enabled).map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')
  sel.value = current
  $('#unanswered-load').disabled = !sel.value
}

async function loadUnanswered() {
  const shopId = $('#unanswered-shop').value
  if (!shopId) return
  const btn = $('#unanswered-load')
  const status = $('#unanswered-status')
  btn.disabled = true
  btn.textContent = 'Загружаю с WB…'
  status.textContent = ''

  // Пытаемся взять лок. Если занят другим — покажем и не будем загружать.
  try {
    const lockRes = await api('/api/locks', {
      method: 'POST',
      body: { shop_id: Number(shopId), action: 'acquire', user_name: window.getUserName() },
    }).catch(e => e) // 409 = занят
    if (lockRes.status === 409) {
      status.textContent = `⚠️ Магазин сейчас работает: ${lockRes.lock?.user_name || 'другой пользователь'}. Попробуйте позже.`
      btn.disabled = false
      btn.textContent = 'Обновить с WB'
      return
    }
  } catch (e) { /* не блокируем на ошибке лока */ }

  try {
    // Берём 100 (max), с auto_preview=1 — бэкенд сразу генерит LLM-черновики для всех,
    // кто ещё не в БД. Это работает только в режиме 'drafts'.
    const data = await api(`/api/feedbacks-unanswered?shop_id=${shopId}&take=100&auto_preview=1`)
    unansweredState = {
      items: data.items,
      shopId: Number(shopId),
      shopName: data.shop.name,
    }
    const drafted = data.items.filter(i => i.in_db && i.in_db.status === 'draft').length
    const newOnes = data.items.filter(i => !i.in_db).length
    let msg = `Загружено: ${data.total_on_wb} с WB`
    if (newOnes > 0) msg += `, ${newOnes} новых (превью генерится в фоне)`
    if (drafted > 0) msg += `, ${drafted} уже с превью`
    status.textContent = msg
    renderUnansweredList()
  } catch (err) {
    status.textContent = err.message
    if (err.status === 401) location.reload()
  } finally {
    btn.disabled = false
    btn.textContent = 'Обновить с WB'
  }
}

// При уходе со страницы — отпустить лок
window.addEventListener('beforeunload', () => {
  if (unansweredState.shopId) {
    const sid = unansweredState.shopId
    navigator.sendBeacon?.('/api/locks', JSON.stringify({ shop_id: sid, action: 'release', user_name: window.getUserName() }))
  }
})

function renderUnansweredList() {
  const el = $('#unanswered-list')
  el.innerHTML = ''
  if (unansweredState.items.length === 0) {
    el.innerHTML = `<div class="empty"><span class="icon">✅</span>Неотвеченных отзывов нет.<br>Можно выпить чаю.</div>`
    return
  }

  // Кнопки «массовых действий» вверху
  const toolbar = document.createElement('div')
  toolbar.className = 'toolbar'
  toolbar.innerHTML = `
    <button id="unanswered-select-all" class="ghost">Выбрать все</button>
    <button id="unanswered-preview-selected" class="ghost">Сгенерировать превью (выбранные)</button>
    <button id="unanswered-approve-selected" class="primary">Одобрить и отправить (выбранные)</button>
    <span class="hint" id="unanswered-selected-count">Выбрано: 0</span>
  `
  el.appendChild(toolbar)

  for (const item of unansweredState.items) {
    const card = document.createElement('div')
    card.className = 'card unanswered-card'
    card.dataset.id = item.id

    const photos = Array.isArray(item.photo_links) ? item.photo_links : []
    const mediaHtml = (photos.length || item.video_preview || item.video_url)
      ? `<div class="fb-media">${
          photos.map((src) =>
            `<a href="${esc(src)}" target="_blank" rel="noopener"><img src="${esc(src)}" loading="lazy" alt="фото" /></a>`
          ).join('')
        }${
          item.video_url
            ? item.video_preview
              ? `<a href="${esc(item.video_url)}" target="_blank" rel="noopener" class="video-thumb"><img src="${esc(item.video_preview)}" loading="lazy" alt="видео" /><span class="play">▶</span></a>`
              : `<a href="${esc(item.video_url)}" target="_blank" rel="noopener" class="video-link">🎬 Видео</a>`
            : ''
        }</div>`
      : ''

    const inDbBadge = item.in_db
      ? `<span class="unanswered-in-db ${item.in_db.status}">${item.in_db.status === 'answered' ? 'уже отвечен' : item.in_db.status === 'draft' ? 'есть черновик' : item.in_db.status === 'error' ? 'ошибка' : item.in_db.status}</span>`
      : '<span class="unanswered-in-db" style="background:rgba(154,160,176,0.12);color:var(--muted)">новый</span>'

    const answered = item.in_db && item.in_db.status === 'answered'
    card.innerHTML = `
      <div class="fb-head">
        <span class="stars">${stars(item.rating)}</span>
        <span class="fb-user">${esc(item.user_name || 'Покупатель')}</span>
        ${inDbBadge}
        <span class="fb-date">${fmtDate(item.created_date) || ''}</span>
      </div>
      <div class="fb-product">${esc(item.product_name || 'Товар')}</div>
      ${item.nm_id ? `<div class="fb-specs"><span>Артикул: <b>${item.nm_id}</b></span></div>` : ''}
      <div class="fb-text">${esc(item.text || '(отзыв без текста)')}</div>
      ${item.pros ? `<div class="fb-pc"><span class="pc pros">+ ${esc(item.pros)}</span></div>` : ''}
      ${item.cons ? `<div class="fb-pc"><span class="pc cons">− ${esc(item.cons)}</span></div>` : ''}
      ${mediaHtml}
      <div class="unanswered-check">
        <label>
          <input type="checkbox" class="unanswered-pick" data-id="${esc(item.id)}" ${answered ? 'disabled' : ''} />
          Выбрать для обработки
        </label>
        <button class="ghost preview-one">Сгенерировать превью</button>
        <button class="primary approve-one" ${answered ? 'disabled' : ''}>Одобрить и отправить</button>
      </div>
      <div class="unanswered-preview" data-role="preview" hidden></div>
    `

    card.querySelector('.preview-one').addEventListener('click', () => handleSingleAction(item.id, 'preview', card))
    card.querySelector('.approve-one').addEventListener('click', () => handleSingleAction(item.id, 'approve', card))
    card.querySelector('.unanswered-pick').addEventListener('change', updateSelectedCount)

    el.appendChild(card)
  }

  $('#unanswered-select-all').addEventListener('click', () => {
    const checkboxes = el.querySelectorAll('.unanswered-pick:not(:disabled)')
    const allChecked = Array.from(checkboxes).every((cb) => cb.checked)
    checkboxes.forEach((cb) => (cb.checked = !allChecked))
    updateSelectedCount()
  })
  $('#unanswered-preview-selected').addEventListener('click', () => handleBatch('preview'))
  $('#unanswered-approve-selected').addEventListener('click', () => handleBatch('approve'))
  updateSelectedCount()
}

function updateSelectedCount() {
  const ids = getSelectedIds()
  $('#unanswered-selected-count').textContent = `Выбрано: ${ids.length}`
}

function getSelectedIds() {
  return Array.from(document.querySelectorAll('.unanswered-pick:checked')).map((cb) => cb.dataset.id)
}

function findCard(id) {
  // id может содержать спецсимволы — защищаемся
  return document.querySelector(`.unanswered-card[data-id="${CSS.escape(id)}"]`)
}

async function handleSingleAction(id, action, card) {
  const preview = card.querySelector('[data-role="preview"]')
  const btns = card.querySelectorAll('button')
  btns.forEach((b) => (b.disabled = true))
  preview.hidden = false
  preview.innerHTML = `<span class="label">${action === 'preview' ? 'Генерирую превью…' : 'Отправляю на WB…'}</span>`

  try {
    const r = await api('/api/feedbacks-unanswered', {
      method: 'POST',
      body: { shop_id: unansweredState.shopId, feedback_ids: [id], action },
    })
    const res = r.results[0]
    if (!res.ok) {
      preview.innerHTML = `<span class="label">Ошибка</span>${esc(res.error || 'неизвестно')}`
      if (res.retryAfterSec) preview.innerHTML += `<br><span class="hint">Повторите через ${res.retryAfterSec} сек.</span>`
      toast(res.error || 'Ошибка', 'error')
      return
    }
    if (action === 'preview') {
      preview.innerHTML = `<span class="label">Превью (${res.source})</span>${esc(res.answer)}`
    } else {
      preview.innerHTML = `<span class="label">✅ Отправлено на WB (${res.source})</span>${esc(res.answer)}`
      // помечаем в списке
      const inDbBadge = card.querySelector('.unanswered-in-db')
      inDbBadge.className = 'unanswered-in-db answered'
      inDbBadge.textContent = 'уже отвечен'
      card.querySelector('.approve-one').disabled = true
      card.querySelector('.unanswered-pick').checked = false
    }
    toast(action === 'preview' ? 'Превью готово' : 'Отправлено на WB', 'ok')
  } catch (err) {
    preview.innerHTML = `<span class="label">Ошибка</span>${esc(err.message)}`
    if (err.status === 429) {
      const wait = err.retryAfterSec ? ` Повторите через ${err.retryAfterSec} сек.` : ' Подождите немного.'
      preview.innerHTML += `<br><span class="hint">WB ограничил запросы.${wait}</span>`
    }
    toast(err.message, 'error')
  } finally {
    btns.forEach((b) => {
      // approve-кнопку оставляем выключенной, если уже отвечено
      if (b.classList.contains('approve-one') && card.querySelector('.unanswered-in-db.answered')) return
      b.disabled = false
    })
  }
}

async function handleBatch(action) {
  const ids = getSelectedIds()
  if (ids.length === 0) return toast('Сначала выберите отзывы', 'error')

  const btnId = action === 'preview' ? '#unanswered-preview-selected' : '#unanswered-approve-selected'
  const btn = $(btnId)
  btn.disabled = true
  const originalText = btn.textContent

  // Клиентский батчинг по 3: каждый запрос укладывается в 60с Vercel free.
  // Кнопка показывает прогресс «Обрабатываю батч 1/5…».
  const BATCH_SIZE = 3
  const batches = []
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    batches.push(ids.slice(i, i + BATCH_SIZE))
  }

  let totalOk = 0
  let totalErr = 0
  const errDetails = []

  try {
    for (let i = 0; i < batches.length; i++) {
      btn.textContent = `Батч ${i + 1}/${batches.length}…`
      try {
        const r = await api('/api/feedbacks-unanswered', {
          method: 'POST',
          body: { shop_id: unansweredState.shopId, feedback_ids: batches[i], action },
        })
        for (const res of r.results) {
          const card = findCard(res.id)
          if (!card) continue
          const preview = card.querySelector('[data-role="preview"]')
          preview.hidden = false
          if (!res.ok) {
            totalErr++
            errDetails.push(res.id)
            preview.innerHTML = `<span class="label">Ошибка</span>${esc(res.error || 'неизвестно')}`
            if (res.retryAfterSec) preview.innerHTML += `<br><span class="hint">Повторите через ${res.retryAfterSec} сек.</span>`
          } else if (action === 'preview') {
            totalOk++
            preview.innerHTML = `<span class="label">Превью (${res.source})</span>${esc(res.answer)}`
          } else {
            totalOk++
            preview.innerHTML = `<span class="label">✅ Отправлено (${res.source})</span>${esc(res.answer)}`
            const inDbBadge = card.querySelector('.unanswered-in-db')
            inDbBadge.className = 'unanswered-in-db answered'
            inDbBadge.textContent = 'уже отвечен'
            card.querySelector('.approve-one').disabled = true
            card.querySelector('.unanswered-pick').checked = false
          }
        }
        // Если в этом батче хоть один упал из-за rate limit — прекращаем (остальные тоже упрутся)
        const rateLimit = r.results.find(x => !x.ok && x.retryAfterSec)
        if (rateLimit) {
          toast(`WB ограничил запросы на ${rateLimit.retryAfterSec}с. Остальные батчи пропущены.`, 'error')
          break
        }
      } catch (err) {
        // Один батч упал целиком — продолжаем остальные
        totalErr += batches[i].length
        errDetails.push(...batches[i])
        if (err.status === 429 && err.retryAfterSec) {
          toast(`WB 429, жду ${err.retryAfterSec}с. Остальные батчи пропущены.`, 'error')
          break
        }
        toast(`Батч ${i + 1} не прошёл: ${err.message}. Продолжаю…`, 'error')
      }
    }
    const summary = action === 'preview'
      ? `Превью: ${totalOk} готово, ${totalErr} ошибок (из ${ids.length})`
      : `Отправлено: ${totalOk}, ошибок ${totalErr} (из ${ids.length})`
    toast(summary, totalErr > 0 ? 'error' : 'ok')
    updateSelectedCount()
  } finally {
    btn.disabled = false
    btn.textContent = originalText
  }
}

// Инициализация: обновляем селект магазинов и вешаем обработчики.
// Дёргаем после загрузки shopsCache (вызовется из app.js через window.__onUnansweredShopsLoaded).
function initUnanswered() {
  renderUnansweredShopSelect()
  $('#unanswered-shop').addEventListener('change', () => {
    $('#unanswered-load').disabled = !$('#unanswered-shop').value
    $('#unanswered-list').innerHTML = ''
    $('#unanswered-status').textContent = ''
  })
  $('#unanswered-load').addEventListener('click', loadUnanswered)
}

// Экспортируем хук для app.js: app.js вызовет window.__onUnansweredShopsLoaded() после каждой загрузки магазинов.
window.__onUnansweredShopsLoaded = renderUnansweredShopSelect

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initUnanswered)
} else {
  initUnanswered()
}

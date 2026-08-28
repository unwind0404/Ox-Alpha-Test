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
  try {
    const data = await api(`/api/feedbacks-unanswered?shop_id=${shopId}&take=20`)
    unansweredState = {
      items: data.items,
      shopId: Number(shopId),
      shopName: data.shop.name,
    }
    status.textContent = `Загружено: ${data.total_on_wb} с WB${data.items.some((i) => i.in_db) ? ' (некоторые уже есть в БД)' : ''}`
    renderUnansweredList()
  } catch (err) {
    status.textContent = err.message
    if (err.status === 401) location.reload()
  } finally {
    btn.disabled = false
    btn.textContent = 'Загрузить с WB'
  }
}

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
  if (ids.length > 3) return toast('За раз не больше 3 (лимит Vercel 60с)', 'error')

  const btnId = action === 'preview' ? '#unanswered-preview-selected' : '#unanswered-approve-selected'
  const btn = $(btnId)
  btn.disabled = true
  btn.textContent = action === 'preview' ? 'Генерирую…' : 'Отправляю…'

  try {
    const r = await api('/api/feedbacks-unanswered', {
      method: 'POST',
      body: { shop_id: unansweredState.shopId, feedback_ids: ids, action },
    })

    let okCount = 0
    let errCount = 0
    for (const res of r.results) {
      const card = findCard(res.id)
      if (!card) continue
      const preview = card.querySelector('[data-role="preview"]')
      preview.hidden = false
      if (!res.ok) {
        errCount++
        preview.innerHTML = `<span class="label">Ошибка</span>${esc(res.error || 'неизвестно')}`
        if (res.retryAfterSec) preview.innerHTML += `<br><span class="hint">Повторите через ${res.retryAfterSec} сек.</span>`
      } else if (action === 'preview') {
        okCount++
        preview.innerHTML = `<span class="label">Превью (${res.source})</span>${esc(res.answer)}`
      } else {
        okCount++
        preview.innerHTML = `<span class="label">✅ Отправлено (${res.source})</span>${esc(res.answer)}`
        const inDbBadge = card.querySelector('.unanswered-in-db')
        inDbBadge.className = 'unanswered-in-db answered'
        inDbBadge.textContent = 'уже отвечен'
        card.querySelector('.approve-one').disabled = true
        card.querySelector('.unanswered-pick').checked = false
      }
    }
    toast(
      action === 'preview'
        ? `Превью готово: ${okCount}, ошибок ${errCount}`
        : `Отправлено: ${okCount}, ошибок ${errCount}`,
      errCount > 0 ? 'error' : 'ok',
    )
    updateSelectedCount()
  } catch (err) {
    toast(err.message, 'error')
  } finally {
    btn.disabled = false
    btn.textContent = action === 'preview' ? 'Сгенерировать превью (выбранные)' : 'Одобрить и отправить (выбранные)'
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

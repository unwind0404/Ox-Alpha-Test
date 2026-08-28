// Доступ к БД (Postgres, бесплатный тариф Neon).
// Если DATABASE_URL не задан, приложение работает в режиме env-only:
// один магазин из переменной окружения, без истории отзывов.

import postgres from 'postgres'

type Sql = ReturnType<typeof postgres>

let client: Sql | null = null

/** Возвращает подключение к БД или null, если DATABASE_URL не задан. */
export function getDb(): Sql | null {
  const url = process.env.DATABASE_URL
  if (!url) return null
  if (!client) {
    client = postgres(url, { ssl: 'require', max: 1 })
  }
  return client
}

/** Создаёт таблицы, если их ещё нет. Идемпотентно. */
export async function initDb(): Promise<void> {
  const db = getDb()
  if (!db) return

  await db`
    CREATE TABLE IF NOT EXISTS shops (
      id         SERIAL PRIMARY KEY,
      name       TEXT        NOT NULL,
      token      TEXT        NOT NULL,
      mode       TEXT        NOT NULL DEFAULT 'templates',
      enabled    BOOLEAN     NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `

  // Миграция: добавляем колонку instructions, если её ещё нет
  await db`
    ALTER TABLE shops
    ADD COLUMN IF NOT EXISTS instructions TEXT
  `

  // Таблица для многопользовательской работы: кто «залочил» магазин
  await db`
    CREATE TABLE IF NOT EXISTS shop_locks (
      shop_id      INTEGER     NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      user_token   TEXT        NOT NULL,
      user_name    TEXT        NOT NULL DEFAULT 'Аноним',
      locked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (shop_id)
    )
  `

  // Журнал действий (audit log) для безопасника
  await db`
    CREATE TABLE IF NOT EXISTS actions_log (
      id          BIGSERIAL PRIMARY KEY,
      user_token  TEXT        NOT NULL,
      user_name   TEXT        NOT NULL DEFAULT 'Аноним',
      action      TEXT        NOT NULL,
      target_type TEXT,
      target_id   TEXT,
      details     JSONB,
      ip          TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await db`CREATE INDEX IF NOT EXISTS idx_actions_log_created ON actions_log (created_at DESC)`

  await db`
    CREATE TABLE IF NOT EXISTS feedbacks (
      id            TEXT        NOT NULL,
      shop_id       INTEGER     NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      nm_id         INTEGER,
      product_name  TEXT,
      subject_name  TEXT,
      user_name     TEXT,
      rating        INTEGER,
      text          TEXT,
      pros          TEXT,
      cons          TEXT,
      photo_links   JSONB       NOT NULL DEFAULT '[]',
      video_url     TEXT,
      video_preview TEXT,
      created_date  TIMESTAMPTZ,
      status       TEXT        NOT NULL DEFAULT 'answered', -- answered | draft | rejected | error
      answer        TEXT,
      source        TEXT,
      error         TEXT,
      processed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (id, shop_id)
    )
  `

  await db`
    CREATE TABLE IF NOT EXISTS insights (
      id          SERIAL PRIMARY KEY,
      shop_id     INTEGER     NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      period      TEXT        NOT NULL, -- 'month' | 'quarter'
      themes      JSONB       NOT NULL,
      overview    TEXT        NOT NULL,
      feedbacks_count INTEGER NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `

  await db`CREATE INDEX IF NOT EXISTS idx_feedbacks_shop ON feedbacks (shop_id, processed_at DESC)`
}

// ---------- Магазины ----------

export type ShopMode = 'templates' | 'drafts' | 'llm'

export type Shop = {
  id: number
  name: string
  token: string
  mode: ShopMode
  enabled: boolean
  instructions: string | null
}

export async function listShops(): Promise<Shop[]> {
  const db = getDb()
  if (!db) return []
  return await db`
    SELECT id, name, token, mode, enabled, instructions
    FROM shops
    ORDER BY id
  ` as Shop[]
}

export async function addShop(name: string, token: string, mode: ShopMode): Promise<number> {
  const db = getDb()
  if (!db) throw new Error('БД не настроена (DATABASE_URL)')
  const rows = await db`
    INSERT INTO shops (name, token, mode)
    VALUES (${name}, ${token}, ${mode})
    RETURNING id
  ` as { id: number }[]
  return rows[0].id
}

export async function updateShopMode(id: number, mode: ShopMode): Promise<void> {
  const db = getDb()
  if (!db) throw new Error('БД не настроена (DATABASE_URL)')
  await db`UPDATE shops SET mode = ${mode} WHERE id = ${id}`
}

export async function setShopEnabled(id: number, enabled: boolean): Promise<void> {
  const db = getDb()
  if (!db) throw new Error('БД не настроена (DATABASE_URL)')
  await db`UPDATE shops SET enabled = ${enabled} WHERE id = ${id}`
}

/** Обновить инструкции для LLM (правила поведения бота). */
export async function updateShopInstructions(id: number, instructions: string): Promise<void> {
  const db = getDb()
  if (!db) throw new Error('БД не настроена (DATABASE_URL)')
  // Пустую строку сохраняем как null, чтобы в БД не было пустых записей
  const value = instructions.trim() ? instructions.trim() : null
  await db`UPDATE shops SET instructions = ${value} WHERE id = ${id}`
}

/** Список отзывов со статусом pending_send (ответ сгенерирован, но не дошёл до WB). */
export async function listPendingSend(shopId: number, limit = 20): Promise<FeedbackRow[]> {
  const db = getDb()
  if (!db) return []
  return await db`
    SELECT f.id, f.shop_id, s.name AS shop_name, f.nm_id, f.product_name, f.subject_name,
           f.user_name, f.rating, f.text, f.pros, f.cons, f.photo_links, f.video_url,
           f.video_preview, f.status, f.answer, f.source, f.error, f.processed_at
    FROM feedbacks f
    LEFT JOIN shops s ON s.id = f.shop_id
    WHERE f.shop_id = ${shopId} AND f.status = 'pending_send'
    ORDER BY f.processed_at ASC
    LIMIT ${limit}
  ` as FeedbackRow[]
}

// ---------- Многопользовательность: локи и audit log ----------

/** Тип лока: какой магазин сейчас «занимает» пользователь. */
export type ShopLock = {
  shop_id: number
  user_token: string
  user_name: string
  locked_at: string
  last_seen: string
}

/** Проверить, кто сейчас «залочил» магазин (если лочил). Возвращает null, если свободен. */
export async function getShopLock(shopId: number): Promise<ShopLock | null> {
  const db = getDb()
  if (!db) return null
  // Лок считается истёкшим, если last_seen старше 5 минут
  const rows = await db`SELECT shop_id, user_token, user_name, locked_at, last_seen FROM shop_locks
    WHERE shop_id = ${shopId} AND last_seen > now() - interval '5 minutes'` as ShopLock[]
  return rows[0] ?? null
}

/** Занять магазин (или обновить свой лок). */
export async function acquireShopLock(shopId: number, userToken: string, userName: string): Promise<void> {
  const db = getDb()
  if (!db) return
  await db`
    INSERT INTO shop_locks (shop_id, user_token, user_name, locked_at, last_seen)
    VALUES (${shopId}, ${userToken}, ${userName}, now(), now())
    ON CONFLICT (shop_id) DO UPDATE SET
      user_token = EXCLUDED.user_token,
      user_name = EXCLUDED.user_name,
      locked_at = now(),
      last_seen = now()
  `
}

/** Отпустить лок (если он наш). */
export async function releaseShopLock(shopId: number, userToken: string): Promise<void> {
  const db = getDb()
  if (!db) return
  await db`DELETE FROM shop_locks WHERE shop_id = ${shopId} AND user_token = ${userToken}`
}

// ---------- Audit log ----------

export type ActionLog = {
  id: number
  user_token: string
  user_name: string
  action: string
  target_type: string | null
  target_id: string | null
  details: Record<string, unknown> | null
  ip: string | null
  created_at: string
}

/** Записать действие в журнал. */
export async function logAction(
  userToken: string,
  userName: string,
  action: string,
  targetType: string | null,
  targetId: string | null,
  details: Record<string, unknown> | null,
  ip: string | null,
): Promise<void> {
  const db = getDb()
  if (!db) return
  try {
    await db`
      INSERT INTO actions_log (user_token, user_name, action, target_type, target_id, details, ip)
      VALUES (${userToken}, ${userName}, ${action}, ${targetType}, ${targetId}, ${details ? db.json(details) : null}, ${ip})
    `
  } catch (e) {
    console.error(`[audit] не удалось записать действие: ${e instanceof Error ? e.message : e}`)
  }
}

/** Получить последние N записей журнала (для UI безопасника). */
export async function listActions(limit = 100): Promise<ActionLog[]> {
  const db = getDb()
  if (!db) return []
  return await db`SELECT * FROM actions_log ORDER BY created_at DESC LIMIT ${limit}` as ActionLog[]
}

/** Алиас для панели (кнопка Вкл/Выкл). */
export async function toggleShop(id: number, enabled: boolean): Promise<void> {
  await setShopEnabled(id, enabled)
}

export async function deleteShop(id: number): Promise<void> {
  const db = getDb()
  if (!db) throw new Error('БД не настроена (DATABASE_URL)')
  await db`DELETE FROM shops WHERE id = ${id}`
}

// ---------- Аналитика (insights) ----------

export type InsightRow = {
  id: number
  shop_id: number
  shop_name: string | null
  period: string
  themes: InsightThemeData[]
  overview: string
  feedbacks_count: number
  created_at: string
}

export type InsightThemeData = {
  title: string
  sentiment: 'negative' | 'positive' | 'neutral'
  count: number
  summary: string
  quotes: string[]
  recommendation?: string
}

export async function saveInsight(
  shopId: number,
  period: string,
  themes: InsightThemeData[],
  overview: string,
  feedbacksCount: number,
): Promise<number> {
  const db = getDb()
  if (!db) throw new Error('БД не настроена (DATABASE_URL)')
  const rows = await db`
    INSERT INTO insights (shop_id, period, themes, overview, feedbacks_count)
    VALUES (${shopId}, ${period}, ${db.json(themes)}, ${overview}, ${feedbacksCount})
    RETURNING id
  ` as { id: number }[]
  return rows[0].id
}

export async function listInsights(shopId: number, limit = 20): Promise<InsightRow[]> {
  const db = getDb()
  if (!db) return []
  return await db`
    SELECT i.id, i.shop_id, s.name AS shop_name, i.period, i.themes, i.overview,
           i.feedbacks_count, i.created_at
    FROM insights i
    JOIN shops s ON s.id = i.shop_id
    WHERE i.shop_id = ${shopId}
    ORDER BY i.created_at DESC
    LIMIT ${limit}
  ` as InsightRow[]
}

// ---------- Отзывы ----------

export type FeedbackRow = {
  id: string
  shop_id: number
  shop_name: string | null
  nm_id: number | null
  product_name: string | null
  subject_name: string | null
  user_name: string | null
  rating: number | null
  text: string | null
  pros: string | null
  cons: string | null
  photo_links: string[]
  video_url: string | null
  video_preview: string | null
  status: string
  answer: string | null
  source: string | null
  error: string | null
  processed_at: string
}

export type FeedbackInput = {
  id: string
  nmId?: number
  productName?: string
  subjectName?: string
  userName?: string
  rating?: number
  text?: string
  pros?: string
  cons?: string
  photoLinks?: string[]
  videoUrl?: string | null
  videoPreview?: string | null
  createdDate?: string
}

export async function saveFeedback(
  shopId: number,
  fb: FeedbackInput,
  answer: string | null,
  source: string | null,
  error: string | null,
  status?: 'answered' | 'draft' | 'error' | 'pending_send',
): Promise<void> {
  const db = getDb()
  if (!db) return

  const finalStatus = status ?? (error ? 'error' : 'answered')

  // Postgres-драйвер отвергает undefined — тотальная санитизация всех полей
  // Каст в string|number|null, чтобы типы postgres-шаблона не ругались
  const v = (x: unknown): string | number | null => (x === undefined || x === null ? null : (x as string | number))

  const photoLinks = Array.isArray(fb.photoLinks)
    ? fb.photoLinks.filter((p): p is string => typeof p === 'string')
    : []
  const videoUrl = typeof fb.videoUrl === 'string' ? fb.videoUrl : null
  const videoPreview = typeof fb.videoPreview === 'string' ? fb.videoPreview : null
  const nmId = typeof fb.nmId === 'number' ? fb.nmId : null
  const rating = typeof fb.rating === 'number' ? fb.rating : null
  const createdDate = fb.createdDate ? new Date(fb.createdDate) : null
  const createdDateSafe = createdDate && !isNaN(createdDate.getTime()) ? createdDate : null

  // Отладка: ловим, какое поле остаётся undefined
  const debugFields: Record<string, unknown> = {
    id: fb.id, shopId, nmId, productName: v(fb.productName), subjectName: v(fb.subjectName),
    userName: v(fb.userName), rating, text: v(fb.text), pros: v(fb.pros), cons: v(fb.cons),
    photoLinks: photoLinks.length, videoUrl, videoPreview, createdDateSafe,
    finalStatus, answer: v(answer), source: v(source), error: v(error),
  }
  const undefinedFields = Object.entries(debugFields)
    .filter(([, val]) => val === undefined)
    .map(([key]) => key)
  if (undefinedFields.length > 0) {
    console.error(`[db] UNDEFINED в полях: ${undefinedFields.join(', ')}`)
  }

  await db`
    INSERT INTO feedbacks
      (id, shop_id, nm_id, product_name, subject_name, user_name, rating, text, pros, cons,
       photo_links, video_url, video_preview, created_date, status, answer, source, error,
       processed_at)
    VALUES
      (${fb.id}, ${shopId}, ${nmId}, ${v(fb.productName)}, ${v(fb.subjectName)},
       ${v(fb.userName)}, ${rating}, ${v(fb.text)}, ${v(fb.pros)}, ${v(fb.cons)},
       ${db.json(photoLinks)}, ${videoUrl}, ${videoPreview},
       ${createdDateSafe},
       ${finalStatus}, ${v(answer)}, ${v(source)}, ${v(error)},
       now())
    ON CONFLICT (id, shop_id) DO UPDATE SET
      -- Обновляем только то, что относится к ответу (status/answer/source/error)
      -- и дату обработки. Метаданные отзыва (nmId, productName, photoLinks и т.п.)
      -- не трогаем — они не меняются между запусками.
      status = EXCLUDED.status,
      answer = EXCLUDED.answer,
      source = EXCLUDED.source,
      error = EXCLUDED.error,
      processed_at = EXCLUDED.processed_at
  `
}

/** История обработанных отзывов с фильтрами (для панели). */
export async function listFeedbacks(
  shopId: number | null,
  status: string | null,
  limit = 200,
): Promise<FeedbackRow[]> {
  const db = getDb()
  if (!db) return []

  // Динамическая сборка WHERE: фрагменты объединяются вручную
  const whereShop = shopId !== null ? db`f.shop_id = ${shopId}` : db`true`
  const whereStatus = status ? db`f.status = ${status}` : db`true`

  return await db`
    SELECT f.id, f.shop_id, s.name AS shop_name, f.nm_id, f.product_name, f.subject_name,
           f.user_name, f.rating, f.text, f.pros, f.cons, f.photo_links, f.video_url,
           f.video_preview, f.status, f.answer, f.source, f.error, f.processed_at
    FROM feedbacks f
    JOIN shops s ON s.id = f.shop_id
    WHERE ${whereShop} AND ${whereStatus}
    ORDER BY f.processed_at DESC
    LIMIT ${limit}
  ` as FeedbackRow[]
}

/** Отзывы магазина за последние N дней (для анализа). */
export async function listFeedbacksSince(
  shopId: number,
  days: number,
): Promise<FeedbackRow[]> {
  const db = getDb()
  if (!db) return []
  return await db`
    SELECT f.id, f.shop_id, s.name AS shop_name, f.nm_id, f.product_name, f.subject_name,
           f.user_name, f.rating, f.text, f.pros, f.cons, f.photo_links, f.video_url,
           f.video_preview, f.status, f.answer, f.source, f.error, f.processed_at
    FROM feedbacks f
    JOIN shops s ON s.id = f.shop_id
    WHERE f.shop_id = ${shopId}
      AND f.processed_at >= now() - (${days} || ' days')::interval
    ORDER BY f.processed_at DESC
    LIMIT 500
  ` as FeedbackRow[]
}

/** Обновить черновик: отредактированный текст и статус (answered/rejected). */
export async function updateFeedbackDraft(
  shopId: number,
  feedbackId: string,
  answer: string,
  status: 'answered' | 'rejected',
): Promise<void> {
  const db = getDb()
  if (!db) throw new Error('БД не настроена (DATABASE_URL)')
  await db`
    UPDATE feedbacks
    SET answer = ${answer}, status = ${status}
    WHERE id = ${feedbackId} AND shop_id = ${shopId} AND status = 'draft'
  `
}

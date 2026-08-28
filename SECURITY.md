# Security Review: WB Cron Bot

> Документ для ревью безопасника. Описывает архитектуру, секреты, модель угроз, реализованные защиты.

## Что это

Серверный бот для продавцов Wildberries: авто-ответы на отзывы (шаблоны или LLM через OpenRouter), черновики с одобрением, аналитика отзывов по темам, Telegram-уведомления.

**Стек:** TypeScript + Vercel Serverless Functions + Postgres (Neon) + OpenRouter API.

## Архитектура

```
┌─────────────┐    HTTPS    ┌──────────────────┐    SQL     ┌────────────┐
│   Browser   │ ──────────► │  Vercel server   │ ────────► │   Neon     │
│  (панель)   │             │  functions       │           │  Postgres  │
└─────────────┘             └──────────────────┘           └────────────┘
                                    │
                                    │  HTTPS
                                    ▼
                            ┌──────────────────┐
                            │  Wildberries API │
                            │  (feedbacks)     │
                            └──────────────────┘
                                    │
                                    │  HTTPS
                                    ▼
                            ┌──────────────────┐
                            │  OpenRouter API  │
                            │  (LLM)           │
                            └──────────────────┘
```

### Компоненты

| Компонент | Назначение | Секреты |
|---|---|---|
| `wb-cron-bot/api/` | Vercel serverless functions (эндпоинты) | — |
| `wb-cron-bot/lib/` | Общая логика: БД, WB-клиент, LLM, Telegram | — |
| `wb-cron-bot/public/` | Фронтенд (HTML + JS + CSS) | — |
| Vercel env | `ADMIN_PASSWORD`, `SESSION_SECRET`, `CRON_SECRET`, `DATABASE_URL`, `OPENROUTER_API_KEY`, `WB_TOKEN_TYPE`, `MAX_ANSWERS_PER_RUN` | ✅ зашифрованы Vercel |
| Neon Postgres | Магазины, отзывы, инструкции, locks, audit log | URL с паролем в Vercel env |

## Модель угроз

| Угроза | Защита | Статус |
|---|---|---|
| Брутфорс пароля панели | Rate-limit: 5 попыток / 15 мин / IP | ✅ |
| Утечка cookie | `HttpOnly`, `Secure` (в проде), `SameSite=Lax`, HMAC-подпись | ✅ |
| CSRF | `SameSite=Lax` cookie + same-origin API | ✅ |
| SQL injection | Все запросы параметризованы через `postgres` пакет | ✅ |
| XSS | `esc()` для всех пользовательских строк в HTML | ✅ |
| Утечка секретов | `.env` в `.gitignore`, секреты только в Vercel env | ✅ |
| Rate limit WB | personal-токен: ~1 req/sec, батчинг по 3 в UI, retry с задержкой | ✅ |
| Race condition в одобрении | `ON CONFLICT (id, shop_id) DO UPDATE` | ✅ |
| Race condition в approve | `UPDATE ... WHERE status = 'draft'` | ✅ |
| Одновременная работа двух людей | `shop_locks` (5 мин TTL), audit log | ✅ |
| OpenRouter rate limit (50/день на free) | Fallback на шаблоны, понятные ошибки | ✅ |

## Аутентификация

**Простая:** один админ-пароль (`ADMIN_PASSWORD` в env) → подписанная HMAC cookie (`wb_session`).

```
Session token: `admin.<exp>.<hmac_sha256(secret, payload)>`
Cookie: HttpOnly; SameSite=Lax; Secure (в проде); Max-Age=30 дней
Secret: process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD
```

**Слабые места** (для безопасника):
- ❌ Нет 2FA / TOTP
- ❌ Нет OAuth / SSO
- ❌ Нет password rotation UI
- ❌ Rate-limit in-memory (per Vercel instance, не глобальный)

**Что есть:**
- ✅ Rate-limit на 5 попыток / 15 мин / IP
- ✅ Задержка 800мс при неверном пароле (защита от брутфорса по времени)
- ✅ `timingSafeEqual` для сравнения паролей
- ✅ `randomBytes` для nonce в cookie (через HMAC payload)

## Секреты

| Переменная | Где задаётся | Где используется | Видна в коде? |
|---|---|---|---|
| `ADMIN_PASSWORD` | Vercel env | Login | Нет (HMAC compare) |
| `SESSION_SECRET` | Vercel env | Cookie HMAC | Нет |
| `CRON_SECRET` | Vercel env | `Authorization: Bearer` для ручного запуска cron | Нет |
| `DATABASE_URL` | Vercel env | `postgres` client | Нет |
| `OPENROUTER_API_KEY` | Vercel env | LLM-запросы | Нет (через `Authorization: Bearer`) |
| `WB_TOKEN_TYPE` | Vercel env | Логика rate limit | Нет |
| `MAX_ANSWERS_PER_RUN` | Vercel env | Цикл обработки | Нет |

**Все секреты задаются через Vercel env (encrypted by Vercel).**

## Audit log (для ревью)

Таблица `actions_log`:
- `user_token` — первые 32 символа HMAC cookie (идентификатор сессии, не сам токен)
- `user_name` — имя, которое ввёл пользователь при входе (для UI)
- `action` — `draft.approve`, `draft.reject`, `draft.regenerate`, `lock.acquire`, `lock.release`
- `target_type` / `target_id` — что именно
- `details` (JSONB) — детали (например, длина текста, retryAfterSec)
- `ip` — IP клиента
- `created_at` — timestamp

**UI:** вкладка «Журнал» в панели — последние 200 действий.

**Что НЕ логируется:**
- Содержимое ответов (только длина)
- Содержимое промптов LLM
- Пароли

## Многопользовательность

**Проблема:** два человека одновременно работают с одним магазином → конфликт approve.

**Решение:** `shop_locks` таблица:
- `(shop_id, user_token, user_name, locked_at, last_seen)`
- TTL 5 минут (обновляется при acquire)
- При попытке acquire чужого магазина → 409 Conflict с указанием, кто сейчас работает
- При уходе со страницы → `navigator.sendBeacon` отпускает лок

**Один магазин** = один пользователь одновременно. **Разные магазины** = параллельно без проблем.

## Rate limits

### Wildberries API
- Basic-токен: 5 req/час (не используется)
- Personal-токен: ~1 req/сек (текущий)
- При 429: сохраняем в БД как draft с пометкой `retryAfterSec`, переходим к следующему отзыву (не блокируем)

### OpenRouter
- 50 запросов/день на free-модели
- При лимите: fallback на `minimax/minimax-m2.7:free`, потом на шаблон

### Vercel
- 60с на serverless-функцию
- Батчинг по 3 отзыва в UI (каждый батч ~10-15с)
- `MAX_ANSWERS_PER_RUN=20` в env (для `process-now`)

### Login
- 5 попыток / 15 мин / IP
- In-memory (per Vercel instance, не глобальный)

## Что не реализовано (TODO)

| Фича | Зачем | Приоритет |
|---|---|---|
| 2FA / TOTP | Защита панели | Высокий (рекомендую добавить) |
| Глобальный rate-limit (Redis/Upstash) | Точный rate-limit для всех Vercel instances | Средний |
| Удаление/ротация cookies | Возможность «забыть все сессии» | Низкий |
| Audit log retention policy | Удаление старых логов (>1 год) | Низкий |
| CSP headers | Защита от inline-скриптов | Средний (сейчас нет) |
| HSTS | Принудительный HTTPS | Vercel включает автоматически |

## Известные ограничения

1. **Один общий пароль** — все админы видят всё. Если нужны разные роли — добавить `users` таблицу.
2. **Audit log в БД** — если злоумышленник имеет доступ к БД, он может удалить логи. Для production-grade — отдельный append-only storage (S3 + WORM).
3. **No HTTPS for Neon** — Vercel → Neon идёт по SSL (`sslmode=require`), но это всё.
4. **No CORS** — все запросы same-origin, что безопасно, но если понадобится API для внешних клиентов — нужно добавить CORS-политику.

## Контакты

- Владелец: [ваш email/handle]
- Репо: https://github.com/unwind0404/Ox-Alpha-Test
- Vercel-проект: `wb-cron-bot` (id `prj_bfKuhYtKRnKnugQwJAWTLmF29PcN`)
- Neon-проект: `ox alpha test` (id `wispy-sea-72053408`, eu-central-1)

## Дополнительно для ревью

- `wb-cron-bot/lib/auth.ts` — аутентификация
- `wb-cron-bot/api/auth.ts` — login endpoint
- `wb-cron-bot/api/drafts.ts` — основные действия (approve/reject/regenerate) с audit log
- `wb-cron-bot/lib/db.ts` — все SQL-запросы (параметризованные через `postgres` пакет)
- `wb-cron-bot/api/locks.ts` — многопользовательские локи

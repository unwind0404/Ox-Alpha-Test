# Контекст проекта Ox-Alpha-Test

> Файл для агента (ox-alpha): прочитай его в начале нового чата, чтобы не спрашивать пользователя заново.
> Обновляй этот файл после значимых изменений.

## Стек

- React 19 + TypeScript + Vite 8
- Стили: обычный CSS, тёмная тема (#12141a фон, акцент #7c9cff/#b57cff)
- Линт: oxlint. Сборка/проверка: `npm run build`

## Что это за приложение

Веб-приложение с двумя вкладками («Чат» и «Задачи», переключение через TabBar в `src/App.tsx`):

1. **Задачи** — todo-лист с фильтрами (все/активные/выполненные), хранение в localStorage (`todos-v1`).
2. **Чат** — интерфейс к LLM через OpenRouter:
   - Модель по умолчанию: `stealth/ox-alpha` (та же, что используется агентом в Zed)
   - Base URL: `https://openrouter.ai/api/v1`
   - Параметры как у Ox Alpha в Zed: max_tokens (контекст) 1 048 576, max_output_tokens 131 072, thinking включён, budget_tokens 50 000
   - API-ключ вводится в настройках UI (тип password), хранится в localStorage (`chat-settings-v1`)
   - Счётчик контекста: полоса прогресса + оценка токенов (~3.5 символа/токен), краснеет при >90%
   - Авто-retry при 429 (rate limit): до 3 попыток, экспоненциальная задержка 1с → 2с → 4с
   - История чата сохраняется в localStorage (`chat-history-v1`)

## История решений (важно для нового чата)

- Пользователь общается на русском.
- Пользователь ранее случайно нажал "Reject All" в Zed и потерял правки — я восстановил их из памяти диалога. Вывод: при потере правок достаточно попросить агента пересоздать их.
- Rate limits: задаётся провайдером (OpenRouter), легально не обходятся; в приложении реализован retry с задержкой.
- Точные лимиты самого агента ox-alpha пользователю неизвестны; параметры модели видны в `%APPDATA%\Zed\settings.json` (max_tokens 1048576, max_output_tokens 131072, budget_tokens 50000).
- Настройки Zed: провайдер openrouter, модель stealth/ox-alpha, enable_thinking: true.

## Текущий статус (обновлено)

- Проект чата+задачи завершён, сборка проходит.
- **wb-review-bot/** — полная версия с UI (Render) — деплой падал по таймауту, отложена.
- **wb-cron-bot/** — ✅ РАЗВЁРНУТ: https://wb-cron-bot.vercel.app
  - **Панель (3 вкладки):** Магазины / **Черновики** / Отзывы / Аналитика (4 вкладки по факту, но визуально «Черновики» и «Отзывы» — разные представления одного и того же)
  - **Режимы магазина:**
    - `templates` — авто-режим: cron раз в день отвечает шаблонами по звёздам, ничего не показывая
    - `drafts` — LLM с подтверждением: cron генерирует черновики, в панели можно править/одобрить/отклонить/перегенерировать
    - `llm` — авто-режим: cron раз в день генерирует и СРАЗУ отправляет LLM-ответ
  - **Что показывается в панели «Отзывы» (`/api/feedbacks`):** ТОЛЬКО отзывы, уже обработанные cron'ом (т.е. status `answered`/`draft`/`rejected`/`error`). Неотвеченные с WB напрямую НЕ подгружаются.
  - **Что показывается в «Черновики» (`/api/drafts`):** то же, что в «Отзывы», но фильтр `status='draft'`. У магазина должен быть включён режим `drafts`, иначе пусто.
  - **Источник «3 отзывов» на UI:** cron ответил на 3 (лимит 1 за запуск × 3 магазина, либо 3 отзыва за несколько запусков), и они сохранились в БД. Остальные ~6 неотвеченных лежат на WB — панель их не показывает.
  - Аналитика (insights): LLM группирует отзывы по темам, цитаты, рекомендации. Ручной запуск за месяц/квартал; авто-анализ по воскресеньям + топ-3 негативных тем в Telegram.
  - lib/insights.ts: промпт-аналитик, парсинг JSON с защитой от markdown, нормализация тем, fallback-модель.
  - Для аналитики нужен OPENROUTER_API_KEY — ✅ задан (sk-or-v1-e3e2...e73b).
  - LLM-модели: `nvidia/nemotron-3-super-120b-a12b:free` (осн.) + `minimax/minimax-m2.7:free` (fallback). ВАЖНО: minimax — reasoning-модель, при `max_tokens < 300` content может быть null.
  - Пароль панели: `wb-admin-2026-xK9mPq` (сообщён пользователю).
  - БД: Neon Postgres, проект «OX alpha test», Франкфурт. Все env заданы: ADMIN_PASSWORD, SESSION_SECRET, CRON_SECRET, DATABASE_URL.
  - **Rate limit WB (базовый токен = 5 req/час):** cron обрабатывает 1 отзыв за запуск (`MAX_ANSWERS_PER_RUN=1`, env `WB_TOKEN_TYPE=personal` → 10). 429 при исчерпании — норма, отзыв остаётся в очереди до следующего запуска.
  - Проверено на реальном токене: WB отдаёт ~9 неотвеченных, шаблоны генерируются, но лимит исчерпался за час тестов.
  - Баги исправлены: pg 42P18 → динамический WHERE; postgres.join → фрагменты SQL; UNDEFINED в saveFeedback → v()-санитайзер; CSS hidden → !important; drafts в форме; validMode; favicon; регрессии listFeedbacks/sendMessage восстановлены.
  - **Осталось от пользователя (актуально):** добавить реальный WB-токен магазина, дождаться сброса часового окна лимита, при желании TG_*.
  - **Известное ограничение UX:** в панели нет «живого» списка неотвеченных с WB и нет кнопки «обработать все прямо сейчас». Планируется к реализации (см. ниже в TODO).
- Документация WB скачана ПОЛНОСТЬЮ, все 13 разделов: `wb-docs/*.md` + справочник `WB_API_REFERENCE.md`. Скрипты в `scripts/`.

## Ключевые факты API WB (из документации)

- Base URL: `https://feedbacks-api.wildberries.ru` (sandbox: `feedbacks-api-sandbox.wildberries.ru`)
- Авторизация: заголовок `Authorization: <токен>` (создаётся в ЛК продавца, право «Отзывы»)
- `GET /api/v1/feedbacks?isAnswered=false&take=&skip=&order=dateDesc&dateFrom=` — список неотвеченных отзывов (take max 5000)
- `POST /api/v1/feedbacks/answer` `{id, text}` — ответить (text 2..5000 символов); PATCH тот же путь — редактировать ответ (1 раз за 60 дней)
- `GET /api/v1/feedbacks/count-unanswered`, `/count`, `/archive`
- Поля отзыва: `id`, `text`, `pros`, `cons`, `productValuation` (оценка 1-5), `userName`, `createdDate`, `productDetails`, `answer`
- Rate limit: 3 запроса/сек на аккаунт для всех методов категории (базовый тариф — 5 запросов/час!)
- Ошибки: 429 при превышении лимита

## Архитектурные заметки (для следующего чата)

- Таблица `feedbacks` хранит **только то, что обработал cron** (либо как `answered`, либо как `draft`/`rejected`/`error`). WB-отзывы, до которых cron не дошёл, в БД **не попадают** и в панели не видны.
- Эндпоинт `/api/feedbacks?shop_id=&status=` читает из БД, не из WB.
- Эндпоинт `/api/drafts?shop_id=` — это просто `listFeedbacks(shopId, 'draft')`.
- `MAX_ANSWERS_PER_RUN=1` — намеренное ограничение из-за лимита WB basic-токена. Увеличить → `WB_TOKEN_TYPE=personal` (но и тариф другой нужен).
- Режим `drafts` генерирует LLM-черновики **в момент запуска cron**, а не при заходе в панель. Если cron не запускали — черновиков не будет, даже если на WB висят 20 неотвеченных.
- `llm` отличается от `drafts` только тем, что сразу шлёт `POST /api/v1/feedbacks/answer` без подтверждения.

## TODO / запрошено пользователем

- [ ] **«Список ВСЕХ неотвеченных + кнопка запуска»** — отдельный эндпоинт `/api/feedbacks/unanswered?shop_id=N` (живой запрос к WB) + вкладка «Неотвеченные» в UI. Кнопка «Обработать» отправляет выбранные через `generateAnswer` + `saveFeedback` + (опц.) `answerFeedback`.
- [ ] Уже в этом же ключе: уточнить, в каком виде показывать «предложенные ответы» (как сейчас в `drafts`, или сделать отдельную превью-таблицу до отправки).
- [ ] (опц.) Авторежим с порогом «уверенности» LLM: если LLM оценивает риск ответа как высокий — отправлять в drafts, а не сразу на WB.

## Как быстро поднять локально

```bash
cd wb-cron-bot
npm install
vercel dev  # подхватит .env (DATABASE_URL, OPENROUTER_API_KEY, CRON_SECRET, ADMIN_PASSWORD)
```

Или деплой одной кнопкой: `vercel --prod` (после `vercel link`).

## Лог изменений (по фазам)

### Фаза 0 — критические баги (сделано)
- `lib/auth.ts`: `Secure` cookie только в `NODE_ENV=production` → локалка на http работает.
- `lib/db.ts:274`: в INSERT уходит `createdDateSafe`, а не `createdDate` — защита от `Invalid Date`.
- `api/shops-add.ts`: `mode` приводится явно через `?? 'templates'`, невалидный mode → 400.
- `api/drafts.ts`: при `approve` 429 от WB теперь даёт 429 + `retryAfterSec` в JSON (а не 500).
- `api/drafts.ts`: `regenerate` — один UPDATE вместо двух (раньше статус побывал бы `rejected`).

### Фаза 1 — UX (сделано)
- `api/cron.ts`: `MAX_ANSWERS_PER_RUN` теперь читается из env, дефолт 1.
- `api/cron.ts`: JSON-ответ `cron-run` дополнен полем `remaining_on_wb` — сколько ещё в очереди WB.
- `public/app.js`: после «Запустить сейчас» toast пишет «... в очереди WB ещё N — обработаются в следующем запуске».
- `public/app.js`: пустая вкладка «Черновики» подсказывает, если ни один магазин не в режиме `drafts`.
- `public/app.js`: `api()` пробрасывает `err.status`, проверки 401 переехали с текста на статус.
- **НЕ прошло проверку:** `npx tsc --noEmit` (WSL недоступен на этой машине, см. лог сессии).

### Фаза 2 — вкладка «Неотвеченные» (сделано)
- **Бэкенд** `api/feedbacks-unanswered.ts`:
  - `GET ?shop_id=N&take=20` — живой запрос WB + склейка с БД (какие уже в БД).
  - `POST {shop_id, feedback_ids, action}` — `action: 'preview' | 'approve'`.
  - `approve` отправляет POST на WB + сохраняет в БД.
  - При 429 от WB отзыв сохраняется как `draft` с пометкой, чтобы пользователь не потерял ответ.
  - Лимит 3 за раз (60с Vercel).
- **Фронт**:
  - Новый `public/app-utils.js` — общие утилиты на `window.*` (решает module-scope изоляцию).
  - Новый `public/app-unanswered.js` — логика вкладки.
  - `public/index.html` — новая вкладка «Неотвеченные» + подключение скриптов.
  - `public/style.css` — стили для вкладки.
  - `public/app.js` — алиасы на `window.*` + хук `__onUnansweredShopsLoaded` после `loadShops()`.
- **Поведение**:
  - Чекбоксы, кнопки «Сгенерировать превью» / «Одобрить и отправить» на каждой карточке.
  - Массовые действия: «Выбрать все», «Превью выбранных», «Одобрить выбранных».
  - Карточка уже отвеченного отзыва — серая, чекбокс и кнопка approve disabled.
- **Баги в ходе разработки**:
  - (window as any) — TS-каст в .js файле → убрал.
  - module-scope `shopsCache`/`api`/`esc` не виден между `<script type="module">` → вынес утилиты в app-utils.js.
  - Пагинация findFeedbackById (50 GET) → упростил до одного GET take=5000.
  - CSS.escape для id (могут быть спецсимволы).
  - approve-кнопка disabled, если отзыв уже в БД как answered.

### Фаза 3 — переключатель стратегий + кнопка «Обработать сейчас» (сделано)
- **Бэкенд** `api/shops-process-now.ts`:
  - POST {shop_id} — однократный запуск обработки только для одного магазина.
  - Уважает `MAX_ANSWERS_PER_RUN` из env.
  - При 429 на ответе WB — сохраняет как `draft` с пометкой.
  - Возвращает `total_on_wb`, `answered`, `draft`, `failed`, `remaining_on_wb`.
  - НЕ триггерит недельный авто-анализ (только по запросу через `/api/insights`).
  - НЕ отправляет общий Telegram-отчёт.
- **Фронт** `public/app.js`:
  - Подсказка под бейджем режима: что делает каждый режим.
  - Кнопка «Обработать сейчас» в карточке магазина (только если `enabled`).
  - Toast с понятной сводкой после запуска.
- **app-utils.js**: `api()` пробрасывает `retryAfterSec` из JSON-ответа в `err.retryAfterSec` (для 429).

### Фаза 4 — сброс проекта (полная реструктуризация)
- **Бэкап:** `Ox-Alpha-Test.bak/` (483 MB) сохранён перед удалением.
- **GitHub:** старый `unwind0404/Ox-Alpha-Test` удалён через `gh repo delete --yes`.
  - Создан новый `unwind0404/Ox-Alpha-Test` (public).
  - `unwind0404/wb-review-bot` удалён (зомби-репо от прошлой попытки).
- **Vercel:** проект `wb-cron-bot` удалён и пересоздан (id `prj_bfKuhYtKRnKnugQwJAWTLmF29PcN`).
  - Root Directory: `.` (CLI деплоит из `wb-cron-bot/` локально).
- **Neon:** было 2 проекта с похожими именами (`ox alpha test` / `OX alpha test`).
  - Оставлен `wispy-sea-72053408` с реальными данными (1 магазин, 4+ отзыва).
  - Удалён пустой `curly-sea-34898997`.
- **Env в Vercel:** заданы вручную через API:
  - `ADMIN_PASSWORD`, `SESSION_SECRET` (сгенерирован), `CRON_SECRET` (сгенерирован)
  - `DATABASE_URL` (Neon pooled), `OPENROUTER_API_KEY`, `WB_TOKEN_TYPE=personal`
  - `MAX_ANSWERS_PER_RUN=20`
- **Деплой через CLI:** `vercel --prod --yes` (требует залогиненный `vercel` CLI, токен в `auth.json`).

### Фаза 5 — переход на MiniMax M3 (LLM сменился)
- **Проблема:** OpenRouter в августе 2026 заблокировал большинство free-моделей по дневному лимиту (50/день). Старые `nemotron-3-super` и `glm-5.2` упёрлись.
- **Решение:** `minimax/minimax-m3:free` — единственная стабильно отвечающая free-модель. Не reasoning (content сразу), хороший русский.
- **Код:** `lib/generator.ts` и `lib/insights.ts`:
  - `DEFAULT_MODEL = 'minimax/minimax-m3:free'`, fallback `minimax/minimax-m2.7:free`.
  - `max_tokens: 500` (было 300 — reasoning-модели возвращали null content при 300).
  - Fallback на шаблон если все LLM упали (с пометкой в лог).
  - Парсинг `reasoning` как fallback если `content` пуст.
  - Понятная ошибка «Дневной лимит OpenRouter на free-модели исчерпан».
- **Главный баг исправлен:** `ON CONFLICT (id, shop_id) DO NOTHING` → `DO UPDATE` (status, answer, error, processed_at). Без этого process-now не обновлял существующие `error`-записи.
- **DeepSeek:** Все варианты (`chat-v3.1`, `r1`, `r1-distill`, `chat`, `coder`) теперь платные на OpenRouter.

### Фаза 6 — настраиваемые правила LLM через UI
- **БД:** `ALTER TABLE shops ADD COLUMN IF NOT EXISTS instructions TEXT`.
- **API:** `POST /api/shops-action` с `action: 'instructions'`.
- **Промпт:** пользовательские инструкции вставляются в **самое начало** с пометкой «⚠️ ЖЁСТКИЕ ПРАВИЛА ОТ ПРОДАВЦА» — LLM лучше соблюдает.
- **Env:** `GLOBAL_INSTRUCTIONS` — общие правила для всех магазинов.
- **UI:** textarea в карточке магазина + кнопка «Сохранить правила».
- **Проверено:** инструкция «НЕ упоминай название товара. В конце добавь: промокод WB-2026» — LLM соблюдает.

### Фаза 7 — production-ready (безопасность + многопользовательность + auto)
- **Rate-limit на /api/auth:** 5 попыток / 15 мин / IP. In-memory per Vercel instance (для глобального нужен Redis). Проверено: 4 неудачи → 401, 5-я → 429 с `Retry-After`.
- **Per-shop 429 retry:** в `cron.ts` и `shops-process-now.ts` — не прерывает цикл, сохраняет как draft, пробует следующий отзыв. Пауза 1с между успешными POST (personal-токен, 1 req/sec).
- **Многопользовательность:**
  - Таблица `shop_locks`: (shop_id PK, user_token, user_name, locked_at, last_seen). TTL 5 мин.
  - `acquireShopLock/releaseShopLock/getShopLock` в `lib/db.ts`.
  - API: `GET/POST /api/admin?action=lock-get|lock-acquire|lock-release`.
  - 409 Conflict если магазин занят другим.
  - `navigator.sendBeacon` отпускает лок при уходе со страницы.
- **Audit log:**
  - Таблица `actions_log` (BIGSERIAL PK, indexed by created_at DESC).
  - `logAction(userToken, userName, action, targetType, targetId, details, ip)`.
  - Логируется: draft.approve, draft.reject, draft.regenerate, lock.acquire, lock.release, draft.approve.429.
  - API: `GET /api/admin?action=audit&limit=N`.
  - UI: вкладка «Журнал» с последними 200 записями.
- **Auto-preview:**
  - `GET /api/feedbacks-unanswered?auto_preview=1` — сразу генерит LLM-черновики для всех, кого нет в БД (только в режиме `drafts`). Лимит 50 за запрос.
  - UI: `take=100` по умолчанию (было 20), кнопка переименована в «Обновить с WB».
- **User name:** поле «Ваше имя» на экране входа, сохраняется в localStorage, попадает в audit log.
- **API consolidation (Vercel Hobby 12-function limit):**
  - `api/locks.ts` + `api/audit.ts` → объединены в `api/admin.ts`.
  - Маршруты: `?action=lock-get|lock-acquire|lock-release|audit`.
- **Сброс пароля:** с `wb-admin-2026-xK9mPq` на `Qwerty1234567899` (через пользователя).

## Контакты/доступы (НЕ для коммита)

- **GitHub:** `unwind0404/Ox-Alpha-Test` (public), коммиты через `gh` CLI с токеном `GH_TOKEN`.
- **Vercel:** проект `wb-cron-bot` (id `prj_bfKuhYtKRnKnugQwJAWTLmF29PcN`), команда `unwind0440-source` (env: `VERCEL_TOKEN` не задан, но `vercel` CLI работает через `~/AppData/Roaming/xdg.data/com.vercel.cli/auth.json`).
- **Neon:** проект `ox alpha test` (id `wispy-sea-72053408`, eu-central-1), URL в Vercel env. API-ключ `napi_5zx5kdcjocu41nu0kjr02soce66lnr98449n05t9lbkzktneop6mezy0rqbzrjs9` — **ОТОЗВАТЬ** после тестов.
- **Пароль панели:** `Qwerty1234567899`.
- **Vercel env:** `DATABASE_URL`, `OPENROUTER_API_KEY=sk-or-v1-bc0ec5d523117feaa...`, `WB_TOKEN_TYPE=personal`, `MAX_ANSWERS_PER_RUN=20`, `SESSION_SECRET`, `CRON_SECRET` (сгенерированы).
- **TG-бот и chat_id:** не заданы (опционально).

## Известные ограничения (для безопасника)

1. **In-memory rate-limit** — per Vercel instance, не глобальный. Для production — Upstash/Redis.
2. **Без 2FA** — один пароль на всех. TODO.
3. **No CSP headers** — Vercel выдаёт минимальный набор. TODO.
4. **Audit log в той же БД** — если злоумышленник имеет доступ к Neon, он может удалить логи. Для production — append-only S3.
5. **Один общий пароль** — все видят всё. Нет ролей.
6. **Vercel Hobby cron** — максимум 1 раз в день. Для 15-минутного cron — нужен внешний сервис (cron-job.org) или Pro plan.

## TODO (для следующих фаз)

- 2FA / TOTP
- Глобальный rate-limit (Upstash Redis)
- CSP/HSTS headers
- Audit log retention policy
- Per-user роли (admin / manager / viewer)
- Telegram-бот для уведомлений о новых отзывах
- WebSocket для real-time обновлений (вместо polling)
- Подключить cron-job.org для 15-минутного cron (обход Hobby лимита)

## Фаза 8 — cron-all с pending_send (стратегия против 429)
- **Один endpoint** `api/cron-all.ts` с двумя режимами:
  - **main** (UTC час == 7, batch=20) — основной ежедневный обход
  - **tail** (остальные часы, batch=3) — щадящий режим для 15-минутного cron
- **Новый статус `pending_send`** — LLM сгенерил ответ, но не дошёл до WB (был 429).
  - Следующий запуск cron-all подхватывает из `listPendingSend()` и пытается снова.
- **Стратегия против накопления 429**:
  - На 429 НЕ бьёмся снова в том же запуске.
  - Сохраняем ответ как `pending_send` с пометкой `retryAfterSec`.
  - Следующий cron (через 15 мин при внешнем cron-job.org) подхватывает.
- **Vercel Hobby лимит:** максимум 1 cron в день. `vercel.json`: `0 7 * * *` — ежедневно в 10:00 МСК.
  - Для 15-минутного cron нужно зарегистрироваться на cron-job.org (бесплатно) и дёргать `/api/cron-all` с `CRON_SECRET`.
- **Объединение API:** `cron.ts` + `cron-tail.ts` + `cron-run.ts` → `cron-all.ts` (Vercel Hobby 12-fn limit).
- **Производительность:**
  - 100 отзывов: 5 дней по 20/день (без cron-job.org), ~2-6 часов (с 15-мин cron)
  - При WB 429 — ответы копятся в `pending_send`, не теряются
  - Пауза 1с между POST (1 req/sec для personal-токена)

## Cron-job.org (опционально, для автономности)
1. Зарегистрироваться на https://cron-job.org
2. Создать задачу: POST https://wb-cron-bot.vercel.app/api/cron-all
3. Headers: `Authorization: Bearer <CRON_SECRET>` (из Vercel env)
4. Schedule: каждые 15 мин
5. Теперь бот будет обрабатывать ~3 отзыва каждые 15 мин = 96/день автономно

## Текущий статус (на 2026-08-28)
- **Готово к продакшну:** rate-limit, audit log, locks, instructions, auto-preview, cron-all (main+tail), pending_send против 429
- **Частично:** cron (только 1 раз в день на Hobby — обход через cron-job.org, см. CRON_SETUP.md)
- **Не готово:** 2FA, CSP, real-time updates
- **Деплой:** https://wb-cron-bot.vercel.app
- **Пароль:** Qwerty1234567899
- **CRON_SECRET (для cron-job.org):** f80fedc375775531204fc09b5cce9064af7d454813cec6980d1fb4326ae704e3 (64 hex, в Vercel env)
- **CRON_SETUP.md:** инструкция по настройке 15-минутного cron через бесплатный cron-job.org
- **Стоимость эксплуатации:** $0 (Vercel Hobby + Neon free + OpenRouter free + cron-job.org free + GitHub free)

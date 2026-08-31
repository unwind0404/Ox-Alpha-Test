# Operations Runbook

> Фаза 12: shadow, drafts pilot, live — пошагово.
> Сделайте **только** после того, как ревьюер одобрил Phase 1.

## Этап 1: Shadow (3 дня, без живых ответов)

**Цель:** убедиться, что cron делает daily sync корректно, но **не публикует ничего**.

**Настройка:**

1. **Wrangler secrets** (для cloud):
   ```bash
   npx wrangler secret put DEPLOYMENT_MODE -- "cloud"
   npx wrangler secret put ENABLE_DEFAULT  # НЕ ставить, либо = "false"
   ```

2. **DB seed** (для каждого магазина):
   ```sql
   UPDATE shops SET enabled = 0, disabled_reason = 'shadow mode' WHERE id = ?;
   ```
   `enabled = 0` означает: бот **только читает** (sync), **не публикует** (publish).

3. **Что мониторить** (3 дня):
   - Каждый день в 07:00 UTC cron делает daily sync
   - В UI вкладка «Журнал» → `coordinator.tick` появляется каждый день
   - В D1 растёт таблица `reviews` (новые отзывы)
   - **Ни одной** строки в `audit_events` с action = `publish.*` (потому что enabled = 0)

**Acceptance:**
- [ ] cron срабатывает 3 раза (3 дня)
- [ ] 0 ошибок в журнале
- [ ] Все новые отзывы из WB попали в `reviews` (сверяем с WB API)
- [ ] 0 публикаций

---

## Этап 2: Drafts pilot (≥ 7 дней или 200 отзывов, ручная модерация)

**Цель:** человек проверяет 100% ответов перед отправкой.

**Настройка:**

1. **Включить магазины:**
   ```sql
   UPDATE shops SET enabled = 1, disabled_reason = NULL WHERE id = ?;
   UPDATE shops SET mode = 'drafts' WHERE id = ?;  -- ВАЖНО: режим drafts
   ```

2. **В `shops.mode` = 'drafts':**
   - cron делает sync → создаёт `reply_jobs` в `state='generating'`
   - LLM генерирует ответ → `state='draft_ready'`
   - **Не отправляет** на WB
   - **Ждёт** ручного approve через UI

3. **В UI:**
   - Вкладка «Черновики» (по факту — вкладка «Очередь» с фильтром `awaiting_approval`)
   - Человек читает ответ, нажимает «Одобрить и отправить»
   - Approve → `state='ready_to_send'`, через 12 мин cron публикует

4. **Что мониторить** (≥ 7 дней):
   - **100%** draft'ов проверены человеком перед approve
   - **0** утечек PII / персональных данных
   - **0** нарушений policy (юридические обещания, контакты, ссылки)
   - **≥ 99%** valid schema (длина 2-5000, нет URL, нет email)
   - **Метрика LLM:** 1 fallback (с M3 на M2.7) — это норма

**Acceptance:**
- [ ] ≥ 7 дней / ≥ 200 отзывов через draft
- [ ] Validation pass rate ≥ 99%
- [ ] 0 утечек PII
- [ ] 0 обещаний компенсации / юридических
- [ ] 0 нецензурных / токсичных

---

## Этап 3: Limited live (low-risk only)

**Цель:** автопубликация только для 4-5 звёзд, не вызывающих сомнений.

**Настройка:**

1. **Стратегия магазина:** `llm` (был `drafts`)
   ```sql
   UPDATE shops SET mode = 'llm' WHERE id = ?;
   ```

2. **`reply-policy.classifyReview()`** фильтрует:
   - `low_risk` (4-5 звёзд, чистый текст) → авто
   - `needs_review` (1-3 звёзд / sensitive) → `manual_review`
   - `injection_detected` → `manual_review` (НЕ отправляется)

3. **`output-gate.validateReply()`** перед каждой публикацией:
   - length 2..5000 ✓
   - URLs только WB allowlist ✓
   - no email / phone / HTML / promises / insults ✓

**Когда включать live-llm:**
- [ ] Drafts pilot прошёл без инцидентов
- [ ] Ревьюер дал согласие
- [ ] Владелец подтвердил

---

## Этап 4: Full live (Phase 2 — personal token, self-managed)

**Когда:** через 30+ дней успешной работы на basic + есть ресурсы на свой сервер.

**Действия:**
1. Развернуть `server-later/` конфиг (Node.js + SQLite)
2. Получить **Personal** токен WB
3. Мигрировать D1 → SQLite export
4. Атомарный switch: `deployment=self_managed, profile=personal`
5. Оставить cloud worker выключенным

См. [`server-later/README.md`](../server-later/README.md) (Task 13).

---

## Тревоги и алерты

| Событие | Действие |
|---|---|
| 401/403 от WB | Остановить автопубликацию, проверить токен |
| 5 последовательных 429 | Circuit breaker (5 в ряд) — остановить на 15 мин |
| oldest ready > 24ч | Уведомление: очередь растёт |
| token expires < 7 дней | Сменить токен, обновить в env |
| dead job | Человек разбирает вручную |
| failed daily sync | Проверить доступность WB API |

---

## Runbook для daily operations

### Утро (9:00 МСК)
- Открыть панель → вкладка «Журнал» → последний `coordinator.tick`
- Если был — cron отработал, всё ОК
- Если не было — проверить cron-job.org, D1, Worker status

### При срабатывании alert
- Telegram-бот (если настроен, Task 13) → уведомление в канал
- Иначе — смотреть Vercel/Cloudflare logs

### Еженедельно
- Retention cleanup (Task 11) автоматически
- Проверить метрики в UI: posted/queued/manual

### Ежемесячно
- Обновить OpenRouter API key (rotation)
- Проверить, что WB токен не expires < 7 дней
- Review audit log на аномалии

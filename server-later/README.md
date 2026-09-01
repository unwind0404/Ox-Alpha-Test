# Phase 2: Self-managed server (Personal token) — **отложена**

> **Статус:** Phase 2 отложена согласно плану ревьюера.
> **Когда может понадобиться:** через 30+ дней успешной работы на basic + есть ресурсы на свой сервер.
> Personal token по ToS WB можно использовать только в self-managed инфраструктуре.

## Зачем

Cloudflare Workers — это облако. WB Personal-токен по ToS нельзя использовать в облаке (только on-premise / собственный ПК / VPS).

Для Personal-токена (3 req/sec, интервал 400 мс, **без ограничения 100/день**) нужен:
- Node.js + persistent SQLite
- Persistent worker с persistent scheduler (setInterval или OS cron)
- Прямой IP без NAT от cloud-провайдера

## Что меняется

| Cloud (Phase 1) | Self-managed (Phase 2) |
|---|---|
| Cloudflare Workers | Node.js LTS |
| D1 (SQLite) | SQLite на диске |
| Durable Object Alarms | OS cron + setInterval |
| Cloudflare Access | Basic Auth + IP whitelist |
| Basic token (5/hour) | Personal token (3/sec) |

## Что НЕ меняется

- **`src/core/`** — runtime-neutral, переиспользуется без изменений
- **`src/ports/`** — contracts те же
- **`src/adapters/wb/`** — WB client
- **`src/adapters/llm/`** — LLM client
- **`src/core/output-gate.ts`, `reply-policy.ts`, `rate-policy.ts`** — pure logic

## План миграции

1. **Cloud kill switch:** `enabled=false; дождаться отсутствия state=sending`
2. **D1 export** — скопировать shops/reviews/jobs/audit
3. **Развернуть** на VPS / dedicated server с persistent volume
4. **Импортировать** данные в SQLite
5. **Выпустить новый Personal token** (только category «Вопросы и отзывы», read+write)
6. **Сохранить** только в secret storage сервера; `deployment=self_managed, profile=personal`
7. **Read-only smoke** → drafts pilot → убедиться, что cloud writer выключен
8. **Отозвать** Basic token, удалить cloud ciphertext

## Файлы для нового рантайма

`server-later/` (создаются при миграции):
- `package.json` — те же deps, плюс `better-sqlite3`
- `src/index.ts` — entrypoint Node.js, заменяет Worker export
- `src/adapters/sqlite-shop-repository.ts` — реализация порта на better-sqlite3
- `src/adapters/sqlite-job-repository.ts` — то же
- `src/adapters/local-scheduler.ts` — setInterval / node-cron
- `src/adapters/local-auth.ts` — basic auth (заменяет Cloudflare Access)
- `migrations/*.sql` — те же схемы, но SQLite-диалект

## Smoke test перед миграцией

```bash
node scripts/smoke-staging.ts
```

Должен пройти:
- basic 100 replies ≥ 20h
- personal 10 replies < 60 sec
- 100/day limit проверка

## Запреты

- ❌ Нельзя обходить лимит через несколько токенов / аккаунтов / прокси
- ❌ Нельзя держать одновременно cloud (basic) и server (personal) writer'ы для одного `wb_account_key`
- ❌ Нельзя использовать Personal token в облачной инфраструктуре

## Lock file при миграции

Перед переключением cloud → server:
1. Cloud cron должен закончить текущий tick (нет `state=sending`)
2. Закрыть cloud worker (wrangler deployments list → delete)
3. Пометить cloud token в D1 как `rotated_at`
4. Только тогда запускать server с personal

Migration lock ОБЯЗАТЕЛЕН. Без него возможен дубль-ответ.

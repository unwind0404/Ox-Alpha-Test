# WB Review Bot v3

> Cloudflare Workers Free + Basic токен (5 req/час, 12-минутные слоты).
> Полная переделка по плану [Basic Now, Personal Later](./docs/architecture/basic-now-personal-later.md). Phase 2 (Personal токен) отложена.

## Стек

- **Runtime:** Cloudflare Workers (Free plan)
- **Storage:** D1 (SQLite) + Durable Objects (per `wb_account_key`)
- **Auth:** Cloudflare Access JWT (admin) / Cloudflare Cron (scheduled)
- **LLM:** OpenRouter `minimax/minimax-m3:free`
- **Strict TypeScript** + Vitest + ESLint + Wrangler

## Архитектура

Runtime-neutral core (`src/core/`) + ports (`src/ports/`) + adapters (`src/adapters/`).
Core не импортирует Cloudflare — это проверено в `test/unit/architecture.test.ts`.

```
src/
├── core/        # типы, state machine, rate policy, reply policy (без I/O)
├── ports/       # contracts (ShopRepository, SchedulerPort, etc)
├── adapters/    # cloudflare (D1, DO), wb, llm
├── coordinator/ # ShopCoordinator, sync, generate, publish
├── ui/          # admin panel (Cloudflare Access)
└── index.ts     # Worker entrypoint
migrations/     # D1 schema (versioned)
test/           # unit / integration / security
```

## Token matrix (fail-closed)

| Deployment | Profile | Allowed |
|---|---|---|
| cloud | basic | ✅ |
| cloud | personal | ❌ (WB ToS) |
| cloud | service | ❌ |
| self_managed | basic | ❌ |
| self_managed | personal | ✅ |
| self_managed | service | ❌ |

Phase 1 = `cloud + basic` — **это production setup**. Phase 2 (`self_managed + personal`) отложена; см. `server-later/README.md`.

## Локальная разработка

```bash
npm install
npm run typecheck   # strict TS
npm run lint        # ESLint
npm test            # Vitest
npm run dev         # wrangler dev (нужны D1, секреты)
```

## Деплой

```bash
wrangler d1 create wb-review-bot-db
# вставить database_id в wrangler.toml
npm run db:migrate:remote
wrangler secret put MASTER_KEY
wrangler secret put FINGERPRINT_KEY
wrangler secret put ADMIN_EMAILS
npm run deploy
```

## Acceptance Checklist

См. [docs/verification.md](./docs/verification.md) — что должно работать перед production.

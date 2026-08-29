# План переделки: Basic Now, Personal Later

> Источник: `2026-08-28-wb-basic-now-personal-later.md` (ревьюер передал как задание).

См. исходный файл в [../../2026-08-28-wb-basic-now-personal-later.md](../../2026-08-28-wb-basic-now-personal-later.md) (не коммитится).

## Краткая сводка

Phase 1: Cloudflare Workers + D1 + DO, basic токен, 1 sync в день, persistent 12-минутная очередь.
Phase 2: self-hosted Node + SQLite + Personal токен (заменяются только adapters).

## Глобальные ограничения

- Cloud = только `basic` profile. Personal в облаке запрещён WB ToS.
- Self-managed = только `personal` profile.
- 3 стратегии: `templates`, `drafts`, `llm`. Default — `drafts`.
- Daily sync: 07:00 UTC. Второй sync не включать.
- Basic: 5 req/hour, интервал 12 мин, safe 100 reply/24ч.
- Personal/Service: 3 req/sec, интервал 400 мс, последовательно 1.
- Никаких долгих `sleep`. Только alarm + state.
- Tokens — не в Git, не в D1 plaintext, не в логах.
- LLM output: Zod-валидация, no URLs/phones/emails/promises.
- Review text = untrusted data. Input isolation обязателен.
- 1-3 stars отзывы и инъекционные — только `manual_review`.
- Strict TS, no `any`, no `@ts-ignore`.

## Task Board (см. [PROJECT_CONTEXT.md](../../PROJECT_CONTEXT.md) Phase 9)

- [ ] Task 1: strict TS, vitest, CI, runtime-neutral boundaries, ports
- [ ] Task 2: D1 schema + state machine + ReviewStatusView
- [ ] Task 3: Access JWT, scheduled handler, security headers
- [ ] Task 4: AES-256-GCM токены, fail-closed token matrix
- [ ] Task 5: WB client + rate profiles + AbortSignal 12s
- [ ] Task 6: full daily sync без starvation
- [ ] Task 7: DO coordinator + lease + 12-мин alarms + forecast
- [ ] Task 8: templates + LLM + output gate + 3 стратегии
- [ ] Task 9: идемпотентный approve + publish + reconcile
- [ ] Task 10: UI + Zod + textContent + ETA + timeline
- [ ] Task 11: retention + observability + runbooks
- [ ] Task 12: shadow + drafts pilot
- [ ] Task 13: Phase 2 prep + server-later README

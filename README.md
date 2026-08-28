# WB Cron Bot

Панель управления автоответами на отзывы Wildberries.

**Деплой:** https://wb-cron-bot.vercel.app

## Что это

Серверный бот для продавцов Wildberries:
- Авто-ответы на отзывы (шаблоны или LLM через OpenRouter)
- Черновики с ручным одобрением
- Аналитика отзывов по темам (еженедельно + вручную)
- Telegram-уведомления (опционально)
- Несколько магазинов в одной панели

## Стек

- TypeScript + Vercel Serverless Functions
- Postgres (Neon) для хранения магазинов, отзывов, аналитики
- OpenRouter API для LLM-ответов и аналитики
- Vite + React для панели (внутри `wb-cron-bot/public/`)

## Структура

```
wb-cron-bot/
├── api/          # Vercel serverless functions (эндпоинты)
├── lib/          # Общая логика: БД, WB-клиент, LLM, Telegram
├── public/       # Фронтенд (HTML + JS + CSS)
└── vercel.json   # Расписание cron + maxDuration
```

## Локальная разработка

```bash
cd wb-cron-bot
npm install
vercel dev
```

## Контекст для агента

Подробный контекст проекта (стек, история решений, TODO) — в файле [`PROJECT_CONTEXT.md`](./PROJECT_CONTEXT.md). Читать в начале нового чата.

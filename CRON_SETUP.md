# Настройка внешнего cron (cron-job.org)

> Бот работает автономно, каждые 15 минут обрабатывает 2-3 отзыва.
> Vercel Hobby не разрешает cron чаще 1 раза в день — обходим через внешний сервис.

## Зачем

Vercel Hobby ограничивает cron до 1 запуска в день. Для автономной работы бота (новые отзывы появляются постоянно) нужен более частый запуск. Используем бесплатный [cron-job.org](https://cron-job.org) — он дёргает наш endpoint каждые 15 мин.

## Шаги настройки (3 минуты)

### 1. Зарегистрироваться на cron-job.org

- Откройте https://cron-job.org → **Sign Up** (бесплатно, без карты)
- Email + пароль, подтвердите почту

### 2. Создать новую cron-задачу

В панели cron-job.org → **CREATE CRONJOB**

| Поле | Значение |
|---|---|
| Title | `WB Cron Bot — tail` (любое) |
| URL | `https://wb-cron-bot.vercel.app/api/cron-all` |
| Method | `POST` |
| **Custom Headers** | `Authorization: Bearer f80fedc375775531204fc09b5cce9064af7d454813cec6980d1fb4326ae704e3` |
| Schedule | **Every 15 minutes** (или `*/15 * * * *` вручную) |
| Enabled | ✅ |

### 3. Проверить

В cron-job.org после создания → кнопка **RUN NOW** (или подождать 15 мин).  
В панели бота → вкладка «Черновики» → новые записи должны появляться каждые 15 мин.

## Альтернативные бесплатные сервисы (если cron-job.org не подходит)

| Сервис | Лимит | URL |
|---|---|---|
| cron-job.org | Безлимит (бесплатно) | https://cron-job.org |
| EasyCron | 5 крон / 1 мин | https://www.easycron.com |
| Cronitor (heartbeat) | 5 крон | https://cronitor.io |
| GitHub Actions | 2000 мин/мес (бесплатно) | https://github.com/features/actions |

Для GitHub Actions: создать `.github/workflows/cron.yml` с HTTP POST — обходит Vercel-лимит полностью.

## Безопасность

- `CRON_SECRET` — это длинная случайная строка (64 hex символа). Не светите её публично.
- Если секрет утечёт — сгенерируйте новый через Vercel env и обновите в cron-job.org.
- Запросы без правильного `Authorization` → 401 Unauthorized.

## Что делать, если Vercel Pro

Если перейдёте на Pro ($20/мес) — можно убрать cron-job.org и использовать встроенный cron:
- `vercel.json`: `"schedule": "*/15 * * * *"`
- Vercel будет сам дёргать `/api/cron-all` каждые 15 мин.
- Никаких внешних сервисов не нужно.

## Сводка: что уже настроено

✅ Backend готов (`/api/cron-all` принимает POST с `CRON_SECRET`)  
✅ Vercel деплой работает  
✅ Tail mode обрабатывает 2-3 отзыва за запуск  
✅ Pending_send стратегия против 429 накопления  
✅ Всё через бесплатные сервисы (Vercel Hobby, cron-job.org, Neon free, OpenRouter free)  

**Осталось:** настроить cron-job.org по инструкции выше — 3 минуты.

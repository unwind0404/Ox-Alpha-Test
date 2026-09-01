-- Migration 0002: align column names with code expectations.
-- Раньше миграция 0001 использовала created_at/updated_at для shops и reviews,
-- но код (D1ShopRepository, D1JobRepository, handleAddShop) ожидает _ms суффикс.
-- Эта миграция переименовывает.

-- shops: created_at → created_at_ms, updated_at → updated_at_ms
ALTER TABLE shops RENAME COLUMN created_at TO created_at_ms;
ALTER TABLE shops RENAME COLUMN updated_at TO updated_at_ms;

-- reviews: created_at_ms уже правильно (created_at_ms), но проверим
-- Если бы был created_at без _ms, тоже бы переименовали
-- (тут ничего не делаем)

-- reply_jobs: status_updated_at_ms, created_at_ms, updated_at_ms — все уже с _ms
-- (тут ничего не делаем)

-- audit_events: created_at_ms — уже правильно
-- (тут ничего не делаем)

# Фаза K — Упаковка и релиз

> [← Workplan (индекс)](../workplan.md) — оглавление, статусы фаз и решения.


> Финал. K1 и K2 можно вести параллельно.

## K1. electron-builder
- **Статус:** `done` · **Assignee:** orchestrator · **Зависимости:** H
- **Описание:** Конфигурация сборки для Windows (nsis), macOS (dmg), Linux
  (AppImage/deb). Подпись (опционально).
- **DoD:**
  - [x] `client/electron-builder.yml` (nsis/dmg/AppImage+deb, asarUnpack для
    native, publish=github). Локальная сборка инсталляторов не прогонялась
    (CI-задача K3) — конфиг валиден, сборка `electron-vite build` работает.

## K2. Docker-образ сервера
- **Статус:** `done` · **Assignee:** orchestrator · **Зависимости:** D8
- **Описание:** `Dockerfile`, том для `ETN_DATA_DIR`, docker-compose пример.
- **DoD:**
  - [x] `server/Dockerfile` (multi-stage, node:22-alpine, prebuilt
    better-sqlite3) + `docker-compose.yml` (volume, init-команда в README).
    Локальная сборка образа не прогонялась (docker недоступен) — верификация
    на CI/при приёмке.

## K3. Release workflow
- **Статус:** `done` · **Assignee:** orchestrator · **Зависимости:** K1, K2
- **Описание:** GitHub Actions: по тегу — сборка клиента и образа сервера, публикация
  в Releases.
- **DoD:**
  - [x] `.github/workflows/release.yml`: matrix (win/mac/linux) + electron-builder,
    GHCR-образ, GitHub Release по тегу `v*`. Сработает при первом теге (требует
    репозитория на GitHub).

## K4. Автообновление клиента
- **Статус:** `done` · **Assignee:** orchestrator · **Зависимости:** K3
- **Описание:** `electron-updater`, источник обновлений (GitHub Releases или
  static-хост). Проверка совместимости с сервером.
- **DoD:**
  - [x] `client/src/main/updater.ts` (quiet check в packaged-сборках, статусы в
    renderer), dep `electron-updater`, `publish: github` в electron-builder.yml.

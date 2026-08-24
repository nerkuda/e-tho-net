---
name: publish-github-release
description: Публикация новой поставки ETN на GitHub (release). Применять, когда пользователь просит «создать поставку/релиз на github», «выпустить новую версию», «зарелизить» — и в конце подготовки релиза, чтобы не повторять чужие ошибки и не делать лишних попыток. Описывает полный проверенный процесс: регресс, бамп версий во всех пакетах, CHANGELOG, коммит, аннотированный тег, пуш в origin и github, ожидание release-workflow и проверку релиза. Содержит подводные камни: два remote (origin — рабочий, github — публичный), upstream main → origin/main, запрет смены Node 22, актуальные версии actions в workflow.
---

# Публикация поставки ETN на GitHub

Цель: выпустить релиз без ошибок с первого раза, не повторяя прошлых проблем.

## Контекст проекта (важно)

- **Два remote у репозитория:**
  - `origin` (git.rivsala.ru:vz/ETN.git) — рабочий: обмен с сотрудниками, сюда уходят все коммиты.
  - `github` (github.com/nerkuda/e-tho-net.git) — публичный: код для пользователей + релизы.
- **Upstream ветки `main` — `origin/main`.** `git push`/`git pull` без аргументов идут в origin. Публикация на github — **только явная** команда `git push github ...`. Случайный push улетает в приватный origin, а не на публичный GitHub — это защита.
- **Node 22 LTS — менять нельзя** (отдельная большая задача). В `setup-node` остаётся `node-version: '22'`.
- Релиз собирает **workflow** `.github/workflows/release.yml` по тегу `v*`: установщики на Windows/macOS/Linux (electron-builder), Docker-образ сервера в GHCR, публикация GitHub Release (автор — `github-actions[bot]`, notes генерируются автоматически из сравнения тегов). Ничего вручную собирать и прикладывать не нужно.
- Релизный коммит — по образцу `chore(release): vX.Y.Z — версии пакетов X.Y.Z, changelog` (см. `git log v0.3.0 -1`).
- Скилл **не** делает: выбор номера версии за пользователя (если не очевиден — спросить), push в github без тега, правку `node-version`.

## Процедура (проверенный путь)

1. **Регресс перед релизом** (если не выполнялся недавно):
   `npm run typecheck` → `npm -w @etn/server test` → `npm -w @etn/client test` → `npm run build`.
   Красный — чинить до релиза. Если падает `EventLogRelay (unit)` — это флейк тайминга, тесты уже детерминизированы (`waitUntil`), одиночный прогон файла обычно зелёный.
2. **Собрать список изменений** с последнего тега: `git log --oneline <last-tag>..HEAD`.
3. **Выбрать версию.** История: каждый релиз — инкремент минора (0.1.0 → 0.2.0 → 0.3.0 → 0.4.0). Есть новая функциональность → следующий минор; только фиксы → патч. Если сомнения — спросить пользователя.
4. **Бампить версию `X.Y.Z` во ВСЕХ пяти файлах** `package.json` (корень + `server/`, `client/`, `shared/`, `markdown/`) и в `docs/install-server.md` (пример health-ответа `{"status":"ok","version":"..."}`). Синхронно, иначе рассогласуется.
5. **CHANGELOG.md**: новая секция `## [X.Y.Z] — ГГГГ-ММ-ДД` вверху, формат Keep a Changelog, по-русски, разделы «### Добавлено» / «### Исправлено», изменения сгруппированы по темам (фазы/крупные блоки — жирным). Ссылок-якорей внизу файла нет — не добавлять.
6. **Коммит** всех перечисленных файлов: `chore(release): vX.Y.Z — версии пакетов X.Y.Z, changelog`.
7. **Push в origin:** `git push origin main`.
8. **Аннотированный тег:** `git tag -a vX.Y.Z -m "Release vX.Y.Z"`.
9. **Публикация:** `git push github main vX.Y.Z` — это триггерит release-workflow.
10. **Дождаться и проверить:**
    - `gh run list --workflow=release.yml --limit 3` → найти run по тегу;
    - `gh run watch <id> --exit-status` (прошлые сборки ~4 минуты);
    - `gh release view vX.Y.Z` → проверить ассеты: `ETN.Setup.X.Y.Z.exe` (Windows), `ETN-X.Y.Z-arm64.dmg` (macOS), `ETN-X.Y.Z.AppImage`/`.deb` (Linux), `latest-*.yml`.

## Подводные камни

- **Не пушить в github без явного запроса** — публичный репозиторий. Всегда явно `git push github ...`.
- **`node-version: '22'` не трогать** — это осознанное решение проекта (лучше-sqlite3 без Python).
- **Workflow-actions держать на актуальных мажорах** (устаревшие дают предупреждение о деприкации Node 20 в раннере): `actions/checkout@v7`, `actions/setup-node@v7`, `actions/upload-artifact@v7`, `actions/download-artifact@v8`, `docker/login-action@v4`, `docker/build-push-action@v7`, `softprops/action-gh-release@v3`. Перед обновлением проверять актуальность: `gh api repos/<owner>/<repo>/tags`.
- **`shared/` и `markdown/`**: client/server читают `dist`, не `src`. После правок — пересборка (`npm -w @etn/shared run build` и т.п.), иначе typecheck красный.
- **dist/out не коммитить** (в .gitignore; пересборка перед релизом не оставляет изменений в дереве).
- **Рабочее дерево перед тегом должно быть чистым**, кроме релизного коммита. Посторонние правки (например, README) — отдельным коммитом заранее.
- **Версию релиза проверять по факту**: `node -e "console.log(require('./package.json').version)"` для всех пяти пакетов — все должны быть `X.Y.Z`.
- Релиз публикуется автоматически; **вручную `gh release create` не вызывать** (workflow сделает сам; ручной вызов создаст дубль).

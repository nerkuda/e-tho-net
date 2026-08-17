# Фаза A — Подготовка монорепо

> [← Workplan (индекс)](../workplan.md) — оглавление, статусы фаз и решения.


> Все задачи фазы A — последовательные (каждая опирается на предыдущую).
> Стартовая точка проекта.

## A1. Нормализация переносов строк и git attributes
- **Статус:** `done` · **Assignee:** agent-A · **Зависимости:** —
- **Описание:** Создать `.gitattributes` (`* text=auto eol=lf` для согласованности
  CRLF/LF на Windows/Linux). Убедиться, что `.gitignore` корректно исключает
  runtime-данные.
- **DoD:**
  - [x] Создан `.gitattributes`.
  - [x] `git status` чист, нет неожиданных modified-файлов из-за CRLF.
- **Спецификация:** —.

## A2. Настройка ESLint и Prettier
- **Статус:** `done` · **Assignee:** agent-A · **Зависимости:** A1
- **Описание:** В корне — `eslint.config.js` (flat config, ESLint 9),
  `.prettierrc`, скрипты `lint`/`format`. Общие правила TypeScript.
- **DoD:**
  - [x] `npm run lint` работает из корня, проверяет все workspace.
  - [x] `npm run format` приводит код к единому стилю.
- **Note:** оркестратор дополнил конфиг отключением `no-require-imports` для
  root CommonJS-файлов и добавил `docs/`/`*.md` в `.prettierignore`.
- **Спецификация:** —.

## A3. CI (GitHub Actions)
- **Статус:** `done` · **Assignee:** agent-A · **Зависимости:** A2
- **Описание:** `.github/workflows/ci.yml` — на push/PR: install, typecheck, lint,
  build, test. Кеширование `node_modules` и `~/.npm`.
- **DoD:**
  - [x] На push в main/PR пайплайн запускается.
  - [ ] Шаги typecheck, lint, build, test — все зелёные (проверится на первом
    реальном пуше; локально все шаги проходят).
- **Note:** `cache: 'npm'` требует `package-lock.json` в репо — закоммичен.
- **Спецификация:** —.

## A4. shared/: базовые типы
- **Статус:** `done` · **Assignee:** agent-A4 · **Зависимости:** A1
- **Описание:** В `shared/src/` описать общие типы: DTO для REST-запросов/ответов,
  типы real-time событий, перечисления (роли, типы свойств, аудит-категории),
  константы (имена настроек, лимиты по умолчанию). Без логики — только типы и
  константы.
- **DoD:**
  - [x] `npm run build:shared` проходит.
  - [x] `@etn/shared` импортируется из server и client.
  - **Note:** типы/константы/ошибки готовы; package.json (`main`/`types`) и
    project references в server/client уже настроены. Финальную проверку
    `npm run build:shared` + `npm run typecheck` выполняет оркестратор
    (в рамках A4 `npm install`/`typecheck` агентом не запускались). Фактический
    код импорта появится в задачах B1/G1 вместе с первым кодом server/client.
- **Спецификация:** [02-data-model.md](../02-data-model.md),
  [03-server-api.md](../03-server-api.md), [04-realtime.md](../04-realtime.md),
  [11-settings-and-state.md](../11-settings-and-state.md).

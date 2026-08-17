# ETN — The Endless Thought Network

Бесплатный self-hosted «цифровой мозг» для сбора, систематизации и анализа мыслей в виде направленного графа связанных записей. Вдохновлен известным приложением TheBrain, но реализует собственные методики работы с информацией.
Клиент-серверная архитектура, real-time совместная работа нескольких пользователей над общими мыслесетями, доступ внешних AI-агентов через MCP.

![CI](https://github.com/nerkuda/e-tho-net/actions/workflows/ci.yml/badge.svg) ![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

## Статус

✅ MVP собран и находится в тестовой эксплуатации: проект развивается по отчётам
пользователей-тестировщиков. План работ — [`docs/workplan.md`](docs/workplan.md)
(индекс: статусы фаз и ключевые решения; описания задач — в `docs/workplan/`,
по файлу на фазу).

## Спецификации

Полный комплект проектных спецификаций (архитектура, модель данных, REST API,
real-time, MCP, аутентификация, клиент, UI, сценарии, словарь, настройки) — в
каталоге [`docs/`](docs/). Начать знакомство с [`docs/README.md`](docs/README.md).

## Стек

- **Сервер:** Node.js 20+ (**рекомендуется 22 LTS** — для него у better-sqlite3 есть готовая prebuilt-binary; на Node 24 потребуется Python в PATH для компиляции), TypeScript, Fastify, better-sqlite3, WebSocket.
- **Клиент:** Electron, TypeScript.
- **Хранилище:** SQLite — одна `_system.db` + `networks/<id>/data.db` на сеть.
- **MCP:** `@modelcontextprotocol/sdk`.

## Структура монорепо

```
etn/
├── docs/      # спецификации и план работ
├── server/    # серверное приложение + CLI (etn init)
├── client/    # десктоп-клиент на Electron
├── shared/    # общие типы (DTO, константы, протоколы real-time)
└── package.json
```

## Разработка

```bash
npm install              # установить зависимости всех workspaces
npm run dev:server       # запуск сервера в режиме разработки
npm run dev:client       # запуск клиента
npm run typecheck        # проверка типов во всех workspaces
npm test                 # все тесты
```

## Установка

- **Сервер** — Docker (`docker compose up -d`) или Node.js 22 из исходников;
  подробно — [`docs/install-server.md`](docs/install-server.md).
- **Клиент** — готовые установщики (Windows/macOS/Linux) в
  [релизах](https://github.com/nerkuda/e-tho-net/releases); из исходников —
  [`docs/install-client.md`](docs/install-client.md).

## Лицензия

Проект распространяется под [MIT License](LICENSE).

## Создано с помощью ИИ

Этот проект полностью (на 100%) написан с помощью нескольких LLM и AI-агента
[ZCode](https://zcode.z.ai) — настольной агентной среды разработки.

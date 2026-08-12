# ETN — The Endless Thought Network

Бесплатный self-hosted аналог программы TheBrain: «цифровой мозг» для сбора,
систематизации и анализа мыслей в виде направленного графа связанных записей.
Клиент-серверная архитектура, real-time совместная работа нескольких
пользователей над общими мыслесетями, доступ внешних AI-агентов через MCP.

## Статус

🚧 Активное проектирование и начало реализации. План работ — в
[`docs/workplan.md`](docs/workplan.md).

## Спецификации

Полный комплект проектных спецификаций (архитектура, модель данных, REST API,
real-time, MCP, аутентификация, клиент, UI, сценарии, словарь, настройки) — в
каталоге [`docs/`](docs/). Начать знакомство с [`docs/README.md`](docs/README.md).

## Стек

- **Сервер:** Node.js 20+, TypeScript, Fastify, better-sqlite3, WebSocket.
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

## Лицензия

(определяется перед публичным релизом)

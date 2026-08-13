# Установка сервера ETN

> MVP. Сервер — один Node.js-процесс, хранит данные в SQLite.
> Рекомендуемая ОС: любая, где работает Node.js 22 LTS (Linux, Windows, macOS).

## 1. Требования

- **Node.js 22 LTS** (обязательно 20+, рекомендуется 22 — для `better-sqlite3`
  есть готовая prebuilt-binary; на Node 24 потребуется Python в PATH для
  компиляции).
- npm 10+ (идёт с Node).
- Свободный TCP-порт (по умолчанию `4321`).
- Для продакшена — обратный прокси с TLS (nginx/caddy) или собственные
  сертификаты (`ETN_TLS_CERT`/`ETN_TLS_KEY`).

## 2. Установка

```bash
git clone <репозиторий ETN>
cd etn
npm install          # установит все workspace (сервер не требует клиента)
npm run build        # сборка TypeScript
```

Для установки только сервера достаточно каталога `server/` + `shared/` — но
проще ставить всё монорепо.

## 3. Инициализация

```bash
export ETN_DATA_DIR=/var/lib/etn      # каталог хранения данных
node server/dist/cli.js init --username admin --display-name "Administrator"
```

Результат — **первичный API-key**, который печатается **ровно один раз**:

```
ETN инициализирован.
Создан пользователь-администратор:
  Имя пользователя:  admin
  Первичный API-key (показан один раз — сохраните его):
  etn_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Сохраните ключ в надёжном месте. Восстановить его нельзя — только перевыпустить
через другого администратора.

Без `init` сервер не стартует (нет ни одного администратора).

## 4. Переменные окружения

| Переменная | Default | Описание |
|-----------|---------|----------|
| `ETN_DATA_DIR` | — (обязательна) | Каталог данных: `_system.db` + `networks/<id>/` |
| `ETN_HOST` | `0.0.0.0` | Адрес прослушивания |
| `ETN_PORT` | `4321` | Порт HTTP |
| `ETN_TLS_CERT` / `ETN_TLS_KEY` | — | Сертификат и ключ (включают HTTPS/WSS) |
| `ETN_LOG_LEVEL` | `info` | `trace`/`debug`/`info`/`warn`/`error` |
| `ETN_MCP_ENABLED` | `0` | `1` — включить MCP-эндпоинт `/mcp` на сервере |
| `ETN_MCP_PORT` | — | Отдельный порт только для MCP (опционально) |

## 5. Запуск

```bash
ETN_DATA_DIR=/var/lib/etn node server/dist/index.js
```

Проверка:

```bash
curl http://localhost:4321/api/v1/health
# {"status":"ok","version":"0.1.0","uptime":...}
```

### 5.1. systemd (Linux)

```ini
# /etc/systemd/system/etn.service
[Unit]
Description=ETN server
After=network.target

[Service]
Type=simple
User=etn
Environment=ETN_DATA_DIR=/var/lib/etn
Environment=ETN_PORT=4321
WorkingDirectory=/opt/etn
ExecStart=/usr/bin/node /opt/etn/server/dist/index.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd -r -m etn
sudo mkdir -p /var/lib/etn && sudo chown etn:etn /var/lib/etn
sudo systemctl daemon-reload && sudo systemctl enable --now etn
```

## 6. Docker

Образ собирается из `server/Dockerfile` (см. `docker-compose.yml` в корне):

```bash
docker compose up -d
```

Том `etn_data` монтируется на `/data`. Инициализация при первом запуске:

```bash
docker compose run --rm etn node /app/server/dist/cli.js init --username admin --display-name Admin
```

## 7. Резервное копирование

ETN хранит всё в `ETN_DATA_DIR`:

```
_data_dir/
├── _system.db
└── networks/
    └── <uuid>/
        ├── data.db
        ├── attachments/   (зарезервировано)
        └── snapshots/
```

- **Бэкап:** остановить сервер (или выполнить checkpoint) и скопировать каталог
  целиком.
- **Восстановление:** положить каталог обратно и запустить сервер.
- Каждая мыслесеть — изолированный каталог; её можно переносить на другой
  сервер (с переносом записи в `_system.db`).

## 8. Обновление

```bash
git pull
npm install
npm run build
sudo systemctl restart etn
```

Миграции SQLite применяются автоматически при старте.

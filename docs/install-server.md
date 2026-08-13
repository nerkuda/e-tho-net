# Установка сервера ETN

> MVP. Сервер — один Node.js-процесс, хранит данные в SQLite.
> Поддерживаемые ОС: Linux, Windows 10/11, macOS. Node.js 22 LTS.

Команды в этом документе даны **в двух видах** — для bash (Linux, macOS, Git Bash
на Windows) и для PowerShell (Windows). Если у вас установлен
[Git for Windows](https://git-scm.com/download/win), bash-варианты работают в
«Git Bash» без изменений. Для большинства пользователей Windows самый простой
путь — **Docker Desktop** (см. §6).

## 1. Требования

- **Node.js 22 LTS** (обязательно 20+, рекомендуется 22 — для `better-sqlite3`
  есть готовая prebuilt-binary; на Node 24 потребуется Python в PATH для
  компиляции).
- npm 10+ (идёт с Node).
- Свободный TCP-порт (по умолчанию `4321`).
- Для продакшена — обратный прокси с TLS (nginx/caddy/IIS) или собственные
  сертификаты (`ETN_TLS_CERT`/`ETN_TLS_KEY`).

Проверка версии Node:

```bash
node --version    # bash (Linux/macOS/Git Bash)
```
```powershell
node --version    # PowerShell
```

Должно вывести `v22.x.x`.

## 2. Установка

```bash
# bash
git clone <репозиторий ETN>
cd etn
npm install          # установит все workspace
npm run build        # сборка TypeScript
```
```powershell
# PowerShell
git clone <репозиторий ETN>
cd etn
npm install
npm run build
```

Для установки только сервера достаточно каталога `server/` + `shared/` — но
проще ставить всё монорепо.

## 3. Инициализация (первый пользователь)

Первый пользователь-администратор создаётся CLI-командой `etn init`.
Без `init` сервер не стартует (нет ни одного администратора).

```bash
# bash
export ETN_DATA_DIR=/var/lib/etn      # Linux/macOS
# или для Git Bash на Windows:
export ETN_DATA_DIR="C:/etn/data"

node server/dist/cli.js init --username admin --display-name "Administrator"
```
```powershell
# PowerShell
$env:ETN_DATA_DIR = "C:\etn\data"

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
через другого администратора. Дальше пользователи создаются через админ-панель
клиента (или REST `POST /api/v1/admin/users`) — эта команда нужна только один
раз, при первом запуске.

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

**Как задать переменные** — три варианта.

Однократно перед запуском (не переживёт закрытие терминала):

```bash
# bash
export ETN_DATA_DIR=/var/lib/etn
export ETN_PORT=4321
```
```powershell
# PowerShell — только на текущую сессию
$env:ETN_DATA_DIR = "C:\etn\data"
$env:ETN_PORT = "4321"
```

Постоянно для пользователя (переживает перезагрузку):

```bash
# bash — дописать в ~/.bashrc (Linux/macOS) или ~/.bash_profile (Git Bash)
echo 'export ETN_DATA_DIR=/var/lib/etn' >> ~/.bashrc
source ~/.bashrc
```
```powershell
# PowerShell — постоянно для текущего пользователя Windows
[Environment]::SetEnvironmentVariable("ETN_DATA_DIR", "C:\etn\data", "User")
# перезапустите PowerShell, чтобы переменная подхватилась
```

Через `.env`-файл в корне проекта ( server читает его автоматически при запуске
через `node` — скопируйте `.env.example` в `.env`):

```bash
cp .env.example .env      # bash
```
```powershell
Copy-Item .env.example .env   # PowerShell
```
Затем отредактируйте `.env` любым текстовым редактором.

## 5. Запуск

```bash
# bash
ETN_DATA_DIR=/var/lib/etn node server/dist/index.js
# или (если переменная уже задана):
node server/dist/index.js
```
```powershell
# PowerShell (переменная задаётся на сессию, затем запуск)
$env:ETN_DATA_DIR = "C:\etn\data"
node server/dist/index.js
# или одной строкой, без сохранения переменной в сессии:
$env:ETN_DATA_DIR = "C:\etn\data"; node server/dist/index.js
```

Проверка:

```bash
curl http://localhost:4321/api/v1/health        # bash
```
```powershell
Invoke-RestMethod http://localhost:4321/api/v1/health   # PowerShell
```

Должно вернуть `{"status":"ok","version":"0.1.0","uptime":...}`.

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

### 5.2. Запуск как служба на Windows

Самый простой способ — **[nssm](https://nssm.cc/)** (Non-Sucking Service Manager):

```powershell
# 1. Установить nssm (скачать с https://nssm.cc/ и положить в PATH)
# 2. Зарегистрировать службу:
nssm install ETN "C:\Program Files\nodejs\node.exe" "C:\etn\server\dist\index.js"
nssm set ETN AppDirectory "C:\etn"
nssm set ETN AppEnvironmentExtra ETN_DATA_DIR=C:\etn\data ETN_PORT=4321
nssm set ETN Start SERVICE_AUTO_START
nssm start ETN
```

Управление:

```powershell
Start-Service ETN       # запуск
Stop-Service ETN        # остановка
Restart-Service ETN     # перезапуск
Get-Service ETN         # статус
# Удаление:
nssm remove ETN confirm
```

Альтернатива — **Планировщик задач** (Task Scheduler) с триггером «при запуске»,
либо **node-windows** (npm-пакет). Для Docker Desktop на Windows — см. §6, там
служба поднимается одной командой.

## 6. Docker (любая ОС, включая Windows)

Самый простой путь на Windows — установить
[Docker Desktop](https://www.docker.com/products/docker-desktop/), затем в корне
проекта:

```bash
docker compose up -d          # bash / PowerShell — одинаково
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

```bash
# bash
sudo systemctl stop etn            # Linux
cp -r /var/lib/etn /backup/etn-$(date +%F)
sudo systemctl start etn
```
```powershell
# PowerShell (Windows, служба nssm)
Stop-Service ETN
$stamp = Get-Date -Format "yyyy-MM-dd"
Copy-Item -Recurse "C:\etn\data" "C:\backup\etn-$stamp"
Start-Service ETN
```

## 8. Обновление

```bash
# bash
git pull
npm install
npm run build
sudo systemctl restart etn
```
```powershell
# PowerShell
git pull
npm install
npm run build
Restart-Service ETN    # если сервер как служба; иначе — перезапустить процесс
```

Миграции SQLite применяются автоматически при старте — отдельных действий не
требуется.

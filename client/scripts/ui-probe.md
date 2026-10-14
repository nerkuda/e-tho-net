# GUI-стенд клиента ETN (`client/scripts/ui-probe*`)

Штатный инструмент GUI-проверки клиента без видимого окна: подключается к
клиенту по Chrome DevTools Protocol (CDP), прогоняет JSON-сценарий и отдаёт
ТЕКСТОВЫЙ отчёт «шаг → проба → факт/ожидание». Модель проверяет поведение
пробы и чтения БД, а не картинки: PNG сохраняется только как доказательство
найденной ошибки.

Инструмент — **платформа**, а не набор зашитых проверок: сценарии пишутся под
задачу и поставляются вместе с работой. Единственный встроенный сценарий —
эталонный smoke (см. ниже), он же образец.

## Состав

| Файл | Роль |
| --- | --- |
| `ui-probe-stand.mjs` | Подъём изолированного стенда ОДНОЙ командой: сервер на копии данных / свежей базе + скрытый клиент. |
| `ui-probe.mjs` | Раннер сценария по CDP (к нему подключается `--scenario`). |
| `ui-probe-scenario.mjs` | Чистый разбор/валидация сценария (`+ .d.mts`). |
| `ui-probe-image.mjs` | Чистый PNG-декод и программные проверки региона (шаг `assert`). |
| `ui-probe-launch.mjs` | Обёртка запуска скрытого клиента (изолированный профиль, `ETN_HIDDEN_WINDOW=1`, CDP). |
| `ui-probe.smoke.scenario.json` | Эталонный smoke-сценарий. |
| `ui-probe.scenario.example.json` | Пример сценарных шагов. |

## Быстрый старт (одна команда)

```bash
# собрать сервер и клиент один раз
npm -w @etn/server run build
npm -w @etn/client run build
npm -w @etn/client run rebuild:native   # один раз после npm install

# эталонная самопроверка стенда (подключение → мысль → правка комментария →
# форматирование → сохранение → контроль в БД стенда)
node client/scripts/ui-probe-stand.mjs --scenario client/scripts/ui-probe.smoke.scenario.json
```

Команда сама: готовит изолированный каталог данных и инициализирует сервер,
засеивает пробную сеть, поднимает скрытый клиент с изолированным профилем,
прогоняет сценарий, проверяет эффект по REST и гасит стенд (включая дерево
процессов Electron). Код возврата — код прогона (0 — все шаги сошлись).

Интерактивный режим (стенд живёт до Ctrl+C, печатает готовую команду прогона):

```bash
node client/scripts/ui-probe-stand.mjs            # свежая база + сид
node client/scripts/ui-probe-stand.mjs --data-from C:/zSpace/ETN_data --api-key etn_…
```

## Сценарий

Формат — JSON-объект `{ name?, description?, timeout?, steps: [...] }`. Каждый
шаг — ровно одно действие (+ необязательные `name`, `timeout`, `expect`). В
строках работают подстановки `{{имя}}`; значения задаёт раннер через
`--var имя=значение` (стенд подставляет адрес, API-key и id засеянных
сущностей).

| Действие | Вид | Назначение |
| --- | --- | --- |
| `key` | `{ "key": "ArrowDown", "modifiers": ["shift"] }` | клавиши/сочетания (CDP `Input.dispatchKeyEvent`) |
| `click` | `"#sel"` \| `{ "selector": "#sel", "at": [4,4] }` \| `[640,400]` \| `{ "x":10, "y":20 }` | клик по элементу/координатам (CDP) |
| `hover` | та же форма точки, что у `click` | навести курсор БЕЗ клика (`mouseMoved`) — включает CSS `:hover` (проверка hover-видимости действий) |
| `text` | `"строка"` | ввод текста (CDP `Input.insertText`) |
| `waitFor` | `"expr"` \| `{ "expression": "…", "frames": 2 }` \| `2` | ожидание по условию; кадровые ожидания — только при активном окне |
| `probe` | `"expr"` \| `{ "name": "rows", "expression": "…" }` | прочитать значение и записать в отчёт; `expect` — сверка «факт/ожидание» |
| `eval` | `"expr"` | побочное действие без записи значения |
| `shot` | `"01.png"` \| `{ "file": "01.png", "clip": "#sel" }` | PNG (только доказательство ошибки) |
| `assert` | см. ниже | растровый ассерт: кроп + проверки, результат текстом |
| `api` | см. ниже | HTTP-запрос к серверу стенда ИЗ РАННЕРА (проверка эффекта/БД) |

### Растровые ассерты (`assert`)

```json
{
  "assert": {
    "name": "focus-cloud",
    "region": ".canvas-focus-row .cloud",
    "checks": [
      { "kind": "notBlank", "minRatio": 0.05 },
      { "kind": "distinct", "minColors": 3 },
      { "kind": "hasColor", "color": "#1b1b1b", "tolerance": 24, "minPixels": 10 },
      { "kind": "colorAt", "at": [4, 4], "color": "#ffffff", "tolerance": 8 }
    ],
    "evidence": false
  }
}
```

`region` — селектор | `[x,y,w,h]` | `{x,y,width,height}`. Проверки:
`notBlank` (доля пикселей, отличных от фонового), `colorAt` (цвет пикселя по
смещению), `hasColor` (число пикселей нужного цвета), `distinct` (число
различимых цветов). PNG пишется только при `evidence: true`.

### Проверки на сервере (`api`)

```json
{
  "api": {
    "name": "comment-in-db",
    "method": "GET",
    "path": "/networks/{{networkId}}/thoughts/{{thoughtId}}/comments",
    "expression": "data.find((c) => c.kind === 'permanent').body_md"
  },
  "expect": "**текст**"
}
```

Обёртка `data` ответа разворачивается; `expression` вычисляется от неё;
`expect` (мета) — ожидаемое значение. Так проверяется эффект ИМЕННО на
сервере/в БД: CDP страницы не видит HTTP main-процесса Electron (грабли
`aa5cf162`).

Необязательное поле `body` (объект) шлёт JSON-тело запроса — сценарий может
не только проверять эффект, но и ЗАСЕИВАТЬ данные перед прогоном (например,
POST дневниковой записи). Пример — `ui-probe.diary-create-thought.scenario.json`.

## Отчёт

`<out>/report.txt` — человекочитаемый «шаг → проба → факт/ожидание»;
`<out>/report.json` — машинный. PNG — только при шаге `shot` или `assert` с
`evidence: true`.

Шаги `assert`/`api` без `expect` дают только факт; с `expect` — сверку.

## Рецепт изолированного стенда (перенесён из карточки компонента `9eddf9c0`)

Раньше стенд поднимали вручную; `ui-probe-stand.mjs` делает это одной
командой. Рецепт ниже — для понимания, что происходит «под капотом», и для
ручной отладки.

1. **Данные.** Изолированный каталог, чтобы не трогать полигон:

   ```bash
   rm -rf .tmp/<st>/data && mkdir -p .tmp/<st>
   ETN_DATA_DIR=C:/R/ETN/.tmp/<st>/data ETN_PORT=4405 node server/dist/cli.js init --username admin > .tmp/<st>/init.log
   grep -o "etn_[a-f0-9]*" .tmp/<st>/init.log | head -1 > .tmp/<st>/key.txt
   ```

2. **Сервер в фоне:**

   ```bash
   ETN_DATA_DIR=C:/R/ETN/.tmp/<st>/data ETN_PORT=4405 ETN_HOST=127.0.0.1 node server/dist/index.js > .tmp/<st>/server.log 2>&1 &
   curl -s http://127.0.0.1:4405/api/v1/health    # готовность
   ```

3. **Сид через REST** (`Authorization: Bearer <key>`): сеть (`POST /networks`),
   HOME (`POST /networks/<id>/thoughts/query`, искать `title === 'HOME'`),
   мысль с комментарием (`POST /networks/<id>/thoughts` с `comment` и
   `create_link.direction = 'parent'`).

4. **Скрытый клиент** (нужна сборка `npm -w @etn/client run build`):

   ```bash
   node client/scripts/ui-probe-launch.mjs --port 9340 --profile C:/R/ETN/.tmp/<st>/profile
   ```

5. **Онбординг сценарием**: `input[placeholder^='http']` = адрес сервера,
   `input[type=password]` = ключ, клик по кнопке «Подключиться»
   (`.onboarding-card .ui-btn--primary`); затем открыть сеть кликом по
   `.network-item`.

6. **Пробуждение скрытой страницы** — раннер делает это сам (по умолчанию) через
   CDP: `Page.bringToFront`, `Emulation.setFocusEmulationEnabled`,
   `Page.setWebLifecycleState('active')` (грабли `03e33360`).

7. **Подсчёт/контроль эффекта — по серверу** (access-log или REST), не по UI
   (грабли `aa5cf162`).

8. **Закрытие.** `ui-probe-stand.mjs` гасит дерево процессов (`taskkill /T`);
   вручную — по PID процесса CDP: `taskkill //PID <pid> //T //F`.

## Грабли (обязательно к учёту)

- **`03e33360`** — в скрытом окне заморожены rAF/layout, документ `hidden`.
  Раннер «будит» страницу через CDP; ждать — по условию/строке, НЕ по кадрам.
- **`aa5cf162`** — CDP страницы не видит HTTP main-процесса Electron: эффект
  проверяй на сервере (шаг `api` / access-log), а не в CDP Network.
- **`91720eda`** — без изолированного профиля клиент делит лок и БД с клиентом
  пользователя и поднимает ЕГО окно. Запускать клиент ТОЛЬКО через
  `ui-probe-launch.mjs` (или `ui-probe-stand.mjs`), никогда — напрямую.
- **Видимое окно запрещено** на рабочей машине пользователя: окно проверки не
  должно перехватывать фокус. `ETN_HIDDEN_WINDOW=1` ставит обёртка.

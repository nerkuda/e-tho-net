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

Ожидание у шагов `probe`/`api` задаётся одним из двух (взаимоисключающе):
`expect` — литерал, либо `expectFrom` — **снимок** значения, прочитанного
ранее выполненным шагом `probe`/`api` с указанным `name`. Снимок делает
сценарий самопроверяемым: «после равно до» без зашитого списка (например,
паритет заголовков разделов до и после правки рецепта — сценарий
`ui-probe.publication-recipe.scenario.json`).

| Действие | Вид | Назначение |
| --- | --- | --- |
| `key` | `{ "key": "ArrowDown", "modifiers": ["shift"] }` | клавиши/сочетания (CDP `Input.dispatchKeyEvent`) |
| `click` | `"#sel"` \| `{ "selector": "#sel", "at": [4,4] }` \| `[640,400]` \| `{ "x":10, "y":20 }` \| `{ "selector": "#sel", "count": 2 }` | клик по элементу/координатам (CDP); `count: 2` — двойной клик (`click.detail >= 2`) |
| `hover` | та же форма точки, что у `click` | навести курсор БЕЗ клика (`mouseMoved`) — включает CSS `:hover` (проверка hover-видимости действий) |
| `drag` | `{ "from": "#handle", "to": { "selector": "#row", "at": [10,2] }, "expect": "#row", "steps": 8, "duration": 120, "modifiers": ["shift"] }` | составной жест: pointerdown в `from`, `steps` промежуточных `mouseMoved`, ожидание попадания в `expect`, pointerup в `to`. `expect` обязателен — промах координат ПРОВАЛИВАЕТ шаг (грабли `7c521541`), ожидание — по условию `elementFromPoint` (грабли `03e33360`) |
| `text` | `"строка"` | ввод текста (CDP `Input.insertText`) |
| `waitFor` | `"expr"` \| `{ "expression": "…", "frames": 2 }` \| `2` | ожидание по условию; кадровые ожидания — только при активном окне |
| `probe` | `"expr"` \| `{ "name": "rows", "expression": "…" }` | прочитать значение и записать в отчёт; `expect`/`expectFrom` — сверка «факт/ожидание» |
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

### Самопроверка «до ↔ после» (`expectFrom`)

Ожидание можно не зашивать, а взять из снимка, снятого ранее тем же сценарием:
шаг `probe`/`api` с `"name": "<шаг>"` сохраняет своё значение, а последующий шаг
с `"expectFrom": "<шаг>"` сверяется с ним. Так проверяется паритет результата до
и после правки:

```json
{ "name": "headings-before",
  "api": { "name": "headings-before", "method": "GET",
           "path": "/networks/{{networkId}}/publications/{{pubId}}/assembly",
           "expression": "data.sections.map((s) => s.heading)" } },
{ "name": "headings-after",
  "api": { "name": "headings-after", "method": "GET",
           "path": "/networks/{{networkId}}/publications/{{pubId}}/assembly",
           "expression": "data.sections.map((s) => s.heading)" },
  "expectFrom": "headings-before" }
```

`expectFrom` ссылается на `name` уже выполненного шага `probe`/`api`; ссылка на
невыполненный/чужой шаг — ошибка шага. `expect` и `expectFrom` взаимоисключающи.
Живой образец — `ui-probe.publication-recipe.scenario.json`.

### Затравка markdown-поля (CodeMirror) — только через API

Текст в markdown-поле (постоянный комментарий, тело записи) сценарий заводит
**шагом `api`**, а НЕ «печатью» в редактор. CodeMirror 6 живёт на собственной
транзакционной модели: ни CDP `Input.insertText` (шаг `text`), ни синтетические
`paste`/`beforeinput`/`ClipboardEvent` её не меняют — DOM может измениться, а
состояние редактора НЕТ: сохранение не уходит, в БД остаётся старый текст, и все
последующие пробы читают прежний контент (грабли `4c035087`). Клавиатурные
сочетания при этом работают (шаг `key` с `modifiers`) — не работает только набор
текста.

Рецепт самодостаточного сценария (без `--seed-comment`):

```json
{ "name": "seed-comment-api",
  "api": { "name": "seededComment", "method": "POST",
           "path": "/networks/{{networkId}}/thoughts/{{homeId}}/comments",
           "body": { "kind": "permanent", "body_md": "…исходник с URL…" },
           "expression": "data.kind" },
  "expect": "permanent" }
```

Дальше — открыть владельца (`click` по `[data-id="{{homeId}}"].cloud` для
корневой мысли), поле покажет заведённый текст.

- Постоянный комментарий заводится только там, где его ещё НЕТ (иначе
  `DUPLICATE`): у корневой мысли HOME своего комментария нет — удобный владелец.
- Альтернатива — `--seed-comment` стенда (тот же путь через REST), но тогда
  сценарий несамодостаточен: без флага прогон разваливается.
- Пробы, читающие DOM, снимай после стабилизации (образец — установленный
  `window.__poll` в `ui-probe.comment-autolink-37458cbc.scenario.json`): сразу
  после записи поле перерисовывается realtime-событием, и проба может поймать
  промежуточный DOM.

## Отчёт

`<out>/report.txt` — человекочитаемый «шаг → проба → факт/ожидание»;
`<out>/report.json` — машинный. PNG — только при шаге `shot` или `assert` с
`evidence: true`.

Шаги `probe`/`api` без `expect`/`expectFrom` дают только факт; с `expect` —
сверку с литералом, с `expectFrom` — сверку со снимком ранее выполненного шага.

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
- **`4c035087`** — CDP-ввод не меняет состояние CodeMirror: шаг `text`
  (`Input.insertText`) и синтетический `paste` в markdown-поле не создают
  транзакцию — сохранение не уходит, в БД старый текст. Затравливай поле
  `api`-шагом (см. «Затравка markdown-поля (CodeMirror) — только через API»).
- **Видимое окно запрещено** на рабочей машине пользователя: окно проверки не
  должно перехватывать фокус. `ETN_HIDDEN_WINDOW=1` ставит обёртка.

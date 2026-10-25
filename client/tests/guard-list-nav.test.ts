/**
 * Сторож единого ядра клавиатурной навигации и общего компонента списка
 * `lib/ui` (ADR «Списки и таблицы: два компонента над общим ядром навигации»
 * fadf99e0, требование 93115633, задача 7893e429).
 *
 * Правила:
 *  1) навигация списков идёт через общий компонент `lib/ui/list.ts` поверх ядра
 *     `lib/ui/nav-core.ts`; у списковых модулей экранов нет собственных
 *     обработчиков стрелок («третий рукописный контроллер» запрещён);
 *  2) таблица `lib/ui/table.ts` считает навигацию тем же ядром, а не своим
 *     расчётом индексов.
 *
 * Область сканирования — `screens/**`. Легитимные исключения — навигации,
 * которые НЕ являются плоским списком (дерево-облако «Структур», форма-грид
 * вкладки отборов); они остаются на собственных обработчиках до профильных
 * задач.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { listSourceFiles } from './guard-helpers.js';

const RENDERER = path.resolve(import.meta.dirname, '..', 'src', 'renderer');

function read(...parts: string[]): string {
  return fs.readFileSync(path.join(RENDERER, ...parts), 'utf8');
}

/**
 * Навигации вне плоского списка (собственные обработчики стрелок допустимы).
 * Путь — от `renderer/`; охват расширен с `screens/**` на `lib/**` и `editor/**`
 * (ошибка 58981cf5: пикер свойств живёт в `lib/property-list.ts` и прежним
 * охватом не проверялся).
 */
const NON_LIST_NAV_ALLOW = new Map<string, string>([
  [
    'screens/structures/kbd-nav.ts',
    'дерево-облако «Структуры мыслей»: пространственная навигация по облачкам, не плоский список.',
  ],
  [
    'screens/thought-type/views-tab.ts',
    'форма-грид вкладки отборов типа: сетка полей, а не список.',
  ],
  [
    'lib/dialog.ts',
    'каркас модального диалога: capture-Escape стопки, фокус-ловушка Tab, стрелки по кнопкам футера — механизм, не список.',
  ],
  [
    'lib/keymap.ts',
    'сам общеклиентский диспетчер сочетаний — единственная точка перехвата keydown (ADR b420b08c).',
  ],
  [
    'lib/suggest-dropdown.ts',
    'механизм выпадающих подсказок полей (стрелки/Enter по подсказкам) — не списковый экран.',
  ],
  [
    'lib/filter-tree.ts',
    'единый список выбора `openChoiceMenu`: клавиатура обрабатывается контейнером, в который входит и его поле поиска (↑/↓ из поиска работают) — второго разбора стрелок у экранов нет.',
  ],
]);

/**
 * Файл — рукописный контроллер навигации списка? Признак: слушатель `keydown`
 * И обработка стрелок вверх/вниз, но без опоры на общее ядро/компонент списка.
 */
function isHandWrittenListNav(rel: string, source: string): boolean {
  if (NON_LIST_NAV_ALLOW.has(rel)) return false;
  if (!/addEventListener\(\s*['"]keydown['"]/.test(source)) return false;
  if (!/['"](ArrowUp|ArrowDown)['"]/.test(source)) return false;
  return !/lib\/ui\/(?:list|nav-core)\.js/.test(source);
}

/**
 * Списки и пикеры С ПОЛЕМ ПОИСКА: ↑/↓/Enter из первой строки поиска обязаны
 * исполнять штатную навигацию списка общим мостом `lib/ui/search-nav`
 * (стандарт b6b2821d, ошибка 58981cf5). Перечень фиксирует всех потребителей
 * явно — в т.ч. те, чьё поле поиска не имеет класса `*-search`
 * (`screens/type-manager.ts`).
 */
const SEARCH_LIST_CONSUMERS = [
  'lib/property-list.ts',
  'lib/saved-filter-bar.ts',
  'lib/entity-picker.ts',
  'trash.ts',
  'admin/admin.ts',
  'screens/type-manager.ts',
  'screens/property-manager.ts',
] as const;

/**
 * Долги класса «список с поиском без моста» — отдельные ошибки 0.14.1: их
 * списки живут на `lib/ui/list.ts`, которому нужен свой вход `handleKey`
 * (мост не переиспользуется как есть). Запись обязывает содержать признак
 * поля поиска; закрытие долга — удаление записи вместе с ошибкой.
 * Самодельный список результатов поиска вложений (`editor/attachments.ts`,
 * ошибка 6452ea94) этим признаком не ловится — там нет спискового фасада.
 */
const SEARCH_LIST_DEBT: ReadonlyMap<string, { error: string; reason: string }> = new Map([
  [
    'screens/publications/publications.ts',
    {
      error: 'be095da7',
      reason: 'библиотека «Публикаций»: поиск здесь, список — library-nav.ts на `lib/ui/list.ts`; ждёт `handleKey` у компонента списка.',
    },
  ],
  [
    'editor/attachment-picker.ts',
    {
      error: 'be095da7',
      reason: 'пикер вложений: поиск + `createListNav`; ждёт `handleKey` у компонента списка.',
    },
  ],
]);

/** Признаки спискового компонента в исходнике. */
const LIST_MARKERS = [/createTable</, /createTree</, /createListNav</];

/** Признак поля поиска: класс с `search` (`extraClass: 'x-search'`, `el('input', '…-search')`). */
const SEARCH_FIELD_MARKER =
  /(?:extraClass:\s*'[^']*search[^']*')|(?:el\(\s*'input',\s*'[^']*search[^']*'\))/;

/** Список с полем поиска без моста навигации — нарушение стандарта b6b2821d. */
function isMissingSearchNav(rel: string, source: string): boolean {
  if (SEARCH_LIST_DEBT.has(rel)) return false;
  if (!LIST_MARKERS.some((marker) => marker.test(source))) return false;
  if (!SEARCH_FIELD_MARKER.test(source)) return false;
  return !/bindSearchNav\(/.test(source);
}

/** Найти списки с поиском без моста в каталоге (рекурсивно). */
function findMissingSearchNav(dir: string): string[] {
  const out: string[] = [];
  for (const file of listSourceFiles(dir, { extensions: ['.ts'] })) {
    const rel = path.relative(dir, file).replace(/\\/g, '/');
    if (isMissingSearchNav(rel, fs.readFileSync(file, 'utf8'))) out.push(rel);
  }
  return out.sort();
}

/** Найти рукописные контроллеры списка в каталоге (рекурсивно). */
function findHandWrittenListNav(rootDir: string): string[] {
  const out: string[] = [];
  for (const file of listSourceFiles(rootDir, { extensions: ['.ts'] })) {
    const rel = path.relative(rootDir, file).replace(/\\/g, '/');
    if (isHandWrittenListNav(rel, fs.readFileSync(file, 'utf8'))) out.push(rel);
  }
  return out.sort();
}

describe('guard: общее ядро навигации и компонент списка (7893e429)', () => {
  const FEED_NAV = read('screens', 'chronicle', 'feed-nav.ts');
  const LIBRARY_NAV = read('screens', 'publications', 'library-nav.ts');
  const TABLE = read('lib', 'ui', 'table.ts');

  it('лента «Дневника» и библиотека «Публикаций» — адаптеры общего компонента списка', () => {
    assert.match(FEED_NAV, /from '\.\.\/\.\.\/lib\/ui\/list\.js'/, 'лента использует компонент списка');
    assert.match(
      LIBRARY_NAV,
      /from '\.\.\/\.\.\/lib\/ui\/list\.js'/,
      'библиотека использует компонент списка',
    );
  });

  it('у списковых модулей нет собственных обработчиков стрелок (правила — в ядре)', () => {
    assert.doesNotMatch(
      FEED_NAV,
      /['"](?:ArrowUp|ArrowDown)['"]/,
      'лента не содержит своей карты стрелок — ход по списку считает компонент/ядро',
    );
    assert.doesNotMatch(
      LIBRARY_NAV,
      /['"](?:ArrowUp|ArrowDown)['"]/,
      'библиотека не содержит своей карты стрелок — ход по списку считает компонент/ядро',
    );
  });

  it('таблица использует то же ядро навигации', () => {
    assert.match(TABLE, /from '\.\/nav-core\.js'/, 'таблица импортирует общее ядро');
    assert.match(TABLE, /nextNavIndex\(/, 'расчёт индекса строки — из ядра, а не свой');
  });

  it('во всём рендерере нет рукописных контроллеров навигации списка', () => {
    const found = findHandWrittenListNav(RENDERER);
    assert.deepEqual(
      found,
      [],
      `Рукописные контроллеры навигации списка в renderer/** (кроме объявленных ` +
        `исключений): ${found.join(', ')}. ` +
        'Навигация списка — только через общий компонент `lib/ui/list.ts` и ядро ' +
        '`lib/ui/nav-core.ts` (ADR fadf99e0).',
    );
  });

  it('правило краснеет на третьем рукописном контроллере навигации', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-list-nav-'));
    try {
      fs.mkdirSync(path.join(dir, 'fresh'));
      fs.writeFileSync(
        path.join(dir, 'fresh', 'new-list.ts'),
        "host.addEventListener('keydown', (e) => {\n" +
          "  if (e.key === 'ArrowDown') step(1);\n" +
          "  if (e.key === 'ArrowUp') step(-1);\n" +
          '});\n',
        'utf8',
      );
      assert.deepEqual(
        findHandWrittenListNav(dir),
        ['fresh/new-list.ts'],
        'новый рукописный контроллер стрелок обязан попадать в нарушение',
      );
      // Адаптер над общим компонентом нарушением не считается.
      fs.writeFileSync(
        path.join(dir, 'fresh', 'adapter.ts'),
        "import { createListNav } from '../../lib/ui/list.js';\n" +
          "host.addEventListener('keydown', () => undefined);\n" +
          "const k = 'ArrowDown';\n",
        'utf8',
      );
      assert.deepEqual(findHandWrittenListNav(dir), ['fresh/new-list.ts']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('guard: поле поиска списка ведёт навигацию (58981cf5, стандарт b6b2821d)', () => {
  it('каждый список с поиском подключён к общему мосту `lib/ui/search-nav`', () => {
    for (const rel of SEARCH_LIST_CONSUMERS) {
      const source = read(...rel.split('/'));
      assert.ok(
        LIST_MARKERS.some((marker) => marker.test(source)),
        `${rel}: перечень обязан ссылаться на списковый компонент (устаревшая запись?)`,
      );
      assert.match(
        source,
        /bindSearchNav\(/,
        `${rel}: ↑/↓/Enter из поля поиска обязаны исполнять навигацию списка общим ` +
          'мостом `lib/ui/search-nav` (ошибка 58981cf5).',
      );
    }
  });

  it('новый список с полем поиска без моста — нарушение (долг зафиксирован ошибками)', () => {
    const found = findMissingSearchNav(RENDERER);
    assert.deepEqual(
      found,
      [],
      `Списки с полем поиска без моста навигации: ${found.join(', ')}. ` +
        'Подключи `bindSearchNav` (lib/ui/search-nav) или заведи ошибку и внеси ' +
        'файл в SEARCH_LIST_DEBT с её id.',
    );
  });

  it('записи известного долга адресуют реальные файлы с полем поиска', () => {
    for (const [rel, debt] of SEARCH_LIST_DEBT) {
      const source = read(...rel.split('/'));
      assert.match(source, /search/i, `${rel}: долг ${debt.error} — файл без поля поиска?`);
    }
  });

  it('правило краснеет на новом списке с поиском без моста', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-search-nav-'));
    try {
      fs.mkdirSync(path.join(dir, 'fresh'));
      // Список + поле поиска без моста — нарушение.
      fs.writeFileSync(
        path.join(dir, 'fresh', 'new-dialog.ts'),
        "const input = fieldInput({ extraClass: 'new-search' });\n" +
          'const table = createTable<Row>({ columns: [] });\n',
        'utf8',
      );
      assert.deepEqual(findMissingSearchNav(dir), ['fresh/new-dialog.ts']);
      // Тот же список с мостом — нарушением не считается.
      fs.writeFileSync(
        path.join(dir, 'fresh', 'bridged.ts'),
        "const input = fieldInput({ extraClass: 'new-search' });\n" +
          'const table = createTable<Row>({ columns: [] });\n' +
          'bindSearchNav(input, { handleKey: (key) => table.handleKey(key) });\n',
        'utf8',
      );
      assert.deepEqual(findMissingSearchNav(dir), ['fresh/new-dialog.ts']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

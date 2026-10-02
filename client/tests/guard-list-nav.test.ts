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
const SCREENS = path.join(RENDERER, 'screens');

function read(...parts: string[]): string {
  return fs.readFileSync(path.join(RENDERER, ...parts), 'utf8');
}

/**
 * Навигации вне плоского списка (собственные обработчики стрелок допустимы):
 * дерево-облако «Структуры мыслей» и форма-грид вкладки отборов типа.
 */
const NON_LIST_NAV_ALLOW = new Set(['structures/kbd-nav.ts', 'thought-type/views-tab.ts']);

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

/** Найти рукописные контроллеры списка в каталоге (рекурсивно). */
function findHandWrittenListNav(screensDir: string): string[] {
  const out: string[] = [];
  for (const file of listSourceFiles(screensDir, { extensions: ['.ts'] })) {
    const rel = path.relative(screensDir, file).replace(/\\/g, '/');
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

  it('в экранах нет рукописных контроллеров навигации списка', () => {
    const found = findHandWrittenListNav(SCREENS);
    assert.deepEqual(
      found,
      [],
      `Рукописные контроллеры навигации списка в screens/**: ${found.join(', ')}. ` +
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

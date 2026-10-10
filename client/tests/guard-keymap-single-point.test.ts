/**
 * Сторож единственной точки перехвата `keydown` (ADR `b420b08c`, задача
 * e7bf87e3 — диспетчер; задача fd3d84f4 — перевод потребителей).
 *
 * Правило: перехват клавиш клиента принадлежит общеклиентскому диспетчеру
 * контекстов `lib/keymap.ts` (`installKeymap`). Любой другой
 * `addEventListener('keydown')` в `client/src/renderer` — либо нарушение, либо
 * явно объявленное легаси-место из инвентаря ниже с обоснованием.
 *
 * Сторож сканирует ВЕСЬ `client/src/renderer` (не только `app.ts`): новый
 * локальный слушатель в любом файле краснит тест. Инвентарь — белый список
 * «оставшихся легаси-мест», который по мере перевода потребителей на диспетчер
 * (задача fd3d84f4) обязан СОКРАЩАТЬСЯ: сторож сверяет и наличие файла в
 * списке, и точное число слушателей в нём, поэтому переведённый файл нельзя
 * молча оставить в инвентаре, а новый/лишний слушатель — молча спрятать.
 *
 * Категории инвентаря:
 *  - `boundary`   — вне границ задачи fd3d84f4 (каталог `editor/**`).
 *  - `mechanism`  — механизм диспетчера (заморожен) физически не выражает
 *                   событие: capture-фаза (порядок обгона `defaultPrevented`),
 *                   событие без не-модификаторной клавиши (`Ctrl`-press),
 *                   `keyup`, element-scoped `stopPropagation`.
 *  - `element`    — клавиатурный контракт WAI-ARIA самого виджета: событие
 *                   принадлежит его фокусируемому элементу и обрабатывается на
 *                   нём (кандидат на миграцию в волнах fd3d84f4).
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const RENDERER_ROOT = path.resolve(import.meta.dirname, '..', 'src', 'renderer');
const KEYMAP_REL = 'lib/keymap.ts';

/** Легаси-место: путь (posix, от `renderer/`), число слушателей и обоснование. */
interface LegacyKeydownSite {
  file: string;
  count: number;
  category: 'boundary' | 'mechanism' | 'element';
  reason: string;
}

/**
 * Инвентарь легаси-мест на момент постановки задачи fd3d84f4. Белый список —
 * временный: каждое место переводится на диспетчер волнами задачи, после чего
 * удаляется отсюда. `lib/ui/splitter.ts` уже переведён (волна 1).
 */
const LEGACY_KEYDOWN_SITES: readonly LegacyKeydownSite[] = [
  // --- boundary: каталог editor/** вне границ задачи fd3d84f4 ---------------
  {
    file: 'editor/value-editor.ts',
    count: 4,
    category: 'boundary',
    reason: 'Поля-редакторы значений (CM6/keymap.of, чипы, облачка связей) — задача явно исключает editor/**.',
  },
  {
    file: 'editor/editor.ts',
    count: 2,
    category: 'boundary',
    reason: 'Заголовок и синонимы карточки мысли (CM6-расширения поля) — задача исключает editor/**.',
  },
  {
    file: 'editor/publication-card.ts',
    count: 1,
    category: 'boundary',
    reason: 'Заголовок карточки публикации — задача исключает editor/**.',
  },
  {
    file: 'editor/mini-graph.ts',
    count: 1,
    category: 'boundary',
    reason: 'Навигация мини-графа связей — задача исключает editor/**.',
  },
  {
    file: 'editor/links-tab.ts',
    count: 1,
    category: 'boundary',
    reason: 'Навигация облачка связей вкладки — задача исключает editor/**.',
  },
  {
    file: 'editor/comment-hotkeys-dialog.ts',
    count: 1,
    category: 'boundary',
    reason: 'Capture-перехват нажатия для записи сочетания — задача исключает editor/**.',
  },

  // --- mechanism: механизм диспетчера не выражает событие -------------------
  {
    file: 'lib/dialog.ts',
    count: 7,
    category: 'mechanism',
    reason:
      'Каркас модального диалога: capture-Escape стопки, Ctrl+Enter/Shift+Enter/Ctrl+Shift+Enter, focus-trap Tab, стрелки по кнопкам. Порядок задаёт capture-фаза и обгон через defaultPrevented; диспетчер — один bubble-слушатель на window и не выражает capture/стопку.',
  },
  {
    file: 'lib/menu.ts',
    count: 1,
    category: 'mechanism',
    reason: 'Capture-Escape закрытия контекстного меню (порядок относительно capture-каркаса диалога).',
  },
  {
    file: 'lib/suggest-dropdown.ts',
    count: 3,
    category: 'mechanism',
    reason: 'Window capture-слушатель выпадашки подсказок плюс element-scoped обработчики поля.',
  },
  {
    file: 'screens/publications/workspace.ts',
    count: 2,
    category: 'mechanism',
    reason: 'Capture-слушатель на docHost документа публикации плюс document-слушатель.',
  },
  {
    file: 'lib/hover-preview.ts',
    count: 1,
    category: 'mechanism',
    reason:
      'Глобальный жест предпросмотра: `Escape`/нажатие `Ctrl` БЕЗ не-модификаторной клавиши (у диспетчера такое событие не даёт ни одного сочетания) плюс парный `keyup`.',
  },
  {
    file: 'lib/image-zoom.ts',
    count: 1,
    category: 'mechanism',
    reason:
      'Глобальный жест лупы: `Escape`/нажатие `Ctrl` без сочетания + парный `keyup`; диспетчер модификатор-онли события не резолвит.',
  },
  {
    file: 'lib/month-calendar.ts',
    count: 1,
    category: 'mechanism',
    reason:
      'Capture-Escape поля года (`window`, capture-фаза): должен обогнать capture-Escape каркаса диалога, зарегистрированный позже, и погасить нажатие до него. Диспетчер — один bubble-слушатель на window и capture-порядок не выражает. Поле года (Enter/Escape) переведено на диспетчер (волна 2).',
  },
];

/** Установка keydown-слушателя: `addEventListener('keydown'` и
 *  `addEventListener?.('keydown'` (optional-chaining у `lib/ui/drag-list`). */
const KEYDOWN_INSTALL_RE = /addEventListener\??\.?\(\s*['"]keydown['"]/g;

/** Рекурсивно собирает `.ts`-файлы под каталогом (posix-пути от корня). */
function collectTsFiles(dir: string, base = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base === '' ? entry.name : `${base}/${entry.name}`;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(abs, rel));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(rel);
  }
  return out;
}

/** Число установок keydown-слушателя в исходнике. */
function countKeydownListeners(source: string): number {
  return source.match(KEYDOWN_INSTALL_RE)?.length ?? 0;
}

const FILES = collectTsFiles(RENDERER_ROOT);
const SOURCES = new Map(FILES.map((rel) => [rel, fs.readFileSync(path.join(RENDERER_ROOT, rel), 'utf8')]));

describe('сторож: единственная точка перехвата keydown в клиенте', () => {
  it('диспетчер владеет единственным слушателем keydown', () => {
    const keymap = SOURCES.get(KEYMAP_REL);
    assert.ok(keymap !== undefined, `есть ${KEYMAP_REL}`);
    assert.equal(
      countKeydownListeners(keymap),
      1,
      'lib/keymap.ts — единственное место установки keydown-слушателя диспетчера',
    );
    assert.ok(keymap.includes('installKeymap'), 'диспетчер выставляет installKeymap');
  });

  it('вне инвентаря нет ни одного локального слушателя keydown', () => {
    const listed = new Map(LEGACY_KEYDOWN_SITES.map((s) => [s.file, s]));
    const offenders: string[] = [];
    for (const [rel, source] of SOURCES) {
      if (rel === KEYMAP_REL) continue;
      const count = countKeydownListeners(source);
      const entry = listed.get(rel);
      if (entry === undefined) {
        if (count > 0) offenders.push(`${rel} (${count} шт.)`);
        continue;
      }
      if (count !== entry.count) {
        offenders.push(
          `${rel}: в инвентаре ${entry.count}, в коде ${count} — обнови инвентарь ` +
            '(переведённый слушатель из списка убирают, новый — не добавляют)',
        );
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `локальный keydown-перехват возможен только через диспетчер; белый список: ${offenders.join('; ')}`,
    );
  });

  it('в инвентаре нет устаревших записей', () => {
    const stale: string[] = [];
    for (const site of LEGACY_KEYDOWN_SITES) {
      const source = SOURCES.get(site.file);
      if (source === undefined) {
        stale.push(`${site.file}: файла нет`);
        continue;
      }
      const count = countKeydownListeners(source);
      if (count === 0) {
        stale.push(`${site.file}: слушателей не осталось — убери из инвентаря`);
      }
    }
    assert.deepEqual(stale, [], `устаревшие записи белого списка: ${stale.join('; ')}`);
  });

  it('каждая запись инвентаря обоснована', () => {
    for (const site of LEGACY_KEYDOWN_SITES) {
      assert.ok(site.reason.trim().length > 0, `${site.file}: обоснование не пустое`);
      assert.ok(
        ['boundary', 'mechanism', 'element'].includes(site.category),
        `${site.file}: категория из набора`,
      );
    }
  });

  it('app.ts не заводит собственный слушатель keydown', () => {
    const app = SOURCES.get('app.ts');
    assert.ok(app !== undefined, 'есть app.ts');
    assert.equal(
      countKeydownListeners(app),
      0,
      'app.ts регистрирует команды в диспетчере, а не слушает keydown сам',
    );
    assert.ok(app.includes('installKeymap()'), 'initKeyboard ставит lib/keymap-диспетчер');
    assert.ok(app.includes('GLOBAL_CONTEXT_ID'), 'app.ts регистрирует глобальный контекст');
  });

  it('main.ts поднимает клавиатуру через initKeyboard', () => {
    const main = SOURCES.get('main.ts');
    assert.ok(main !== undefined, 'есть main.ts');
    assert.ok(main.includes('initKeyboard()'), 'main.ts вызывает initKeyboard');
  });
});

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
    file: 'editor/properties.ts',
    count: 1,
    category: 'element',
    reason:
      'Shift+F10 на фокусируемой ячейке имени строки свойства открывает контекстное меню строки (требование 53701739): клавиатурный контракт WAI-ARIA самого элемента, событие приходит на ячейку с фокусом.',
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
      'Каркас модального диалога: capture-Escape стопки (уступает верхнему слою через реестр `lib/keymap.ts`), Ctrl+Enter/Shift+Enter/Ctrl+Shift+Enter, focus-trap Tab, стрелки по кнопкам. Порядок задаёт capture-фаза и обгон через defaultPrevented; диспетчер — один bubble-слушатель на window и не выражает capture/стопку.',
  },
  {
    file: 'lib/menu.ts',
    count: 1,
    category: 'mechanism',
    reason:
      'Capture-Escape меню: должен опередить редактор под меню (CM6 гасит Escape раньше bubble-диспетчера). Чьё это нажатие, решает реестр слоёв диспетчера — `handleEscape` (ошибка 9ff6b606).',
  },
  {
    file: 'lib/suggest-dropdown.ts',
    count: 3,
    category: 'mechanism',
    reason:
      'Capture-Escape выпадашки (оконный слушатель; должен опередить редактор поля) плюс element-scoped обработчики поля ввода (↑/↓, Enter, Tab, ←/→). Приоритет Escape решает реестр слоёв диспетчера — `handleEscape`.',
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
      'Глобальный жест лупы: `Escape` показанной лупы (через `handleEscape` реестра слоёв диспетчера — приоритет верхнего слоя) и нажатие `Ctrl` БЕЗ не-модификаторной клавиши (у диспетчера такое событие не даёт ни одного сочетания) + парный `keyup`.',
  },
  {
    file: 'lib/month-calendar.ts',
    count: 1,
    category: 'mechanism',
    reason:
      'Capture-Escape поля года (`window`, capture-фаза): должен обогнать capture-Escape каркаса диалога, зарегистрированный позже, и погасить нажатие до него. Диспетчер — один bubble-слушатель на window и capture-порядок не выражает. Поле года (Enter/Escape) переведено на диспетчер (волна 2).',
  },

  // --- element: клавиатурный контракт самого виджета ------------------------
  {
    file: 'lib/filter-tree.ts',
    count: 1,
    category: 'element',
    reason:
      'Клавиатурный контракт выпадающего списка редактора отбора (требование заказчика 2026-10-13: стрелки ↑/↓ и Enter в поле живого поиска/по списку): событие принадлежит корню списка ВНУТРИ поповера (element-scoped, гасится до внешних обработчиков) — у диспетчера нет контекста для списка внутри уже открытого поповера.',
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

/**
 * Модули всплывающих слоёв, которые закрываются `Escape`. Открываясь, каждый
 * обязан зарегистрировать слой в общем реестре диспетчера (`pushKeyOverlay`):
 * иначе `Escape` забирает каркас диалога под слоем, а приоритет между слоями
 * (поповер над меню) не разрешается (ошибка 9ff6b606). Новый всплывающий слой
 * добавляется сюда и в реестр — второго механизма приоритетов ADR `b420b08c`
 * не допускает.
 */
const ESCAPE_OVERLAY_MODULES: readonly string[] = [
  'lib/menu.ts',
  'lib/ui/popover.ts',
  'lib/suggest-dropdown.ts',
  'lib/image-zoom.ts',
  'editor/comment-search.ts',
  'editor/markdown-field.ts',
];

describe('сторож: слои Escape — в общем диспетчере (ADR b420b08c)', () => {
  it('каждый всплывающий слой регистрирует Escape через keymap.pushKeyOverlay', () => {
    const offenders: string[] = [];
    for (const rel of ESCAPE_OVERLAY_MODULES) {
      const source = SOURCES.get(rel);
      if (source === undefined) {
        offenders.push(`${rel}: файла нет — обнови список слоёв`);
        continue;
      }
      if (!/pushKeyOverlay\s*\(/.test(source)) {
        offenders.push(`${rel}: слой Escape не зарегистрирован через pushKeyOverlay`);
      }
    }
    assert.deepEqual(offenders, [], offenders.join('; '));
  });

  it('каркас диалога уступает Escape верхнему слою, а не решает приоритет сам', () => {
    const dialog = SOURCES.get('lib/dialog.ts');
    assert.ok(dialog !== undefined, 'есть lib/dialog.ts');
    assert.ok(
      dialog.includes('keyOverlaySnapshot') && dialog.includes('hasKeyOverlayAbove'),
      'диалог снимает снимок реестра и спрашивает диспетчер о слое выше',
    );
    assert.ok(
      dialog.includes('resolveEscapeOverlay'),
      'нажатие отдаётся верхнему слою через диспетчер',
    );
  });

  it('второго реестра слоёв/приоритетов Escape в клиенте нет', () => {
    const offenders: string[] = [];
    for (const [rel, source] of SOURCES) {
      if (rel === KEYMAP_REL) continue;
      if (/pushEscapeLayer|escapeLayerSnapshot|hasEscapeLayerAbove|escape-layers/.test(source)) {
        offenders.push(rel);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'приоритет Escape разрешает только lib/keymap.ts (ADR b420b08c)',
    );
  });
});

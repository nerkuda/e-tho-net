/**
 * Сторож всплывающих панелей `lib/ui` (задача dd1f47d4, требование f74f1aae
 * «Всплывающий предпросмотр — общий компонент lib/ui», ADR 03eb2c61,
 * инвентаризация 3fc7c54d — «Popover (закрываемый кликом вне)»).
 *
 * Правило: всплывающая панель и её механика (оформление, позиционирование,
 * закрытие кликом вне) живут только в компоненте `lib/ui/popover.ts`;
 * потребители (движки) вызывают {@link openPopover} / берут чистую геометрию.
 * Каждый запрет ловится обычным прогоном `npm -w @etn/client test`.
 *
 * Запрещено вне `lib/ui/`:
 *   1. классы панели (`ui-popover`, `ui-popover-head`, `ui-popover-body` и
 *      упразднённые `hover-preview-popup`/`hp-body`/`hp-head`) — панель
 *      собирает `openPopover`;
 *   2. прямые делегированные слушатели «клик вне» (`pointerdown`/`mousedown`
 *      на `document`/`window`) и capture-слушатели `click` на них — закрытие
 *      кликом вне делает компонент;
 *   3. ручная расстановка хвостика панели (`--hp-arrow-left`) — её задаёт
 *      компонент (`--ui-popover-arrow-left`).
 *   4. **самодельный слой-панель** (задача 58f77990): новый CSS-модуль вне
 *      `lib/ui` не заводит НИ подсказку-слой (класс с `tip`/`tooltip` +
 *      `position: absolute|fixed`), НИ `position: fixed` слой — только через
 *      `openPopover`. Уже существующие слои и осознанное отклонение перечислены
 *      закрытыми списками `PANEL_LAYER_FILES_ALLOW` (модули) и
 *      `TIP_LAYER_SELECTORS_ALLOW` (селектор подсказки фразы, ADR `efa5138c`);
 *      мёртвая запись списка краснит тест.
 *
 * **Allow-края.** Уже существующие механики закрытия кликом вне, не переведённые
 * на компонент этой задачей (граница задачи: вторая поповерная механика не
 * расширяется), остаются как есть — с обоснованием:
 *   • `search/search.ts` — панель результатов/настроек поиска (фундамент
 *     строки поиска, отдельная механика с исключениями подсказок и диалогов);
 *   • `lib/menu.ts` — контекстное меню (единый модуль меню, задача меню карты
 *     — T9);
 *   • `lib/suggest-dropdown.ts` — выпадашка подсказок (свой жизненный цикл
 *     под полем, поглощается списками этапа 2);
 *   • `screens/tabs/tab-overflow.ts` — список переполнения вкладок (часть
 *     механизма вкладок).
 * Их перевод — отдельные задачи; список закрыт, новый слушатель в обход
 * компонента сторож не пропустит.
 *
 * Строки-комментарии правилами не считаются (в пояснениях имена классов
 * допустимы).
 */

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { assertGuardClean, listSourceFiles, type GuardRule } from './guard-helpers.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');

/** Уже существующие механики закрытия кликом вне (см. обоснование в шапке). */
const ALLOW_OUTSIDE_CLICK = new Set([
  'search/search.ts',
  'lib/menu.ts',
  'lib/suggest-dropdown.ts',
  'screens/tabs/tab-overflow.ts',
]);

// ---------------------------------------------------------------------------
// Слой-панель вне фасада: закрытый список допустимых модулей и подсказок
// ---------------------------------------------------------------------------

/**
 * Слой вне `lib/ui`: подсказка/тултип (`position: absolute|fixed` у класса с
 * `tip`/`tooltip` в имени) либо любой `position: fixed` слой. Правило задачи
 * 58f77990: новый самодельный слой не должен проходить молча — он обязан либо
 * идти через `openPopover`, либо быть внесён сюда вместе с обоснованием (ADR).
 *
 * Почему список ФАЙЛОВ, а не селекторов: в рендерере уже 36 правил с
 * `position: absolute|fixed` + `z-index` (слои холста, раскладки, меню, тостов,
 * диалогов) — поэлементный allow-список был бы шумом и разрастался бы сам.
 * Файловый список закрыт: мёртвая запись краснит тест, новый модуль со слоем —
 * тоже.
 */
const PANEL_LAYER_FILES_ALLOW = new Map<string, string>([
  ['styles/canvas.css', 'холст: слои облачков, связей, бейджей и зон'],
  ['styles/dialogs.css', 'подложка диалога (каркас lib/dialog)'],
  ['styles/notifications.css', 'тосты — существующая механика уведомлений'],
  ['styles/menus.css', 'контекстное меню — allow-край правила «клик вне»'],
  ['styles/editor.css', 'лупа изображений предпросмотра'],
  ['styles/type-combobox.css', 'список комбобокса типа — переводится этапом 2'],
]);

/**
 * Селекторы-подсказки вне `lib/ui`, допустимые осознанно: самодельный тултип
 * разрешён ТОЛЬКО этот и только по ADR `efa5138c` (инлайн-элемент превью
 * вместо `openPopover`: подсказке нужны многострочная раскрашенная разметка,
 * доступность по фокусу и полное отсутствие перехвата кликов/Escape). Модуль
 * подсказки — `styles/filter-editor.css`; любой другой самодельный слой-подсказка
 * (в том числе в другом файле) краснит сторож.
 */
const TIP_LAYER_SELECTORS_ALLOW = new Set(['.ff-preview__tip']);

/** Класс-подсказка в селекторе: имя класса содержит `tip`/`tooltip`. */
const TIP_CLASS = /\.(?:[\w-]*tip|[\w-]*tooltip)[\w-]*/;

/** Правило создаёт плавающий слой (подсказка бывает и `absolute`). */
const FLOATING_LAYER = /position:\s*(?:fixed|absolute)/;

/** Правило отрывается от потока (`position: fixed`) — общий признак слоя-панели. */
const FIXED_LAYER = /position:\s*fixed/;

/** Блоки `селектор { … }` без комментариев. */
function cssRules(css: string): { selector: string; body: string }[] {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...code.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: match[1]!.trim().replace(/\s+/g, ' '),
    body: match[2]!,
  }));
}

/**
 * Нарушения «самодельный слой вне lib/ui» в одном CSS-модуле: подсказка-класс
 * или `position: fixed` слой вне закрытых списков.
 */
export function layerViolations(rel: string, css: string): string[] {
  if (rel.startsWith('lib/ui/')) return [];
  const out: string[] = [];
  for (const rule of cssRules(css)) {
    if (TIP_CLASS.test(rule.selector)) {
      if (!FLOATING_LAYER.test(rule.body)) continue;
      if (!TIP_LAYER_SELECTORS_ALLOW.has(rule.selector)) {
        out.push(`${rule.selector} — самодельная подсказка-слой (нужен openPopover или ADR)`);
      }
      continue;
    }
    if (!FIXED_LAYER.test(rule.body)) continue;
    if (!PANEL_LAYER_FILES_ALLOW.has(rel)) {
      out.push(`${rule.selector} — position: fixed слой вне lib/ui (нужен openPopover или ADR)`);
    }
  }
  return out;
}


/** Строка — комментарий? (в пояснениях имена классов/переменных допустимы). */
function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/**
 * Исходник без комментариев. Подстрочная проверка проводки не должна «видеть»
 * вызовы в закомментированном коде (`// attachOutsidePointer();` — не проводка).
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

/** Общее для всех правил: не `lib/ui`, не комментарий. */
function outsideFacades(rel: string, line: string): boolean {
  return isComment(line) || rel.startsWith('lib/ui/');
}

/** Allow-край правил о «клике вне»: известные движки (кроме комментариев). */
function allowedOutsideClick(rel: string, line: string): boolean {
  return isComment(line) || ALLOW_OUTSIDE_CLICK.has(rel);
}

function rules(): GuardRule[] {
  return [
    {
      name: 'no-own-popover-panel',
      description: 'Панель всплывающего слоя собирает openPopover (классы ui-popover*).',
      pattern:
        /['"](?:ui-popover|ui-popover-head|ui-popover-body|hover-preview-popup|hp-body|hp-head)['"]/,
      allow: outsideFacades,
    },
    {
      name: 'no-pointerdown-outside-click',
      description:
        'Делегированный слушатель «клик вне» (pointerdown/mousedown на document/window) — только через компонент lib/ui/popover.',
      pattern: /(?:document|window)\.addEventListener\(\s*['"](?:pointerdown|mousedown)['"]/,
      allow: allowedOutsideClick,
    },
    {
      name: 'no-capture-click-outside',
      description:
        'Capture-слушатель click на document/window («клик вне») — только через компонент lib/ui/popover.',
      pattern: /(?:document|window)\.addEventListener\(\s*['"]click['"][^\n]*,\s*true\s*\)/,
      allow: allowedOutsideClick,
    },
    {
      name: 'no-manual-popover-arrow',
      description:
        'Смещение хвостика панели задаёт компонент (--ui-popover-arrow-left), не прикладной код.',
      pattern: /--hp-arrow-left/,
      allow: outsideFacades,
    },
  ];
}

describe('guard: всплывающая панель lib/ui', () => {
  it('панель и её механика — только через компонент lib/ui/popover', () => {
    assertGuardClean(RENDERER_ROOT, rules());
  });

  it('поле комментария проводит «клик вне» через компонент, а не своим слушателем', () => {
    // Обратный регресс: поле обязано ставить/снимать «клик вне» через
    // `watchOutsideTap` при входе/выходе из правки. Отключение проводки
    // (attachOutsidePointer/detachOutsidePointer) краснит этот тест
    // (ошибка e2c6c66c, раунд 2). Комментарии вычищаются: закомментированный
    // вызов проводкой не считается.
    const raw = fs.readFileSync(path.join(RENDERER_ROOT, 'editor', 'markdown-field.ts'), 'utf8');
    const src = stripComments(raw);
    assert.doesNotMatch(
      stripComments('// attachOutsidePointer();\n/* watchOutsideTap(x, y) */'),
      /attachOutsidePointer\(\)|watchOutsideTap\(/,
      'вычистка комментариев работает — закомментированная проводка не засчитывается',
    );
    assert.match(
      src,
      /stopOutsideTap\s*=\s*watchOutsideTap\(/,
      '«клик вне» проводят через lib/ui watchOutsideTap',
    );
    assert.match(src, /attachOutsidePointer\(\)/, 'вход в правку ставит слушатель клика вне');
    assert.match(src, /detachOutsidePointer\(\)/, 'выход из правки снимает слушатель клика вне');
    assert.match(src, /const showEdit = [\s\S]*?attachOutsidePointer\(\)/, 'проводка — в showEdit');
  });
});

describe('guard: слой-панель вне lib/ui — закрытый список (задача 58f77990)', () => {
  /** Все CSS-модули рендерера с относительным путём (слеши `/`). */
  function cssModules(): { rel: string; css: string }[] {
    return listSourceFiles(RENDERER_ROOT, { extensions: ['.css'] }).map((abs) => ({
      rel: path.relative(RENDERER_ROOT, abs).replace(/\\/g, '/'),
      css: fs.readFileSync(abs, 'utf8'),
    }));
  }

  it('новый самодельный слой-подсказка или fixed-слой вне lib/ui запрещён', () => {
    const offenders: string[] = [];
    for (const { rel, css } of cssModules()) {
      for (const problem of layerViolations(rel, css)) offenders.push(`  • ${rel} «${problem}»`);
    }
    if (offenders.length > 0) {
      throw new Error(
        `Самодельные слои вне lib/ui (${offenders.length}):\n${offenders.join('\n')}\n\n` +
          'Всплывающий слой собирает openPopover (lib/ui/popover.ts). Отклонение ' +
          'допустимо только осознанно: внеси модуль в PANEL_LAYER_FILES_ALLOW ' +
          '(или селектор в TIP_LAYER_SELECTORS_ALLOW) с обоснованием-ADR.',
      );
    }
  });

  it('закрытые списки не имеют мёртвых записей', () => {
    const modules = cssModules();
    for (const rel of PANEL_LAYER_FILES_ALLOW.keys()) {
      const module = modules.find((m) => m.rel === rel);
      assert.ok(module !== undefined, `модуль списка существует: ${rel}`);
      assert.ok(
        cssRules(module!.css).some(
          (rule) => FIXED_LAYER.test(rule.body) && !TIP_CLASS.test(rule.selector),
        ),
        `запись списка не мёртвая: в ${rel} есть fixed-слой`,
      );
    }
    for (const selector of TIP_LAYER_SELECTORS_ALLOW) {
      assert.ok(
        modules.some((m) =>
          cssRules(m.css).some(
            (rule) => rule.selector === selector && FLOATING_LAYER.test(rule.body),
          ),
        ),
        `разрешённая подсказка существует и является слоем: ${selector}`,
      );
    }
  });

  it('правила краснеют на умышленном нарушении', () => {
    // Новый самодельный тултип — в новом модуле и в существующем.
    assert.deepEqual(layerViolations('styles/new-screen.css', '.foo-tooltip { position: absolute; z-index: 5; }'), [
      '.foo-tooltip — самодельная подсказка-слой (нужен openPopover или ADR)',
    ]);
    assert.deepEqual(
      layerViolations('styles/filter-editor.css', '.ff-preview__hint-tip { position: absolute; z-index: 5; }'),
      ['.ff-preview__hint-tip — самодельная подсказка-слой (нужен openPopover или ADR)'],
    );
    // Новый fixed-слой вне lib/ui и вне закрытого списка.
    assert.deepEqual(layerViolations('styles/new-screen.css', '.my-panel { position: fixed; z-index: 5; }'), [
      '.my-panel — position: fixed слой вне lib/ui (нужен openPopover или ADR)',
    ]);
    // Разрешённые формы: фасад, список модулей, известная подсказка.
    assert.deepEqual(layerViolations('lib/ui/popover.css', '.ui-popover { position: fixed; z-index: 1950; }'), []);
    assert.deepEqual(layerViolations('styles/canvas.css', '.zone-count { position: fixed; z-index: 2; }'), []);
    assert.deepEqual(
      layerViolations('styles/filter-editor.css', '.ff-preview__tip { position: absolute; z-index: 30; }'),
      [],
    );
    // Не слой — не нарушение.
    assert.deepEqual(layerViolations('styles/new-screen.css', '.foo { position: relative; }'), []);
  });
});

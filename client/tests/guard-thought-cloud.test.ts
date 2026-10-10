/**
 * Сторож стандарта «Клиент: представление мысли — только через общую фабрику
 * облачка» (S1, задача 1b9dccc5 вехи 2 версии 0.8.2; ADR «Облачко мысли
 * собирает одна фабрика DOM, различия — именованные профили»).
 *
 * Правила:
 * 1. Визуальные поля мысли (`fg_color`, `bg_color`, `font_*`, `icon_kind`) не
 *    читаются вне разрешённых мест. Разрешены: сам канон
 *    (`lib/thought-cloud.ts`), резолвер визуала типа (`lib/type-tree.ts`),
 *    редакторы полей (диалоги стиля/иконки, сиды диалогов в редакторе и
 *    панели выделения, редактор типов) и сериализация DTO (снапшот
 *    копирования, запрос создания, цвет линии от фона облачка, перенос полей
 *    в форму FocusNeighbor). Любое другое место, читающее эти поля, строит
 *    своё представление мысли мимо фабрики — красное.
 * 2. Старый путь канона закрыт: `resolveCloudStyle` / `applyCloudStyle` /
 *    `resolveThoughtIcon` / `applyThoughtIcon` больше не импортируются из
 *    `canvas/canvas.js` — единственный источник канона `lib/thought-cloud.ts`.
 * 3. Элементы облачка (`cloud`, `cloud-main`, `cloud-icon`, `cloud-title`,
 *    `prop-ref-cloud`, `mini-icon`, `prc-title`) не собираются вручную вне
 *    фабрики — готовая разметка приходит только из `createThoughtCloud`.
 *    Класс ловится и первым аргументом (`el('cloud-icon')`), и вторым
 *    (`el('span', 'mini-icon')`).
 * 4. Ширина облачка объявляется местом, а не селектором в стилях: имя всегда
 *    обрезано либо по явному пределу ширины, либо по ширине контейнера.
 *    Ширину «по контейнеру» задаёт ОДИН библиотечный класс-модификатор
 *    (`cloud-width-container`, опция `width: 'container'` фабрики) с одним
 *    общим правилом; контекстные обходы в CSS (`.link-endpoint .cloud`,
 *    `.search-hit… > .cloud`, `.st-row .st-cloud.cloud`) закрыты. Класс не
 *    вешается вручную — только фабрикой.
 * 5. В каждом месте вызова фабрики ширина объявлена явно (`width: …`) ИЛИ
 *    задана раскладкой места из списка {@link FIXED_WIDTH_SITES} (холстовая
 *    сетка, измеренный узел мини-графа, модификатор с явным пределом, колонка
 *    таблицы). Новое место без явного предела ширины обязано идти с
 *    `width: 'container'`.
 *
 * Сторож вводится зелёным — в том же изменении, которое переводит все 26 мест
 * на фабрику (мета-стандарт «Правило без теста-сторожа не считается
 * введённым»).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertGuardClean } from './guard-helpers.js';
import { assembledStylesFile } from './renderer-css.js';

const RENDERER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'renderer',
);
const STYLES_CSS = assembledStylesFile();
const THOUGHT_CLOUD_TS = path.join(RENDERER_ROOT, 'lib', 'thought-cloud.ts');

/**
 * Файлы, которым разрешено читать визуальные поля мысли/типа. Каждый —
 * не «представление мысли», а редактор или сериализация:
 *  - `lib/thought-cloud.ts` — сам канон фабрики;
 *  - `lib/type-tree.ts` — резолвер визуала ТИПА (первоисточник фабрики);
 *  - `editor/style-dialog.ts` / `editor/icon-dialog.ts` — диалоги
 *    редактирования стиля и иконки;
 *  - `editor/editor.ts` — сид диалога иконки мысли в шапке редактора;
 *  - `canvas/clipboard.ts` — сериализация снапшота копирования;
 *  - `canvas/add-dialog.ts` — сериализация запроса создания мысли;
 *  - `canvas/links.ts` — цвет линии связи от фона облачка (роль линии, не
 *    облачка);
 *  - `canvas/canvas.ts` — перенос полей в форму `FocusNeighbor` для отбора;
 *  - `screens/type-manager.ts` — редактор ТИПОВ (не мыслей);
 *  - `selection/selection.ts` — сид диалога стиля выделения;
 *  - `screens/structures/structures.ts` — сериализация `ThoughtRef` для
 *    keyed-сверки строк дерева (`rowRenderSignature`; перенесена из снесённого
 *    `realtime-apply.ts` в G2): читает поля оформления, но облачко по-прежнему
 *    собирает только `lib/thought-cloud.ts`.
 */
const VISUAL_FIELD_READERS = new Set([
  'lib/thought-cloud.ts',
  'lib/type-tree.ts',
  'editor/style-dialog.ts',
  'editor/icon-dialog.ts',
  // Универсальный диалог выбора ресурса (задача d1a56d76): источник «Иконки
  // мыслей» читает иконку/вид типа для сетки быстрого выбора.
  'editor/resource-picker.ts',
  // Диалог вставки картинки в текст (0.12.1, задача 87c455db): вкладка «Иконки
  // мыслей» фильтрует типы по виду иконки (`icon_kind='emoji'`) для быстрого
  // выбора глифа — тот же редактор выбора, а не представление мысли.
  'editor/insert-image-dialog.ts',
  'editor/editor.ts',
  'canvas/clipboard.ts',
  'canvas/add-dialog.ts',
  'canvas/links.ts',
  'canvas/canvas.ts',
  'screens/type-manager.ts',
  'selection/selection.ts',
  'screens/structures/structures.ts',
]);

/**
 * Места, где ширину облачка задаёт НЕ контейнер, а раскладка самого места:
 * каждому соответствует явный предел или измерение (причина — в значении).
 * Новое место сюда не добавляется: без такого предела оно обязано идти с
 * `width: 'container'` (см. правило 5 в шапке).
 *
 *  - `lib/thought-cloud.ts` — сама фабрика (её объявление не «место»);
 *  - `canvas/canvas.ts` — облачка холста: ширину задаёт холстовая сетка
 *    (`--cloud-width`), а не контейнер; строка предпросмотра — та же ширина;
 *  - `editor/mini-graph.ts` — узлы мини-графа: ширину измеряет
 *    `measureCloudWidth` до раскладки;
 *  - `screens/pinned-bar.ts` — чип полосы закреплённых: явный предел
 *    `.pinned-chip` (260px);
 *  - `screens/history-bar.ts` — чип полосы истории: явный предел
 *    `.history-cloud` (170px);
 *  - `screens/chronicle/chronicle.ts` — чип хроники: явный предел
 *    `.chron-chip.thought` / `.chron-chip.link` (150/240px);
 *  - `trash.ts` — чип таблицы группового удаления: ширину задаёт колонка
 *    таблицы диалога (auto-layout), «ширины контейнера» у ячейки нет.
 */
const FIXED_WIDTH_SITES = new Set([
  'lib/thought-cloud.ts',
  'canvas/canvas.ts',
  'editor/mini-graph.ts',
  'screens/pinned-bar.ts',
  'screens/history-bar.ts',
  'screens/chronicle/chronicle.ts',
  'trash.ts',
]);

/** Читает файл как UTF-8 (кидает с путём — так ошибка сторожа понятнее). */
function readText(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

/** Убирает CSS-комментарии, сохраняя переводы строк (для номеров строк). */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * Убирает из кода содержимое строк и комментариев, сохраняя переводы строк, —
 * чтобы искать вызовы фабрики и балансировать скобки по чистому коду.
 */
function stripCode(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

/** Одно CSS-объявление правила (порядок появления сохранён). */
interface Declaration {
  prop: string;
  value: string;
}

/**
 * Разбирает блок объявлений правила в список «свойство → значение».
 * Порядок сохраняется: позднее объявление переопределяет раннее — это и есть
 * каскад внутри правила (шорткат, затем лонгхенд).
 */
function parseDeclarations(body: string): Declaration[] {
  const out: Declaration[] = [];
  for (const chunk of body.split(';')) {
    const trimmed = chunk.trim();
    if (trimmed === '') continue;
    const at = trimmed.indexOf(':');
    if (at < 0) continue;
    out.push({
      prop: trimmed.slice(0, at).trim().toLowerCase(),
      value: trimmed.slice(at + 1).trim(),
    });
  }
  return out;
}

/** Токены значения CSS верхнего уровня (скобки `var(…)`/`rgb(…)` — один токен). */
function topLevelTokens(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (cur !== '') {
        out.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (cur !== '') out.push(cur);
  return out;
}

/** Ключевые слова стиля рамки (border-style). */
const BORDER_STYLES = new Set([
  'none',
  'hidden',
  'solid',
  'dashed',
  'dotted',
  'double',
  'groove',
  'ridge',
  'inset',
  'outset',
]);

/** Ширины рамки (длина или ключевое слово). */
const BORDER_WIDTHS = /^(?:\d+(?:\.\d+)?(?:px|em|rem)|thin|medium|thick)$/;

/**
 * Итоговый `border-right` правила с учётом каскада. Учитывает и общие
 * свойства (`border`, `border-color`/`-width`/`-style`), которые задают все
 * четыре стороны, и правые лонгхенды/шорткат, которые их переопределяют.
 * Порядок объявлений = каскад внутри правила. Для box-шорткатов из нескольких
 * значений берётся сторона «right» (индекс 1 при 2–4 значениях, иначе 0).
 * Возвращает итоговые значения по каждой части.
 */
function resolveBorderRight(decls: Declaration[]): {
  color: string | null;
  width: string | null;
  style: string | null;
} {
  let color: string | null = null;
  let width: string | null = null;
  let style: string | null = null;
  /** `border`/`border-right`: смешанные токены (ширина/стиль/цвет). */
  const setMixed = (value: string): void => {
    for (const token of topLevelTokens(value)) {
      const t = token.toLowerCase();
      if (BORDER_WIDTHS.test(t)) width = t;
      else if (BORDER_STYLES.has(t)) style = t;
      else color = token;
    }
  };
  /** Box-шорткат: взять значение стороны «right» и присвоить части. */
  const setSide = (value: string, assign: (v: string) => void): void => {
    const tokens = topLevelTokens(value);
    if (tokens.length === 0) return;
    assign(tokens.length === 1 ? (tokens[0] ?? '') : (tokens[1] ?? ''));
  };
  for (const d of decls) {
    switch (d.prop) {
      case 'border':
      case 'border-right':
        setMixed(d.value);
        break;
      case 'border-color':
        setSide(d.value, (v) => {
          color = v;
        });
        break;
      case 'border-right-color':
        color = d.value;
        break;
      case 'border-width':
        setSide(d.value, (v) => {
          width = v.trim().toLowerCase();
        });
        break;
      case 'border-right-width':
        width = d.value.trim().toLowerCase();
        break;
      case 'border-style':
        setSide(d.value, (v) => {
          style = v.trim().toLowerCase();
        });
        break;
      case 'border-right-style':
        style = d.value.trim().toLowerCase();
        break;
      default:
        break;
    }
  }
  return { color, width, style };
}

/** Свойства, задающие рамку (в т.ч. правую сторону) — признак «правило красит разделитель». */
const BORDER_PROPS = new Set([
  'border',
  'border-right',
  'border-color',
  'border-width',
  'border-style',
  'border-right-color',
  'border-right-width',
  'border-right-style',
]);

/** Классы последнего составного селектора части селектора. */
function lastCompoundClasses(selectorPart: string): string[] {
  const compounds = selectorPart.trim().split(/[\s>+~]+/);
  const last = compounds[compounds.length - 1] ?? '';
  return [...last.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1] ?? '');
}

/** Фон правила не «свой»: `inherit` либо полностью прозрачный фон. */
function isOwnBackgroundAllowed(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === 'inherit' || isTransparentColor(v);
}

/** Правило, красящее иконочную полосу: селектор + тело. */
interface BandRule {
  selector: string;
  body: string;
}

/**
 * Все правила, чей последний составной селектор — `.cloud-icon` (фон/разделитель
 * полосы). Ловит и базовое `.cloud-icon`, и контекстные (`.cloud .cloud-icon`,
 * `.cloud.focus-cloud .cloud-icon`), и любые иные формы: обход «вторым правилом»
 * ниже по файлу не спрятать. Перечисление селекторов через запятую учитывается
 * поэлементно.
 */
function collectBandRules(css: string): BandRule[] {
  const rules: BandRule[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const rawSelector = m[1] ?? '';
    const body = m[2] ?? '';
    for (const part of rawSelector.split(',')) {
      if (!lastCompoundClasses(part).includes('cloud-icon')) continue;
      rules.push({ selector: part.trim().replace(/\s+/g, ' '), body });
    }
  }
  return rules;
}

/**
 * Цвет прозрачен: ключевое слово `transparent` либо нулевая альфа в
 * `rgb()`/`rgba()` (в любой записи — с запятыми или через слэш).
 */
function isTransparentColor(value: string | null): boolean {
  if (value === null) return false;
  const v = value.trim().toLowerCase().replace(/\s+/g, ' ');
  if (v === 'transparent') return true;
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(v);
  return m !== null && m[4] !== undefined && Number.parseFloat(m[4]) === 0;
}

/** Рекурсивно собирает исходники renderer'а (без node_modules). */
function listTs(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') listTs(abs, out);
    } else if (entry.name.endsWith('.ts')) {
      out.push(abs);
    }
  }
  return out;
}

/** Текст одного вызова `createThoughtCloud(...)` — со сбалансированными скобками. */
function callText(source: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return source.slice(openParen, i + 1);
    }
  }
  return source.slice(openParen);
}

describe('guard: представление мысли строится только общей фабрикой облачка', () => {
  it('визуальные поля мысли не читаются вне разрешённых мест', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'no-visual-field-reads',
        description:
          'Читать fg_color/bg_color/font_*/icon_kind для построения своего ' +
          'представления мысли мимо lib/thought-cloud.ts запрещено (S1).',
        pattern: /\.(?:fg_color|bg_color|font_bold|font_italic|font_underline|font_strike|icon_kind)\b/,
        allow: (rel) => VISUAL_FIELD_READERS.has(rel),
      },
    ]);
  });

  it('канон облачка не импортируется из canvas.ts (старый путь закрыт)', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'no-canvas-canon-imports',
        description:
          'resolveCloudStyle/applyCloudStyle/resolveThoughtIcon/applyThoughtIcon ' +
          'импортируются только из lib/thought-cloud.ts; импорт из canvas/canvas.js ' +
          'закрыт (S1).',
        filePattern: /import\s*\{[^}]*\b(?:resolveCloudStyle|applyCloudStyle|resolveThoughtIcon|applyThoughtIcon)\b[^}]*\}\s*from\s*['"][^'"]*canvas\/canvas\.js['"]/s,
      },
    ]);
  });

  it('элементы облачка не собираются вручную вне фабрики', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'no-manual-cloud-assembly',
        description:
          'Ручная сборка элементов облачка (div/el с классами cloud, cloud-main, ' +
          'cloud-icon, cloud-title, prop-ref-cloud, mini-icon, prc-title) вне ' +
          'lib/thought-cloud.ts запрещена: готовая разметка — только из createThoughtCloud. ' +
          'Класс ловится и первым аргументом (el(\'cloud-icon\')), и вторым ' +
          '(el(\'span\', \'mini-icon\')).',
        // Опциональная первая строковая пара «(tag, class)»: класс — либо
        // единственный аргумент, либо второй в паре. `[^'\\]|\\.` — строка до
        // закрывающей кавычки (без переносов), чтобы не перескочить аргумент.
        pattern: /\b(?:div|el)\(\s*(?:'(?:[^'\\]|\\.)*'\s*,\s*)?'(?:cloud|cloud-main|cloud-icon|cloud-title|prop-ref-cloud|mini-icon|prc-title)'/,
        allow: (rel) => rel === 'lib/thought-cloud.ts',
      },
    ]);
  });

  it('ширина «по контейнеру» — только библиотечным классом, без контекстных обходов', () => {
    const css = stripCssComments(readText(STYLES_CSS));
    const libraryRule = /\.cloud-width-container\s*\{([^}]*)\}/.exec(css);
    assert.ok(
      libraryRule !== null,
      'the library rule `.cloud-width-container` must exist (width: auto; max-width: 100%)',
    );
    const libraryBody = libraryRule?.[1] ?? '';
    assert.match(libraryBody, /width:\s*auto;/, 'library rule releases the fixed width');
    assert.match(libraryBody, /max-width:\s*100%;/, 'the cloud must not overflow its container');
    assert.match(libraryBody, /min-width:\s*0;/, 'the cloud must be able to shrink to the container');

    // Имя класса в TS и в CSS — одно и то же (иначе модификатор молча не сработает).
    const ts = readText(THOUGHT_CLOUD_TS);
    const exportedClass = /CLOUD_WIDTH_CONTAINER_CLASS\s*=\s*'([^']+)'/.exec(ts)?.[1];
    assert.equal(
      exportedClass,
      'cloud-width-container',
      'CLOUD_WIDTH_CONTAINER_CLASS must match the CSS class',
    );

    // Никакое ДРУГОЕ правило не снимает предел ширины у облачка контекстом:
    // ширину «по контейнеру» объявляет вызов фабрики, а не селектор места.
    // Снятие (`width: auto` / `max-width: 100%`) допустимо только вместе с
    // СВОИМ пределом (`.cloud.focus-cloud` — состояние холста: `max-width:
    // min(78%, …)`); «размазанное» снятие без предела — нарушение.
    const violations: string[] = [];
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = (match[1] ?? '').trim().replace(/\s+/g, ' ');
      const body = match[2] ?? '';
      // Только классы самого облачка (`.cloud-title` и родня — другие элементы).
      if (!/\.(?:cloud|prop-ref-cloud)(?![\w-])/.test(selector)) continue;
      const maxWidths = [...body.matchAll(/max-width\s*:\s*([^;]+);/gi)].map((m) =>
        (m[1] ?? '').trim(),
      );
      const releasesWidth =
        /(?:^|[;\s])width\s*:\s*auto\s*;/i.test(body) || maxWidths.includes('100%');
      const hasOwnBound = maxWidths.some((value) => value !== '100%');
      if (!releasesWidth || hasOwnBound) continue;
      // База профиля задаёт предел по умолчанию, библиотечный класс — снимает.
      if (selector === '.cloud' || selector === '.prop-ref-cloud') continue;
      if (selector === '.cloud-width-container') continue;
      violations.push(`${selector} { … width: auto / max-width: 100% … }`);
    }
    assert.deepEqual(
      violations,
      [],
      `ширина облачка «по контейнеру» задаётся только классом .cloud-width-container ` +
        `(опция width: 'container' фабрики), а не селектором места:\n  ${violations.join('\n  ')}`,
    );
  });

  it('класс ширины вешается только фабрикой, не вызывающим', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'no-manual-container-class',
        description:
          'Класс cloud-width-container (ширина «по контейнеру») вешает фабрика ' +
          'lib/thought-cloud.ts по опции width: \'container\'; вручную — запрещено.',
        pattern: /cloud-width-container|CLOUD_WIDTH_CONTAINER_CLASS/,
        allow: (rel) => rel === 'lib/thought-cloud.ts',
      },
    ]);
  });

  it('иконочная полоса всегда берёт фон облачка — inherit, без признака cloud-has-bg', () => {
    // Дефолтный фон, унаследованный от типа и заданный вручную — все три
    // случая дают ОДИН фон у облачка и у иконочной полосы (задача 1dc56942,
    // ревизия критериев 2026-09-29): полоса объявляет унаследованный фон
    // (собственного `--surface-2` у неё нет), а разделительная линия прозрачна
    // при сохранённой толщине 1 px — геометрия полосы не меняется.
    //
    // Проверяем ЭФФЕКТ, а не точный текст, и ВСЕ правила полосы: обход «вторым
    // правилом» ниже по файлу (`.cloud .cloud-icon { background: … }`) обязан
    // краснеть. Блок объявлений разбирается в «свойство → значение», шорткаты
    // `border`/`border-right` и box-лонгхенды сводятся к итоговому разделителю.
    // Эквивалентные записи (`background: inherit` / `background: transparent`;
    // `border-right: 1px solid var(--border); border-right-color: transparent;`)
    // остаются зелёными.
    const css = stripCssComments(readText(STYLES_CSS));
    const bandRules = collectBandRules(css);
    assert.ok(
      bandRules.length > 0,
      'правила иконочной полосы с последним составным селектором `.cloud-icon` должны существовать',
    );

    // Каждое правило полосы: фон не свой, разделитель не виден и толщина 1 px.
    const problems: string[] = [];
    for (const rule of bandRules) {
      const decls = parseDeclarations(rule.body);
      if (/--surface-2/.test(rule.body)) {
        problems.push(`${rule.selector}: собственный фон --surface-2 запрещён`);
      }
      const bg = [...decls]
        .reverse()
        .find((d) => d.prop === 'background' || d.prop === 'background-color');
      if (bg !== undefined && !isOwnBackgroundAllowed(bg.value)) {
        problems.push(
          `${rule.selector}: фон полосы должен быть inherit или прозрачным, а не «${bg.value}»`,
        );
      }
      if (decls.some((d) => BORDER_PROPS.has(d.prop))) {
        const border = resolveBorderRight(decls);
        if (border.color !== null && !isTransparentColor(border.color)) {
          problems.push(`${rule.selector}: разделитель виден (border-right-color: ${border.color})`);
        }
        if (border.width !== null && border.width !== '1px') {
          problems.push(
            `${rule.selector}: толщина разделителя ${border.width} вместо 1 px (геометрия полосы сломана)`,
          );
        }
        if (border.style !== null && (border.style === 'none' || border.style === 'hidden')) {
          problems.push(
            `${rule.selector}: разделитель не отрисовывается (${border.style}) — геометрия полосы сломана`,
          );
        }
      }
    }
    assert.deepEqual(
      problems,
      [],
      `правила иконочной полосы должны давать унаследованный/прозрачный фон и невидимый разделитель 1 px:\n  ${problems.join('\n  ')}`,
    );

    // Условие исчезло: признак-класс `cloud-has-bg` мёртв и удалён — его нет
    // ни правилом в CSS, ни в коде фабрики, ни где-либо ещё в рендерере.
    assert.ok(
      !/\.cloud-has-bg\b/.test(css),
      'условное правило `.cloud-has-bg .cloud-icon` должно быть удалено',
    );
    assert.ok(
      !/cloud-has-bg|CLOUD_BG_CLASS/.test(readText(THOUGHT_CLOUD_TS)),
      'класс-признак cloud-has-bg и CLOUD_BG_CLASS должны быть удалены из фабрики',
    );
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'no-retired-bg-class',
        description:
          'Класс-признак cloud-has-bg удалён как мёртвый (фон полосы — всегда ' +
          'inherit/прозрачный от облачка): возвращать его в рендерер запрещено.',
        pattern: /cloud-has-bg|CLOUD_BG_CLASS/,
      },
    ]);
  });

  it('картинка-иконка в полосе масштабируется вместе с эмодзи (font-size полосы)', () => {
    // Ошибка c1b57533: высота `<img>` иконки была привязана к базовому
    // `calc(var(--cloud-font) * 1.45)` и не учитывала подъём `font-size` у
    // `.cloud.focus-cloud .cloud-icon` (1.9) — в фокусном облачке картинка
    // оставалась маленькой, тогда как эмодзи заполнял полосу. Размер картинки
    // обязан следовать шрифту полосы (`1em`), а не базовой переменной, иначе
    // любой контекстный подъём размера глифа снова разведёт их.
    const css = stripCssComments(readText(STYLES_CSS));

    // Контекстный подъём размера глифа существует — иначе правило `1em` не
    // имело бы смысла, и тест защищал бы от несуществующего расхождения.
    const sizeBumps: string[] = [];
    let iconImgHeight: string | null = null;
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = (m[1] ?? '').trim().replace(/\s+/g, ' ');
      const body = m[2] ?? '';
      if (lastCompoundClasses(selector).includes('cloud-icon')) {
        const decl = parseDeclarations(body).find((d) => d.prop === 'font-size');
        if (decl !== undefined) sizeBumps.push(`${selector} { font-size: ${decl.value} }`);
      }
      if (/\.cloud-icon\s+img$/.test(selector)) {
        const decl = parseDeclarations(body).find((d) => d.prop === 'height');
        iconImgHeight = decl?.value ?? null;
      }
    }

    assert.ok(
      sizeBumps.length > 0,
      'должен существовать контекстный подъём `font-size` у `.cloud-icon` (например, `.cloud.focus-cloud .cloud-icon`)',
    );
    assert.ok(iconImgHeight !== null, 'правило `.cloud-icon img { height: … }` должно существовать');
    assert.match(
      iconImgHeight,
      /^1em$/,
      `высота картинки-иконки должна быть font-relative (\`1em\`), а не фиксированной ` +
        `от базовой переменной — иначе она не догоняет увеличенный глиф (найдено: «${iconImgHeight}»)`,
    );
    assert.ok(
      !/var\(--cloud-font\)/.test(iconImgHeight),
      'высота картинки-иконки не должна опираться на базовый `var(--cloud-font)` в обход шрифта полосы',
    );
  });

  it('в каждом месте ширина облачка объявлена явно или задана раскладкой места', () => {
    const missing: string[] = [];
    for (const file of listTs(RENDERER_ROOT)) {
      const rel = path.relative(RENDERER_ROOT, file).replace(/\\/g, '/');
      const raw = readText(file);
      if (!raw.includes('createThoughtCloud(')) continue;
      if (FIXED_WIDTH_SITES.has(rel)) continue;
      const code = stripCode(raw);
      let idx = -1;
      while ((idx = code.indexOf('createThoughtCloud(', idx + 1)) >= 0) {
        const open = code.indexOf('(', idx);
        const call = callText(code, open);
        if (/\bwidth\s*:/.test(call)) continue;
        const lineNo = code.slice(0, idx).split('\n').length;
        missing.push(`${rel}:${lineNo}`);
      }
    }
    assert.deepEqual(
      missing,
      [],
      `место без явного предела ширины обязано идти с width: 'container' ` +
        `(явный предел — модификатор места, см. FIXED_WIDTH_SITES):\n  ${missing.join('\n  ')}`,
    );
  });
});

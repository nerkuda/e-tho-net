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
 *  - `selection/selection.ts` — сид диалога стиля выделения.
 */
const VISUAL_FIELD_READERS = new Set([
  'lib/thought-cloud.ts',
  'lib/type-tree.ts',
  'editor/style-dialog.ts',
  'editor/icon-dialog.ts',
  'editor/editor.ts',
  'canvas/clipboard.ts',
  'canvas/add-dialog.ts',
  'canvas/links.ts',
  'canvas/canvas.ts',
  'screens/type-manager.ts',
  'selection/selection.ts',
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

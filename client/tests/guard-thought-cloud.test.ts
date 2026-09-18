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
 *
 * Сторож вводится зелёным — в том же изменении, которое переводит все 26 мест
 * на фабрику (мета-стандарт «Правило без теста-сторожа не считается
 * введённым»).
 */

import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertGuardClean } from './guard-helpers.js';

const RENDERER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'renderer',
);

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
          'lib/thought-cloud.ts запрещена: готовая разметка — только из createThoughtCloud.',
        pattern: /\b(?:div|el)\(\s*'(?:[^']*,\s*)?(?:cloud|cloud-main|cloud-icon|cloud-title|prop-ref-cloud|mini-icon|prc-title)'/,
        allow: (rel) => rel === 'lib/thought-cloud.ts',
      },
    ]);
  });
});

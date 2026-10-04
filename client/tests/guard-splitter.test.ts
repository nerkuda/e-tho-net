/**
 * Сторож единого сплиттера `lib/ui` (задача 50f57b82, ADR 03eb2c61,
 * инвентаризация 3fc7c54d — раздел «Splitter»).
 *
 * Правило: разделитель/ресайзер рендерера живёт только в компоненте
 * `lib/ui/splitter.ts` — он создаёт гриф и ведёт pointer-drag (захват
 * указателя, класс `dragging`, `pointermove`/`pointerup`/`pointercancel`).
 * Владелец задаёт лишь политику через `plan`/`resolve`/`apply`/`commit`.
 * Прежде шесть модулей (`editor/splitter`, `lib/filter-panel-frame`,
 * `screens/editor-resizer`, `screens/selection-resizer`,
 * `screens/event-area-resizer`, `canvas/zone-splitters`) тянули разделитель
 * каждый по-своему, и политики разошлись.
 *
 * Запрещено вне `lib/ui/`:
 *   1. собственный pointer-drag — захват указателя
 *      (`setPointerCapture`/`releasePointerCapture`). Внутри `lib/ui` захват
 *      ведут ОБЩИЕ компоненты: разделитель `splitter.ts` и сортируемый список
 *      `drag-list.ts` (задача d13fd645) — дублировать drag в экранах нельзя;
 *   2. собственное создание элемента разделителя — `div('…splitter…')` /
 *      `div('…resizer…')` вместо фабрики `splitterElement`.
 *
 * Сторож вводится зелёным — в том же изменении, которое переводит все шесть
 * точек на компонент. Имена и вызовы внутри `lib/ui` разрешены;
 * строки-комментарии правилами не считаются.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { assertGuardClean, collectViolations, type GuardRule } from './guard-helpers.js';

const RENDERER_ROOT = path.resolve(import.meta.dirname, '..', 'src', 'renderer');

/** Сам компонент — единственное место, где живёт drag и фабрика элемента. */
const COMPONENT = 'lib/ui/splitter.ts';

/** Строка — комментарий? (в пояснениях имена функций/классов допустимы). */
function isComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/** Захват указателя — признак собственного pointer-drag разделителя. */
const OWN_DRAG = /setPointerCapture|releasePointerCapture/;

/** Создание элемента разделителя в обход фабрики `splitterElement`. */
const OWN_ELEMENT = /(?:div|el)\(\s*['"][^'"]*(?:splitter|resizer)/;

const RULES: GuardRule[] = [
  {
    name: 'no-own-splitter-drag',
    description:
      'Pointer-drag разделителя ведёт компонент `lib/ui/splitter.ts` ' +
      '(задача 50f57b82): собственный захват указателя в разделителе вне ' +
      '`lib/ui` запрещён — прежде шесть реализаций расходились в поведении.',
    pattern: OWN_DRAG,
    // Захват указателя — только внутри общих компонентов `lib/ui`.
    allow: (rel, line) => rel.startsWith('lib/ui/') || isComment(line),
  },
  {
    name: 'no-own-splitter-element',
    description:
      'Элемент разделителя создаёт фабрика `splitterElement` из ' +
      '`lib/ui/splitter.ts` (задача 50f57b82): `div(\'…-splitter\')` и ' +
      "`div('…-resizer')` в обход неё запрещены.",
    pattern: OWN_ELEMENT,
    allow: (rel, line) => rel === COMPONENT || isComment(line),
  },
];

/** Точки, переведённые на общий компонент (шесть мест каталога 3fc7c54d). */
const TRANSLATED = [
  'editor/splitter.ts',
  'lib/filter-panel-frame.ts',
  'screens/editor-resizer.ts',
  'screens/selection-resizer.ts',
  'screens/event-area-resizer.ts',
  'canvas/zone-splitters.ts',
];

describe('guard: разделитель рендерера — единый компонент lib/ui', () => {
  it('собственный pointer-drag и собственный элемент разделителя запрещены', () => {
    assertGuardClean(RENDERER_ROOT, RULES);
  });

  it('компонент ведёт весь жизненный цикл драга и создаёт гриф', () => {
    const src = fs.readFileSync(path.join(RENDERER_ROOT, COMPONENT), 'utf8');
    for (const [re, what] of [
      [/export function splitterElement\(/, 'фабрика элемента'],
      [/export function wireSplitter\(/, 'монтаж драга'],
      [/export function uiSplitter\(/, 'фабрика «элемент + драг»'],
      [/const DRAGGING_CLASS = 'dragging'/, 'класс dragging'],
      [/setPointerCapture\(event\.pointerId\)/, 'захват указателя'],
      [/addEventListener\('pointermove', onMove\)/, 'слежение за указателем'],
      [/addEventListener\('pointerup', onUp\)/, 'отпускание указателя'],
      [/addEventListener\('pointercancel', onUp\)/, 'отмена драга'],
      [/element\.textContent = options\.grip \?\? GRIP_GLYPH/, 'единый гриф'],
    ] as const) {
      assert.match(src, re, `компонент обязан содержать ${what}`);
    }
  });

  it('все шесть точек идут через компонент, а не через свой drag', () => {
    for (const rel of TRANSLATED) {
      const src = fs.readFileSync(path.join(RENDERER_ROOT, rel), 'utf8');
      assert.match(
        src,
        /wireSplitter\(|uiSplitter\(/,
        `${rel} обязан вешать драг через lib/ui/splitter`,
      );
      assert.ok(
        !OWN_DRAG.test(src),
        `${rel} не должен сам захватывать указатель`,
      );
    }
  });

  it('оба правила краснеют на умышленном нарушении', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-splitter-'));
    try {
      fs.mkdirSync(path.join(dir, 'screens'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'screens', 'own-resizer.ts'),
        [
          "const node = div('own-splitter');",
          'function wire() {',
          '  node.setPointerCapture(1);',
          '}',
        ].join('\n'),
      );
      const violations = collectViolations(dir, RULES);
      assert.ok(
        violations.some((v) => v.rule === 'no-own-splitter-drag'),
        'правило о собственном драге срабатывает',
      );
      assert.ok(
        violations.some((v) => v.rule === 'no-own-splitter-element'),
        'правило о собственном элементе срабатывает',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

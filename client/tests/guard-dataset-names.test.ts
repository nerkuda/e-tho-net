/**
 * Сторож имён свойств `dataset` рендерера (ошибка 0.13.1 — `entity-kind`).
 *
 * Правило: ключ `dataset` — это имя свойства `DOMStringMap`, а он принимает
 * ТОЛЬКО синтаксически допустимые имена (идентификаторы). Обращение
 * `el.dataset['entity-kind']` не читает `data-entity-kind`, а бросает
 * `SyntaxError: Failed to set a named property 'entity-kind' on 'DOMStringMap'`
 * и рушит весь рендер: так падала панель «Дневника» при вводе слова в поиске
 * (лист «Цели в выборке», `client/src/renderer/lib/filter-value.ts`).
 *
 * Канонично: camelCase (`el.dataset['entityKind']` — соответствует атрибуту
 * `data-entity-kind`) либо `el.setAttribute('data-entity-kind', …)` — как в
 * `screens/chronicle/chronicle.ts` (строка `data-row-key`).
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import { describe, it } from 'node:test';

import { assertGuardClean, type GuardRule } from './guard-helpers.js';
import { RENDERER_ROOT } from './renderer-css.js';

/** Ключ `dataset` со строковым литералом, содержащим дефис — недопустимое имя. */
const KEBAB_KEY = /dataset\[\s*['"][^'"]*-[^'"]*['"]\s*\]/;

/** Строка — комментарий (правило к исполняемому коду, не к пояснениям). */
function isComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

const RULES: GuardRule[] = [
  {
    name: 'dataset-kebab-key',
    description:
      'Ключ dataset со дефисом (`dataset[\'entity-kind\']`) бросает SyntaxError на DOMStringMap — ' +
      'пиши camelCase (`dataset[\'entityKind\']`) или `setAttribute(\'data-…\', …)`.',
    pattern: KEBAB_KEY,
    allow: (_rel, line) => isComment(line),
  },
];

describe('guard: имена свойств dataset рендерера', () => {
  it('ни один ключ dataset не содержит дефис (DOMStringMap бросает SyntaxError)', () => {
    assertGuardClean(RENDERER_ROOT, RULES);
  });
});

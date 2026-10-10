/**
 * Модификаторные Enter волны 3 миграции на диспетчер сочетаний (задача
 * fd3d84f4, повторная приёмка). Прежние локальные обработчики реагировали на
 * `event.key === 'Enter'` НЕЗАВИСИМО от модификаторов; после перевода на
 * `lib/keymap.ts` (диспетчер сопоставляет набор модификаторов точно)
 * сочетания восстановлены хелпером `modifierChordVariants('Enter')`.
 *
 * Поведенческие тесты восстановленных мест — в `add-dialog.test.ts`
 * (поле и строки кандидатов), `structures-expanded-kbd-nav.test.ts` (список),
 * `canvas-editor-frames.test.ts` (карта) и `chronicle-record-title.test.ts`
 * (поле заголовка). Здесь — якорные проверки остальных четырёх мест волны 3,
 * которые монтируются только целиком (поиск карты, строки дифа слоёв, грид
 * отборов, inline-переименование полки): они обязаны строить хотя бы одну
 * привязку на каждое подмножество модификаторов и не иметь чистого `Enter`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const RENDERER = path.resolve(import.meta.dirname, '..', 'src', 'renderer');

function source(rel: string): string {
  return readFileSync(path.join(RENDERER, ...rel.split('/')), 'utf8');
}

/** Место волны 3: файл, команда диспетчера и человекочитаемое имя. */
const WAVE3_SITES: ReadonlyArray<{ rel: string; command: string; what: string }> = [
  { rel: 'search/search.ts', command: 'search.enter', what: 'поле поиска карты' },
  { rel: 'screens/layers.ts', command: 'layers.diff.open', what: 'строки построчного дифа слоёв' },
  { rel: 'screens/thought-type/views-tab.ts', command: 'viewsTab.open', what: 'грид отборов типа мысли' },
  {
    rel: 'screens/publications/publications.ts',
    command: 'publications.shelf.rename.commit',
    what: 'inline-переименование полки',
  },
];

describe('волна 3: Enter-привязки восстановлены через modifierChordVariants (задача fd3d84f4)', () => {
  for (const site of WAVE3_SITES) {
    it(`${site.what} (${site.rel}) строит привязки на все подмножества модификаторов`, () => {
      const text = source(site.rel);
      assert.match(
        text,
        /modifierChordVariants\('Enter'\)/,
        `${site.rel}: Enter обязан быть выражен хелпером модификаторных вариантов`,
      );
      assert.match(
        text,
        new RegExp(`command: '${site.command.replace(/[.]/g, '\\.')}'`),
        `${site.rel}: команда ${site.command} должна присутствовать`,
      );
      // Чистый `chord: 'Enter'` — признак невосстановленной семантики (модификаторы
      // теряются). Механизмные места (Escape и т.п.) трогать не требуется.
      assert.doesNotMatch(
        text,
        /chord: 'Enter'/,
        `${site.rel}: не осталось чистого Enter — иначе Shift/Alt/Meta+Enter теряются`,
      );
    });
  }

  it('карта: Ctrl/Meta+Enter фокусируют курсор, прочие модификаторы — открывают мысль', () => {
    const text = source('canvas/kbd-nav.ts');
    assert.match(text, /modifierChordVariants\('Enter'\)/, 'Enter карты — через хелпер');
    assert.match(
      text,
      /chord\.includes\('Ctrl\+'\) \|\| chord\.includes\('Meta\+'\) \? 'canvas\.focusCursor' : 'canvas\.open'/,
      'Ctrl/Meta-ветка — canvas.focusCursor (как прежде), прочие — canvas.open',
    );
    assert.doesNotMatch(text, /chord: 'Ctrl\+Enter'/, 'нет отдельной одноразовой привязки Ctrl+Enter');
  });
});

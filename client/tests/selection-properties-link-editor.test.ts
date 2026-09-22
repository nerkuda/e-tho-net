/**
 * Regression test for the bulk «Изменить значение свойства…» dialog
 * (`selection/dialogs.ts`, selection panel → «Свойства»): a `link`-typed
 * property row must use the unified value editor (`buildValueEditor` из
 * `editor/value-editor.ts`, ADR «значение свойства вводит один компонент»,
 * стандарт S2, задача 77e7cafd вехи 4), not the muted dash placeholder that
 * made свойства-связи unrecoverable through this dialog (ошибка e5cfacb9).
 *
 * `showSelectionPropertiesDialog` drives `showDialog`, which registers
 * `window.addEventListener('keydown', …)` — heavier to shim than a
 * source-scan for this narrow structural invariant, matching the existing
 * convention (see `type-editor-tabs.test.ts`).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const SOURCE_PATH = resolve(
  import.meta.dirname,
  '..',
  'src',
  'renderer',
  'selection',
  'dialogs.ts',
);

function readSource(): string {
  return readFileSync(SOURCE_PATH, 'utf8');
}

describe('selection properties dialog — link property row (e5cfacb9)', () => {
  it('imports buildValueEditor from editor/value-editor.js (S2, веха 4)', () => {
    const src = readSource();
    assert.ok(
      /import\s*\{[^}]*buildValueEditor[^}]*\}\s*from\s*['"]\.\.\/editor\/value-editor\.js['"]/.test(
        src,
      ),
      'buildValueEditor must be imported from editor/value-editor.js',
    );
  });

  it('the value cell builds the unified editor for every value type', () => {
    const src = readSource();
    const cellStart = src.indexOf('function buildValueCell');
    assert.ok(cellStart > 0, 'buildValueCell not found');
    const cellBody = src.slice(cellStart);
    assert.ok(
      cellBody.includes('buildValueEditor({'),
      'the value cell must build the unified value editor (link included)',
    );
  });

  it('no longer renders the old muted dash placeholder for link properties', () => {
    const src = readSource();
    assert.ok(
      !src.includes('Свойство-связь: значение — рёбра, пакетный диалог их не редактирует.'),
      'the old read-only placeholder comment must be gone',
    );
    assert.ok(
      !/cell\.append\(span\('—', 'muted'\)\);\s*\n\s*return cell;\s*\n\s*}\s*\n?\s*}/.test(src),
      'no dangling default-fallback dash at the end of buildValueCell',
    );
  });

  it('PropertyRowState.def is typed as EffectiveTypeProperty (config needed by buildValueEditor)', () => {
    const src = readSource();
    assert.ok(
      /interface PropertyRowState\s*\{\s*def:\s*EffectiveTypeProperty;/.test(src),
      'PropertyRowState.def must carry EffectiveTypeProperty (with .config)',
    );
  });
});

/**
 * Regression test for the bulk «Изменить значение свойства…» dialog
 * (`selection/dialogs.ts`, selection panel → «Свойства»): a `link`-typed
 * property row must use the unified chip editor (`buildLinkValueEditor`,
 * инструкция a47947c8-fcd0-43aa-9132-cb7f17fbc240), not the muted dash
 * placeholder that made свойства-связи unrecoverable through this dialog
 * (ошибка e5cfacb9).
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
  it('imports buildLinkValueEditor from editor/properties.js', () => {
    const src = readSource();
    assert.ok(
      /import\s*\{[^}]*buildLinkValueEditor[^}]*\}\s*from\s*['"]\.\.\/editor\/properties\.js['"]/.test(
        src,
      ),
      'buildLinkValueEditor must be imported from editor/properties.js',
    );
  });

  it('the link branch of buildValueCell builds the unified chip editor', () => {
    const src = readSource();
    const cellStart = src.indexOf('function buildValueCell');
    assert.ok(cellStart > 0, 'buildValueCell not found');
    const cellBody = src.slice(cellStart);
    assert.ok(
      cellBody.includes('buildLinkValueEditor({'),
      'the link branch must build the unified chip editor',
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

  it('PropertyRowState.def is typed as EffectiveTypeProperty (config needed by buildLinkValueEditor)', () => {
    const src = readSource();
    assert.ok(
      /interface PropertyRowState\s*\{\s*def:\s*EffectiveTypeProperty;/.test(src),
      'PropertyRowState.def must carry EffectiveTypeProperty (with .config)',
    );
  });
});

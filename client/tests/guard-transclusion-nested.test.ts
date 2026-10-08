/**
 * Сторож вложенного редактора блока трансклюзии и удаления «растворения» текста
 * источника (0.12.1, ТП `fcde7c55`, задача `73ae1d4b`).
 *
 * Правила, которые обязан удерживать код:
 *   1. механизма «растворения» в `transclusion.ts` больше НЕТ: нет `blockEdit`,
 *      `startBlockEdit`, `restoreBlockEdit`, `cancelBlockEdit`, `BlockEditState`,
 *      `refRaw`, `setBlockEditRange`, `blockEditCollapseFacet`, линейной рамки
 *      `TRANSCLUSION_EDIT_RANGE_CLASS`/`--first`/`--last` и `TRANSCLUSION_ACTIONS_CLASS`;
 *      режимные CSS-селекторы (`cm-transclusion-actions`,
 *      `cm-transclusion-edit-range`, `transclusion-link`, `transclusion-change`)
 *      удалены и из `styles/editor.css`;
 *   2. в `comment-commands.ts` нет кнопок «Отменить/Сохранить трансклюзию»
 *      (`transclusion.cancel` / `transclusion.save`) и `setBlockEditing`;
 *   3. вход в блок — кареткой: жесты зовут `enterBlock`, есть хранилище
 *      `NestedEditorStore` и стек вложенного редактора тот же
 *      (`mdEditorExtensions`), глубина ограничена `MAX_NESTED_DEPTH`;
 *   4. гейтов порчи данных в `md-editor.ts` больше нет (`isBlockEditing`,
 *      `inputMirrorText` не нужны — текст блока не попадает в документ поля).
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const RENDERER_ROOT = path.resolve(import.meta.dirname, '..', 'src', 'renderer');
const EDITOR = path.join(RENDERER_ROOT, 'editor');
const read = (name: string): string => fs.readFileSync(path.join(EDITOR, name), 'utf8');

const TRANSCLUSION = read('transclusion.ts');
const COMMENT_COMMANDS = read('comment-commands.ts');
const MD_EDITOR = read('md-editor.ts');
const NESTED = read('transclusion-nested.ts');
const COMMENT_COLLAPSE = read('comment-collapse.ts');
const EDITOR_CSS = fs.readFileSync(
  path.join(RENDERER_ROOT, 'styles', 'editor.css'),
  'utf8',
);

/**
 * Удалённые идентификаторы «растворения» (в исходнике не должно быть вовсе).
 * `blockEdit` — с границами слова: не должен ловить действующие имена
 * `blockEditorKey` / `blockEditorStoreFacet` / `blockEditorHostFacet`.
 */
const REMOVED = [
  /\bblockEdit\b/,
  'startBlockEdit',
  'restoreBlockEdit',
  'cancelBlockEdit',
  'saveBlockEdit',
  'BlockEditState',
  'refRaw',
  'setBlockEditRange',
  'TRANSCLUSION_EDIT_RANGE_CLASS',
  'TRANSCLUSION_EDITING_FIRST',
  'TRANSCLUSION_ACTIONS_CLASS',
];

describe('guard: вложенный редактор блока вместо растворения (73ae1d4b)', () => {
  it('механизм «растворения» удалён из transclusion.ts', () => {
    for (const name of REMOVED) {
      const found = typeof name === 'string' ? TRANSCLUSION.includes(name) : name.test(TRANSCLUSION);
      assert.ok(!found, `в transclusion.ts остался удалённый идентификатор «${String(name)}»`);
    }
  });

  it('фасет диапазона правки блока удалён из comment-collapse.ts', () => {
    assert.ok(
      !COMMENT_COLLAPSE.includes('blockEditCollapseFacet'),
      'в comment-collapse.ts остался blockEditCollapseFacet',
    );
    assert.ok(
      !COMMENT_COLLAPSE.includes('BlockEditCollapseRegion'),
      'в comment-collapse.ts остался тип BlockEditCollapseRegion',
    );
  });

  it('режимные CSS-селекторы блока («растворение», ховер-кнопки) не возвращаются', () => {
    for (const sel of [
      'cm-transclusion-actions',
      'cm-transclusion-edit-range',
      'transclusion-link',
      'transclusion-change',
    ]) {
      assert.ok(
        !EDITOR_CSS.includes(sel),
        `в editor.css остался/вернулся режимный селектор «${sel}»`,
      );
    }
  });

  it('кнопки «Отменить/Сохранить трансклюзию» и setBlockEditing удалены', () => {
    for (const name of ['transclusion.cancel', 'transclusion.save', 'setBlockEditing']) {
      assert.ok(
        !COMMENT_COMMANDS.includes(name),
        `в comment-commands.ts остался удалённый элемент «${name}»`,
      );
    }
  });

  it('вход в блок идёт кареткой: жесты зовут enterBlock', () => {
    assert.ok(TRANSCLUSION.includes('enterBlock('), 'transclusion.ts не зовёт enterBlock');
    assert.ok(TRANSCLUSION.includes('setActiveBlock'), 'нет эффекта активного блока setActiveBlock');
    assert.ok(TRANSCLUSION.includes('blockEditorStoreFacet'), 'нет фасета хранилища вложенных редакторов');
  });

  it('вложенный редактор использует тот же стек расширений и ограничен по глубине', () => {
    assert.ok(
      NESTED.includes('mdEditorExtensions'),
      'вложенный редактор не переиспользует mdEditorExtensions (дублирование стека)',
    );
    assert.ok(NESTED.includes('MAX_NESTED_DEPTH'), 'нет ограничения глубины вложенных редакторов');
    assert.ok(NESTED.includes('export class NestedEditorStore'), 'нет хранилища NestedEditorStore');
  });

  it('гейты порчи данных в md-editor.ts удалены как мёртвые', () => {
    assert.ok(
      !MD_EDITOR.includes('isBlockEditing'),
      'в md-editor.ts остался гейт isBlockEditing — текст блока больше не в документе поля',
    );
    assert.ok(
      !MD_EDITOR.includes('inputMirrorText'),
      'в md-editor.ts остался гейт inputMirrorText',
    );
  });
});

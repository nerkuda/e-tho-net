/**
 * Юнит-тесты команд-иконок диалога фильтра типов связей на карте
 * (client/src/renderer/canvas/link-filter-dialog.ts; ошибка bd8b78a0).
 *
 * Проверяется состав верхней строки — две команды-иконки с полными
 * названиями в тултипах («Пометить все», «Вернуть умолчания»; «Очистить»
 * добавляет сам пикер) — и их действие над набором отметок. Раскладку
 * (ничего не вылезает) юнит-тестами не проверить: jsdom в проекте нет,
 * раскладку смотрит CSS-зонд на Chromium (грабли «CSS-раскладку проверяют
 * зондом…»).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LinkType } from '@etn/shared';

import { linkFilterCommands } from '../src/renderer/canvas/link-filter-dialog.js';
import type { EntityPickerDialogCtx } from '../src/renderer/lib/entity-picker.js';
import { store } from '../src/renderer/state.js';

function lt(id: string, name: string, isRoot = false): LinkType {
  return {
    id,
    name_forward: name,
    name_reverse: `${name}обр`,
    parent_id: isRoot ? id : null,
    is_root: isRoot,
    color: null,
    style: null,
    width: null,
    description: null,
    version: 1,
    created_at: '',
    updated_at: '',
    created_by: '',
  };
}

/** Контекст-заглушка с подсчётом перерисовок. */
function makeCtx(initial: string[]): { ctx: EntityPickerDialogCtx; rerenders: () => number } {
  let rerenders = 0;
  const ctx: EntityPickerDialogCtx = {
    checked: new Set(initial),
    rerender: () => {
      rerenders += 1;
    },
  };
  return { ctx, rerenders: () => rerenders };
}

/** Не-типовые id в наборе (синтетическая строка «Структура»). */
function syntheticIds(checked: ReadonlySet<string>, typeIds: readonly string[]): string[] {
  return [...checked].filter((id) => !typeIds.includes(id));
}

describe('link-filter-dialog: команды-иконки верхней строки (bd8b78a0)', () => {
  it('две команды: «Пометить все» и «Вернуть умолчания», иконки + тултипы', () => {
    const cmds = linkFilterCommands({ include_structural: true })(makeCtx([]).ctx);
    assert.deepEqual(
      cmds.map((c) => [c.icon, c.title]),
      [
        ['check-check', 'Пометить все'],
        ['rotate-ccw', 'Вернуть умолчания'],
      ],
    );
  });

  it('«Пометить все» отмечает все не-корневые типы связей и строку «Структура»', () => {
    store.update({ linkTypes: [lt('root', 'основной', true), lt('la', 'A'), lt('lb', 'B')] });
    const { ctx, rerenders } = makeCtx([]);
    const cmds = linkFilterCommands({ include_structural: true })(ctx);
    const markAll = cmds[0];
    assert.ok(markAll, 'первая команда — «Пометить все»');
    markAll.onClick();
    assert.deepEqual([...ctx.checked].sort(), ['la', 'lb', '__structural__'].sort());
    assert.equal(rerenders(), 1, 'список перерисован');
  });

  it('«Вернуть умолчания» возвращает дефолтный набор (типы + структура по флагу)', () => {
    const { ctx } = makeCtx(['lb']);
    const cmds = linkFilterCommands({ type_ids: ['la'], include_structural: true })(ctx);
    const reset = cmds[1];
    assert.ok(reset, 'вторая команда — «Вернуть умолчания»');
    reset.onClick();
    assert.deepEqual([...ctx.checked].sort(), ['la', '__structural__'].sort());

    const off = makeCtx(['la', 'lb']);
    const noStructural = linkFilterCommands({ type_ids: ['la'], include_structural: false })(
      off.ctx,
    );
    const resetOff = noStructural[1];
    assert.ok(resetOff, 'вторая команда — «Вернуть умолчания»');
    resetOff.onClick();
    assert.deepEqual([...off.ctx.checked], ['la']);
    assert.deepEqual(syntheticIds(off.ctx.checked, ['la']), [], 'структура не отмечена');
  });
});

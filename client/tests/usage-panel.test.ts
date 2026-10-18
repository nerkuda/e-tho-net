/**
 * Чистая модель панели использования (спека f7623077, ошибка aca92904).
 *
 * Проверяется главное для сценария c8160921 (шаги 3–5): строка группы — это
 * пара «ссылающаяся мысль + имя свойства», а удерживающие слои берутся из
 * `usage.holding_layers` с подстраховкой `deletion-check`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { HoldingLayerRef, ThoughtUsage } from '@etn/shared';

import { usageLayers, usagePropertyRows } from '../src/renderer/lib/usage.js';

function ref(id: string, title: string) {
  return {
    id,
    title,
    type_id: null,
    icon: null,
    icon_kind: 'emoji' as const,
    icon_attachment_id: null,
    active: true,
    marked_for_deletion: false,
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
  };
}

const USAGE: ThoughtUsage = {
  total: 3,
  groups: [
    {
      property_id: 'p-1',
      key: 'автор',
      thoughts: [ref('t-1', 'Книга 1'), ref('t-2', 'Книга 2')],
    },
    {
      property_id: 'p-2',
      key: 'редактор',
      thoughts: [ref('t-3', 'Книга 3')],
    },
  ],
  holding_layers: [{ id: 'layer-1', title: 'Правки' }],
};

describe('usagePropertyRows: группа «Используется в свойствах»', () => {
  it('даёт по строке на пару «мысль + свойство» в серверном порядке', () => {
    const rows = usagePropertyRows(USAGE);
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((row) => [row.thought.id, row.propertyKey]),
      [
        ['t-1', 'автор'],
        ['t-2', 'автор'],
        ['t-3', 'редактор'],
      ],
    );
    assert.equal(rows[0]!.propertyId, 'p-1');
  });

  it('пустой/отсутствующий usage — пустой список', () => {
    assert.deepEqual(usagePropertyRows(null), []);
    assert.deepEqual(usagePropertyRows({ total: 0, groups: [], holding_layers: [] }), []);
  });
});

describe('usageLayers: группа «Используется в слоях»', () => {
  const fromUsage: HoldingLayerRef[] = [{ id: 'layer-1', title: 'Правки' }];
  const fromCheck: HoldingLayerRef[] = [
    { id: 'base', title: 'Основа' },
    { id: 'layer-1', title: 'Правки' },
    { id: 'layer-2', title: 'Эксперимент' },
  ];

  it('берёт holding_layers из usage', () => {
    assert.deepEqual(usageLayers(fromUsage, []), fromUsage);
  });

  it('подстраховывается deletion-check и схлопывает дубли', () => {
    assert.deepEqual(usageLayers(fromUsage, fromCheck), fromCheck);
  });

  it('нет удержаний — пустой список', () => {
    assert.deepEqual(usageLayers(undefined, null), []);
  });
});

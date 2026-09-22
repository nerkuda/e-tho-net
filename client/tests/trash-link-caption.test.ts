/**
 * Подпись связи «<источник> → <назначение> · <тип связи>» — общее правило
 * диалога удаления связи (ошибка ce687b37: диалог не называл удаляемую связь)
 * и строки корзины (ошибка 009784ad: у ребра в `etn.trash.list` только id
 * концов). Чистая логика — DOM не нужен: имена концов приходят картой, имя типа
 * резолвится из кэша типов сети (`store.state.linkTypes`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LinkType } from '@etn/shared';

import { store } from '../src/renderer/state.js';
import { trashInternals } from '../src/renderer/trash.js';

const { linkCaption, linkTypeForwardName } = trashInternals;

/** Минимальный тип связи для кэша сети. */
function linkType(id: string, forward: string, reverse: string): LinkType {
  return {
    id,
    name_forward: forward,
    name_reverse: reverse,
    parent_id: null,
    is_root: false,
    color: null,
    style: null,
    width: null,
    description: null,
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    created_by: 'u1',
  };
}

const link = { source_id: 's', target_id: 't', type_id: 'lt1' };

describe('подпись связи в диалогах удаления и корзины', () => {
  it('строит «источник → назначение · имя типа» из карты названий', () => {
    store.update({ linkTypes: [linkType('lt1', 'вызывает', 'вызывается')] });
    try {
      const titles = new Map([
        ['s', 'Мысль A'],
        ['t', 'Мысль B'],
      ]);
      assert.equal(linkCaption(link, titles), 'Мысль A → Мысль B · вызывает');
    } finally {
      store.update({ linkTypes: [] });
    }
  });

  it('нетипизированная связь подписана словом «связь» (как тултип ребра графа)', () => {
    store.update({ linkTypes: [] });
    const titles = new Map([
      ['s', 'A'],
      ['t', 'B'],
    ]);
    assert.equal(linkCaption({ ...link, type_id: null }, titles), 'A → B · связь');
  });

  it('неизвестный тип связи тоже читается словом «связь», а не прочерком', () => {
    store.update({ linkTypes: [] });
    assert.equal(linkTypeForwardName('missing'), 'связь');
    assert.equal(linkTypeForwardName(''), 'связь');
  });

  it('имя типа берётся вперёд (свойство источника), обратное — не подставляется', () => {
    store.update({ linkTypes: [linkType('lt1', 'место работы', 'сотрудники')] });
    try {
      assert.equal(linkTypeForwardName('lt1'), 'место работы');
    } finally {
      store.update({ linkTypes: [] });
    }
  });

  it('нерозрешённое имя конца заменяется его id — подпись не пустеет', () => {
    store.update({ linkTypes: [] });
    assert.equal(linkCaption(link, new Map()), 's → t · связь');
  });
});

/**
 * Таблица корзины (08-ui-spec.md §5a.4; ошибка 009784ad: «id вместо названий,
 * узкое окно, непонятные ссылки»).
 *
 * Закрепляем суть переделки на чистой модели строк — без DOM:
 *   * колонка 1 у мысли — название (не id), у связи — подпись
 *     «источник → назначение · тип связи» (в `etn.trash.list` у ребра только id);
 *   * колонка 2 — число мест использования: у мысли `usage.total`, у связи
 *     прочерк (использования в свойствах у связей нет, §5a.3);
 *   * кнопки «Восстановить»/«Удалить» — иконки с тултипами; доступность
 *     «Удалить» определяется `blocked` из `GET /trash`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LinkType } from '@etn/shared';

import { store } from '../src/renderer/state.js';
import { trashInternals } from '../src/renderer/trash.js';

const { referencesText, thoughtTrashRow, linkTrashRow } = trashInternals;

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

describe('строки таблицы корзины (§5a.4)', () => {
  it('мысль показывается названием, а не id; счёт ссылок — usage.total', () => {
    const view = thoughtTrashRow({ title: 'Мысль A' }, 3);
    assert.equal(view.label, '📝 Мысль A');
    assert.equal(view.count, 3);
  });

  it('мысль без использования показывает 0, а не прочерк', () => {
    assert.equal(thoughtTrashRow({ title: 'Мысль B' }, 0).count, 0);
  });

  it('связь подписана «источник → назначение · тип связи»', () => {
    store.update({ linkTypes: [linkType('lt1', 'вызывает', 'вызывается')] });
    try {
      const view = linkTrashRow(
        { source_id: 's', target_id: 't', type_id: 'lt1' },
        new Map([
          ['s', 'Мысль A'],
          ['t', 'Мысль B'],
        ]),
      );
      assert.equal(view.label, '🔗 Мысль A → Мысль B · вызывает');
      // У связи нет использования в свойствах — колонка «Ссылок» пуста.
      assert.equal(view.count, null);
    } finally {
      store.update({ linkTypes: [] });
    }
  });

  it('связь без резолва концов подписана id — но всё равно не «просто id»', () => {
    store.update({ linkTypes: [] });
    const view = linkTrashRow({ source_id: 's', target_id: 't', type_id: null }, new Map());
    assert.equal(view.label, '🔗 s → t · связь');
  });

  it('прочерк — только там, где числа нет вовсе', () => {
    assert.equal(referencesText(null), '—');
    assert.equal(referencesText(0), '0');
  });
});

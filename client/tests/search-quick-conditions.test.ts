/**
 * Быстрые команды отбора и снятие корпусных полей зоны поиска (задача 4b1cc3d4).
 *
 * Контракт (элемент интерфейса «Строка поиска вида «Карта мыслей»»):
 *  - команды подменю «Добавить отбор…» кладут условие в ОСНОВНУЮ (корневую)
 *    группу редактора ИДЕМПОТЕНТНО: повторный клик, уже имеющееся условие и
 *    другой режим обхода «в иерархии» — по литеральному совпадению операнда,
 *    оператора, значения (включая токен `$thought`) и режима;
 *  - корпусные поля (тип связи, автор/редактор), снятые с панели, не должны
 *    возвращаться из старого L4-снимка невидимым фильтром: `clearSearchCorpusFields`
 *    чистит их, и в запрос они не попадают.
 *
 * Логика чистая (модель дерева), поэтому проверяется напрямую, без DOM.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  addSearchQuickCondition,
  buildSearchCriteriaWire,
  clearSearchCorpusFields,
  defaultSearchCriteriaState,
  filterTreeLeavesEqual,
  parseSearchCriteria,
  SEARCH_QUICK_CONDITIONS,
  type FilterTreeGroup,
  type FilterTreeLeaf,
} from '../src/renderer/lib/filter-builder.js';

/** Форма «корневая группа `И` из перечисленных детей» для ожидаемых значений. */
function mainGroupChildren(children: unknown[]): FilterTreeGroup {
  return { kind: 'group', op: 'and', children: children as FilterTreeGroup['children'] };
}

describe('идемпотентность быстрых команд отбора (задача 4b1cc3d4)', () => {
  it('«По родителю в фокусе» кладёт условие «Мысль в иерархии $thought»', () => {
    const leaf = SEARCH_QUICK_CONDITIONS.parentInFocus();
    assert.deepEqual(leaf, {
      kind: 'leaf',
      entity: { kind: 'id' },
      operator: 'in_hierarchy',
      value: { kind: 'token', token: '$thought' },
    });
  });

  it('повторный клик не плодит дубли', () => {
    const leaf = SEARCH_QUICK_CONDITIONS.parentInFocus();
    const first = addSearchQuickCondition(null, leaf);
    assert.equal(first.added, true, 'первый клик добавляет условие');
    const second = addSearchQuickCondition(first.tree, SEARCH_QUICK_CONDITIONS.parentInFocus());
    assert.equal(second.added, false, 'повторный клик ничего не меняет');
    assert.deepEqual(
      second.tree,
      mainGroupChildren([SEARCH_QUICK_CONDITIONS.parentInFocus()]),
      'в основной группе ровно одно условие',
    );
  });

  it('команда не дублирует условие, уже стоящее в подгруппе основной группы', () => {
    const tree: FilterTreeGroup = {
      kind: 'group',
      op: 'and',
      children: [
        {
          kind: 'group',
          op: 'or',
          children: [SEARCH_QUICK_CONDITIONS.onlyActive()],
        } as FilterTreeGroup,
      ],
    };
    const next = addSearchQuickCondition(tree, SEARCH_QUICK_CONDITIONS.onlyActive());
    assert.equal(next.added, false, 'условие найдено в поддереве основной группы');
    assert.deepEqual(next.tree, tree, 'дерево не изменилось');
  });

  it('«Только актуальные» в дефолтном дереве видимости уже есть — клик не добавляет', () => {
    // Дефолт строки поиска содержит строки видимости «Актуальность = да» и
    // «Пометка удаления = нет» (defaultSearchCriteriaState).
    const next = addSearchQuickCondition(
      defaultSearchCriteriaState().tree ?? null,
      SEARCH_QUICK_CONDITIONS.onlyActive(),
    );
    assert.equal(next.added, false, 'условие уже в основной группе');
  });

  it('корень-одиночный лист оборачивается группой `И` с новым условием', () => {
    const single: FilterTreeLeaf = SEARCH_QUICK_CONDITIONS.onlyNotTrashed();
    const next = addSearchQuickCondition(single, SEARCH_QUICK_CONDITIONS.onlyActive());
    assert.equal(next.added, true);
    assert.equal(next.tree.kind, 'group');
    assert.deepEqual(next.tree, mainGroupChildren([single, SEARCH_QUICK_CONDITIONS.onlyActive()]));
  });

  it('разный РЕЖИМ обхода «в иерархии» — другое условие (сравнение режимов)', () => {
    const structural: FilterTreeLeaf = {
      kind: 'leaf',
      entity: { kind: 'parents' },
      operator: 'in_hierarchy',
      value: { kind: 'token', token: '$thought' },
    };
    const allLinks: FilterTreeLeaf = { ...structural, mode: 'all_links' };
    assert.equal(filterTreeLeavesEqual(structural, allLinks), false, 'режим входит в сравнение');
    assert.equal(
      filterTreeLeavesEqual(structural, { ...structural }),
      true,
      'одинаковые условия без режима равны',
    );
    const next = addSearchQuickCondition(structural, allLinks);
    assert.equal(next.added, true, 'другой режим добавляется, а не считается дублем');
  });
});

describe('снятие корпусных полей поиска — старый снимок не даёт невидимого фильтра', () => {
  it('parseSearchCriteria читает корпусные ключи, clearSearchCorpusFields их снимает', () => {
    // Старый L4-снимок со снятыми с UI корпусными полями.
    const state = parseSearchCriteria({
      onlyLinks: true,
      linkTypeIds: ['lt-1', 'lt-2'],
      authorId: 'user-a',
      editorId: 'user-e',
    });
    assert.deepEqual(state.linkTypeIds, ['lt-1', 'lt-2'], 'снимок прочитан как есть');
    clearSearchCorpusFields(state);
    assert.deepEqual(state.linkTypeIds, [], 'типы связей сняты');
    assert.equal(state.authorId, '', 'автор снят');
    assert.equal(state.editorId, '', 'редактор снят');
    assert.deepEqual(
      buildSearchCriteriaWire(state),
      {},
      'очищенные поля не уезжают в запрос (нет невидимого фильтра)',
    );
    assert.equal(state.onlyLinks, true, 'области поиска очистка не трогает');
  });

  it('дефолтное состояние и так не шлёт корпусных параметров', () => {
    assert.deepEqual(buildSearchCriteriaWire(defaultSearchCriteriaState()), {});
  });
});

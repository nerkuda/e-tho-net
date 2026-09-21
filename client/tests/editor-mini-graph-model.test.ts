/**
 * Юнит-тесты чистой модели локального графа (задача 6811d5e7).
 *
 * Проверяют правила по пунктам решения пользователя без DOM и d3:
 * направление стрелки/тултипа по фактическому ребру (п.1/3), эффективное
 * оформление линии из типа связи с наследованием (п.4), свёртку массовых
 * связей и понятные показатели шапки (п.6). Независимость от отборов (п.5)
 * проверяется структурно в `editor-mini-graph.test.ts` (источник данных).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Link, LinkType } from '@etn/shared';

import {
  MASS_LINK_THRESHOLD,
  PERIPHERY_CAP,
  UNTYPED_LINK_LABEL,
  computeGraphStats,
  computeMassLinks,
  edgeTooltip,
  edgeTypeName,
  graphStatEntries,
  neutralEdgeVisual,
  orientLink,
  resolveEdgeVisual,
} from '../src/renderer/editor/mini-graph-model.js';

const CENTER = 'thought-center';
const OTHER = 'thought-other';

function link(over: Partial<Link> = {}): Link {
  return {
    id: over.id ?? `link-${Math.random().toString(36).slice(2)}`,
    source_id: over.source_id ?? CENTER,
    target_id: over.target_id ?? OTHER,
    type_id: over.type_id ?? null,
    color: over.color ?? null,
    style: over.style ?? null,
    width: over.width ?? null,
    active: true,
    marked_for_deletion: false,
    marked_for_deletion_at: null,
    marked_for_deletion_by: null,
    version: 1,
    created_at: '2026-09-20T00:00:00.000Z',
    updated_at: '2026-09-20T00:00:00.000Z',
  };
}

function linkType(over: Partial<LinkType> = {}): LinkType {
  return {
    id: over.id ?? 'type-1',
    name_forward: over.name_forward ?? 'включает',
    name_reverse: over.name_reverse ?? 'входит в',
    parent_id: over.parent_id ?? null,
    is_root: over.is_root ?? false,
    color: over.color ?? null,
    style: over.style ?? null,
    width: over.width ?? null,
    description: over.description ?? null,
    version: 1,
    created_at: '2026-09-20T00:00:00.000Z',
    updated_at: '2026-09-20T00:00:00.000Z',
    created_by: 'user-1',
  };
}

describe('mini-graph-model — направление и тултип ребра (п.1/3)', () => {
  it('ориентирует ребро по фактическому направлению связи, а не «от центра»', () => {
    const outgoing = orientLink(link({ source_id: CENTER, target_id: OTHER }), CENTER);
    assert.equal(outgoing.fromCenter, true);
    assert.equal(outgoing.sourceId, CENTER);
    assert.equal(outgoing.targetId, OTHER);

    const incoming = orientLink(link({ source_id: OTHER, target_id: CENTER }), CENTER);
    assert.equal(incoming.fromCenter, false);
    assert.equal(incoming.sourceId, OTHER);
    assert.equal(incoming.targetId, CENTER);
  });

  it('выбирает прямое/обратное имя типа по направлению source → target', () => {
    const type = linkType({ name_forward: 'содержит', name_reverse: 'содержится в' });
    assert.equal(edgeTypeName(type, true), 'содержит');
    assert.equal(edgeTypeName(type, false), 'содержится в');
    assert.equal(edgeTypeName(undefined, true), '', 'untyped link has no type name');
  });

  it('тултип: «<тип>: <источник> -> <назначение>», без типа — слово «связь»', () => {
    assert.equal(edgeTooltip('включает', 'Работа', 'Задача'), 'включает: Работа -> Задача');
    assert.equal(edgeTooltip('', 'Работа', 'Задача'), 'связь: Работа -> Задача');
    assert.equal(UNTYPED_LINK_LABEL, 'связь');
    // Направление — фактическое: для входящей ребра источник и цель меняются.
    const inc = orientLink(link({ source_id: OTHER, target_id: CENTER }), CENTER);
    const text = edgeTooltip('включает', 'Сосед', 'Центр');
    assert.equal(inc.sourceId, OTHER);
    assert.equal(text, 'включает: Сосед -> Центр');
  });
});

describe('mini-graph-model — оформление линии из типа связи (п.4)', () => {
  it('берёт цвет/штрих/толщину типа связи', () => {
    const type = linkType({ id: 't-colored', color: '#3366ff', style: 'dashed', width: 3 });
    const visual = resolveEdgeVisual([type], link({ type_id: 't-colored' }));
    assert.deepEqual(visual, { color: '#3366ff', dash: '6 4', width: 3 });
  });

  it('наследует незаданные поля по цепочке предков (L21)', () => {
    const parent = linkType({ id: 't-parent', color: '#111111', width: 4 });
    const child = linkType({ id: 't-child', parent_id: 't-parent', color: '#222222', width: null });
    const visual = resolveEdgeVisual([parent, child], link({ type_id: 't-child' }));
    assert.equal(visual.color, '#222222', 'own colour wins');
    assert.equal(visual.width, 4, 'null width inherits from the parent');
  });

  it('собственное переопределение связи сильнее настроек типа', () => {
    const type = linkType({ id: 't-x', color: '#000000', width: 1, style: 'solid' });
    const visual = resolveEdgeVisual(
      [type],
      link({ type_id: 't-x', color: '#ff0000', style: 'dotted', width: 5 }),
    );
    assert.deepEqual(visual, { color: '#ff0000', dash: '2 4', width: 5 });
  });

  it('связь БЕЗ типа получает нейтральное оформление, а не настройки корневого типа', () => {
    const root = linkType({ id: 't-root', is_root: true, color: '#abcdef', width: 7 });
    const visual = resolveEdgeVisual([root], link({ type_id: null }));
    assert.deepEqual(visual, neutralEdgeVisual());
    assert.equal(visual.color, null, 'no colour — CSS paints the neutral default');
    assert.equal(visual.dash, 'none');
    assert.equal(visual.width, 1);
  });
});

describe('mini-graph-model — массовые связи (п.6)', () => {
  it('прячет все рёбра пары, кроме одного, начиная с порога', () => {
    const type = linkType({ id: 't-mass', name_forward: 'связано с', name_reverse: 'связано с' });
    const links = Array.from({ length: MASS_LINK_THRESHOLD + 2 }, (_, i) =>
      link({ id: `m${i}`, type_id: 't-mass' }),
    );
    const mass = computeMassLinks(links, CENTER, [type]);
    assert.equal(mass.get(OTHER)?.hidden, MASS_LINK_THRESHOLD + 1);
    assert.equal(mass.get(OTHER)?.label, 'связано с');
  });

  it('ниже порога ничего не скрывает', () => {
    const type = linkType({ id: 't-few' });
    const links = Array.from({ length: MASS_LINK_THRESHOLD - 1 }, (_, i) =>
      link({ id: `f${i}`, type_id: 't-few' }),
    );
    assert.equal(computeMassLinks(links, CENTER, [type]).size, 0);
  });

  it('имя типа в чипе — по направлению от центра, для связи без типа — «связь»', () => {
    const type = linkType({ id: 't-dir', name_forward: 'вперёд', name_reverse: 'назад' });
    const incoming = Array.from({ length: MASS_LINK_THRESHOLD }, (_, i) =>
      link({ id: `in${i}`, source_id: OTHER, target_id: CENTER, type_id: 't-dir' }),
    );
    assert.equal(computeMassLinks(incoming, CENTER, [type]).get(OTHER)?.label, 'назад');

    const untyped = Array.from({ length: MASS_LINK_THRESHOLD }, (_, i) =>
      link({ id: `u${i}`, type_id: null }),
    );
    assert.equal(computeMassLinks(untyped, CENTER, []).get(OTHER)?.label, UNTYPED_LINK_LABEL);
  });

  it('считает разные типы к одному соседу раздельно, а хранит суммарно по соседу', () => {
    const a = linkType({ id: 't-a' });
    const b = linkType({ id: 't-b' });
    const links = [
      ...Array.from({ length: MASS_LINK_THRESHOLD }, (_, i) => link({ id: `a${i}`, type_id: 't-a' })),
      ...Array.from({ length: MASS_LINK_THRESHOLD }, (_, i) => link({ id: `b${i}`, type_id: 't-b' })),
    ];
    const mass = computeMassLinks(links, CENTER, [a, b]);
    assert.equal(mass.size, 1, 'one chip per neighbour');
    assert.equal(mass.get(OTHER)?.hidden, 2 * (MASS_LINK_THRESHOLD - 1));
  });
});

describe('mini-graph-model — показатели шапки (п.6)', () => {
  it('считает видимых/не поместившихся соседей по порогу', () => {
    const small = computeGraphStats(3, 0);
    assert.deepEqual(small, { total: 3, visible: 3, massHidden: 0, peripheryHidden: 0 });

    const big = computeGraphStats(PERIPHERY_CAP + 5, 12);
    assert.deepEqual(big, {
      total: PERIPHERY_CAP + 5,
      visible: PERIPHERY_CAP,
      massHidden: 12,
      peripheryHidden: 5,
    });
  });

  it('даёт понятные названия и объясняющую подсказку каждому показателю', () => {
    const entries = graphStatEntries(computeGraphStats(PERIPHERY_CAP + 2, 18));
    const labels = entries.map((e) => e.text);
    assert.deepEqual(labels, [
      `Соседей: ${PERIPHERY_CAP + 2}`,
      'Скрыто массовых: 18',
      'Ещё не поместилось: 2',
    ]);
    for (const entry of entries) {
      assert.ok(entry.tooltip.length > 40, `«${entry.text}» has a real explanation`);
    }
    const massTooltip = entries[1]!.tooltip;
    assert.ok(massTooltip.includes(String(MASS_LINK_THRESHOLD)), 'explains the mass threshold');
    assert.ok(massTooltip.includes('«Связи»'), 'explains where to see the hidden links');
    assert.ok(entries[2]!.tooltip.includes('«Связи»'), 'points to the full neighbour list');
  });

  it('не показывает нулевые показатели', () => {
    const entries = graphStatEntries(computeGraphStats(4, 0));
    assert.equal(entries.length, 1);
    assert.ok(entries[0]!.text.startsWith('Соседей:'));
  });
});

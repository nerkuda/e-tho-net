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
  EDGE_LANE_GAP,
  GRAPH_LINK_FIELDS,
  MASS_LINK_THRESHOLD,
  PERIPHERY_CAP,
  TRASHED_EDGE_DASH,
  UNTYPED_LINK_LABEL,
  assignEdgeLanes,
  computeGraphStats,
  edgeTooltip,
  edgeTypeName,
  graphEventAffects,
  graphStatEntries,
  isTrashedEdge,
  linkChangeAffectsGraph,
  linkPatchAffectsGraph,
  massChipTooltip,
  neutralEdgeVisual,
  orientLink,
  planGraphEdges,
  resolveEdgeVisual,
  shiftEdgeByLane,
  thoughtChangesAffectGraph,
} from '../src/renderer/editor/mini-graph-model.js';

const CENTER = 'thought-center';
const OTHER = 'thought-other';
const THIRD = 'thought-third';
const HIDDEN = 'thought-hidden';

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
    marked_for_deletion: over.marked_for_deletion ?? false,
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

  it('помеченное на удаление ребро помечается в тултипе «(в корзине)» (355319d4)', () => {
    assert.equal(
      edgeTooltip('включает', 'Работа', 'Задача', true),
      'включает: Работа -> Задача (в корзине)',
    );
    assert.equal(
      edgeTooltip('', 'Работа', 'Задача', true),
      'связь: Работа -> Задача (в корзине)',
    );
    // Живое ребро пометки не получает.
    assert.equal(edgeTooltip('включает', 'Работа', 'Задача', false), 'включает: Работа -> Задача');
  });
});

describe('mini-graph-model — ребро в корзине (ошибка 355319d4)', () => {
  it('isTrashedEdge различает помеченное ребро и ребро без записи связи', () => {
    assert.equal(isTrashedEdge(link({ marked_for_deletion: true })), true);
    assert.equal(isTrashedEdge(link({ marked_for_deletion: false })), false);
    assert.equal(
      isTrashedEdge(null),
      false,
      'структурное ребро без записи связи помеченным быть не может',
    );
  });

  it('оформление помеченного ребра — всегда приглушённый пунктир, стиль типа его не «оживляет»', () => {
    const type = linkType({ id: 't-solid', color: '#3366ff', style: 'solid', width: 3 });
    const visual = resolveEdgeVisual(
      [type],
      link({ type_id: 't-solid', marked_for_deletion: true }),
    );
    assert.equal(visual.dash, TRASHED_EDGE_DASH);
    // Цвет/толщина остаются типовыми — приглушение делает CSS-класс `.trashed`.
    assert.equal(visual.color, '#3366ff');
    assert.equal(visual.width, 3);
  });
});

describe('mini-graph-model — сторона подписи и полосы встречных рёбер (ошибка 6452c840)', () => {
  // Тип связи полигона etn-dev: forward «версия» (сторона источника),
  // reverse «работы версии» (сторона назначения).
  const versionType = linkType({
    id: 't-version',
    name_forward: 'версия',
    name_reverse: 'работы версии',
  });

  it('центральная — источник: подпись forward, стрелка ОТ центра', () => {
    const outgoing = orientLink(link({ source_id: CENTER, target_id: OTHER }), CENTER);
    const type = versionType;
    assert.equal(outgoing.fromCenter, true);
    assert.equal(edgeTypeName(type, outgoing.fromCenter), 'версия');
    assert.equal(outgoing.sourceId, CENTER, 'стрелка начинается в центре');
    assert.equal(outgoing.targetId, OTHER, 'и смотрит на соседа');
  });

  it('центральная — назначение: подпись reverse, стрелка В центр', () => {
    const incoming = orientLink(link({ source_id: OTHER, target_id: CENTER }), CENTER);
    const type = versionType;
    assert.equal(incoming.fromCenter, false);
    assert.equal(edgeTypeName(type, incoming.fromCenter), 'работы версии');
    assert.equal(incoming.sourceId, OTHER);
    assert.equal(incoming.targetId, CENTER, 'стрелка смотрит в центр');
  });

  it('одиночная связь остаётся на центральной полосе (вид графа не меняется)', () => {
    const lanes = assignEdgeLanes([{ key: 'l1', sourceId: CENTER, targetId: OTHER }]);
    assert.equal(lanes.get('l1'), 0);
  });

  it('встречные связи одной пары уходят на РАЗНЫЕ полосы (иначе — одна линия с двумя стрелками)', () => {
    const lanes = assignEdgeLanes([
      { key: 'out', sourceId: CENTER, targetId: OTHER },
      { key: 'in', sourceId: OTHER, targetId: CENTER },
    ]);
    const out = lanes.get('out')!;
    const inc = lanes.get('in')!;
    assert.notEqual(out, inc, 'встречные связи не накладываются');
    assert.equal(out, -inc, 'полосы симметричны относительно прямой пары');
    assert.equal(Math.abs(out), EDGE_LANE_GAP / 2);
  });

  it('кратные рёбра одного направления делят одну полосу (у них одна подпись стороны)', () => {
    const lanes = assignEdgeLanes([
      { key: 'a', sourceId: CENTER, targetId: OTHER },
      { key: 'b', sourceId: CENTER, targetId: OTHER },
      { key: 'c', sourceId: OTHER, targetId: CENTER },
    ]);
    assert.equal(lanes.get('a'), lanes.get('b'), 'одинаковое направление — одна полоса');
    assert.notEqual(lanes.get('a'), lanes.get('c'));
  });

  it('раскладка пары не зависит от направления связи: ключ пары — без порядка', () => {
    const lanes = new Set(
      [...assignEdgeLanes([
        { key: 'x', sourceId: OTHER, targetId: CENTER },
        { key: 'y', sourceId: CENTER, targetId: OTHER },
      ]).values()],
    );
    assert.equal(lanes.size, 2, 'два направления — две полосы');
  });

  it('shiftEdgeByLane уводит встречные линии в противоположные стороны', () => {
    // Горизонтальная пара: центр слева (id меньше), сосед справа.
    const forward = shiftEdgeByLane({ x: 0, y: 0 }, { x: 100, y: 0 }, CENTER, OTHER, -6);
    const backward = shiftEdgeByLane({ x: 100, y: 0 }, { x: 0, y: 0 }, OTHER, CENTER, 6);
    assert.equal(forward.a.y, -6);
    assert.equal(forward.b.y, -6);
    assert.equal(backward.a.y, 6);
    assert.equal(backward.b.y, 6);
    // Оба конца смещаются одинаково — длина и направление линии сохраняются.
    assert.equal(forward.b.x - forward.a.x, 100);
    assert.equal(backward.a.x - backward.b.x, 100);
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

describe('mini-graph-model — массовые связи (п.6, ошибка 42a7c0a1)', () => {
  const type = linkType({ id: 't-mass', name_forward: 'связано с', name_reverse: 'связано с' });
  const visible = [OTHER];

  /** Рёбра «центр → сосед» (по умолчанию к OTHER). */
  const outgoing = (n: number, typeId: string | null = type.id, prefix = 'out'): Link[] =>
    Array.from({ length: n }, (_, i) =>
      link({ id: `${prefix}${i}`, source_id: CENTER, target_id: OTHER, type_id: typeId }),
    );
  /** Встречные рёбра «сосед → центр». */
  const incoming = (n: number, typeId: string | null = type.id, prefix = 'in'): Link[] =>
    Array.from({ length: n }, (_, i) =>
      link({ id: `${prefix}${i}`, source_id: OTHER, target_id: CENTER, type_id: typeId }),
    );
  /** Краткая форма результата: линии, скрытые и разбивка чипа по сторонам. */
  const brief = (
    plan: ReturnType<typeof planGraphEdges>,
    otherId = OTHER,
  ): { drawn: number; hidden: number; sides: string[] } => ({
    drawn: plan.drawnIds.size,
    hidden: plan.hidden,
    sides: (plan.massByNeighbour.get(otherId)?.pairs ?? []).map(
      (pair) => `${pair.side}:${pair.hidden}`,
    ),
  });

  it('ниже порога — все рёбра линиями, чипа нет (4 исходящих + 5 входящих)', () => {
    const links = [...outgoing(4), ...incoming(5)];
    const plan = planGraphEdges(links, CENTER, visible, [type]);
    assert.deepEqual(brief(plan), { drawn: 9, hidden: 0, sides: [] });
    assert.equal(plan.massByNeighbour.size, 0);
  });

  it('12 исходящих → 1 линия, 11 скрытых', () => {
    const links = outgoing(12);
    const plan = planGraphEdges(links, CENTER, visible, [type]);
    assert.deepEqual(brief(plan), { drawn: 1, hidden: 11, sides: ['out:11'] });
    assert.ok(plan.drawnIds.has(links[0]!.id), 'линия — первое живое ребро пары');
    const mass = plan.massByNeighbour.get(OTHER)!;
    assert.deepEqual(mass.pairs, [{ label: 'связано с', side: 'out', hidden: 11, trashed: 0 }]);
    assert.equal(mass.label, 'связано с');
  });

  it('5 исходящих + 5 входящих → 2 линии, 8 скрытых (порог по СУММЕ сторон)', () => {
    const plan = planGraphEdges([...outgoing(5), ...incoming(5)], CENTER, visible, [type]);
    assert.deepEqual(brief(plan), { drawn: 2, hidden: 8, sides: ['out:4', 'in:4'] });
  });

  it('12 исходящих + 5 входящих → 2 линии, 15 скрытых', () => {
    const plan = planGraphEdges([...outgoing(12), ...incoming(5)], CENTER, visible, [type]);
    assert.deepEqual(brief(plan), { drawn: 2, hidden: 15, sides: ['out:11', 'in:4'] });
  });

  it('разные типы между одной парой — разные пары и отдельные пороги', () => {
    const a = linkType({ id: 't-a', name_forward: 'тип а', name_reverse: 'тип а' });
    const b = linkType({ id: 't-b', name_forward: 'тип б', name_reverse: 'тип б' });
    const links = [
      ...Array.from({ length: MASS_LINK_THRESHOLD }, (_, i) => link({ id: `a${i}`, type_id: 't-a' })),
      ...Array.from({ length: MASS_LINK_THRESHOLD }, (_, i) => link({ id: `b${i}`, type_id: 't-b' })),
    ];
    const plan = planGraphEdges(links, CENTER, visible, [a, b]);
    assert.equal(plan.drawnIds.size, 2, 'по одной линии на тип');
    assert.equal(plan.hidden, 2 * (MASS_LINK_THRESHOLD - 1));
    const mass = plan.massByNeighbour.get(OTHER);
    assert.equal(mass?.pairs.length, 2);
    assert.equal(mass?.label, 'тип а, тип б');
  });

  it('встречные рёбра одного направленного типа: обе линии, свои имена сторон', () => {
    const directed = linkType({
      id: 't-directed',
      name_forward: 'версия',
      name_reverse: 'работы версии',
    });
    const plan = planGraphEdges(
      [
        ...Array.from({ length: MASS_LINK_THRESHOLD }, (_, i) =>
          link({ id: `out${i}`, source_id: CENTER, target_id: OTHER, type_id: directed.id }),
        ),
        ...Array.from({ length: MASS_LINK_THRESHOLD }, (_, i) =>
          link({ id: `in${i}`, source_id: OTHER, target_id: CENTER, type_id: directed.id }),
        ),
      ],
      CENTER,
      visible,
      [directed],
    );
    assert.equal(plan.drawnIds.size, 2, 'прямая и встречная линии сохраняются обе');
    assert.equal(plan.hidden, 2 * (MASS_LINK_THRESHOLD - 1));
    const mass = plan.massByNeighbour.get(OTHER);
    assert.deepEqual(
      mass?.pairs.map((pair) => [pair.side, pair.label]),
      [
        ['out', 'версия'],
        ['in', 'работы версии'],
      ],
    );
  });

  it('связь без типа подписана «связь» и сворачивается своей парой', () => {
    const plan = planGraphEdges(outgoing(MASS_LINK_THRESHOLD, null, 'u'), CENTER, visible, []);
    assert.equal(plan.drawnIds.size, 1);
    assert.equal(plan.hidden, MASS_LINK_THRESHOLD - 1);
    assert.equal(plan.massByNeighbour.get(OTHER)?.label, UNTYPED_LINK_LABEL);
  });

  it('план ограничен нарисованными соседями: у соседа без чипа нет и «скрытых»', () => {
    const links = [
      ...outgoing(MASS_LINK_THRESHOLD, type.id, 'v'),
      ...Array.from({ length: MASS_LINK_THRESHOLD }, (_, i) =>
        link({ id: `h${i}`, target_id: THIRD, type_id: type.id }),
      ),
    ];
    const plan = planGraphEdges(links, CENTER, visible, [type]);
    assert.equal(plan.drawnIds.size, 1, 'линия только у видимого соседа');
    assert.equal(plan.hidden, MASS_LINK_THRESHOLD - 1, 'рёбра невидимого соседа не считаются');
    assert.equal(plan.massByNeighbour.has(THIRD), false);
  });

  it('сумма линий и чисел на чипах сходится с числом рёбер видимых соседей', () => {
    const links = [
      ...outgoing(MASS_LINK_THRESHOLD + 2, type.id, 'v'),
      ...incoming(3, type.id, 'in'),
      ...Array.from({ length: MASS_LINK_THRESHOLD }, (_, i) =>
        link({ id: `t${i}`, target_id: THIRD, type_id: type.id }),
      ),
      ...Array.from({ length: MASS_LINK_THRESHOLD }, (_, i) =>
        link({ id: `h${i}`, target_id: HIDDEN, type_id: type.id }),
      ),
    ];
    const plan = planGraphEdges(links, CENTER, [OTHER, THIRD], [type]);
    const chipTotal = [...plan.massByNeighbour.values()].reduce((sum, mass) => sum + mass.hidden, 0);
    assert.equal(chipTotal, plan.hidden, 'счётчик шапки равен сумме чисел на чипах');
    assert.equal(
      plan.drawnIds.size + plan.hidden,
      2 * MASS_LINK_THRESHOLD + 5,
      'линии + чипы = рёбра видимых соседей',
    );
    // У OTHER: 12 прямых + 3 встречных = массовая пара (порог по сумме):
    // 2 линии (out+in), скрыто 11 + 2.
    assert.deepEqual(brief(plan), { drawn: 3, hidden: 22, sides: ['out:11', 'in:2'] });
    // У THIRD: 10 рёбер (массовая, 1 линия).
    assert.equal(plan.massByNeighbour.get(THIRD)?.hidden, MASS_LINK_THRESHOLD - 1);
  });

  it('представитель стороны — живое ребро; скрытые в корзине попадают в подсказку', () => {
    const links = Array.from({ length: MASS_LINK_THRESHOLD }, (_, i) =>
      link({ id: `m${i}`, type_id: type.id, marked_for_deletion: i === 0 }),
    );
    const plan = planGraphEdges(links, CENTER, visible, [type]);
    const drawn = links.filter((item) => plan.drawnIds.has(item.id));
    assert.equal(drawn.length, 1);
    assert.equal(drawn[0]!.marked_for_deletion, false, 'линия пары не выглядит «в корзине»');
    const mass = plan.massByNeighbour.get(OTHER)!;
    assert.equal(mass.trashed, 1);
    const tip = massChipTooltip(mass);
    assert.ok(tip.includes('в корзине: 1'), tip);
    assert.ok(tip.includes('метка корзины у чипа'), tip);
    // Помеченные рёбра из значений свойства не приходят — «Свойства» дают
    // полный список только ЖИВЫХ связей (проверено GUI-пробой: 11 из 12).
    assert.ok(tip.includes('Полный список живых связей'), tip);
  });

  it('подсказка чипа: тип, число скрытых и реальная вкладка «Свойства»', () => {
    const mass = planGraphEdges(outgoing(MASS_LINK_THRESHOLD), CENTER, visible, [type])
      .massByNeighbour.get(OTHER)!;
    assert.equal(
      massChipTooltip(mass),
      'связано с: ещё 9 связей. Полный список — на вкладке «Свойства».',
    );
  });

  it('подсказка склоняет «связь» (21 → «связь», не «связей»)', () => {
    const mass = planGraphEdges(outgoing(22), CENTER, visible, [type]).massByNeighbour.get(OTHER)!;
    assert.equal(mass.hidden, 21);
    assert.equal(
      massChipTooltip(mass),
      'связано с: ещё 21 связь. Полный список — на вкладке «Свойства».',
    );
  });

  it('подсказка различает стороны, когда имена типа совпадают', () => {
    // Нетипизированная пара с обеими сторонами: обе записи называются «связь»,
    // без пометки стороны они неразличимы.
    const mass = planGraphEdges(
      [...outgoing(MASS_LINK_THRESHOLD, null, 'o'), ...incoming(MASS_LINK_THRESHOLD, null, 'i')],
      CENTER,
      visible,
      [],
    ).massByNeighbour.get(OTHER)!;
    assert.equal(
      massChipTooltip(mass),
      'связь (исходящие): 9; связь (входящие): 9. Полный список — на вкладке «Свойства».',
    );
  });

  it('порог настраивается (тест на границу, не только дефолт)', () => {
    const links = [link({ id: 'x1', type_id: type.id }), link({ id: 'x2', type_id: type.id })];
    const plan = planGraphEdges(links, CENTER, visible, [type], 2);
    assert.equal(plan.drawnIds.size, 1);
    assert.equal(plan.hidden, 1);
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
    // Полный список прямых связей живёт на вкладке «Свойства»; вкладки
    // «Связи» в клиенте нет (ошибка 42a7c0a1, круг 2).
    assert.ok(massTooltip.includes('«Свойства»'), 'explains where to see the hidden links');
    assert.ok(!massTooltip.includes('«Связи»'), 'does not point at a nonexistent tab');
    assert.ok(entries[2]!.tooltip.includes('«Свойства»'), 'points to the full neighbour list');
  });

  it('не показывает нулевые показатели', () => {
    const entries = graphStatEntries(computeGraphStats(4, 0));
    assert.equal(entries.length, 1);
    assert.ok(entries[0]!.text.startsWith('Соседей:'));
  });
});

describe('mini-graph-model — что требует пересборки графа (ошибка 42a7c0a1, круг 3)', () => {
  const base = link({ id: 'link-1', type_id: 'type-1' });

  it('GRAPH_LINK_FIELDS покрывает концы, тип, оформление, активность и корзину', () => {
    assert.deepEqual(
      [...GRAPH_LINK_FIELDS].sort(),
      ['active', 'color', 'marked_for_deletion', 'source_id', 'style', 'target_id', 'type_id', 'width'].sort(),
    );
  });

  it('обновление связи значимо, если изменилось видимое на графе поле', () => {
    assert.equal(linkChangeAffectsGraph(base, { ...base, marked_for_deletion: true }), true);
    assert.equal(linkChangeAffectsGraph(base, { ...base, marked_for_deletion: false }), false);
    assert.equal(linkChangeAffectsGraph(base, { ...base, type_id: null }), true);
    assert.equal(linkChangeAffectsGraph(base, { ...base, active: false }), true);
    assert.equal(linkChangeAffectsGraph(base, { ...base, color: '#f00' }), true);
    assert.equal(linkChangeAffectsGraph(base, { ...base, style: 'dashed' }), true);
    assert.equal(linkChangeAffectsGraph(base, { ...base, width: 3 }), true);
    assert.equal(linkChangeAffectsGraph(base, base), false);
  });

  it('без прежнего состояния изменение считается значимым (restore мимо кэша)', () => {
    assert.equal(linkChangeAffectsGraph(undefined, base), true);
  });

  it('PATCH связи значим только по реально изменённому видимому полю', () => {
    assert.equal(linkPatchAffectsGraph(base, { marked_for_deletion: true }), true);
    assert.equal(linkPatchAffectsGraph({ ...base, marked_for_deletion: true }, { marked_for_deletion: true }), false);
    assert.equal(linkPatchAffectsGraph(base, { type_id: 'type-1' }), false);
    assert.equal(linkPatchAffectsGraph(base, { active: false }), true);
    assert.equal(linkPatchAffectsGraph(base, {}), false);
  });

  it('правка мысли пересобирает граф только по видимым полям', () => {
    assert.equal(thoughtChangesAffectGraph({ title: 'Новое' }), true);
    assert.equal(thoughtChangesAffectGraph({ marked_for_deletion: true }), true);
    assert.equal(thoughtChangesAffectGraph({ active: false }), true);
    assert.equal(thoughtChangesAffectGraph({ fg_color: '#123456' }), true);
    assert.equal(thoughtChangesAffectGraph({ synonyms: ['x'] }), false);
    assert.equal(thoughtChangesAffectGraph({ comment: 'текст' }), false);
    assert.equal(thoughtChangesAffectGraph({ version: 2 }), false);
  });

  const context = {
    ownerId: CENTER,
    linkIds: new Set(['link-1', 'link-2']),
    neighbourIds: new Set([OTHER, THIRD]),
  };

  it('события связей: создание/обновление/удаление касательно центра', () => {
    assert.equal(
      graphEventAffects({ type: 'link.created', data: { link: link({ id: 'new' }) } }, context),
      true,
    );
    assert.equal(
      graphEventAffects(
        { type: 'link.created', data: { link: link({ id: 'other-link', source_id: THIRD, target_id: HIDDEN }) } },
        context,
      ),
      false,
    );
    assert.equal(
      graphEventAffects(
        { type: 'link.updated', data: { id: 'link-1', changes: { marked_for_deletion: false } } },
        context,
      ),
      true,
    );
    assert.equal(
      graphEventAffects({ type: 'link.updated', data: { id: 'link-1', changes: { width: 2 } } }, context),
      true,
    );
    assert.equal(
      graphEventAffects({ type: 'link.updated', data: { id: 'link-1', changes: {} } }, context),
      false,
    );
    assert.equal(
      graphEventAffects({ type: 'link.updated', data: { id: 'postoronniy', changes: { active: false } } }, context),
      false,
    );
    assert.equal(graphEventAffects({ type: 'link.deleted', data: { id: 'link-1' } }, context), true);
    assert.equal(graphEventAffects({ type: 'link.deleted', data: { id: 'postoronniy' } }, context), false);
  });

  it('значения свойств граф не пересобирают — рёбра приходят отдельными link.* событиями', () => {
    // Свойство-связь — проекция рёбер: сервер публикует по нему link.created/
    // link.deleted/link.updated (routes/properties.ts). Скалярная правка рёбер
    // не меняет — пересборка на property-value.* была бы миганием (круг 3, п.3).
    assert.equal(
      graphEventAffects(
        { type: 'property-value.set', data: { owner_type: 'thought', owner_id: CENTER } },
        context,
      ),
      false,
    );
    assert.equal(
      graphEventAffects(
        { type: 'property-value.deleted', data: { owner_type: 'thought', owner_id: THIRD } },
        context,
      ),
      false,
    );
    assert.equal(
      graphEventAffects({ type: 'property-value.set', data: { owner_type: 'link', owner_id: 'link-1' } }, context),
      false,
    );
  });

  it('сосед: обновление видимых полей или удаление пересобирают граф', () => {
    assert.equal(
      graphEventAffects({ type: 'thought.updated', data: { id: OTHER, changes: { marked_for_deletion: true } } }, context),
      true,
    );
    assert.equal(
      graphEventAffects({ type: 'thought.updated', data: { id: OTHER, changes: { comment: 'x' } } }, context),
      false,
    );
    assert.equal(
      graphEventAffects({ type: 'thought.updated', data: { id: HIDDEN, changes: { title: 'x' } } }, context),
      false,
    );
    assert.equal(graphEventAffects({ type: 'thought.deleted', data: { id: THIRD } }, context), true);
    assert.equal(graphEventAffects({ type: 'thought.deleted', data: { id: HIDDEN } }, context), false);
  });

  it('типы связей и мыслей меняют оформление — граф пересобирается', () => {
    for (const type of [
      'link-type.updated',
      'link-type.deleted',
      'thought-type.updated',
      'thought-type.deleted',
    ]) {
      assert.equal(graphEventAffects({ type, data: {} }, context), true, type);
    }
    assert.equal(graphEventAffects({ type: 'comment.updated', data: {} }, context), false);
  });
});

/**
 * Чистая модель локального графа редактора (вкладка «Граф», задача 6811d5e7).
 *
 * Здесь нет ни DOM, ни d3 — только разбор рёбер, оформление и показатели.
 * Вынесено отдельно от `mini-graph.ts` (который тянет d3-selection и требует
 * живого DOM), чтобы правила «направление стрелки/тултипа», «оформление линии»
 * и «счётчики шапки» проверялись обычными юнит-тестами без DOM-шима.
 *
 * Единственный источник этих правил — спецификация «Вкладка «Граф» редактора»
 * (мысль 9a23c3b1) и решение пользователя в задаче 6811d5e7.
 */

import type { Link, LinkStyle, LinkType } from '@etn/shared';

import { LINK_STYLE_DEFAULTS, resolveLinkTypeVisual } from '../lib/type-tree.js';

/** Слово вместо имени типа связи, когда тип не задан (п.3 задачи). */
export const UNTYPED_LINK_LABEL = 'связь';

/** Порог «массовости» пары (тип, сосед): избыточные рёбра прячутся за «+N». */
export const MASS_LINK_THRESHOLD = 10;

/** Сколько соседей рисуется пилюлями; остальные — за счётчиком «не поместилось». */
export const PERIPHERY_CAP = 40;

/**
 * Ребро, ориентированное по ФАКТИЧЕСКОМУ направлению связи (source → target),
 * а не «от центра». Центр может быть как источником, так и целью.
 */
export interface OrientedLink {
  link: Link;
  /** Фактический источник ребра (по данным связи). */
  sourceId: string;
  /** Фактическая цель ребра (по данным связи). */
  targetId: string;
  /** Центральная мысль — источник связи (иначе — цель). */
  fromCenter: boolean;
}

/** Ориентирует связь относительно редактируемой мысли. */
export function orientLink(link: Link, centerId: string): OrientedLink {
  const fromCenter = link.source_id === centerId;
  return {
    link,
    // Фактическое направление — как записано в самой связи: центр может быть
    // как источником, так и целью, и это не меняет местами концы ребра.
    sourceId: link.source_id,
    targetId: link.target_id,
    fromCenter,
  };
}

/**
 * Имя типа связи в направлении source → target: прямое для связи «от центра»,
 * обратное — для входящей. Тип не задан — пустая строка (нейтральность).
 */
export function edgeTypeName(type: LinkType | undefined, fromCenter: boolean): string {
  if (type === undefined) return '';
  return fromCenter ? type.name_forward : type.name_reverse;
}

/** Шаг между полосами встречных рёбер одной пары мыслей, px (мир графа). */
export const EDGE_LANE_GAP = 12;

/** Точка в мировых координатах графа. */
export interface GraphPoint {
  x: number;
  y: number;
}

/**
 * Раскладывает рёбра по полосам, чтобы ВСТРЕЧНЫЕ связи одной пары мыслей
 * (A -> B и B -> A) не рисовались одной линией: наложенные друг на друга
 * линии дают ложную картину «одна связь с двумя стрелками», а подписи сторон
 * перекрывают друг друга — видно только ту, что нарисована позже.
 *
 * Ключ пары — оба id без порядка, поэтому раскладка не зависит от направления
 * связи. Полоса задаётся смещением вдоль канонической нормали пары (см.
 * {@link shiftEdgeByLane}); одинаково направленные кратные рёбра делят одну
 * полосу — у них одно имя стороны, и наложение подписей незаметно.
 *
 * Возвращает смещение (px) по ключу ребра; ребро без пары (обычный случай) —
 * смещение 0, геометрия не меняется.
 */
export function assignEdgeLanes(
  edges: readonly { key: string; sourceId: string; targetId: string }[],
  gap: number = EDGE_LANE_GAP,
): Map<string, number> {
  // пара (без порядка) -> направление (source>target) -> ключи рёбер
  const pairs = new Map<string, Map<string, string[]>>();
  for (const edge of edges) {
    if (edge.sourceId === edge.targetId) continue;
    const pairKey =
      edge.sourceId < edge.targetId
        ? `${edge.sourceId}|${edge.targetId}`
        : `${edge.targetId}|${edge.sourceId}`;
    let directions = pairs.get(pairKey);
    if (directions === undefined) {
      directions = new Map();
      pairs.set(pairKey, directions);
    }
    const directionKey = `${edge.sourceId}>${edge.targetId}`;
    const keys = directions.get(directionKey);
    if (keys === undefined) directions.set(directionKey, [edge.key]);
    else keys.push(edge.key);
  }
  const lanes = new Map<string, number>();
  for (const directions of pairs.values()) {
    const directionKeys = [...directions.keys()];
    directionKeys.forEach((directionKey, index) => {
      // Одно направление — центральная полоса (0): вид графа не меняется.
      // Встречные — симметрично по обе стороны прямой пары.
      const offset = (index - (directionKeys.length - 1) / 2) * gap;
      for (const key of directions.get(directionKey) ?? []) lanes.set(key, offset);
    });
  }
  return lanes;
}

/**
 * Сдвигает линию ребра на `offset` вдоль КАНОНИЧЕСКОЙ нормали пары: нормаль к
 * прямой между узлами, ориентированная от узла с меньшим id к большему.
 * Ориентация берётся из id, а не из направления связи — иначе встречные рёбра
 * сместились бы навстречу друг другу и снова совпали.
 */
export function shiftEdgeByLane(
  a: GraphPoint,
  b: GraphPoint,
  sourceId: string,
  targetId: string,
  offset: number,
): { a: GraphPoint; b: GraphPoint } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const sign = sourceId < targetId ? 1 : -1;
  const nx = (-dy / len) * sign;
  const ny = (dx / len) * sign;
  const ox = nx * offset;
  const oy = ny * offset;
  return { a: { x: a.x + ox, y: a.y + oy }, b: { x: b.x + ox, y: b.y + oy } };
}

/** Пометка корзины в тултипе ребра (ошибка 355319d4). */
export const TRASHED_EDGE_TITLE_SUFFIX = '(в корзине)';

/** Штрих помеченного на удаление ребра — приглушённый пунктир. */
export const TRASHED_EDGE_DASH = '4 4';

/**
 * Ребро помечено на удаление (корзина, S13). Правило живёт здесь, чтобы
 * оформление, тултип и метка корзины на графе не разъехались (ошибка
 * 355319d4). Ребро без записи связи (`null`) помеченным быть не может.
 */
export function isTrashedEdge(link: Link | null): boolean {
  return link !== null && link.marked_for_deletion === true;
}

/**
 * Тултип ребра: `«<имя типа связи>: <имя источника> -> <имя назначения>»`;
 * тип не задан — вместо имени слово «связь». Направление — фактическое.
 * `trashed` (ошибка 355319d4) добавляет пометку «(в корзине)» — помеченное
 * ребро остаётся на графе, но пользователь обязан видеть, что оно в корзине.
 */
export function edgeTooltip(
  typeName: string,
  sourceTitle: string,
  targetTitle: string,
  trashed = false,
): string {
  const name = typeName === '' ? UNTYPED_LINK_LABEL : typeName;
  const suffix = trashed ? ` ${TRASHED_EDGE_TITLE_SUFFIX}` : '';
  return `${name}: ${sourceTitle} -> ${targetTitle}${suffix}`;
}

/** Эффективное оформление линии: цвет/штрих/толщина в мировых px. */
export interface EdgeVisual {
  /** `null` — цвет не задан, линия берёт нейтральный цвет из CSS. */
  color: string | null;
  /** Значение `stroke-dasharray` (или `none`). */
  dash: string;
  /** Толщина линии. */
  width: number;
}

/** `stroke-dasharray` по стилю линии (те же значения, что на карте мыслей). */
export function edgeDash(style: LinkStyle): string {
  return style === 'dashed' ? '6 4' : style === 'dotted' ? '2 4' : 'none';
}

/**
 * Эффективное оформление ребра (п.4 задачи, как линии на карте): собственные
 * переопределения связи (`color`/`style`/`width`) сильнее настроек типа, а
 * настройки типа резолвятся по цепочке предков (L21,
 * {@link resolveLinkTypeVisual}). Связь БЕЗ типа получает нейтральное
 * оформление приложения, а не настройки корневого типа.
 */
export function resolveEdgeVisual(
  linkTypes: readonly LinkType[],
  link: Link,
): EdgeVisual {
  const type =
    link.type_id === null ? LINK_STYLE_DEFAULTS : resolveLinkTypeVisual(linkTypes, link.type_id);
  const color = link.color ?? type.color;
  const style = link.style ?? type.style;
  const width = link.width ?? type.width;
  return {
    color: color ?? LINK_STYLE_DEFAULTS.color,
    // Помеченное на удаление ребро всегда пунктирное (ошибка 355319d4) — стиль
    // типа его не «оживляет»; приглушение делает CSS-класс `.trashed`.
    dash: isTrashedEdge(link) ? TRASHED_EDGE_DASH : edgeDash(style),
    width,
  };
}

/** Нейтральное оформление линии — связь без типа или ребро без записи связи. */
export function neutralEdgeVisual(): EdgeVisual {
  return {
    color: LINK_STYLE_DEFAULTS.color,
    dash: edgeDash(LINK_STYLE_DEFAULTS.style),
    width: LINK_STYLE_DEFAULTS.width,
  };
}

/** Скрытые избыточные рёбра одного типа к одному соседу. */
export interface MassInfo {
  /** Сколько рёбер скрыто (одно из пары всегда рисуется). */
  hidden: number;
  /** Имя типа связи в направлении центра (или «связь»). */
  label: string;
}

/**
 * Считает массовые связи: для каждой пары (тип связи, сосед) — сколько рёбер
 * к этому соседу. От {@link MASS_LINK_THRESHOLD} и выше лишние (всё, кроме
 * первого) скрываются за чипом «+N» у узла соседа.
 */
export function computeMassLinks(
  links: readonly Link[],
  centerId: string,
  linkTypes: readonly LinkType[],
  threshold: number = MASS_LINK_THRESHOLD,
): Map<string, MassInfo> {
  const pairCounts = new Map<string, { label: string; count: number }>();
  for (const link of links) {
    const otherId = link.source_id === centerId ? link.target_id : link.source_id;
    if (otherId === centerId) continue;
    const key = `${link.type_id ?? ''}|${otherId}`;
    const existing = pairCounts.get(key);
    if (existing === undefined) {
      const oriented = orientLink(link, centerId);
      const type = link.type_id === null ? undefined : linkTypes.find((t) => t.id === link.type_id);
      const typeName = edgeTypeName(type, oriented.fromCenter);
      pairCounts.set(key, {
        label: typeName === '' ? UNTYPED_LINK_LABEL : typeName,
        count: 1,
      });
    } else {
      existing.count += 1;
    }
  }
  const mass = new Map<string, MassInfo>();
  for (const [key, info] of pairCounts) {
    if (info.count < threshold) continue;
    const otherId = key.slice(key.indexOf('|') + 1);
    const entry = mass.get(otherId) ?? { hidden: 0, label: info.label };
    entry.hidden += info.count - 1; // одно ребро пары рисуется, остальные прячем
    entry.label = info.label;
    mass.set(otherId, entry);
  }
  return mass;
}

/** Показатели шапки графа. */
export interface GraphStats {
  /** Всего прямых соседей мысли. */
  total: number;
  /** Сколько соседей нарисовано пилюлями. */
  visible: number;
  /** Сколько рёбер скрыто как массовые (за чипами «+N»). */
  massHidden: number;
  /** Сколько соседей не поместилось за порогом {@link PERIPHERY_CAP}. */
  peripheryHidden: number;
}

/** Сводит счётчики шапки в одну структуру. */
export function computeGraphStats(total: number, massHidden: number): GraphStats {
  const visible = Math.min(total, PERIPHERY_CAP);
  return { total, visible, massHidden, peripheryHidden: total - visible };
}

/** Строка шапки: текст и понятное объяснение во всплывающей подсказке. */
export interface StatEntry {
  text: string;
  tooltip: string;
}

/**
 * Показатели шапки понятными словами с подсказками (п.6 задачи). Порядок
 * стабилен: соседи → скрытые массовые → не поместившиеся.
 */
export function graphStatEntries(stats: GraphStats): StatEntry[] {
  const entries: StatEntry[] = [
    {
      text: `Соседей: ${stats.total}`,
      tooltip:
        'Все прямые соседи мысли: структурные родители и потомки, а также типизированные связи в обе стороны. ' +
        'Граф всегда показывает все связи мысли — фильтры карты мыслей на него не влияют.',
    },
  ];
  if (stats.massHidden > 0) {
    entries.push({
      text: `Скрыто массовых: ${stats.massHidden}`,
      tooltip:
        `Когда с одним соседом связано ${MASS_LINK_THRESHOLD} и более рёбер одного типа, рисуется одна линия, ` +
        `а остальные связываются в чип «+N» у этого соседа (подсказка чипа — тип и число скрытых связей). ` +
        'Развернуть их на графе нельзя; полный список — на вкладке «Связи».',
    });
  }
  if (stats.peripheryHidden > 0) {
    entries.push({
      text: `Ещё не поместилось: ${stats.peripheryHidden}`,
      tooltip:
        `На графе показаны первые ${PERIPHERY_CAP} соседей, остальные ${stats.peripheryHidden} не поместились. ` +
        'Полный список соседей — на вкладке «Связи».',
    });
  }
  return entries;
}

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

import { pluralRu } from '../lib/plural.js';
import { LINK_STYLE_DEFAULTS, resolveLinkTypeVisual } from '../lib/type-tree.js';

/** Слово вместо имени типа связи, когда тип не задан (п.3 задачи). */
export const UNTYPED_LINK_LABEL = 'связь';

/** Порог «массовости» пары (тип, сосед): избыточные рёбра прячутся за «+N». */
export const MASS_LINK_THRESHOLD = 10;

/** Где в клиенте живёт полный список прямых связей мысли (вкладка редактора). */
export const LINKS_TAB_TITLE = 'Свойства';

/** Согласованная форма «связь/связи/связей» для числа скрытых рёбер. */
function linksWord(n: number): string {
  return pluralRu(n, 'связь', 'связи', 'связей');
}

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

/** Сторона пары относительно центральной мысли: центр — источник или цель. */
export type MassSide = 'out' | 'in';

/**
 * Скрытые рёбра одной СТОРОНЫ массовой пары (тип связи, сосед). Пара свёртки
 * — без стороны: порог считается по сумме обеих сторон, а линия-представитель
 * рисуется на каждую присутствующую сторону (встречные рёбра, 6452c840).
 */
export interface MassPair {
  /** Имя типа связи в направлении стороны (``name_forward`` для `out`,
   *  ``name_reverse`` для `in`; «связь» у ребра без типа). */
  label: string;
  /** Сторона пары: центр — источник (`out`) или цель (`in`). */
  side: MassSide;
  /** Сколько рёбер стороны скрыто (одно ребро стороны остаётся линией). */
  hidden: number;
  /** Сколько из скрытых рёбер стороны помечено на удаление (корзина). */
  trashed: number;
}

/** Скрытые массовые рёбра одного соседа — содержимое чипа «+N». */
export interface MassInfo {
  /** Всего скрыто у соседа — число на чипе и вклад в счётчик шапки. */
  hidden: number;
  /** Имена типов скрытых пар (через запятую) — короткая подпись чипа. */
  label: string;
  /** Разбивка по парам — точная подсказка «тип и число». */
  pairs: MassPair[];
  /** Сколько скрытых рёбер в корзине (пометка в подсказке чипа). */
  trashed: number;
}

/** План рёбер мини-графа: что рисуем линиями и что показываем числом. */
export interface GraphEdgePlan {
  /** id связей, у которых есть нарисованная линия: по одной на пару. */
  drawnIds: ReadonlySet<string>;
  /** Скрытые массовые рёбра по id соседа — чипы «+N». */
  massByNeighbour: ReadonlyMap<string, MassInfo>;
  /** Всего скрыто массовых (сумма чисел на чипах) — счётчик шапки. */
  hidden: number;
}

/** Накопитель рёбер одной пары (тип связи, сосед) при построении плана. */
interface PairGroup {
  otherId: string;
  type: LinkType | undefined;
  links: Link[];
}

/**
 * Строит план рёбер мини-графа для НАРИСОВАННЫХ соседей: какие связи
 * получают линию, а какие видны только числом в чипе «+N».
 *
 * Пара свёртки — (тип связи, сосед), БЕЗ стороны: порог
 * {@link MASS_LINK_THRESHOLD} считается по сумме рёбер обеих сторон (спека
 * «Вкладка «Граф» редактора», 9a23c3b1). В массовой паре рисуется не более
 * ОДНОЙ линии на каждую присутствующую сторону — так сохраняется требование
 * ошибки 6452c840 о встречных рёбрах (две параллельные линии со своими
 * стрелками и подписями), но повторные рёбра стороны не превращаются в
 * десяток наложенных линий. Примеры: 12 исходящих — 1 линия и 11 скрытых;
 * 5 исходящих + 5 входящих — 2 линии и 8 скрытых; 12 исходящих + 5 входящих —
 * 2 линии и 15 скрытых. Ниже порога рисуются все рёбра, как раньше.
 *
 * `visibleNeighbourIds` ограничивает план нарисованными соседями: массовые
 * рёбра соседа за `PERIPHERY_CAP` не имеют чипа, поэтому не должны попадать
 * ни в число скрытых, ни в счётчик шапки — иначе сумма линий и чипов не
 * сходится с фактическим числом рёбер.
 *
 * Представитель стороны — живое ребро, если оно есть: помеченное на удаление
 * ребро не должно «приглушать» линию, за которой стоят живые связи. Скрытые
 * рёбра в корзине считаются и попадают в подсказку чипа; путь к их
 * восстановлению — метка корзины у чипа (общий диалог корзины).
 */
export function planGraphEdges(
  links: readonly Link[],
  centerId: string,
  visibleNeighbourIds: readonly string[],
  linkTypes: readonly LinkType[],
  threshold: number = MASS_LINK_THRESHOLD,
): GraphEdgePlan {
  const visible = new Set(visibleNeighbourIds);
  const groups = new Map<string, PairGroup>();
  for (const link of links) {
    const fromCenter = link.source_id === centerId;
    const toCenter = link.target_id === centerId;
    if (!fromCenter && !toCenter) continue;
    const otherId = fromCenter ? link.target_id : link.source_id;
    if (otherId === centerId || !visible.has(otherId)) continue;
    const key = `${link.type_id ?? ''}|${otherId}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        otherId,
        type:
          link.type_id === null ? undefined : linkTypes.find((t) => t.id === link.type_id),
        links: [],
      };
      groups.set(key, group);
    }
    group.links.push(link);
  }

  const drawnIds = new Set<string>();
  const massByNeighbour = new Map<string, MassInfo>();
  let hidden = 0;
  for (const group of groups.values()) {
    if (group.links.length < threshold) {
      for (const link of group.links) drawnIds.add(link.id);
      continue;
    }
    // Массовая пара: по одной линии-представителю на каждую сторону, которая
    // в паре присутствует. Встречные рёбра (6452c840) остаются видимыми, а
    // повторные рёбра стороны — только числом в чипе.
    const sides = new Map<MassSide, Link[]>();
    for (const link of group.links) {
      const side: MassSide = link.source_id === centerId ? 'out' : 'in';
      const list = sides.get(side);
      if (list === undefined) sides.set(side, [link]);
      else list.push(link);
    }
    let info = massByNeighbour.get(group.otherId);
    for (const [side, sideLinks] of sides) {
      const representative = sideLinks.find((link) => !isTrashedEdge(link)) ?? sideLinks[0]!;
      drawnIds.add(representative.id);
      const hiddenLinks = sideLinks.filter((link) => link !== representative);
      if (hiddenLinks.length === 0) continue;
      const trashed = hiddenLinks.filter((link) => isTrashedEdge(link)).length;
      hidden += hiddenLinks.length;
      if (info === undefined) {
        info = { hidden: 0, label: '', pairs: [], trashed: 0 };
        massByNeighbour.set(group.otherId, info);
      }
      info.hidden += hiddenLinks.length;
      info.trashed += trashed;
      const typeName = edgeTypeName(group.type, side === 'out');
      info.pairs.push({
        label: typeName === '' ? UNTYPED_LINK_LABEL : typeName,
        side,
        hidden: hiddenLinks.length,
        trashed,
      });
    }
  }
  for (const info of massByNeighbour.values()) {
    info.label = [...new Set(info.pairs.map((pair) => pair.label))].join(', ');
  }
  return { drawnIds, massByNeighbour, hidden };
}

/** Перечень «тип: N» по сторонам пары; сторону печатаем, когда метки совпали. */
function massPairList(pairs: readonly MassPair[]): string {
  const sameLabel = new Set(pairs.map((pair) => pair.label)).size !== pairs.length;
  return pairs
    .map((pair) => {
      // У симметричного имени типа (и у ребра без типа) прямое и обратное имена
      // совпадают — без пометки стороны две встречные записи неразличимы.
      const label = sameLabel
        ? `${pair.label} (${pair.side === 'out' ? 'исходящие' : 'входящие'})`
        : pair.label;
      return `${label}: ${pair.hidden}`;
    })
    .join('; ');
}

/**
 * Подсказка чипа «+N»: тип/сторона и число скрытых связей, корзина, где
 * полный список. Полный список ЖИВЫХ прямых связей живёт на вкладке
 * «Свойства» (свойства-связи; вкладки «Связи» в клиенте нет — 42a7c0a1,
 * круг 2). Помеченные на удаление рёбра из значений свойства не приходят,
 * поэтому при непустой корзине подсказка честно говорит «живых», а путь к
 * помеченным — корзина через метку у чипа.
 */
export function massChipTooltip(mass: MassInfo): string {
  const only = mass.pairs.length === 1 ? mass.pairs[0]! : null;
  const details =
    only !== null ? `${only.label}: ещё ${only.hidden} ${linksWord(only.hidden)}` : massPairList(mass.pairs);
  const trashed =
    mass.trashed > 0
      ? `, в корзине: ${mass.trashed} (метка корзины у чипа — восстановление через корзину)`
      : '';
  const liveWord = mass.trashed > 0 ? 'живых связей ' : '';
  return `${details}${trashed}. Полный список ${liveWord}— на вкладке «${LINKS_TAB_TITLE}».`;
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

// ---------------------------------------------------------------------------
// Что требует пересборки графа (ошибка 42a7c0a1, круг 3)
// ---------------------------------------------------------------------------

/**
 * Поля связи, которые видны на графе: концы (сосед/направление), тип
 * (подпись и оформление), собственные переопределения вида, активность и
 * метка корзины. Изменение любого из них обязано пересобрать план рёбер;
 * правка прочих полей (комментарий и т.п.) граф не трогает — иначе панель
 * мигала бы на каждое сохранение.
 */
export const GRAPH_LINK_FIELDS = [
  'source_id',
  'target_id',
  'type_id',
  'color',
  'style',
  'width',
  'active',
  'marked_for_deletion',
] as const;

/**
 * Поля мысли, которые видны на графе: подпись пилюли, значок и оформление
 * (включая эффективные от типа), активность и метка корзины. Всё остальное
 * (комментарий, синонимы, версия) граф не перерисовывает.
 */
export const GRAPH_THOUGHT_FIELDS = [
  'title',
  'type_id',
  'icon',
  'icon_kind',
  'icon_attachment_id',
  'icon_color',
  'fg_color',
  'bg_color',
  'font_bold',
  'font_italic',
  'font_underline',
  'font_strike',
  'active',
  'marked_for_deletion',
] as const;

/**
 * Меняет ли обновление СВЯЗИ её отображение на графе. `before` — состояние до
 * обновления (нормализованный кэш): без него изменение считается значимым —
 * безопаснее пересобрать, чем показать устаревшую метку корзины (блокер
 * круга 3: restore из корзины не гасил `.mini-graph-mass-trash`).
 */
export function linkChangeAffectsGraph(before: Link | undefined, after: Link): boolean {
  if (before === undefined) return true;
  return GRAPH_LINK_FIELDS.some((field) => before[field] !== after[field]);
}

/** Меняет ли PATCH связи (тот же набор полей) её отображение на графе. */
export function linkPatchAffectsGraph(
  before: Link,
  patch: Readonly<Record<string, unknown>>,
): boolean {
  return GRAPH_LINK_FIELDS.some((field) => field in patch && patch[field] !== before[field]);
}

/** Меняет ли правка мысли её отображение на графе (пилюля/состав соседей). */
export function thoughtChangesAffectGraph(changes: Readonly<Record<string, unknown>>): boolean {
  return GRAPH_THOUGHT_FIELDS.some((field) => field in changes);
}

/**
 * Какие realtime-события обязаны пересобрать открытый граф мысли-владельца.
 * `linkIds`/`neighbourIds` — текущий снимок панели: событие про постороннюю
 * связь или постороннюю мысль граф не трогает (нет мигания).
 */
export interface GraphEventContext {
  /** Мысль-центр открытой вкладки. */
  ownerId: string;
  /** id связей, показанных в текущем снимке панели. */
  linkIds: ReadonlySet<string>;
  /** id соседей из текущего снимка панели. */
  neighbourIds: ReadonlySet<string>;
}

/** Минимальная форма события шины, достаточная для решения (без DOM/сети). */
export interface GraphEventLike {
  type: string;
  data: Readonly<Record<string, unknown>>;
}

/**
 * Требует ли событие шины пересборки открытого графа. Проверены все пути
 * изменения рёбер (таблица — в отчёте круга 3):
 *  • `link.created` — ребро центра с мыслью (создание/перенос узла);
 *  • `link.updated` — связь из снимка панели, меняющая видимые поля;
 *  • `link.deleted` — связь из снимка (purge из корзины);
 *  • `thought.updated` — сосед сменил подпись/вид или ушёл в корзину;
 *  • `thought.deleted` — сосед удалён;
 *  • `link-type.*` / `thought-type.*` — эффективное оформление линий/пилюль.
 *
 * `property-value.set/deleted` сюда НЕ входят: значения свойств-связей — это
 * проекция рёбер, и сервер публикует по ним отдельные `link.created` /
 * `link.deleted` / `link.updated` (`routes/properties.ts`). Скалярное
 * свойство рёбер не меняет — пересборка на него была бы миганием (круг 3,
 * п.3: инвалидировать только по фактическому изменению).
 */
export function graphEventAffects(
  event: GraphEventLike,
  context: GraphEventContext,
): boolean {
  const data = event.data;
  switch (event.type) {
    case 'link.created': {
      const link = data.link as Link | undefined;
      if (link === undefined) return true;
      return link.source_id === context.ownerId || link.target_id === context.ownerId;
    }
    case 'link.updated': {
      if (!context.linkIds.has(String(data.id))) return false;
      const changes = data.changes;
      if (typeof changes !== 'object' || changes === null) return true;
      return GRAPH_LINK_FIELDS.some((field) => field in (changes as Record<string, unknown>));
    }
    case 'link.deleted':
      return context.linkIds.has(String(data.id));
    case 'thought.updated': {
      if (!context.neighbourIds.has(String(data.id))) return false;
      const changes = data.changes;
      if (typeof changes !== 'object' || changes === null) return true;
      return thoughtChangesAffectGraph(changes as Record<string, unknown>);
    }
    case 'thought.deleted':
      return context.neighbourIds.has(String(data.id));
    case 'link-type.updated':
    case 'link-type.deleted':
    case 'thought-type.updated':
    case 'thought-type.deleted':
      return true;
    default:
      return false;
  }
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
        `Когда с одним соседом связано ${MASS_LINK_THRESHOLD} и более рёбер одного типа (считая обе стороны), ` +
        'рисуется по одной линии на каждую сторону пары, а остальные связываются в чип «+N» у этого соседа ' +
        '(подсказка чипа — тип, сторона и число скрытых связей). Счётчик суммирует числа на чипах. ' +
        `Развернуть их на графе нельзя; полный список — на вкладке «${LINKS_TAB_TITLE}».`,
    });
  }
  if (stats.peripheryHidden > 0) {
    entries.push({
      text: `Ещё не поместилось: ${stats.peripheryHidden}`,
      tooltip:
        `На графе показаны первые ${PERIPHERY_CAP} соседей, остальные ${stats.peripheryHidden} не поместились. ` +
        `Полный список соседей и связей — на вкладке «${LINKS_TAB_TITLE}».`,
    });
  }
  return entries;
}

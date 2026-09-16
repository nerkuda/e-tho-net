/**
 * Editor tab «Граф» — мини-граф на всю высоту вкладки (d3-force/zoom/drag,
 * задача 8ab775d9, ADR «Локальный граф на d3-force/zoom/drag», приёмка
 * 0.8.1).
 *
 * Содержимое прежней группы «Локальный граф» с вкладки «Связи» переехало
 * сюда целиком: центр = редактируемая мысль, вокруг — все прямые соседи
 * (структурные родители/потомки + типизированные связи в обе стороны).
 * Массовые связи (≥10 одинакового типа к одной цели) скрываются за
 * чипом «+N». Граф строится при первом открытии вкладки (ленивая
 * активация панели редактора).
 *
 * Здесь нет сворачиваемой группы: вкладка одна, мини-граф заполняет всё
 * доступное место (`fillHeight: true`).
 */
import type { Link, ThoughtRef, ThoughtType } from '@etn/shared';

import { requireNetworkId } from '../app.js';
import { div, el, errText } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { store } from '../state.js';
import { registerTabContent, type EditorContext } from './editor.js';
import { buildMiniGraph } from './mini-graph.js';

/** Cap on the batched resolve call — server-side limit of `thoughts.resolve`. */
const RESOLVE_BATCH = 100;
/** Порог «массовости» пары (тип, цель): прячем избыточные рёбра за чипом «+N». */
const MASS_LINK_THRESHOLD = 10;

/**
 * Подтягивает с типа визуальные поля, которые мысль наследует, а не хранит
 * собственные (`icon`, цвета, шрифт). Используется только для соседей
 * мини-графа: центральная мысль приходит из `ctx.thought` уже с вычисленными
 * значениями. Без этого пилюли соседей рендерятся нейтрально, даже когда у
 * типа есть иконка и стиль.
 */
function inheritFromType(ref: ThoughtRef, typeById: Map<string, ThoughtType>): ThoughtRef {
  if (ref.type_id === null) return ref;
  const tt = typeById.get(ref.type_id);
  if (tt === undefined) return ref;
  return {
    ...ref,
    icon: ref.icon ?? tt.icon,
    icon_kind: ref.icon === null ? tt.icon_kind : ref.icon_kind,
    fg_color: ref.fg_color ?? tt.fg_color,
    bg_color: ref.bg_color ?? tt.bg_color,
    font_bold: ref.font_bold ?? tt.font_bold,
    font_italic: ref.font_italic ?? tt.font_italic,
    font_underline: ref.font_underline ?? tt.font_underline,
    font_strike: ref.font_strike ?? tt.font_strike,
  };
}

/** Registers the graph tab content (a single mini-graph that fills the pane). */
export function registerGraphTab(): void {
  registerTabContent('graph', buildGraphTab);
}

/** Builds the whole «Граф» tab pane content for the entity. */
function buildGraphTab(ctx: EditorContext): HTMLElement {
  const root = div('graph-tab');
  // Инлайн-стили дублируют CSS-правила `.graph-tab`. Vite в dev-режиме
  // кеширует styles.css между рестартами Electron, и без этой страховки
  // окно остаётся высотой по содержимому, если CSS не дошёл.
  root.style.display = 'flex';
  root.style.flexDirection = 'column';
  root.style.flex = '1 1 auto';
  root.style.minHeight = '0';
  root.append(el('div', 'graph-tab-body', 'Загрузка графа…'));
  void renderGraph(root, ctx);
  return root;
}

async function renderGraph(host: HTMLElement, ctx: EditorContext): Promise<void> {
  host.replaceChildren();
  host.append(await buildGraphBody(ctx));
}

/**
 * Тело вкладки: стягивает всех прямых соседей мысли (структурные
 * «Родители»/«Потомки» + типизированные связи в обе стороны) и рисует
 * мини-канвас, занимающий всю высоту родителя.
 */
async function buildGraphBody(ctx: EditorContext): Promise<HTMLElement> {
  const networkId = requireNetworkId();
  // `links-local-graph--fill` включает flex-растяжение по высоте для всей
  // цепочки `.tab-pane.fixed → .links-local-graph → .mini-graph → viewport`,
  // чтобы viewport (`.mini-graph-viewport--fill`) получил реальное свободное
  // место и заполнил вкладку (приёмка 0.8.1: граф на всю высоту вкладки).
  // Инлайн-стили дублируют CSS-правила — см. комментарий в buildGraphTab.
  const root = div('links-local-graph links-local-graph--fill');
  root.style.flex = '1 1 auto';
  root.style.minHeight = '0';
  if (ctx.thought === null) {
    root.append(el('p', 'muted', 'Граф недоступен — мысль ещё загружается.'));
    return root;
  }
  // Параллельно: соседи (оба направления одним вызовом), полный список связей
  // мысли (для подписей рёбер), сама мысль (уже есть в `ctx.thought`).
  let neighbours: Array<{ id: string; title: string }> = [];
  let links: Link[] = [];
  try {
    const [parents, children, grouped] = await Promise.all([
      etn.thoughts.neighbors(networkId, ctx.ownerId, 'parents', 200),
      etn.thoughts.neighbors(networkId, ctx.ownerId, 'children', 200),
      etn.links.listByThought(networkId, ctx.ownerId, true),
    ]);
    const seen = new Set<string>();
    const all = [...parents, ...children];
    for (const item of all) {
      if (item.id !== ctx.ownerId && !seen.has(item.id)) {
        seen.add(item.id);
        neighbours.push({ id: item.id, title: item.title });
      }
    }
    links = [
      ...(grouped.by_type.flatMap((g) => g.items) as unknown as Link[]),
      ...(grouped.untyped_parents as unknown as Link[]),
      ...(grouped.untyped_children as unknown as Link[]),
    ];
  } catch (err) {
    root.append(el('p', 'muted', `Не удалось загрузить граф: ${errText(err)}`));
    return root;
  }

  // Считаем массовые связи: для каждой связи с типом группируем по типу,
  // и если у одной и той же цели несколько связей одного типа — прячем
  // избыточные рёбра.
  const massMap = new Map<string, { hidden: number; label: string }>();
  const pairCounts = new Map<string, { typeName: string; count: number }>();
  for (const link of links) {
    const otherId = link.source_id === ctx.ownerId ? link.target_id : link.source_id;
    if (otherId === ctx.ownerId) continue;
    const key = `${link.type_id ?? ''}|${otherId}`;
    const existing = pairCounts.get(key);
    if (existing === undefined) {
      const typeName =
        store.state.linkTypes.find((t) => t.id === link.type_id)?.name_forward ?? 'связь';
      pairCounts.set(key, { typeName, count: 1 });
    } else {
      existing.count += 1;
    }
  }
  for (const [key, info] of pairCounts) {
    if (info.count >= MASS_LINK_THRESHOLD) {
      const [, otherId] = key.split('|') as [string, string];
      const target = massMap.get(otherId) ?? { hidden: 0, label: info.typeName };
      target.hidden += info.count - 1; // одно ребро рисуем, остальные прячем
      target.label = info.typeName;
      massMap.set(otherId, target);
    }
  }

  if (neighbours.length === 0) {
    root.append(el('p', 'muted', 'У мысли нет прямых связей.'));
    return root;
  }

  // Соседи для мини-графа — полными карточками (значок/цвета/шрифт/пометки,
  // приёмка 0.8.1 «облачка как везде»): батч-резолв; неудача — нейтральная
  // карточка из id/title.
  let graphRefs: ThoughtRef[] = neighbours.map((nb) => ({
    id: nb.id,
    title: nb.title,
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
  }));
  try {
    const resolved = await etn.thoughts.resolve(
      networkId,
      neighbours.slice(0, RESOLVE_BATCH).map((nb) => nb.id),
    );
    const byId = new Map(resolved.map((r) => [r.id, r]));
    graphRefs = graphRefs.map((r) => byId.get(r.id) ?? r);
  } catch {
    // Оффлайн-мигание — граф рисуется с нейтральными пилюлями.
  }
  // Серверный `thoughts.resolve` возвращает собственные icon/цвета/шрифт
  // мысли (`null`, если заданы на типе); центральная мысль приходит из
  // `ctx.thought` с уже вычисленными значениями, а соседи — нет. Подтягиваем
  // наследуемые поля с типа, чтобы пилюли соседей выглядели как везде
  // (приёмка 0.8.1 «облачка как везде»; баг — иконка/цвета видны только у
  // центра).
  const typeById = new Map(store.state.thoughtTypes.map((t) => [t.id, t]));
  graphRefs = graphRefs.map((r) => inheritFromType(r, typeById));

  root.append(
    buildMiniGraph({
      thought: ctx.thought,
      neighbours: graphRefs,
      links,
      mass: massMap,
      fillHeight: true,
    }),
  );
  return root;
}

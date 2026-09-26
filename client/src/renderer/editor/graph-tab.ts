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
import type { Link, ThoughtRef } from '@etn/shared';

import { requireNetworkId } from '../app.js';
import { div, el, errText } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { store } from '../state.js';
import { registerTabContent, type EditorContext } from './editor.js';
import { buildMiniGraph } from './mini-graph.js';
import { computeMassLinks } from './mini-graph-model.js';

/** Cap on the batched resolve call — server-side limit of `thoughts.resolve`. */
const RESOLVE_BATCH = 100;

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
  // Параллельно: соседи (оба направления), полный список связей мысли (для
  // подписей/направления/оформления рёбер), сама мысль (уже есть в `ctx.thought`).
  //
  // НЕЗАВИСИМОСТЬ ОТ ОТБОРОВ (задача 6811d5e7, п.5): граф показывает все связи
  // мысли ВСЕГДА. Источник — собственные запросы этой вкладки:
  //  - `thoughts.neighbors` (родители/потомки) и `links.listByThought` (все
  //    типизированные и нетипизированные рёбра обеих сторон) без фильтра типов
  //    связей и без `type_id` — отбор карты мыслей (фильтр типов связей на
  //    карте и прочие её условия) сюда не передаётся и не должен передаваться.
  const neighbours: Array<{ id: string; title: string }> = [];
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
    // Группы «связи по типу» и нетипизированные пары несут связь вложенной
    // (`{ link, target_thought }`) — разворачиваем её; направление и тип берём
    // у самой связи, а не у обёртки (задача 6811d5e7, п.1/3/4).
    links = [
      ...grouped.by_type.flatMap((g) => g.items.map((i) => i.link)),
      ...grouped.untyped_parents.map((u) => u.link),
      ...grouped.untyped_children.map((u) => u.link),
    ];
  } catch (err) {
    root.append(el('p', 'muted', `Не удалось загрузить граф: ${errText(err)}`));
    return root;
  }

  // Массовые связи: ≥ MASS_LINK_THRESHOLD рёбер одного типа к одному соседу —
  // лишние прячутся за чипом «+N» (единственный источник правила — модель).
  const massMap = computeMassLinks(links, ctx.ownerId, store.state.linkTypes);

  if (neighbours.length === 0) {
    root.append(el('p', 'muted', 'У мысли нет прямых связей.'));
    return root;
  }

  // Соседи для мини-графа — полными карточками (значок/цвета/шрифт/пометки,
  // приёмка 0.8.1 «облачка как везде»): батч-резолв; неудача — нейтральная
  // карточка из id/title. Сервер отдаёт только собственные поля мысли
  // (`null`, если значение задано на типе), поэтому вид типа разрешает сам
  // мини-граф общими хелперами канваса — руками здесь ничего не достраиваем.
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

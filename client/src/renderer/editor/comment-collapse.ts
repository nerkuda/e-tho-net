/**
 * Сворачивание разделов комментария (0.12.1, задача 634f1412; элемент
 * интерфейса 826c4423, требования b482b36b и e04d84f7).
 *
 * **Что сворачивается.**
 * - Заголовки H1–H6 — своё содержимое до следующего заголовка того же или
 *   более высокого уровня.
 * - Вложенные блоки — под-списки (`ul`/`ol` внутри элемента списка или
 *   цитаты) и вложенные цитаты: сворачивается содержимое блока, сам блок с
 *   индикатором остаётся виден.
 *
 * **Где работает.** И в просмотре (HTML из `@etn/markdown`), и в
 * редактировании (live preview CodeMirror 6) — `decorateCommentView` и
 * `commentCollapseExtension` соответственно.
 *
 * **Индикатор** — управляющий элемент у начала строки заголовка/блока
 * (кнопка-шеврон из `lib/ui`).
 *
 * **Состояние** хранится ЛОКАЛЬНО на клиенте (localStorage, ключ
 * «сеть + владелец поля + раздел») и переживает переоткрытие поля; на сервер
 * не едет (требование b482b36b). Распространение на блоки трансклюзий — ТП2.
 *
 * «Раздел» идентифицируется позиционно: `h{уровень}#{n}` — n-й по счёту
 * заголовок этого уровня в документе, `n#{m}` — m-й по счёту вложенный блок.
 * Позиционные ключи одинаковы для обоих режимов одного и того же текста и
 * переживают переоткрытие; при правке текста выше раздела ключ может
 * сместиться (осознанный компромисс — семантический ключ по тексту разошёлся
 * бы между просмотром и правкой на inline-разметке).
 */

import { syntaxTree } from '@codemirror/language';
import {
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from '@codemirror/view';

import { t } from '../lib/i18n.js';
import { iconButton } from '../lib/ui/button.js';
import { svgIcon } from '../lib/ui/icon.js';

/** Базовый класс кнопки-индикатора (общий для просмотра и правки). */
export const COLLAPSE_TOGGLE_CLASS = 'md-collapse-toggle';

/** Класс скрытого элемента в режиме просмотра. */
export const COLLAPSE_HIDDEN_CLASS = 'md-collapse-hidden';

// ---------------------------------------------------------------------------
// Локальное хранилище состояния (localStorage, на сервер не едет)
// ---------------------------------------------------------------------------

/** Ключ localStorage одного поля: сеть + владелец поля. */
export function commentCollapseStorageKey(networkId: string, ownerKey: string): string {
  return `comment.collapse.${networkId}.${ownerKey}`;
}

/** Разбирает сохранённый список свёрнутых разделов (только непустые строки). */
export function parseCollapsedIds(raw: string | null): string[] {
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((v): v is string => typeof v === 'string' && v !== '');
}

/** Сериализует набор свёрнутых разделов (в стабильном порядке). */
export function serializeCollapsedIds(ids: Iterable<string>): string {
  return JSON.stringify([...ids].sort());
}

/** localStorage за охраной: недоступен (Node-тесты, жёсткие контексты) → null. */
function storage(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Состояние свёрнутости одного поля: память + локальный персист. Владелец
 * неизвестен (`ownerKey === undefined`) — состояние живёт только в памяти
 * поля (переоткрытие его не сохранит, на сервер не едет в любом случае).
 */
export interface CommentCollapseState {
  /** Свёрнут ли раздел. */
  isCollapsed(id: string): boolean;
  /** Переключает раздел (с записью в localStorage, когда владелец известен). */
  setCollapsed(id: string, collapsed: boolean): void;
  /** Снимок всех свёрнутых разделов (для инициализации поля редактора). */
  all(): string[];
}

/** Создаёт состояние свёрнутости поля. */
export function createCommentCollapseState(
  networkId: string,
  ownerKey: string | undefined,
): CommentCollapseState {
  const read = (): Set<string> => {
    if (ownerKey === undefined) return new Set();
    const ls = storage();
    if (ls === null) return new Set();
    try {
      return new Set(parseCollapsedIds(ls.getItem(commentCollapseStorageKey(networkId, ownerKey))));
    } catch {
      return new Set();
    }
  };
  const collapsed = read();
  const persist = (): void => {
    if (ownerKey === undefined) return;
    const ls = storage();
    if (ls === null) return;
    try {
      ls.setItem(
        commentCollapseStorageKey(networkId, ownerKey),
        serializeCollapsedIds(collapsed),
      );
    } catch {
      // Полное/недоступное хранилище — сворачивание не критичные данные.
    }
  };
  return {
    isCollapsed: (id) => collapsed.has(id),
    setCollapsed: (id, value) => {
      if (value) collapsed.add(id);
      else collapsed.delete(id);
      persist();
    },
    all: () => [...collapsed],
  };
}

// ---------------------------------------------------------------------------
// Индикатор
// ---------------------------------------------------------------------------

/** Кнопка-индикатор свёрнутого узла (шеврон из lib/ui; поворот — CSS). */
function createToggleButton(collapsed: boolean, onToggle: () => void): HTMLButtonElement {
  const btn = iconButton({
    icon: svgIcon('chevron-down', 12),
    role: 'ghost',
    size: 's',
    title: collapsed ? t('comment.collapse.expand') : t('comment.collapse.collapse'),
    class: COLLAPSE_TOGGLE_CLASS,
    onClick: (event) => {
      event.preventDefault();
      event.stopPropagation();
      onToggle();
    },
  });
  btn.classList.toggle('is-collapsed', collapsed);
  btn.setAttribute('aria-expanded', String(!collapsed));
  return btn;
}

// ---------------------------------------------------------------------------
// Режим просмотра (HTML)
// ---------------------------------------------------------------------------

/** Тег заголовка H1–H6? */
function headingLevel(node: Element): number {
  const m = /^H([1-6])$/.exec(node.tagName.toUpperCase());
  return m === null ? 0 : Number(m[1]);
}

/** Обход элементов в порядке документа: узел, родитель, соседи и индекс. */
function walkElements(
  root: HTMLElement,
  visit: (node: HTMLElement, parent: HTMLElement, siblings: HTMLElement[], index: number) => void,
): void {
  const step = (parent: HTMLElement): void => {
    const siblings = Array.from(parent.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement,
    );
    siblings.forEach((child, index) => {
      visit(child, parent, siblings, index);
      step(child);
    });
  };
  step(root);
}

/** Один сворачиваемый раздел просмотра: индикатор и скрываемые элементы. */
interface ViewSection {
  id: string;
  anchor: HTMLElement;
  hide: HTMLElement[];
}

/**
 * Навешивает сворачивание на отрендеренный HTML комментария. Идемпотентна:
 * прежние индикаторы и классы скрытия снимаются — функция вызывается на
 * каждом рендере просмотра.
 */
export function decorateCommentView(view: HTMLElement, state: CommentCollapseState): void {
  // Идемпотентность: снять прежнюю разметку сворачивания.
  const existing: HTMLElement[] = [];
  walkElements(view, (node) => existing.push(node));
  for (const node of existing) {
    if (node.classList.contains(COLLAPSE_TOGGLE_CLASS)) node.remove();
    else node.classList.remove(COLLAPSE_HIDDEN_CLASS);
  }

  const headings: Array<{ node: HTMLElement; siblings: HTMLElement[]; index: number }> = [];
  const nestedBlocks: HTMLElement[] = [];
  walkElements(view, (node, parent, siblings, index) => {
    const level = headingLevel(node);
    if (level > 0) headings.push({ node, siblings, index });
    const tag = node.tagName.toUpperCase();
    const parentTag = parent.tagName.toUpperCase();
    if (
      (tag === 'UL' || tag === 'OL' || tag === 'BLOCKQUOTE') &&
      (parentTag === 'LI' || parentTag === 'BLOCKQUOTE')
    ) {
      nestedBlocks.push(node);
    }
  });

  const sections: ViewSection[] = [];
  const levelCounters = new Map<number, number>();

  // Заголовки: тело — сиблинги до следующего заголовка того же/высшего уровня.
  for (const { node, siblings, index } of headings) {
    const level = headingLevel(node);
    const hide: HTMLElement[] = [];
    for (const sib of siblings.slice(index + 1)) {
      const sibLevel = headingLevel(sib);
      if (sibLevel !== 0 && sibLevel <= level) break;
      hide.push(sib);
    }
    if (hide.length === 0) continue; // сворачивать нечего
    const n = (levelCounters.get(level) ?? 0) + 1;
    levelCounters.set(level, n);
    sections.push({ id: `h${level}#${n}`, anchor: node, hide });
  }

  // Вложенные блоки: скрывается содержимое блока, индикатор — у его начала.
  let nested = 0;
  for (const block of nestedBlocks) {
    const hide = Array.from(block.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement,
    );
    if (hide.length === 0) continue;
    nested += 1;
    sections.push({ id: `n#${nested}`, anchor: block, hide });
  }

  // Кто кого скрывает: элемент виден, пока не свёрнут ни один из его разделов.
  const owners = new Map<HTMLElement, string[]>();
  const toggles = new Map<string, HTMLButtonElement>();
  const apply = (): void => {
    for (const [element, ids] of owners) {
      element.classList.toggle(
        COLLAPSE_HIDDEN_CLASS,
        ids.some((id) => state.isCollapsed(id)),
      );
    }
    for (const [id, btn] of toggles) {
      const isCollapsed = state.isCollapsed(id);
      btn.classList.toggle('is-collapsed', isCollapsed);
      btn.setAttribute('aria-expanded', String(!isCollapsed));
      btn.title = isCollapsed ? t('comment.collapse.expand') : t('comment.collapse.collapse');
    }
  };

  for (const section of sections) {
    for (const element of section.hide) {
      const ids = owners.get(element);
      if (ids === undefined) owners.set(element, [section.id]);
      else ids.push(section.id);
    }
    const btn = createToggleButton(state.isCollapsed(section.id), () => {
      state.setCollapsed(section.id, !state.isCollapsed(section.id));
      apply();
    });
    // Двойной клик по индикатору не должен переводить поле в правку.
    btn.addEventListener('dblclick', (event) => event.stopPropagation());
    section.anchor.prepend(btn);
    toggles.set(section.id, btn);
  }

  apply();
}

// ---------------------------------------------------------------------------
// Режим редактирования (CodeMirror 6, live preview)
// ---------------------------------------------------------------------------

/** Эффект переключения свёрнутости раздела. */
export const setCollapseEffect = StateEffect.define<{ id: string; collapsed: boolean }>();

/** Набор свёрнутых разделов (единственный источник для декораций). */
const collapseSetField = StateField.define<Set<string>>({
  create: () => new Set(),
  update: (value, tr) => {
    let next = value;
    for (const effect of tr.effects) {
      if (!effect.is(setCollapseEffect)) continue;
      next = new Set(next);
      if (effect.value.collapsed) next.add(effect.value.id);
      else next.delete(effect.value.id);
    }
    return next;
  },
});

/** Скрытый диапазон тела свёрнутого раздела. */
export interface CollapsedRange {
  from: number;
  to: number;
}

interface CollapseDecoState {
  setRef: Set<string> | null;
  ranges: CollapsedRange[];
  deco: DecorationSet;
}

/** Раздел редактора: позиция индикатора и диапазон скрываемого тела. */
interface EditorSection {
  id: string;
  anchorFrom: number;
  bodyFrom: number;
  bodyTo: number;
}

/** Минимум узла дерева, нужный проверке вложенности (SyntaxNode подходит). */
interface TreeNodeLike {
  name: string;
  parent: TreeNodeLike | null;
}

/** Вложенный ли блочный узел дерева (внутри ListItem/Blockquote). */
function isNestedNode(node: { parent: TreeNodeLike | null }): boolean {
  let current: TreeNodeLike | null = node.parent;
  while (current !== null) {
    if (current.name === 'Document') return false;
    if (current.name === 'ListItem' || current.name === 'Blockquote') return true;
    current = current.parent;
  }
  return false;
}

/** Собирает сворачиваемые разделы документа по дереву синтаксиса. */
function collectSections(state: EditorState): EditorSection[] {
  const doc = state.doc;
  const headings: Array<{ level: number; from: number; to: number }> = [];
  const nestedBlocks: Array<{ from: number; to: number }> = [];

  syntaxTree(state).iterate({
    enter(node) {
      const name = node.name;
      if (/^ATXHeading[1-6]$/.test(name) || /^SetextHeading[12]$/.test(name)) {
        const level = Number(name.slice(-1));
        headings.push({ level, from: node.from, to: node.to });
        return;
      }
      if (name === 'BulletList' || name === 'OrderedList' || name === 'Blockquote') {
        if (isNestedNode(node.node)) nestedBlocks.push({ from: node.from, to: node.to });
      }
    },
  });

  const sections: EditorSection[] = [];

  // Заголовки: тело — строки до начала строки следующего заголовка не выше уровнем.
  const levelCounters = new Map<number, number>();
  headings.forEach((heading, index) => {
    let end = doc.length;
    for (let j = index + 1; j < headings.length; j += 1) {
      if ((headings[j]?.level ?? 0) <= heading.level) {
        end = doc.lineAt(headings[j]!.from).from;
        break;
      }
    }
    const bodyFrom = doc.lineAt(heading.to).to + 1;
    if (bodyFrom >= end) return; // тело пустое — сворачивать нечего
    const lastLine = doc.lineAt(end - 1);
    const bodyTo = lastLine.to;
    if (bodyTo <= bodyFrom) return;
    const n = (levelCounters.get(heading.level) ?? 0) + 1;
    levelCounters.set(heading.level, n);
    sections.push({
      id: `h${heading.level}#${n}`,
      anchorFrom: doc.lineAt(heading.from).from,
      bodyFrom,
      bodyTo,
    });
  });

  // Вложенные блоки: тело — весь блок, индикатор — у его первой строки.
  let nested = 0;
  for (const block of nestedBlocks) {
    const bodyFrom = doc.lineAt(block.from).from;
    const bodyTo = doc.lineAt(block.to).to;
    if (bodyTo <= bodyFrom) continue;
    nested += 1;
    sections.push({ id: `n#${nested}`, anchorFrom: bodyFrom, bodyFrom, bodyTo });
  }

  return sections.sort((a, b) => a.bodyFrom - b.bodyFrom);
}

/** Кнопка-индикатор в редакторе как виджет CM6. */
class CollapseToggleWidget extends WidgetType {
  constructor(
    readonly id: string,
    readonly collapsed: boolean,
  ) {
    super();
  }

  override eq(other: CollapseToggleWidget): boolean {
    return other.id === this.id && other.collapsed === this.collapsed;
  }

  override toDOM(view: EditorView): HTMLElement {
    const btn = createToggleButton(this.collapsed, () => {
      view.dispatch({
        effects: setCollapseEffect.of({ id: this.id, collapsed: !this.collapsed }),
      });
    });
    btn.classList.add('cm-md-collapse-toggle');
    return btn;
  }

  override ignoreEvent(): boolean {
    // Кнопка сама обрабатывает клик; редактор событие не должен трогать.
    return true;
  }
}

/** Строит декорации и список скрытых диапазонов для текущего состояния. */
function buildDecorations(state: EditorState): CollapseDecoState {
  const collapsed = state.field(collapseSetField);
  const ranges: CollapsedRange[] = [];
  const parts: Array<Range<Decoration>> = [];

  for (const section of collectSections(state)) {
    // Раздел внутри тела уже свёрнутого раздела скрыт родителем — не строим.
    if (ranges.some((r) => section.anchorFrom >= r.from && section.anchorFrom < r.to)) continue;
    const isCollapsed = collapsed.has(section.id);
    parts.push(
      Decoration.widget({
        widget: new CollapseToggleWidget(section.id, isCollapsed),
        side: -1,
      }).range(section.anchorFrom),
    );
    if (isCollapsed) {
      ranges.push({ from: section.bodyFrom, to: section.bodyTo });
      parts.push(Decoration.replace({ block: true }).range(section.bodyFrom, section.bodyTo));
    }
  }

  return { setRef: collapsed, ranges, deco: Decoration.set(parts, true) };
}

/** Поле декораций сворачивания (также отдаёт диапазоны скрытых тел). */
const collapseDecoField = StateField.define<CollapseDecoState>({
  create: (state) => buildDecorations(state),
  update: (value, tr) => {
    const current = tr.state.field(collapseSetField);
    if (!tr.docChanged && current === value.setRef) return value;
    return buildDecorations(tr.state);
  },
  provide: (field) => EditorView.decorations.from(field, (state) => state.deco),
});

/**
 * Точка в скрытом диапазоне? Нужна live preview (`md-live.ts`): внутри
 * заменённого тела декорации ставить нельзя — они пересекут замену.
 */
export function isCollapsedHiddenAt(state: EditorState, pos: number): boolean {
  const value = state.field(collapseDecoField, false);
  if (value === undefined) return false;
  return value.ranges.some((r) => pos >= r.from && pos < r.to);
}

/**
 * Расширение редактора: набор свёрнутых разделов поля (инициализируется из
 * локального состояния) плюс запись переключений в то же состояние.
 */
export function commentCollapseExtension(state: CommentCollapseState): Extension {
  return [
    collapseSetField.init(() => new Set(state.all())),
    collapseDecoField,
    EditorView.updateListener.of((update) => {
      for (const tr of update.transactions) {
        for (const effect of tr.effects) {
          if (!effect.is(setCollapseEffect)) continue;
          state.setCollapsed(effect.value.id, effect.value.collapsed);
        }
      }
    }),
  ];
}

/** Тестовый шов: разбор разделов и поле декораций редактора. */
export const commentCollapseInternals = { collectSections, collapseDecoField };

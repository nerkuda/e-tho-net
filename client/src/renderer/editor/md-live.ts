/**
 * Live preview (task M6): WYSIWYM-декорации markdown-редактора.
 *
 * Неактивные блоки отображаются так, как они будут выглядеть в HTML-просмотре:
 * маркеры синтаксиса (решётки заголовков, `*` emphasis, `>` цитат, URL ссылок)
 * скрываются, а целые блоки (fenced-код, картинки, таблицы, wiki-ссылки,
 * горизонтальные линейки) становятся DOM-виджетами, отрендеренными ТЕМ ЖЕ
 * конвейером @etn/markdown, который создаёт кешированный серверный HTML.
 * Курсор внутри блока (или клик по виджету) показывает исходный markdown.
 *
 * Декорации выдаёт StateField (block-декорации, пересекающие переносы строк,
 * из ViewPlugin запрещены); клики по виджетам обрабатывает domEventHandlers.
 */

import { syntaxTree } from '@codemirror/language';
import {
  EditorState,
  StateField,
  type Range,
  type SelectionRange,
} from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from '@codemirror/view';

import { renderMarkdown } from '@etn/markdown';

import { renderMermaidBlocks } from './md-mermaid.js';

/** Корневой класс всех виджетов live preview. */
export const MD_WIDGET_CLASS = 'md-widget';

/**
 * Блочное правило (M6-фикс): блок активен, пока каретка/выделение
 * пересекает его диапазон ВКЛЮЧИТЕЛЬНО — от первого до последнего символа
 * блока маркеры не скрываются.
 */
export function isInRangeInclusive(
  ranges: readonly SelectionRange[],
  from: number,
  to: number,
): boolean {
  return ranges.some((r) => r.from <= to && r.to >= from);
}

/**
 * Инлайн-правило (M6-фикс): элемент активен, пока каретка внутри него или
 * непосредственно перед/после (позиции `from-1` … `to`).
 */
export function isNearInline(
  ranges: readonly SelectionRange[],
  from: number,
  to: number,
): boolean {
  return ranges.some((r) => {
    if (r.empty) return r.from >= from - 1 && r.from <= to;
    return r.to >= from - 1 && r.from <= to + 1;
  });
}

/** Базовый виджет: HTML-блок из единого рендерера; клик раскрывает исходник. */
class HtmlWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly html: string,
  ) {
    super();
  }

  override eq(other: HtmlWidget): boolean {
    return other.from === this.from && other.to === this.to && other.html === this.html;
  }

  override toDOM(): HTMLElement {
    const box = document.createElement('div');
    box.className = `${MD_WIDGET_CLASS} comment-view`;
    box.dataset.mdFrom = String(this.from);
    box.dataset.mdTo = String(this.to);
    // HTML из @etn/markdown экранируется по построению (тот же контракт,
    // что и у серверного body_html).
    box.innerHTML = this.html;
    // Mermaid-блоки рендерятся асинхронно после монтирования виджета (M7).
    // Без requestAnimationFrame: в фоновом окне Electron он не тикает.
    renderMermaidBlocks(box);
    return box;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/** Виджет wiki-ссылки: отображается алиас (или имя), скобки скрыты. */
class WikiLinkWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly label: string,
  ) {
    super();
  }

  override eq(other: WikiLinkWidget): boolean {
    return other.from === this.from && other.to === this.to && other.label === this.label;
  }

  override toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = `${MD_WIDGET_CLASS} wiki-link`;
    span.textContent = this.label;
    span.dataset.mdFrom = String(this.from);
    span.dataset.mdTo = String(this.to);
    return span;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/** Горизонтальная линейка. */
class HrWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
  ) {
    super();
  }

  override eq(other: HrWidget): boolean {
    return other.from === this.from && other.to === this.to;
  }

  override toDOM(): HTMLElement {
    const hr = document.createElement('hr');
    hr.className = `${MD_WIDGET_CLASS} md-hr`;
    hr.dataset.mdFrom = String(this.from);
    hr.dataset.mdTo = String(this.to);
    return hr;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/** Разбор `[[target|alias]]` для виджета wiki-ссылки (пустой алиас = имя). */
export function wikiLabel(source: string): { target: string; label: string } | null {
  const m = /^\[\[([^[\]\n|]+)(?:\|([^\]\n]*))?\]\]$/.exec(source.trim());
  if (m === null) return null;
  const target = m[1]!.trim();
  const alias = m[2]?.trim() ?? '';
  return { target, label: alias !== '' ? alias : target };
}

/** Строит набор декораций для текущего состояния. */
function buildDecorations(state: EditorState): DecorationSet {
  // Диапазоны собираются в массив и сортируются в Decoration.set: hide-замены
  // имеют startSide −2, mark — 5e8, поэтому на одной позиции (бэктики внутри
  // InlineCode) порядок вставки не монотонен, и RangeSetBuilder не подходит.
  const parts: Array<Range<Decoration>> = [];
  const ranges = state.selection.ranges;

  const hide = (from: number, to: number): void => {
    parts.push({ from, to, value: Decoration.replace({ inclusive: true }) });
  };

  /** Стек диапазонов Blockquote: маркеры цитат «живут» блоком-родителем. */
  const quoteStack: Array<{ from: number; to: number }> = [];

  /**
   * Стек инлайн-родителей (Link / Emphasis-семейство / InlineCode): маркеры
   * детей скрываются только когда неактивен их инлайн-родитель. Позиции детей
   * из итератора — документальные, поэтому диапазоны родителей запоминаются
   * при входе в узел (метод Tree.getChildren не подходит: его координаты
   * зависят от дерева-объекта, а не от узла).
   */
  const inlineStack: Array<{ kind: 'link' | 'emphasis' | 'code'; from: number; to: number }> = [];

  syntaxTree(state).iterate({
    enter(node) {
      const { from, to } = node;

      switch (node.name) {
        // Заголовки: скрыть «# …» до начала текста; блок активен, пока
        // каретка внутри заголовка (включая последний символ). Класс строки
        // задаёт размер/отступы как у h1–h6 в HTML-просмотре (паритет стилей).
        case 'ATXHeading1':
        case 'ATXHeading2':
        case 'ATXHeading3':
        case 'ATXHeading4':
        case 'ATXHeading5':
        case 'ATXHeading6': {
          const level = node.name.slice('ATXHeading'.length);
          parts.push({ from, to, value: Decoration.line({ class: `cm-md-h${level}` }) });
          if (!isInRangeInclusive(ranges, from, to)) {
            const m = /^#{1,6} +/.exec(state.sliceDoc(from, to));
            if (m !== null) hide(from, from + m[0].length);
          }
          break;
        }
        // Цитаты: запоминаем диапазон блока; маркеры обрабатываются ниже.
        case 'Blockquote': {
          quoteStack.push({ from, to });
          break;
        }
        // Маркер цитаты: активен, пока каретка внутри её Blockquote.
        case 'QuoteMark': {
          const block = quoteStack[quoteStack.length - 1];
          const active = block !== undefined && isInRangeInclusive(ranges, block.from, block.to);
          if (!active) {
            const extra = state.sliceDoc(to, to + 1) === ' ' ? 1 : 0;
            hide(from, to + extra);
          }
          break;
        }
        // Инлайн-родители: запоминаем диапазон; маркеры детей — ниже.
        case 'Link': {
          inlineStack.push({ kind: 'link', from, to });
          break;
        }
        case 'Emphasis':
        case 'StrongEmphasis':
        case 'Strikethrough': {
          inlineStack.push({ kind: 'emphasis', from, to });
          break;
        }
        case 'InlineCode': {
          inlineStack.push({ kind: 'code', from, to });
          // Плашка как у <code> в просмотре — mark на весь узел: скрытые
          // бэктики ширины не занимают. Контент inline-кода не является
          // отдельным узлом дерева (CodeText появляется только с codeParser).
          parts.push({ from, to, value: Decoration.mark({ class: 'cm-md-inline-code' }) });
          break;
        }
        // Маркеры инлайн-выделения: видны, пока каретка внутри элемента или
        // непосредственно перед/после него.
        case 'EmphasisMark':
        case 'StrikethroughMark':
        case 'CodeMark': {
          const parent = inlineStack[inlineStack.length - 1];
          if (
            parent !== undefined &&
            parent.kind !== 'link' &&
            !isNearInline(ranges, parent.from, parent.to)
          ) {
            hide(from, to);
          }
          break;
        }
        // URL ссылки: скрыть «(url "title")», оставив видимый текст.
        case 'URL': {
          const link = [...inlineStack].reverse().find((p) => p.kind === 'link');
          if (link !== undefined && !isNearInline(ranges, link.from, link.to)) {
            hide(from - 1, link.to);
          }
          break;
        }
        // Целые блоки — виджеты (активны включительно по диапазону).
        // Дети узла не обрабатываются: внутри диапазона, заменённого
        // виджетом, декорации не отображаются.
        case 'FencedCode': {
          if (!isInRangeInclusive(ranges, from, to)) {
            parts.push({
              from,
              to,
              value: Decoration.replace({
                // Блок занимает несколько строк — обязателен block: true.
                block: true,
                widget: new HtmlWidget(from, to, renderMarkdown(state.sliceDoc(from, to))),
              }),
            });
            return false;
          }
          break;
        }
        case 'Image': {
          if (!isInRangeInclusive(ranges, from, to)) {
            parts.push({
              from,
              to,
              value: Decoration.replace({
                widget: new HtmlWidget(from, to, renderMarkdown(state.sliceDoc(from, to))),
              }),
            });
            return false;
          }
          break;
        }
        case 'Table': {
          if (!isInRangeInclusive(ranges, from, to)) {
            parts.push({
              from,
              to,
              value: Decoration.replace({
                // Таблица занимает несколько строк — обязателен block: true.
                block: true,
                widget: new HtmlWidget(from, to, renderMarkdown(state.sliceDoc(from, to))),
              }),
            });
            return false;
          }
          break;
        }
        case 'HorizontalRule': {
          if (!isInRangeInclusive(ranges, from, to)) {
            parts.push({
              from,
              to,
              value: Decoration.replace({ widget: new HrWidget(from, to) }),
            });
            return false;
          }
          break;
        }
        // Wiki-ссылка — инлайн-элемент: скобки видны и внутри, и сразу
        // после `]]`, чтобы ссылку можно было править.
        case 'WikiLink': {
          if (!isNearInline(ranges, from, to)) {
            const parsed = wikiLabel(state.sliceDoc(from, to));
            if (parsed !== null) {
              parts.push({
                from,
                to,
                value: Decoration.replace({
                  widget: new WikiLinkWidget(from, to, parsed.label),
                }),
              });
              return false;
            }
          }
          break;
        }
        default:
          break;
      }
    },
    leave(node) {
      switch (node.name) {
        case 'Blockquote':
          quoteStack.pop();
          break;
        case 'Link':
        case 'Emphasis':
        case 'StrongEmphasis':
        case 'Strikethrough':
        case 'InlineCode':
          inlineStack.pop();
          break;
        default:
          break;
      }
    },
  });

  return Decoration.set(parts, true);
}

/** Live-preview декорации (block-декорации требует StateField, не ViewPlugin). */
export const livePreview = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state),
  update: (decorations, tr) => {
    if (tr.docChanged || tr.selection) return buildDecorations(tr.state);
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Клик по виджету: каретка в диапазон блока — декорации раскроют исходник. */
export const mdWidgetClick = EditorView.domEventHandlers({
  mousedown: (event, view) => {
    const target = event.target as Element | null;
    const widget = target?.closest?.(`.${MD_WIDGET_CLASS}`);
    if (!(widget instanceof HTMLElement)) return false;
    const fromRaw = widget.dataset.mdFrom;
    const toRaw = widget.dataset.mdTo;
    if (fromRaw === undefined || toRaw === undefined) return false;
    const from = Number(fromRaw);
    const to = Number(toRaw);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to - from < 2) return false;

    let pos = from + 1;
    const coords = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (coords !== null && coords > from && coords < to) pos = coords;
    view.dispatch({
      selection: { anchor: Math.min(pos, to - 1) },
      scrollIntoView: false,
      userEvent: 'select',
    });
    return true;
  },
});

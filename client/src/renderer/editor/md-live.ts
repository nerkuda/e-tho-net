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
import { EditorState, RangeSetBuilder, StateField } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from '@codemirror/view';

import { renderMarkdown } from '@etn/markdown';

/** Корневой класс всех виджетов live preview. */
export const MD_WIDGET_CLASS = 'md-widget';

/** True when any selection range intersects `[from, to)` (блок «активен»). */
function isRangeActive(
  ranges: readonly { from: number; to: number }[],
  from: number,
  to: number,
): boolean {
  return ranges.some((r) => r.from < to && r.to > from);
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
  const builder = new RangeSetBuilder<Decoration>();
  const ranges = state.selection.ranges;

  const hide = (from: number, to: number): void => {
    builder.add(from, to, Decoration.replace({ inclusive: true }));
  };

  syntaxTree(state).iterate({
    enter(node) {
      const { from, to } = node;
      const active = isRangeActive(ranges, from, to);

      switch (node.name) {
        // Заголовки: скрыть «# …» до начала текста.
        case 'ATXHeading1':
        case 'ATXHeading2':
        case 'ATXHeading3':
        case 'ATXHeading4':
        case 'ATXHeading5':
        case 'ATXHeading6': {
          if (!active) {
            const m = /^#{1,6} +/.exec(state.sliceDoc(from, to));
            if (m !== null) hide(from, from + m[0].length);
          }
          break;
        }
        // Цитаты: скрыть «>» (и следующий пробел).
        case 'QuoteMark': {
          if (!active) {
            const extra = state.sliceDoc(to, to + 1) === ' ' ? 1 : 0;
            hide(from, to + extra);
          }
          break;
        }
        // Инлайн-маркеры: * _ ** ~~ `
        case 'EmphasisMark':
        case 'StrikethroughMark':
        case 'CodeMark': {
          if (!active) hide(from, to);
          break;
        }
        // Ссылки: скрыть «(url "title")», оставив видимый текст.
        case 'Link': {
          if (active) break;
          // Дети в координатах поддерева; переводим в координаты документа.
          const urls = node.node.getChildren('URL');
          if (urls.length > 0) {
            const urlFrom = node.from + urls[0]!.from;
            if (urlFrom > from) hide(urlFrom - 1, to);
          }
          break;
        }
        // Целые блоки — виджеты. Дети узла не обрабатываются: диапазоны
        // внутри виджета добавить нельзя (RangeSetBuilder требует сортировку
        // по from/startSide, а у replace-виджетов side другой).
        case 'FencedCode': {
          if (!active) {
            builder.add(
              from,
              to,
              Decoration.replace({
                // Блок занимает несколько строк — обязателен block: true.
                block: true,
                widget: new HtmlWidget(from, to, renderMarkdown(state.sliceDoc(from, to))),
              }),
            );
            return false;
          }
          break;
        }
        case 'Image': {
          if (!active) {
            builder.add(
              from,
              to,
              Decoration.replace({
                widget: new HtmlWidget(from, to, renderMarkdown(state.sliceDoc(from, to))),
              }),
            );
            return false;
          }
          break;
        }
        case 'Table': {
          if (!active) {
            builder.add(
              from,
              to,
              Decoration.replace({
                // Таблица занимает несколько строк — обязателен block: true.
                block: true,
                widget: new HtmlWidget(from, to, renderMarkdown(state.sliceDoc(from, to))),
              }),
            );
            return false;
          }
          break;
        }
        case 'HorizontalRule': {
          if (!active) {
            builder.add(
              from,
              to,
              Decoration.replace({ widget: new HrWidget(from, to) }),
            );
            return false;
          }
          break;
        }
        case 'WikiLink': {
          if (!active) {
            const parsed = wikiLabel(state.sliceDoc(from, to));
            if (parsed !== null) {
              builder.add(
                from,
                to,
                Decoration.replace({
                  widget: new WikiLinkWidget(from, to, parsed.label),
                }),
              );
              return false;
            }
          }
          break;
        }
        default:
          break;
      }
    },
  });

  return builder.finish();
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

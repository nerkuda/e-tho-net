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

import { choiceControl } from '../lib/ui/choice-row.js';
import { isCollapsedHiddenAt, setCollapseEffect } from './comment-collapse.js';
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

/** Чекбокс task-списка (`- [ ]` / `- [x]`): заменяет маркер вне активного пункта. */
class TaskCheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }

  override eq(other: TaskCheckboxWidget): boolean {
    return other.checked === this.checked;
  }

  override toDOM(): HTMLElement {
    // Контрол строит фасад дизайн-системы (сторож `guard-ui-fields`):
    // голый `<input>` в обход `choiceControl` запрещён.
    const input = choiceControl('checkbox', { checked: this.checked, disabled: true });
    input.classList.add('cm-md-task-checkbox');
    return input;
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

/**
 * Распознаёт ID-форму wiki-ссылки (`[[#<uuid>]]` / `[[#<uuid>|<alias>]]` /
 * `[[n:<net>#<uuid>]]` и т.п.). Для таких форм live-preview не ставит свой
 * виджет: имя подтягивает на лету плагин `wikiIdPlugin` (R6), который знает
 * про резолв `etn.thoughts.resolve` и atomic range в edit-mode. Иначе
 * `wikiLabel` отдал бы `target = "#<uuid>"` как label, и пользователь видел
 * бы `#<uuid>` вместо имени мысли.
 */
export function isIdWikiLinkTarget(target: string): boolean {
  if (target.startsWith('#')) {
    const id = target.slice(1).trim();
    // Публикация (0.11.1, задача 3275fd8d): `[[#pub:<uuid>]]` — префиксная
    // ID-форма (ADR 7168009e); виджет рисует `wikiIdPlugin`, не live-preview.
    if (id.startsWith('pub:')) {
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        id.slice('pub:'.length).trim(),
      );
    }
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  }
  if (target.startsWith('n:')) {
    const hashAt = target.indexOf('#', 2);
    if (hashAt === -1) return false;
    const net = target.slice(2, hashAt).trim();
    const id = target.slice(hashAt + 1).trim();
    return (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(net) &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    );
  }
  return false;
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
  const inlineStack: Array<{
    kind: 'link' | 'emphasis' | 'code';
    from: number;
    to: number;
    /** Пустое содержимое пары (`====`, `<u></u>`) — маркеры не скрываются. */
    empty?: boolean;
  }> = [];

  /**
   * Стек пунктов списка: маркер списка (`-`/`N.`) и task-маркер (`[ ]`/`[x]`)
   * «принадлежат» своему `ListItem` — его диапазон задаёт активность обоих.
   */
  const listItemStack: Array<{ from: number; to: number }> = [];

  syntaxTree(state).iterate({
    enter(node) {
      // Внутри тела свёрнутого раздела (задача 634f1412) декорации не строим:
      // их диапазоны пересеклись бы с блок-заменой сворачивания.
      if (isCollapsedHiddenAt(state, node.from)) return false;

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
          // Line-декорация обязана быть нулевой длины (LineDecoration.range
          // бросает RangeError при to !== from): класс применяется к строке,
          // содержащей позицию from — заголовок всегда начинается с её начала.
          parts.push(Decoration.line({ class: `cm-md-h${level}` }).range(from));
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
        // Маркер цитаты: активен, пока каретка внутри её Blockquote. Рамка —
        // line-декорация по одной на строку цитаты, только у внешнего блока
        // (span-класс подсветки обрамлял бы каждый «>» вложенной цитаты).
        case 'QuoteMark': {
          const block = quoteStack[quoteStack.length - 1];
          if (quoteStack.length === 1) {
            // Вертикальные отступы (6px сверху/снизу) — только у первой и
            // последней строки блока: между строками одной цитаты отступа нет,
            // как в просмотре (`styles/editor.css`, `.cm-md-quote-first/-last`).
            const line = state.doc.lineAt(from);
            const classes = ['cm-md-quote-line'];
            if (block !== undefined && line.from === block.from) classes.push('cm-md-quote-first');
            if (block !== undefined && line.to === block.to) classes.push('cm-md-quote-last');
            parts.push(Decoration.line({ class: classes.join(' ') }).range(from));
          }
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
        // ТП1: выделение `==…==` и подчёркивание `<u>…</u>` — инлайн-родители
        // (узлы задаёт `wiki-link.ts`). Содержимое отрисовано всегда, как текст
        // жирного: выделение — фоном, подчёркивание — линией; маркеры скрывает
        // обработка `MarkMark`/`UnderlineMark` ниже (по активности родителя).
        case 'Mark':
        case 'Underline': {
          const openLen = node.name === 'Mark' ? 2 : 3;
          const closeLen = node.name === 'Mark' ? 2 : 4;
          // Пустая пара (`====`, `<u></u>`) в рендерер не проходит — там
          // остаётся литерал (markdown/src/mark.ts, underline.ts). Такой же
          // узел лексера содержимого не имеет: маркеры не скрываем.
          const empty = to - from <= openLen + closeLen;
          inlineStack.push({ kind: 'emphasis', from, to, empty });
          if (!empty) {
            parts.push({
              from: from + openLen,
              to: to - closeLen,
              value: Decoration.mark({
                class: node.name === 'Mark' ? 'cm-md-mark' : 'cm-md-underline',
              }),
            });
          }
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
        case 'MarkMark':
        case 'UnderlineMark':
        case 'CodeMark': {
          const parent = inlineStack[inlineStack.length - 1];
          if (
            parent !== undefined &&
            parent.kind !== 'link' &&
            parent.empty !== true &&
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
        // Пункт списка: его диапазон «владеет» маркером списка (`-`/`N.`) и
        // task-маркером (`[ ]`/`[x]`). Пока каретка внутри пункта или вплотную
        // к нему — исходные маркеры видны; вне — маркер списка скрывается, а
        // task-маркер заменяется чекбоксом (паритет с просмотром и публикацией,
        // где `-` не виден: ошибка 9d611f5f).
        case 'ListItem': {
          listItemStack.push({ from, to });
          break;
        }
        // Маркер списка (`-`, `*`, `+`, `1.`, `1)`): вне активного пункта
        // скрывается вместе с пробелом-разделителем — пункт отрисован как в
        // просмотре. Общий для обычных и task-списков.
        case 'ListMark': {
          const item = listItemStack[listItemStack.length - 1];
          if (item !== undefined && !isNearInline(ranges, item.from, item.to)) {
            const extra = state.sliceDoc(to, to + 1) === ' ' ? 1 : 0;
            hide(from, to + extra);
          }
          break;
        }
        // Task-маркер (`[ ]`/`[x]`): вне активного пункта заменяется чекбоксом.
        // Активность — по диапазону `ListItem` (как у маркера списка), чтобы
        // весь пункт раскрывался исходником одновременно.
        case 'TaskMarker': {
          const item = listItemStack[listItemStack.length - 1];
          if (item !== undefined && !isNearInline(ranges, item.from, item.to)) {
            const checked = /[xX]/.test(state.sliceDoc(from + 1, to - 1));
            parts.push({
              from,
              to,
              value: Decoration.replace({ widget: new TaskCheckboxWidget(checked) }),
            });
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
          // Трансклюзия (восклицательный знак перед скобками) — не wiki-ссылка:
          // её развёртку и виджет ведёт `editor/transclusion.ts` (f72a9134).
          if (from > 0 && state.sliceDoc(from - 1, from) === '!') return false;
          if (!isNearInline(ranges, from, to)) {
            const parsed = wikiLabel(state.sliceDoc(from, to));
            if (parsed !== null) {
              // ID-форма (`[[#<uuid>]]` / `[[n:<net>#<uuid>]]`) — пропускаем
              // live-preview: имя подтягивает на лету `wikiIdPlugin` (R6),
              // который умеет асинхронный резолв и atomic range в edit-mode.
              // Иначе здесь пришлось бы показывать `#<uuid>` как label.
              if (isIdWikiLinkTarget(parsed.target)) return false;
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
        case 'Mark':
        case 'Underline':
        case 'InlineCode':
          inlineStack.pop();
          break;
        case 'ListItem':
          listItemStack.pop();
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
    // Переключение свёрнутости раздела (задача 634f1412) меняет набор
    // пропускаемых узлов — декорации перестраиваются вместе с ним.
    const collapseToggled = tr.effects.some((effect) => effect.is(setCollapseEffect));
    if (tr.docChanged || tr.selection || collapseToggled) return buildDecorations(tr.state);
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * Обработчик `mousedown` виджета live-preview: клик по виджету уводит каретку
 * в диапазон блока — декорации раскрывают исходный markdown.
 *
 * Реагирует только на ОСНОВНУЮ кнопку мыши (`event.button === 0`): правый и
 * средний клик — жесты вызова контекстного меню, они не должны менять
 * выделение и разворачивать виджет (ошибка `87751f42`, тот же класс, что
 * `27b95e60` в `transclusion.ts`). Событие при этом не гасим — `contextmenu`
 * открывает меню поля поверх прежнего состояния. Родной обработчик CM6 на
 * неосновных кнопках выделение не двигает (`view/dist/index.js`:
 * basicMouseSelection — только при `button == 0`).
 */
export function mdWidgetMouseDown(event: MouseEvent, view: EditorView): boolean {
  if (event.button !== 0) return false;
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
}

/** Клик по виджету: каретка в диапазон блока — декорации раскроют исходник. */
export const mdWidgetClick = EditorView.domEventHandlers({
  mousedown: mdWidgetMouseDown,
});

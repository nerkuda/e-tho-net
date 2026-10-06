/**
 * Трансклюзии комментариев в поле markdown (0.12.1, ТП2, задача `f72a9134`;
 * ADR `8c41387c`, ADR `dc1758ad`, ADR `85a7a01e`; элементы интерфейса
 * `7a479549` и `2b116d37`).
 *
 * Узкий клиентский модуль поверх единого рендерера: разбор ссылок и развёртка
 * текста выполняются ТОЛЬКО экспортируемыми функциями `@etn/markdown`
 * (`parseTransclusions`, `expandTransclusions`, `extractSection`) — своего
 * парсера здесь нет (сторож `markdown-single-renderer`). Резолвер источника
 * (постоянный комментарий мысли своей сети) и режимы блока живут здесь.
 *
 * Три режима одной ссылки в редакторе (курсор/выделение решают):
 *  1. **Правка ссылки** — выделение пересекает ссылку: виден исходный markdown,
 *     токен `#<id>` заменён атомарным виджетом с именем мысли (не правится
 *     посимвольно, удаляется целиком), раздел правится посимвольно.
 *  2. **Блок** — выделение вне ссылки: вся ссылка заменена блоком с развёрнутым
 *     текстом источника и кнопкой-всплывашкой смены ссылки.
 *  3. **Ссылка** — блок свёрнут кнопкой: показано имя мысли (клик — вход в
 *     правку). Выход выделения за скобки возвращает блок.
 *
 * За границами задачи (другие работы ТП2): фон по уровням/анимация/неделимость
 * навигации (`a2b68d72`), захват источника (`f59d24e1`), контекстное меню
 * (`955478e8`), realtime-обновление блока.
 */

import type { Completion, CompletionSource } from '@codemirror/autocomplete';
import {
  RangeSet,
  StateEffect,
  StateField,
  type Extension,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import {
  extractSection,
  expandTransclusions,
  parseTransclusions,
  renderMarkdown,
  type TransclusionRef,
  type TransclusionResolution,
} from '@etn/markdown';

import { requireNetworkId } from '../app.js';
import { etn } from '../lib/etn.js';
import { t } from '../lib/i18n.js';
import { iconButton } from '../lib/ui/button.js';
import { svgIcon } from '../lib/ui/icon.js';

/** Корневой класс блока трансклюзии (редактирование). */
export const TRANSCLUSION_BLOCK_CLASS = 'cm-transclusion-block';
/** Класс свёрнутой ссылки трансклюзии. */
export const TRANSCLUSION_LINK_CLASS = 'cm-transclusion-link';
/** Кнопка-всплывашка смены ссылки (правый верхний угол блока). */
export const TRANSCLUSION_CHANGE_CLASS = 'cm-transclusion-change-link';
/** Плашка ошибки источника/раздела. */
export const TRANSCLUSION_ERROR_CLASS = 'cm-transclusion-error';
/** Атомарный токен `#<id>` в режиме правки ссылки. */
export const TRANSCLUSION_ID_CLASS = 'cm-transclusion-id';

/** Длина префикса ссылки — восклицательный знак и две открывающие скобки. */
const OPEN_LEN = 3;

/** Контекст каретки внутри ссылки трансклюзии. */
export interface TransclusionContext {
  /** Разобранная ссылка (диапазон содержит каретку). */
  ref: TransclusionRef;
  /** Начало токена `#<id>` (сам `#`). */
  idFrom: number;
  /** Конец токена `#<id>` (исключительно). */
  idTo: number;
  /** Начало текста раздела (после второго `#`), либо `null`. */
  sectionFrom: number | null;
  /** Конец текста раздела (перед `]]`), либо `null`. */
  sectionTo: number | null;
  /** Каретка в токене `#<id>`. */
  inId: boolean;
  /** Каретка в тексте раздела. */
  inSection: boolean;
}

/** Находит ссылку трансклюзии, содержащую позицию, и размечает её части. */
export function transclusionAtCaret(source: string, pos: number): TransclusionContext | null {
  for (const ref of parseTransclusions(source)) {
    if (pos < ref.start || pos > ref.end) continue;
    const idFrom = ref.start + OPEN_LEN; // на `#`
    const innerEnd = ref.end - 2; // перед `]]`
    const hash2 = source.indexOf('#', idFrom + 1);
    const hasSection = ref.section !== null && hash2 !== -1 && hash2 < innerEnd;
    const idTo = hasSection ? hash2 : innerEnd;
    return {
      ref,
      idFrom,
      idTo,
      sectionFrom: hasSection ? hash2 + 1 : null,
      sectionTo: hasSection ? innerEnd : null,
      inId: pos >= idFrom && pos <= idTo,
      inSection: hasSection && pos >= hash2 + 1 && pos <= innerEnd,
    };
  }
  return null;
}

/** ATX-заголовок: уровень и текст (закрывающие `#` срезаны). */
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;

/**
 * Заголовки источника по порядку (для выпадашки разделов). Лёгкий обзор
 * заголовков markdown-текста — не разбор трансклюзий; повторяющиеся имена
 * схлопываются (при резолве берётся первый).
 */
export function listSectionTitles(bodyMd: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of bodyMd.split('\n')) {
    const m = HEADING_RE.exec(line.endsWith('\r') ? line.slice(0, -1) : line);
    if (m === null) continue;
    const title = m[2]!.trim();
    if (title === '' || seen.has(title)) continue;
    seen.add(title);
    out.push(title);
  }
  return out;
}

/** Метка ссылки в свёрнутом виде: имя мысли и, при наличии, раздел. */
export function transclusionLinkLabel(title: string, section: string | null): string {
  const name = title !== '' ? title : t('comment.transclusion.untitled');
  return section === null ? name : `${name} · ${section}`;
}

/** Ключ кэша данных ссылки (сеть + источник + раздел). */
export function transclusionCacheKey(networkId: string, ref: TransclusionRef): string {
  return `${networkId}:${ref.sourceId}#${ref.section ?? ''}`;
}

/** Загруженный источник: имя мысли, наличие и полный текст постоянного комментария. */
export interface TransclusionSource {
  found: boolean;
  title: string;
  body_md: string;
}

/** Разрешение источника по id (инжектируемая зависимость для тестов). */
export type TransclusionSourceLoader = (sourceId: string) => Promise<TransclusionSource | null>;

/** Источник не найден — плашка «нет источника трансклюзии». */
type TransclusionError = 'source' | 'section' | null;

/** Данные одной ссылки для отрисовки. */
export interface TransclusionEntry {
  title: string;
  exists: boolean;
  error: TransclusionError;
  /** Отрендеренный HTML развёрнутого текста, либо `null` при ошибке. */
  html: string | null;
}

/** Загрузчик источника по умолчанию — постоянный комментарий мысли своей сети. */
export function defaultTransclusionLoader(networkId: string): TransclusionSourceLoader {
  return async (sourceId) => {
    try {
      const [refs, comments] = await Promise.all([
        etn.thoughts.resolve(networkId, [sourceId]),
        etn.comments.list(networkId, 'thought', sourceId),
      ]);
      const title = refs.find((r) => r.id === sourceId)?.title ?? '';
      const permanent = comments.find((c) => c.kind === 'permanent');
      if (permanent === undefined) return { found: false, title, body_md: '' };
      return { found: true, title, body_md: permanent.body_md };
    } catch {
      return null;
    }
  };
}

/**
 * Разворачивает текст ссылки, итеративно дозагружая источники. Рекурсия,
 * глубина (5) и защита от циклов — внутри `expandTransclusions`
 * (`@etn/markdown`); здесь лишь наполняем резолвер текстами и повторяем
 * развёртку, пока остаются неизвестные источники.
 */
async function expandWithLoader(
  raw: string,
  load: TransclusionSourceLoader,
): Promise<{ text: string; top: TransclusionSource | null }> {
  const bodies = new Map<string, string | null>();
  const topId = parseTransclusions(raw)[0]?.sourceId ?? null;
  let text = raw;
  for (let round = 0; round < 8; round += 1) {
    const pending = new Set<string>();
    const resolver = (id: string): TransclusionResolution => {
      if (!bodies.has(id)) {
        pending.add(id);
        return { found: false, body_md: '' };
      }
      const body = bodies.get(id);
      return body === null || body === undefined
        ? { found: false, body_md: '' }
        : { found: true, body_md: body };
    };
    text = expandTransclusions(raw, resolver);
    if (pending.size === 0) break;
    const fetched = await Promise.all(
      [...pending].map(async (id): Promise<readonly [string, string | null]> => {
        const src = await load(id);
        return [id, src !== null && src.found ? src.body_md : null] as const;
      }),
    );
    for (const [id, body] of fetched) bodies.set(id, body);
  }
  const top = topId === null ? null : await load(topId);
  return { text, top };
}

/** Строит данные ссылки для отрисовки (развёртка и состояния ошибок). */
async function loadEntry(
  ref: TransclusionRef,
  load: TransclusionSourceLoader,
): Promise<TransclusionEntry> {
  const { text, top } = await expandWithLoader(ref.raw, load);
  const title = top?.title ?? '';
  if (top === null || !top.found) {
    return { title, exists: false, error: 'source', html: null };
  }
  if (ref.section !== null && extractSection(top.body_md, ref.section) === null) {
    return { title, exists: true, error: 'section', html: null };
  }
  return { title, exists: true, error: null, html: renderMarkdown(text) };
}

/* ------------------------------------------------------------------ *
 * Декорации CM6
 * ------------------------------------------------------------------ */

/** Эффект установки/снятия свёрнутости ссылки (кнопка смены ссылки). */
const setCollapsed = StateEffect.define<{ key: string; collapsed: boolean }>();

/** Эффект наполнения кэша данными ссылок. */
const setEntries = StateEffect.define<Array<{ key: string; entry: TransclusionEntry }>>();

/** Состояние плагина: кэш данных, свёрнутые ссылки, декорации и атомарные токены. */
interface TransclusionStateData {
  networkId: string | null;
  cache: Map<string, TransclusionEntry>;
  collapsed: Set<string>;
  deco: DecorationSet;
  atomic: RangeSet<Decoration>;
}

/** Атомарный виджет токена `#<id>` в режиме правки ссылки. */
class TransclusionIdWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly deleted: boolean,
  ) {
    super();
  }

  override eq(other: TransclusionIdWidget): boolean {
    return other.label === this.label && other.deleted === this.deleted;
  }

  override toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = `${TRANSCLUSION_ID_CLASS}${this.deleted ? ' wiki-link-deleted' : ''}`;
    span.contentEditable = 'false';
    span.textContent = this.label;
    return span;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/** Свёрнутая ссылка: имя мысли (раздел — уточнением), клик — вход в правку. */
class TransclusionLinkWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly label: string,
    readonly deleted: boolean,
  ) {
    super();
  }

  override eq(other: TransclusionLinkWidget): boolean {
    return (
      other.from === this.from &&
      other.to === this.to &&
      other.label === this.label &&
      other.deleted === this.deleted
    );
  }

  override toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = `${TRANSCLUSION_LINK_CLASS}${this.deleted ? ' wiki-link-deleted' : ''}`;
    span.dataset.mdFrom = String(this.from);
    span.dataset.mdTo = String(this.to);
    span.textContent = this.label;
    return span;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/** Блок трансклюзии с развёрнутым текстом и кнопкой-всплывашкой смены ссылки. */
class TransclusionBlockWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly entry: TransclusionEntry,
    readonly key: string,
  ) {
    super();
  }

  override eq(other: TransclusionBlockWidget): boolean {
    return (
      other.from === this.from &&
      other.to === this.to &&
      other.key === this.key &&
      other.entry.html === this.entry.html &&
      other.entry.error === this.entry.error &&
      other.entry.title === this.entry.title &&
      other.entry.exists === this.entry.exists
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('div');
    // Без класса `md-widget`: его клик обрабатывает mdWidgetClick (md-live.ts),
    // иначе было бы двойное перемещение каретки.
    box.className = `${TRANSCLUSION_BLOCK_CLASS} comment-view`;
    box.dataset.mdFrom = String(this.from);
    box.dataset.mdTo = String(this.to);

    if (this.entry.error !== null) {
      const err = document.createElement('div');
      err.className = TRANSCLUSION_ERROR_CLASS;
      err.textContent =
        this.entry.error === 'source'
          ? t('comment.transclusion.noSource')
          : t('comment.transclusion.noSection');
      box.append(err);
      return box;
    }

    const button = iconButton({
      icon: svgIcon('link-edit', 12),
      role: 'ghost',
      size: 's',
      title: t('comment.transclusion.changeLink'),
      class: TRANSCLUSION_CHANGE_CLASS,
      onClick: () => {
        view.dispatch({ effects: setCollapsed.of({ key: this.key, collapsed: true }) });
      },
    });
    button.addEventListener('mousedown', (event) => event.preventDefault());
    box.append(button);

    const body = document.createElement('div');
    body.innerHTML = this.entry.html ?? '';
    box.append(body);
    return box;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/** Пересекается ли выделение с диапазоном ссылки. */
function intersects(
  selection: { from: number; to: number },
  from: number,
  to: number,
): boolean {
  return selection.from < to && selection.to > from;
}

/** Строит декорации и атомарные диапазоны для текущего состояния. */
export function buildTransclusionDecorations(
  source: string,
  selection: { from: number; to: number },
  cache: Map<string, TransclusionEntry>,
  networkId: string | null,
  collapsed: Set<string>,
): { deco: DecorationSet; atomic: RangeSet<Decoration> } {
  const parts: Array<{ from: number; to: number; value: Decoration }> = [];
  const atomParts: Array<{ from: number; to: number; value: Decoration }> = [];
  const refs = parseTransclusions(source);

  for (const ref of refs) {
    const idFrom = ref.start + OPEN_LEN;
    const innerEnd = ref.end - 2;
    const hash2 = source.indexOf('#', idFrom + 1);
    const idTo = hash2 !== -1 && hash2 < innerEnd ? hash2 : innerEnd;
    const key = networkId === null ? null : transclusionCacheKey(networkId, ref);
    const entry = key === null ? undefined : cache.get(key);
    const title = entry?.title ?? '';
    const deleted = entry !== undefined && !entry.exists;

    if (intersects(selection, ref.start, ref.end)) {
      // Режим правки ссылки: токен `#<id>` — атомарный виджет с именем мысли;
      // раздел остаётся редактируемым текстом.
      const label = title !== '' ? title : '…';
      atomParts.push({ from: idFrom, to: idTo, value: Decoration.mark({}) });
      parts.push({
        from: idFrom,
        to: idTo,
        value: Decoration.replace({
          widget: new TransclusionIdWidget(label, deleted),
          inclusive: false,
        }),
      });
      continue;
    }

    if (key !== null && collapsed.has(key)) {
      parts.push({
        from: ref.start,
        to: ref.end,
        value: Decoration.replace({
          widget: new TransclusionLinkWidget(
            ref.start,
            ref.end,
            transclusionLinkLabel(title, ref.section),
            deleted,
          ),
          inclusive: false,
        }),
      });
      continue;
    }

    parts.push({
      from: ref.start,
      to: ref.end,
      value: Decoration.replace({
        block: true,
        widget: new TransclusionBlockWidget(ref.start, ref.end, entry ?? emptyEntry(), key ?? ''),
        inclusive: false,
      }),
    });
  }

  return { deco: Decoration.set(parts, true), atomic: RangeSet.of(atomParts, true) };
}

/** Заглушка данных до загрузки источника. */
function emptyEntry(): TransclusionEntry {
  return { title: '', exists: true, error: null, html: '' };
}

/** Поле состояния: кэш, свёрнутые ссылки, декорации и атомарные токены. */
export const transclusionState = StateField.define<TransclusionStateData>({
  create: (state) => {
    const networkId = safeNetwork();
    const { deco, atomic } = buildTransclusionDecorations(
      state.doc.toString(),
      state.selection.main,
      new Map(),
      networkId,
      new Set(),
    );
    return { networkId, cache: new Map(), collapsed: new Set(), deco, atomic };
  },
  update(state, tr) {
    let networkId = state.networkId;
    let cache = state.cache;
    // Смена выделения возвращает блок из свёрнутого вида («выход за скобки —
    // снова текст блока»), кроме собственных эффектов кнопки смены ссылки.
    let collapsed = !tr.state.selection.eq(tr.startState.selection)
      ? new Set<string>()
      : state.collapsed;
    for (const effect of tr.effects) {
      if (effect.is(setCollapsed)) {
        collapsed = new Set(collapsed);
        if (effect.value.collapsed) collapsed.add(effect.value.key);
        else collapsed.delete(effect.value.key);
      } else if (effect.is(setEntries)) {
        if (cache === state.cache) cache = new Map(cache);
        for (const { key, entry } of effect.value) cache.set(key, entry);
      }
    }
    const currentNetwork = safeNetwork();
    if (currentNetwork !== null && currentNetwork !== networkId) networkId = currentNetwork;

    if (
      !tr.docChanged &&
      !tr.selection &&
      cache === state.cache &&
      collapsed === state.collapsed &&
      networkId === state.networkId
    ) {
      return state;
    }
    const { deco, atomic } = buildTransclusionDecorations(
      tr.state.doc.toString(),
      tr.state.selection.main,
      cache,
      networkId,
      collapsed,
    );
    return { networkId, cache, collapsed, deco, atomic };
  },
  provide: (f) => EditorView.decorations.from(f, (s) => s.deco),
});

/** Атомарные токены `#<id>` в режиме правки ссылки. */
export const transclusionAtomicRanges = EditorView.atomicRanges.of((view) => {
  const state = view.state.field(transclusionState, false);
  return state === undefined ? RangeSet.empty : state.atomic;
});

/** Клики по блоку/ссылке: вход в правку ссылки; кнопка обрабатывает себя сама. */
export const transclusionClick = EditorView.domEventHandlers({
  mousedown: (event, view) => {
    const target = event.target as Element | null;
    // Кнопка смены ссылки: не трогаем курсор, событие обработает кнопка.
    if (target !== null && target.closest(`.${TRANSCLUSION_CHANGE_CLASS}`) !== null) return true;
    const el = target?.closest?.(`.${TRANSCLUSION_BLOCK_CLASS}, .${TRANSCLUSION_LINK_CLASS}`);
    if (!(el instanceof HTMLElement)) return false;
    const from = Number(el.dataset.mdFrom);
    const to = Number(el.dataset.mdTo);
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

/** Плагин: догружает источники ссылок документа и наполняет кэш состояния. */
const transclusionLoader = ViewPlugin.fromClass(
  class {
    inflight = false;

    constructor(readonly view: EditorView) {
      this.schedule();
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.selectionSet) this.schedule();
    }

    schedule(): void {
      if (this.inflight) return;
      const state = this.view.state.field(transclusionState, false);
      if (state === undefined) return;
      const networkId = state.networkId ?? safeNetwork();
      if (networkId === null) return;
      const source = this.view.state.doc.toString();
      const todo = parseTransclusions(source).filter(
        (ref) => !state.cache.has(transclusionCacheKey(networkId, ref)),
      );
      if (todo.length === 0) return;
      this.inflight = true;
      const load = defaultTransclusionLoader(networkId);
      void Promise.all(
        todo.map(async (ref) => ({
          key: transclusionCacheKey(networkId, ref),
          entry: await loadEntry(ref, load).catch(emptyEntry),
        })),
      )
        .then((entries) => {
          this.view.dispatch({ effects: setEntries.of(entries) });
        })
        .finally(() => {
          this.inflight = false;
        });
    }
  },
);

/* ------------------------------------------------------------------ *
 * Автокомплит разделов
 * ------------------------------------------------------------------ */

/** Кэш заголовков источника по id (живёт в рамках сессии редактора). */
const sectionTitlesCache = new Map<string, string[]>();

/**
 * Источник подсказок «разделы источника» (для общего автокомплита wiki-ссылок):
 * активен, когда каретка стоит в тексте раздела ссылки трансклюзии.
 */
export function transclusionSectionCompletions(): CompletionSource {
  return async (context) => {
    const ctx = transclusionAtCaret(context.state.doc.toString(), context.pos);
    if (ctx === null || !ctx.inSection || ctx.sectionFrom === null) return null;
    const networkId = safeNetwork();
    if (networkId === null) return null;
    const cacheKey = `${networkId}:${ctx.ref.sourceId}`;
    let titles = sectionTitlesCache.get(cacheKey);
    if (titles === undefined) {
      const load = defaultTransclusionLoader(networkId);
      const src = await load(ctx.ref.sourceId).catch(() => null);
      titles = src !== null && src.found ? listSectionTitles(src.body_md) : [];
      sectionTitlesCache.set(cacheKey, titles);
    }
    const prefix = context.state.sliceDoc(ctx.sectionFrom, context.pos).toLowerCase();
    const options: Completion[] = titles
      .filter((title) => title.toLowerCase().startsWith(prefix))
      .map((title) => ({ label: title, apply: title, type: 'text' }));
    if (options.length === 0) return null;
    return {
      from: ctx.sectionFrom,
      to: context.pos,
      options,
      validFor: /^[^\]\n#]*$/,
    };
  };
}

/** Все расширения трансклюзий редактора, для `md-editor.ts`. */
export const transclusionExtensions: Extension[] = [
  transclusionState,
  transclusionLoader,
  transclusionAtomicRanges,
  transclusionClick,
];

/** Текущая сеть или `null` (список сетей / ранний доступ). */
function safeNetwork(): string | null {
  try {
    return requireNetworkId();
  } catch {
    return null;
  }
}

/** Тестовый шов: чистые функции и сборка декораций. */
export const transclusionInternals = {
  buildTransclusionDecorations,
  expandWithLoader,
  loadEntry,
  emptyEntry,
  setCollapsed,
  setEntries,
};

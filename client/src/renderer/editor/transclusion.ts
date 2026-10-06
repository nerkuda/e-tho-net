/**
 * Трансклюзии комментариев в поле markdown (0.12.1, ТП2, задачи `f72a9134`,
 * `f59d24e1` и `a2b68d72`; ADR `8c41387c`, ADR `dc1758ad`, ADR `85a7a01e`,
 * ADR `fdb1a271`, ADR `c425202a`; элементы интерфейса `7a479549` и `2b116d37`;
 * требования `647fa34a`, `29a3c17a`, `fc60d763`).
 *
 * Узкий клиентский модуль поверх единого рендерера: разбор ссылок и развёртка
 * текста выполняются ТОЛЬКО экспортируемыми функциями `@etn/markdown`
 * (`parseTransclusions`, `expandTransclusions`, `extractSection`) — своего
 * парсера здесь нет (сторож `markdown-single-renderer`). Резолвер источника
 * (постоянный комментарий мысли своей сети) и режимы блока живут здесь.
 *
 * **Правка блока и захват источника (задача `f59d24e1`).** Двойной клик по
 * блоку или Enter при каретке внутри ссылки переводят блок в режим правки
 * (`setBlockEdit`); с этого момента на мысль-источник ставится захват
 * существующим механизмом `lib/lock-guard.ts` (`/locks`, `edit.*`) и
 * снимается при выходе (Esc, кнопки «Отменить/Сохранить трансклюзию» под
 * полем). Чужой захват даёт на блоке «замочек» 🔒 и в правку не пускает.
 * Сама запись изменений в источник — задача `e2c14673` (граница).
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
 * **Визуальные слои блока (задача `a2b68d72`).** Развёрнутый текст рендерится с
 * блочными обёртками `@etn/markdown` (`data-transclusion-depth`), поэтому фон
 * подкрашивается по уровню вложенности (ADR `c425202a`), а плашки ошибок
 * источника приходят из рендера (`fc60d763`). Блок неделим при навигации:
 * замена идёт блоком на весь диапазон ссылки, а клик по блоку не ставит каретку
 * внутрь (правка ссылки — кнопкой смены ссылки, правка блока — двойным кликом).
 * Появление/раскрытие блока анимировано (CSS, с учётом `prefers-reduced-motion`).
 * Просмотр поля (view-режим) разворачивает ссылки через `renderTransclusionView`.
 *
 * За границами задачи (другие работы ТП2): контекстное меню (`955478e8`), запись
 * изменений блока в источник (`e2c14673`), realtime-обновление блока,
 * свёрнутость разделов внутри трансклюзий (`1b405a92`).
 */

import {
  completionStatus,
  type Completion,
  type CompletionSource,
} from '@codemirror/autocomplete';
import {
  EditorState,
  Facet,
  Prec,
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
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import {
  extractSection,
  expandTransclusions,
  parseTransclusions,
  renderMarkdown,
  type TransclusionLabels,
  type TransclusionRef,
  type TransclusionResolution,
} from '@etn/markdown';

import { requireNetworkId } from '../app.js';
import { etn } from '../lib/etn.js';
import { t } from '../lib/i18n.js';
import { holderName, otherHolder, subscribeLockCache } from '../lib/lock-cache.js';
import {
  acquireOrShowBlocked,
  lockHandleFromOutcome,
  releaseHeld,
  type LockHandle,
} from '../lib/lock-guard.js';
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
/** Блок в режиме правки (рамка как у облачка, задача f59d24e1). */
export const TRANSCLUSION_EDITING_CLASS = 'cm-transclusion-block--editing';
/** «Замочек» блока при чужом захвате источника (задача f59d24e1). */
export const TRANSCLUSION_LOCK_CLASS = 'cm-transclusion-lock';

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

/**
 * Локализованные подписи контейнеров трансклюзий (задача `a2b68d72`): единый
 * рендерер оборачивает развёрнутые фрагменты блоками (глубина/ошибки), а текст
 * ошибок даёт клиент через `t()` — рендерер строк не знает.
 */
export function transclusionLabels(): TransclusionLabels {
  return {
    noSource: t('comment.transclusion.noSource'),
    noSection: t('comment.transclusion.noSection'),
    skipped: t('comment.transclusion.skipped'),
  };
}

/** Отрисовка развёрнутого markdown с блочными обёртками трансклюзий. */
export function renderTransclusionMarkdown(text: string): string {
  return renderMarkdown(text, { transclusion: { labels: transclusionLabels() } });
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
  return { title, exists: true, error: null, html: renderTransclusionMarkdown(text) };
}

/**
 * Готовит HTML просмотра (view-режим поля) для markdown с трансклюзиями
 * (задача `a2b68d72`): разворачивает ссылки через общий загрузчик и отдаёт
 * HTML с блочными обёртками (глубина, ошибки). `null` — трансклюзий в тексте
 * нет, вызывающий оставляет прежний путь рендера. Экспортируется для тестов.
 */
export async function renderTransclusionView(
  md: string,
  networkId: string,
  load: TransclusionSourceLoader = defaultTransclusionLoader(networkId),
): Promise<string | null> {
  if (md.trim() === '' || parseTransclusions(md).length === 0) return null;
  const { text } = await expandWithLoader(md, load);
  return renderTransclusionMarkdown(text);
}

/* ------------------------------------------------------------------ *
 * Декорации CM6
 * ------------------------------------------------------------------ */

/** Эффект установки/снятия свёрнутости ссылки (кнопка смены ссылки). */
const setCollapsed = StateEffect.define<{ key: string; collapsed: boolean }>();

/** Эффект наполнения кэша данными ссылок. */
const setEntries = StateEffect.define<Array<{ key: string; entry: TransclusionEntry }>>();

/**
 * Эффект режима правки блока трансклюзии (задача `f59d24e1`): значение —
 * id мысли-источника, в правку которого входит пользователь, либо `null` для
 * выхода. Захват источника ставится/снимается плагином по смене значения.
 */
export const setBlockEdit = StateEffect.define<string | null>();

/** Эффект обновления карты чужих захватов источников (`sourceId` → имя). */
const setLockedSources = StateEffect.define<ReadonlyMap<string, string>>();

/** Состояние плагина: кэш данных, свёрнутые ссылки, декорации и атомарные токены. */
interface TransclusionStateData {
  networkId: string | null;
  cache: Map<string, TransclusionEntry>;
  collapsed: Set<string>;
  /** Источник в режиме правки блока, либо `null` (задача f59d24e1). */
  editingSourceId: string | null;
  /** Чужие захваты источников: `sourceId` → имя держателя (задача f59d24e1). */
  lockedSources: ReadonlyMap<string, string>;
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
    /** Источник блока — для «замочка» и входа в правку. */
    readonly sourceId: string,
    /** Блок в режиме правки (задача f59d24e1). */
    readonly editing: boolean,
    /** Имя чужого держателя захвата источника, либо `null` (задача f59d24e1). */
    readonly lockedBy: string | null,
  ) {
    super();
  }

  override eq(other: TransclusionBlockWidget): boolean {
    return (
      other.from === this.from &&
      other.to === this.to &&
      other.key === this.key &&
      other.sourceId === this.sourceId &&
      other.editing === this.editing &&
      other.lockedBy === this.lockedBy &&
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
    box.className =
      `${TRANSCLUSION_BLOCK_CLASS} comment-view` +
      (this.editing ? ` ${TRANSCLUSION_EDITING_CLASS}` : '');
    box.dataset.mdFrom = String(this.from);
    box.dataset.mdTo = String(this.to);
    box.dataset['transclusionSource'] = this.sourceId;

    // «Замочек» при чужом захвате источника (требование 647fa34a): источник
    // правит другой участник — вход в правку блока заблокирован.
    if (this.lockedBy !== null) {
      const badge = document.createElement('span');
      badge.className = TRANSCLUSION_LOCK_CLASS;
      badge.textContent = '🔒';
      badge.title = t('comment.transclusion.locked', this.lockedBy);
      box.append(badge);
    }

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

    // В режиме правки кнопка смены ссылки скрыта: сначала выходят из правки.
    if (!this.editing) {
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
    }

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

/** Пустая карта чужих захватов (значение по умолчанию). */
const NO_LOCKS: ReadonlyMap<string, string> = new Map();

/** Строит декорации и атомарные диапазоны для текущего состояния. */
export function buildTransclusionDecorations(
  source: string,
  selection: { from: number; to: number },
  cache: Map<string, TransclusionEntry>,
  networkId: string | null,
  collapsed: Set<string>,
  /** Источник в режиме правки блока, либо `null` (задача f59d24e1). */
  editingSourceId: string | null = null,
  /** Чужие захваты источников: `sourceId` → имя держателя (задача f59d24e1). */
  lockedSources: ReadonlyMap<string, string> = NO_LOCKS,
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
    const lockedBy = lockedSources.get(ref.sourceId) ?? null;

    // Режим правки блока перекрывает прочие режимы: блок остаётся блоком даже
    // при каретке внутри ссылки (задача f59d24e1).
    if (editingSourceId !== null && editingSourceId === ref.sourceId) {
      parts.push({
        from: ref.start,
        to: ref.end,
        value: Decoration.replace({
          block: true,
          widget: new TransclusionBlockWidget(
            ref.start,
            ref.end,
            entry ?? emptyEntry(),
            key ?? '',
            ref.sourceId,
            true,
            lockedBy,
          ),
          inclusive: false,
        }),
      });
      continue;
    }

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
        widget: new TransclusionBlockWidget(
          ref.start,
          ref.end,
          entry ?? emptyEntry(),
          key ?? '',
          ref.sourceId,
          false,
          lockedBy,
        ),
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

/** Поле состояния: кэш, свёрнутые ссылки, режим правки, захваты, декорации. */
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
    return {
      networkId,
      cache: new Map(),
      collapsed: new Set(),
      editingSourceId: null,
      lockedSources: NO_LOCKS,
      deco,
      atomic,
    };
  },
  update(state, tr) {
    let networkId = state.networkId;
    let cache = state.cache;
    let editingSourceId = state.editingSourceId;
    let lockedSources = state.lockedSources;
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
      } else if (effect.is(setBlockEdit)) {
        editingSourceId = effect.value;
        // Вход в правку блока и выход из неё — всегда развёрнутое состояние.
        if (collapsed.size > 0) collapsed = new Set();
      } else if (effect.is(setLockedSources)) {
        lockedSources = effect.value;
      }
    }
    const currentNetwork = safeNetwork();
    if (currentNetwork !== null && currentNetwork !== networkId) networkId = currentNetwork;

    if (
      !tr.docChanged &&
      !tr.selection &&
      cache === state.cache &&
      collapsed === state.collapsed &&
      editingSourceId === state.editingSourceId &&
      lockedSources === state.lockedSources &&
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
      editingSourceId,
      lockedSources,
    );
    return { networkId, cache, collapsed, editingSourceId, lockedSources, deco, atomic };
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
    const block = target?.closest?.(`.${TRANSCLUSION_BLOCK_CLASS}`);
    if (block instanceof HTMLElement) {
      // Неделимость блока при навигации мышью (задача a2b68d72, требование
      // 29a3c17a/элемент 2b116d37): клик по блоку НЕ ставит каретку внутрь
      // ссылки — блок остаётся целым (иначе он распадался бы в исходный
      // markdown и стрелки шли бы сквозь него). Правка ссылки — кнопкой
      // смены ссылки (свёрнутая ссылка), правка блока — двойным кликом/Enter.
      return true;
    }
    const el = target?.closest?.(`.${TRANSCLUSION_LINK_CLASS}`);
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

/* ------------------------------------------------------------------ *
 * Режим правки блока и захват источника (задача f59d24e1)
 * ------------------------------------------------------------------ */

/**
 * Хост поля комментария: уведомление о входе/выходе из правки блока. Поле
 * подменяет кнопки под полем на «Отменить/Сохранить трансклюзию»
 * (элемент интерфейса `2b116d37`). Фасет необязателен — без хоста режим
 * правки работает, но кнопки поля не переключаются.
 */
export interface TransclusionEditHost {
  /** Режим правки блока включён (`true`) или выключен (`false`). */
  onBlockEditChange(editing: boolean): void;
}

/** Фасет хоста поля: единственное значение (последнее — при нескольких). */
const transclusionEditHostFacet = Facet.define<TransclusionEditHost, TransclusionEditHost | null>({
  combine: (values) => values[values.length - 1] ?? null,
});

/** Расширение-хост для поля: уведомляет о входе/выходе из правки блока. */
export function transclusionEditHostExtension(host: TransclusionEditHost): Extension {
  return transclusionEditHostFacet.of(host);
}

/** Идентификатор источника в ссылке под позицией `pos`, либо `null`. */
function transclusionSourceAt(view: EditorView, pos: number): string | null {
  return transclusionAtCaret(view.state.doc.toString(), pos)?.ref.sourceId ?? null;
}

/** Выход из режима правки блока трансклюзии (кнопки/Esc; записи нет — e2c14673). */
export function exitBlockEdit(view: EditorView): void {
  view.dispatch({ effects: setBlockEdit.of(null) });
}

/** Вход в режим правки блока: двойной клик и Enter (элемент `2b116d37`). */
export const transclusionEditGestures = [
  Prec.high(
    keymap.of([
      {
        key: 'Enter',
        run: (view) => {
          // Открытый автокомплит (мысли/разделы) обрабатывает Enter сам.
          if (completionStatus(view.state) === 'active') return false;
          const editing = view.state.field(transclusionState, false)?.editingSourceId ?? null;
          // Внутри правки блока Enter не вставляет перевод строки (запись — e2c14673).
          if (editing !== null) return true;
          const sourceId = transclusionSourceAt(view, view.state.selection.main.head);
          if (sourceId === null) return false;
          view.dispatch({ effects: setBlockEdit.of(sourceId) });
          return true;
        },
      },
      {
        key: 'Escape',
        run: (view) => {
          // Открытый автокомплит закрывает Escape сам.
          if (completionStatus(view.state) === 'active') return false;
          const editing = view.state.field(transclusionState, false)?.editingSourceId ?? null;
          // Esc в правке блока выходит из неё, не отменяя правку всего поля.
          if (editing === null) return false;
          exitBlockEdit(view);
          return true;
        },
      },
    ]),
  ),
  EditorView.domEventHandlers({
    dblclick: (event, view) => {
      const coords = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (coords === null) return false;
      const sourceId = transclusionSourceAt(view, coords);
      if (sourceId === null) return false;
      const editing = view.state.field(transclusionState, false)?.editingSourceId ?? null;
      if (editing === sourceId) return true;
      view.dispatch({ effects: setBlockEdit.of(sourceId) });
      return true;
    },
  }),
] as const;

/** Сравнивает карты чужих захватов (чтобы не слать лишние транзакции). */
function sameLockMap(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

/**
 * Плагин режима правки блока: держит захват мысли-источника, пока блок в
 * правке (существующий механизм `lib/lock-guard.ts`, ADR `fdb1a271`), и ведёт
 * карту чужих захватов для «замочка» (требование `647fa34a`). Сама запись в
 * источник — задача `e2c14673`.
 */
const transclusionEditPlugin = ViewPlugin.fromClass(
  class {
    handle: LockHandle | null = null;
    source: string | null = null;
    host: TransclusionEditHost | null = null;
    disposed = false;
    /** Пересбор карты захватов уже запланирована (микрозадача). */
    locksScheduled = false;
    unsubscribe: () => void;

    constructor(readonly view: EditorView) {
      this.unsubscribe = subscribeLockCache(() => this.refreshLocks());
      this.refreshLocks();
      this.sync(this.view.state);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged) this.refreshLocks();
      const before = update.startState.field(transclusionState, false)?.editingSourceId ?? null;
      const after = update.state.field(transclusionState, false)?.editingSourceId ?? null;
      if (before !== after) this.sync(update.state);
    }

    /** Карта чужих захватов источников текущего документа. */
    computeLocks(): Map<string, string> {
      const next = new Map<string, string>();
      for (const ref of parseTransclusions(this.view.state.doc.toString())) {
        const row = otherHolder('thought', ref.sourceId);
        if (row !== null) next.set(ref.sourceId, holderName(row));
      }
      return next;
    }

    /**
     * Пересобирает карту чужих захватов источников документа. Диспатч
     * откладывается в микрозадачу: плагин может вызываться из `update()`, где
     * синхронный `dispatch` запрещён.
     */
    refreshLocks(): void {
      if (this.disposed || this.locksScheduled) return;
      this.locksScheduled = true;
      queueMicrotask(() => {
        this.locksScheduled = false;
        if (this.disposed) return;
        const state = this.view.state.field(transclusionState, false);
        if (state === undefined) return;
        const next = this.computeLocks();
        if (sameLockMap(state.lockedSources, next)) return;
        this.view.dispatch({ effects: setLockedSources.of(next) });
      });
    }

    /** Реагирует на смену источника в правке: захват нового, снятие старого. */
    sync(state: EditorState): void {
      const next = state.field(transclusionState, false)?.editingSourceId ?? null;
      this.host = state.facet(transclusionEditHostFacet);
      if (next === this.source) return;
      releaseHeld(this.handle);
      this.handle = null;
      this.source = next;
      this.host?.onBlockEditChange(next !== null);
      if (next === null) return;
      const source = next;
      void acquireOrShowBlocked('thought', source).then((outcome) => {
        if (this.disposed || this.source !== source) return;
        this.handle = lockHandleFromOutcome('thought', source, outcome);
        if (outcome.kind === 'blocked') {
          // Источник держит другой участник — в правку не входим, «замочек» уже
          // показан картой захватов (lock-guard сам уведомил пользователя).
          this.view.dispatch({ effects: setBlockEdit.of(null) });
          this.refreshLocks();
        }
      });
    }

    destroy(): void {
      this.disposed = true;
      this.unsubscribe();
      releaseHeld(this.handle);
      this.handle = null;
      this.host?.onBlockEditChange(false);
    }
  },
);

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
  ...transclusionEditGestures,
  transclusionEditPlugin,
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

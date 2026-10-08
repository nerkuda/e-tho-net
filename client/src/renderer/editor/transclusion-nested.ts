/**
 * Тонкий компонент «вложенный редактор блока трансклюзии» (0.12.1, ТП
 * `fcde7c55` «Живой блок трансклюзии — сплошная правка в одном окне», задача
 * `73ae1d4b`; ADR `f3adf3d3`).
 *
 * Блок-виджет лениво монтирует ВНУТРИ себя отдельный `EditorView` CodeMirror 6
 * на том же стеке расширений, что и поле-контейнер ({@link mdEditorExtensions})
 * — со своим `EditorState` и собственной историей undo (ADR `f3adf3d3`,
 * решение 1/3). Печать идёт в документ вложенного редактора и НЕ меняет
 * документ контейнера; блок остаётся атомарным диапазоном контейнера
 * (`transclusion.ts`).
 *
 * Модуль намеренно НЕ знает про семантику блока (ссылку, правку ссылки, меню):
 * он владеет только жизненным циклом вложенных инстансов редактора и их
 * хранилищем. Хранилище ({@link NestedEditorStore}) живёт на инстанс
 * поля-контейнера и переживает пересборку виджета: текст правки сохраняется в
 * состоянии инстанса при выходе из блока и восстанавливается при повторном
 * входе; `Esc` — отмена всей правки поля (поле откатывает инстансы через
 * {@link NestedEditorStore.rollbackAll}), `Ctrl+Enter` — единая запись поля
 * (задача `e9dfc2df`).
 *
 * Рекурсия: стек вложенного инстанса включает расширения трансклюзий, поэтому
 * вложенные трансклюзии внутри блока работают так же, до глубины
 * {@link MAX_NESTED_DEPTH} (счёт глубины — {@link nestedDepthFacet}).
 *
 * Фабрика `EditorView` вынесена параметром хранилища ({@link NestedViewFactory}):
 * headless-тесты подменяют её, не поднимая настоящий CodeMirror (в DOM-шиме он
 * не работает) и проверяя логику входа/выхода/грязного флага на лёгком дублёре.
 */

import { EditorState, Facet, Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';

import { mdEditorExtensions } from './md-editor.js';

/** Предельная глубина вложенных редакторов (ТП, ADR f3adf3d3; требование границ). */
export const MAX_NESTED_DEPTH = 5;

/**
 * Класс пометки блока, правку которого не удалось записать в источник
 * (частичный сбой «Единой записи», задача `e9dfc2df`). Ставится на корневой DOM
 * вложенного редактора; вид — `styles/editor.css`.
 */
export const NESTED_SAVE_ERROR_CLASS = 'cm-transclusion-save-error';

/** Причина выхода из вложенного редактора (перенос фокуса наружу). */
export type NestedExitReason =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'blur'
  | 'ctrl-enter';

/** Вызовы вложенного редактора в хост (поле-контейнер). */
export interface NestedEditorOptions {
  /** Глубина инстанса (контейнер — 0, первый блок — 1, …). */
  depth: number;
  /** Текст блока изменён — «грязный» сигнал наружу (задача `e9dfc2df`). */
  onDirty: (key: string) => void;
  /** Фокус покинул вложенный редактор — выход из блока с сохранением текста. */
  onExit: (key: string, reason: NestedExitReason) => void;
  /**
   * `Ctrl+Enter` внутри блока — ЕДИНАЯ запись всего поля (окружение и все
   * «грязные» источники): поле само коммитит правку и возвращается в просмотр
   * (задача `e9dfc2df`). Отдельного сохранения блока по `Ctrl+Enter` нет.
   */
  onCommit: (key: string) => void;
  /**
   * `Esc` внутри блока — отмена ВСЕЙ правки поля (окружение и все блоки): поле
   * само откатывает инстансы к загруженному тексту и снимает захваты (задача
   * `e9dfc2df`, требование «Esc — отмена всего»).
   */
  onCancel: (key: string) => void;
  /**
   * Хост поля (задача `e9dfc2df`): пробрасывается в СТЕК вложенного инстанса
   * фасетом {@link blockEditorHostFacet}, поэтому блок ЛЮБОЙ глубины видит хост
   * и догружает захват своего источника при монтировании (`onBlockMounted`), а
   * также проводит `Ctrl+Enter`/`Esc` в единую запись/отмену поля. `null`/нет —
   * инстанс без хоста (тесты/ранний доступ).
   */
  host?: BlockEditorHost | null;
}

/**
 * Хост поля комментария, получающий события вложенных редакторов (задача
 * «Единая запись», `e9dfc2df`): изменение текста блока, запрос единой записи
 * (`Ctrl+Enter` внутри блока), отмена всей правки (`Esc` внутри блока) и
 * монтирование блока (для пакетного захвата его источника). Живёт здесь, рядом
 * с {@link NestedEditorStore}, и пробрасывается в стек вложенного инстанса
 * фасетом, чтобы блок любой глубины видел хост.
 */
export interface BlockEditorHost {
  /** Текст блока `key` изменён (отличается от загруженного). */
  onBlockDirty(key: string): void;
  /** `Ctrl+Enter` в блоке — единая запись всего поля (опционально). */
  onCommitEdit?(key: string): void;
  /** `Esc` в блоке — отмена всей правки поля (опционально). */
  onCancelEdit?(key: string): void;
  /** Блок смонтирован — поле может взять захват источника (опционально). */
  onBlockMounted?(sourceId: string): void;
}

/** Фасет хоста поля: единственное значение (последнее — при нескольких). */
export const blockEditorHostFacet = Facet.define<BlockEditorHost, BlockEditorHost | null>({
  combine: (values) => values[values.length - 1] ?? null,
});

/** Расширение-хост для поля: уведомляет о событиях вложенных блоков. */
export function blockEditorHostExtension(host: BlockEditorHost): Extension {
  return blockEditorHostFacet.of(host);
}

/** Глубина текущего инстанса редактора (нет фасета — контейнер, глубина 0). */
export const nestedDepthFacet = Facet.define<number, number>({
  combine: (values) => values[values.length - 1] ?? 0,
});

/** Хранилище вложенных инстансов на поле-контейнер (фасет расширения). */
export const blockEditorStoreFacet = Facet.define<NestedEditorStore, NestedEditorStore | null>({
  combine: (values) => values[values.length - 1] ?? null,
});

/** Один вложенный инстанс блока: DOM, состояние правки и «грязность». */
interface NestedEntry {
  readonly key: string;
  /** Текст, загруженный из источника при входе (точка отката `Esc`). */
  initialText: string;
  dirty: boolean;
  /** Правку блока не удалось записать в источник (задача `e9dfc2df`). */
  error: boolean;
  readonly view: EditorView | null;
  readonly dom: HTMLElement | null;
}

/**
 * Фабрика вложенного инстанса. Возвращает `EditorView` и его корневой DOM
 * (в headless-тестах — дублёр). `null`-DOM означает «инстанс недоступен» —
 * виджет отрисует запасной HTML.
 */
export type NestedViewFactory = (params: {
  key: string;
  initialText: string;
  options: NestedEditorOptions;
  /** Общий стек расширений инстанса (contains onInput-обвязку) — собран хранилищем. */
  extensions: Extension[];
  /**
   * Обвязка изменения текста инстанса (учёт «грязности»). Реальная фабрика уже
   * получает её внутри стека; тестовый дублёр вызывает её сам, эмулируя ввод.
   */
  onInput: (md: string) => void;
}) => { view: EditorView | null; dom: HTMLElement | null };

/**
 * Загруженный текст инстанса и его «грязность» — то, что переживает пересборку
 * виджета. Нужен для повторного входа без перечитывания источника и для
 * будущей «Единой записи» (задача `e9dfc2df`).
 */
export interface NestedEditorHandle {
  readonly key: string;
  readonly initialText: string;
  dirty: boolean;
  readonly view: EditorView | null;
  readonly dom: HTMLElement | null;
}

/** Хранилище вложенных инстансов редактора блока (на инстанс поля). */
export class NestedEditorStore {
  private readonly entries = new Map<string, NestedEntry>();
  /** Запрошенный, но ещё не применённый фокус (для момента подключения DOM). */
  private pendingFocus: { key: string; where: 'start' | 'end' | 'keep' } | null = null;

  constructor(
    private readonly createView: NestedViewFactory = defaultNestedViewFactory,
  ) {}

  /** Есть ли уже смонтированный/загруженный инстанс под ключом. */
  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** Загруженный текст инстанса, либо `null`. */
  text(key: string): string | null {
    const entry = this.entries.get(key);
    return entry === undefined ? null : textOfEntry(entry);
  }

  /** «Грязен» ли инстанс (текст отличается от загруженного). */
  isDirty(key: string): boolean {
    return this.entries.get(key)?.dirty === true;
  }

  /** Ключи «грязных» инстансов (текст отличается от загруженного). */
  dirtyKeys(): string[] {
    const out: string[] = [];
    for (const [key, entry] of this.entries) if (entry.dirty) out.push(key);
    return out;
  }

  /** Правку инстанса не удалось записать в источник (пометка блока). */
  hasError(key: string): boolean {
    return this.entries.get(key)?.error === true;
  }

  /** DOM инстанса для вставки в виджет блока, либо `null`. */
  dom(key: string): HTMLElement | null {
    return this.entries.get(key)?.dom ?? null;
  }

  /**
   * Создаёт (или пересоздаёт) инстанс с загруженным текстом. Повторный вход
   * использует сохранённый текст — вызывающий сам решает, нужен ли новый.
   */
  mount(key: string, initialText: string, options: NestedEditorOptions): NestedEditorHandle {
    this.disposeEntry(key);
    const holder: { entry: NestedEntry | null } = { entry: null };
    const onInput = (md: string): void => {
      if (holder.entry === null) return;
      // Сравнение с ТЕКУЩЕЙ базой инстанса (`initialText`), а не с исходным
      // аргументом: после удачной записи база сдвигается ({@link markSaved}), и
      // «грязность» обязана считаться от записанного текста.
      const dirty = md !== holder.entry.initialText;
      if (dirty === holder.entry.dirty) return;
      holder.entry.dirty = dirty;
      options.onDirty(key);
    };
    const { view, dom } = this.createView({
      key,
      initialText,
      options,
      extensions: nestedExtensions(key, options, onInput, this),
      onInput,
    });
    const entry: NestedEntry = { key, initialText, dirty: false, error: false, view, dom };
    holder.entry = entry;
    this.entries.set(key, entry);
    return entry;
  }

  /**
   * Фокусирует инстанс (если смонтирован) и ставит каретку в начало или конец
   * текста — вход в блок кареткой с нужного края (`keep` — не трогать выделение).
   */
  focus(key: string, where: 'start' | 'end' | 'keep' = 'keep'): void {
    const view = this.entries.get(key)?.view;
    if (view === undefined || view === null) return;
    if (where !== 'keep') {
      const anchor = where === 'start' ? 0 : view.state.doc.length;
      view.dispatch({ selection: { anchor } });
    }
    this.pendingFocus = { key, where: 'keep' };
    // Виджет активного блока монтирует DOM инстанса при отрисовке транзакции —
    // фокусировать до подключения к документу бессмысленно. Если DOM уже в
    // документе, фокусируем сразу; иначе виджет вызовет {@link applyPendingFocus}
    // после вставки. Микрозадача — страховка для уже подключённого DOM.
    if (view.dom?.isConnected === true) this.applyPendingFocus(key);
    else queueMicrotask(() => this.applyPendingFocus(key));
  }

  /**
   * Применяет отложенный фокус, если он ждёт для инстанса `key`. Вызывается
   * виджетом блока сразу после монтирования DOM инстанса.
   */
  applyPendingFocus(key: string): void {
    if (this.pendingFocus === null || this.pendingFocus.key !== key) return;
    const view = this.entries.get(key)?.view;
    this.pendingFocus = null;
    view?.focus();
  }

  /** Откат `Esc`: текст возвращается к загруженному, «грязность» снимается. */
  rollback(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined || entry.view === null) return;
    setViewText(entry.view, entry.initialText);
    entry.dirty = false;
    this.setError(key, false);
  }

  /** Откат всех инстансов к загруженному тексту (Esc — отмена всего поля). */
  rollbackAll(): void {
    for (const key of [...this.entries.keys()]) this.rollback(key);
  }

  /**
   * Удачная запись правки блока в источник: текущий текст становится новой
   * базой инстанса, «грязность» и пометка ошибки снимаются (частичный сбой
   * «Единой записи» — задача `e9dfc2df`).
   */
  markSaved(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    entry.initialText = textOfEntry(entry);
    entry.dirty = false;
    this.setError(key, false);
  }

  /** Помечает блок сбойной записью (или снимает пометку) — вид в CSS. */
  markError(key: string, on = true): void {
    this.setError(key, on);
  }

  /** Внутренний переключатель пометки ошибки: флаг + класс на DOM инстанса. */
  private setError(key: string, on: boolean): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    entry.error = on;
    entry.dom?.classList.toggle(NESTED_SAVE_ERROR_CLASS, on);
  }

  /** Уничтожает инстанс под ключом (например, источник перечитан заново). */
  disposeEntry(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    entry.view?.destroy();
    this.entries.delete(key);
  }

  /** Уничтожает все инстансы (поле выходит из правки). */
  dispose(): void {
    for (const key of [...this.entries.keys()]) this.disposeEntry(key);
  }
}

/** Текущий текст инстанса (из его документа). */
function textOfEntry(entry: NestedEntry): string {
  const view = entry.view;
  if (view === null) return entry.initialText;
  return view.state.doc.toString();
}

/** Заменяет документ инстанса целиком (откат). */
function setViewText(view: EditorView, text: string): void {
  const len = view.state.doc.length;
  view.dispatch({ changes: { from: 0, to: len, insert: text } });
}

/** Стек расширений вложенного инстанса: общий стек + жесты выхода/отката/глубины. */
function nestedExtensions(
  key: string,
  options: NestedEditorOptions,
  onInput: (md: string) => void,
  store: NestedEditorStore,
): Extension[] {
  return [
    ...mdEditorExtensions({ onInput }, new Set()),
    // Вложенный инстанс сам умеет монтировать детей: его виджеты берут то же
    // хранилище и видят свою глубину (рекурсия до MAX_NESTED_DEPTH).
    blockEditorStoreFacet.of(store),
    // Хост поля пробрасывается в стек инстанса (задача e9dfc2df): блок ЛЮБОЙ
    // глубины видит хост — догружает захват источника при монтировании
    // (`onBlockMounted`) и проводит Ctrl+Enter/Esc в единую запись/отмену поля.
    // Без этого у блока внутри блока `host === null` и захват не брался.
    ...(options.host === undefined || options.host === null
      ? []
      : [blockEditorHostFacet.of(options.host)]),
    Prec.highest(
      keymap.of([
        // `Esc` внутри блока — отмена ВСЕЙ правки поля (окружение и все блоки),
        // а не только этого инстанса: поле откатывает все вложенные редакторы к
        // загруженному тексту и снимает захваты (задача `e9dfc2df`).
        {
          key: 'Escape',
          run: () => {
            options.onCancel(key);
            return true;
          },
        },
        // `Ctrl+Enter` внутри блока — ЕДИНАЯ запись всего поля: поле запишет
        // окружение и все «грязные» источники одной командой (задача
        // `e9dfc2df`). Отдельной записи блока нет.
        {
          key: 'Mod-Enter',
          run: () => {
            options.onCommit(key);
            return true;
          },
        },
        // Края документа — перенос фокуса наружу: в контейнер до/после блока.
        { key: 'ArrowUp', run: (view) => edgeExit(view, options, key, 'up') },
        { key: 'ArrowLeft', run: (view) => edgeExit(view, options, key, 'left') },
        { key: 'ArrowDown', run: (view) => edgeExit(view, options, key, 'down') },
        { key: 'ArrowRight', run: (view) => edgeExit(view, options, key, 'right') },
      ]),
    ),
    nestedDepthFacet.of(options.depth),
  ];
}

/**
 * Выход по краю документа вложенного редактора: стрелка на первой/последней
 * строке уводит фокус в контейнер (до/после блока). Возвращает `false`, если
 * каретка не на краю, — стрелка остаётся обычной навигацией внутри блока.
 */
function edgeExit(
  view: EditorView,
  options: NestedEditorOptions,
  key: string,
  dir: 'up' | 'down' | 'left' | 'right',
): boolean {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const doc = view.state.doc;
  const atStart = sel.head === 0;
  const atEnd = sel.head === doc.length;
  const firstLine = doc.lineAt(sel.head).from === sel.head;
  const lastLine = doc.lineAt(sel.head).to === sel.head;
  const exit =
    (dir === 'up' && firstLine) ||
    (dir === 'down' && lastLine) ||
    (dir === 'left' && atStart) ||
    (dir === 'right' && atEnd);
  if (!exit) return false;
  options.onExit(key, dir);
  return true;
}

/** Фабрика по умолчанию: настоящий `EditorView` CodeMirror 6. */
function defaultNestedViewFactory(params: {
  key: string;
  initialText: string;
  options: NestedEditorOptions;
  extensions: Extension[];
}): { view: EditorView | null; dom: HTMLElement | null } {
  const view = new EditorView({
    state: EditorState.create({
      doc: params.initialText,
      extensions: params.extensions,
    }),
  });
  // Фокус ушёл из вложенного редактора наружу (клик по контейнеру/другому
  // блоку) — выход из блока с сохранением текста. Переход фокуса ВНУТРЬ
  // вложенного редактора focusout не порождает.
  view.dom.addEventListener('focusout', (event) => {
    const next = event.relatedTarget as Node | null;
    if (next !== null && view.dom.contains(next)) return;
    if (next === null) return;
    params.options.onExit(params.key, 'blur');
  });
  return { view, dom: view.dom };
}

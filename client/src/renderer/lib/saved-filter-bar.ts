/**
 * Строка сохранённых отборов и диалог выбора сохранённого отбора
 * (задача 2ebe4206, версия 0.8.2).
 *
 * Панель отбора каждого экрана заканчивается одной строкой: поле «имя отбора»,
 * кнопка-дискета («записать настройки отбора»), кнопка-крестик («удалить
 * настройки отбора») и кнопка с многоточием («выбрать сохранённый отбор»).
 * Список сохранённых отборов показывается ОТДЕЛЬНЫМ ДИАЛОГОМ по единым
 * правилам диалогов-списков (требование 11ddd910): сверху поиск по именам
 * (правило 1), под ним строка управления «Изменить» / «Копировать» /
 * «Удалить» над текущей строкой (правило 2), сам список — единый табличный
 * фасад `lib/ui/table.ts` (задача ae76b75e, требование 93115633): текущая
 * строка, клавиатура (↑/↓, Home/End, PgUp/PgDn, Enter), контекстное меню
 * строки, копирование Ctrl+C. Диалог — пикер одиночного значения (правило 6
 * требования 11ddd910): клик лишь делает строку текущей, а выбор ПОДТВЕРЖДАЮТ
 * двойной клик и Enter (эквивалент кнопки «Выбрать» футера, правило 3) и диалог
 * закрывается. Переименование доступно кнопкой «Изменить» и командой меню
 * строки; после копии список позиционируется на ней (правило 7). У строки
 * контекстное меню «Переименовать» / «Скопировать» (копия с « (копия)») /
 * «Удалить».
 *
 * Экран передаёт каркасу только своё: хранилище отборов (REST-виды разные —
 * `structures` и `chronicle`), конвертер текущих настроек в определение и
 * применитель сохранённого определения. Вид строки и диалога — общий, поэтому
 * «Хроника» работает с сохранёнными отборами так же, как «Структуры».
 *
 * Своей модели отбора модуль не держит: определения отборов для него —
 * непрозрачные значения (см. стандарт S4 и ADR «условия отбора строит один
 * конструктор с одной моделью состояния»).
 */

import { confirmDialog, errorDialog, promptDialog, showDialog } from './dialog.js';
import { t } from './i18n.js';
import { div, el, span } from './dom.js';
import { defineKeyContext, pushKeyContext } from './keymap.js';
import { modifierChordVariants } from './keymap-chords.js';
import { svgIcon } from './ui/icon.js';
import { menuAction, type MenuItem } from './menu.js';
import { notice } from './notice.js';
import { iconButton, uiButton } from './ui/button.js';
import { createTable } from './ui/table.js';
import { duplicateFilterName, filterSavedByName } from './pure.js';

/** Запись сохранённого отбора. `definition` — непрозрачное определение вида. */
export interface SavedFilterEntry {
  id: string;
  name: string;
  definition: unknown;
}

/** Хранилище сохранённых отборов одного вида (REST-обёртка экрана). */
export interface SavedFilterStore {
  list(): Promise<SavedFilterEntry[]>;
  create(name: string, definition: unknown): Promise<SavedFilterEntry>;
  update(id: string, patch: { name?: string; definition?: unknown }): Promise<SavedFilterEntry>;
  remove(id: string): Promise<void>;
}

/** Параметры строки сохранённых отборов. */
export interface SavedFilterBarOptions {
  /** Хранилище отборов этого вида (REST-обёртка с `view` экрана). */
  store: SavedFilterStore;
  /** Текущее имя в поле ввода. */
  getName: () => string;
  /** Запись имени из поля в состояние экрана. */
  setName: (name: string) => void;
  /** Текущие настройки отбора → определение для сохранения. */
  buildDefinition: () => unknown;
  /** Применить сохранённый отбор к панели и выполнить запрос. */
  applyEntry: (entry: SavedFilterEntry) => void;
  /** id выбранного (применённого) отбора — подсветка в диалоге. */
  selectedId: () => string | null;
  /** Сообщить экрану, что выбранный отбор сменился или удалён. */
  setSelectedId: (id: string | null) => void;
  /** Экран сохраняет своё L4-состояние после смены выбора. */
  onPersist?: () => void;
}

/** Рукоятка строки сохранённых отборов. */
export interface SavedFilterBarHandle {
  /** Корень строки — кладётся в футер формы отбора. */
  root: HTMLElement;
  /** Перечитать список отборов (например, по real-time событию). */
  reload(): Promise<void>;
}

/**
 * Строит строку сохранённых отборов. Размер/поведение панели каркас не знает —
 * строка живёт в футере формы отбора и не прокручивается вместе с группами.
 */
export function buildSavedFilterBar(opts: SavedFilterBarOptions): SavedFilterBarHandle {
  let entries: SavedFilterEntry[] = [];

  const root = div('sfb-row');
  const nameWrap = div('st-f-kw-wrap');
  const nameInput = el('input', 'st-f-input sfb-name') as HTMLInputElement;
  nameInput.type = 'text';
  nameInput.placeholder = 'имя отбора';
  nameInput.maxLength = 200;
  nameInput.value = opts.getName();
  nameInput.addEventListener('input', () => opts.setName(nameInput.value));
  nameWrap.append(nameInput);

  const saveBtn = iconButton({
    icon: svgIcon('save', 15),
    title: 'Записать настройки отбора',
    size: 's',
    onClick: () => void save(),
  });

  const deleteBtn = iconButton({
    icon: svgIcon('x', 15),
    title: 'Удалить настройки отбора',
    size: 's',
    onClick: () => void removeCurrent(),
  });

  const moreBtn = iconButton({
    icon: el('span', undefined, '…'),
    title: 'Выбрать сохранённый отбор',
    size: 's',
    class: 'sfb-more',
    onClick: () => openPicker(),
  });

  root.append(nameWrap, saveBtn, deleteBtn, moreBtn);

  async function load(): Promise<void> {
    try {
      entries = await opts.store.list();
    } catch {
      entries = [];
    }
  }

  async function reload(): Promise<void> {
    await load();
  }

  /** Записывает текущие настройки под именем из поля (создать/перезаписать). */
  async function save(): Promise<void> {
    const name = nameInput.value.trim();
    if (name === '') {
      notice('Введите имя отбора');
      return;
    }
    const definition = opts.buildDefinition();
    const existing = entries.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
    try {
      if (existing !== undefined) {
        const updated = await opts.store.update(existing.id, { definition });
        opts.setSelectedId(updated.id);
      } else {
        const created = await opts.store.create(name, definition);
        opts.setSelectedId(created.id);
      }
    } catch (err) {
      errorDialog('Сохранить отбор', err);
      return;
    }
    opts.onPersist?.();
    await load();
    notice(`Отбор «${name}» сохранён`);
  }

  /** Удаляет отбор по имени из поля, иначе — выбранный. */
  async function removeCurrent(): Promise<void> {
    const name = nameInput.value.trim();
    const byName =
      name === ''
        ? undefined
        : entries.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
    const selected = opts.selectedId();
    const target = byName ?? (selected === null ? undefined : entries.find((e) => e.id === selected));
    if (target === undefined) {
      notice('Отбор с таким именем не найден');
      return;
    }
    await removeEntry(target);
  }

  /** Удаляет запись после подтверждения. */
  async function removeEntry(entry: SavedFilterEntry): Promise<void> {
    const confirmed = await confirmDialog(
      'Удалить отбор',
      `Удалить сохранённый отбор «${entry.name}»?`,
      true,
    );
    if (!confirmed) return;
    try {
      await opts.store.remove(entry.id);
    } catch (err) {
      errorDialog('Удалить отбор', err);
      return;
    }
    if (opts.selectedId() === entry.id) opts.setSelectedId(null);
    opts.onPersist?.();
    await load();
  }

  /** Переименовывает запись (исправление опечаток) через диалог ввода. */
  async function renameEntry(entry: SavedFilterEntry): Promise<string | null> {
    const name = await promptDialog('Переименовать отбор', 'Имя', entry.name);
    const trimmed = (name ?? '').trim();
    if (trimmed === '' || trimmed === entry.name) return null;
    try {
      await opts.store.update(entry.id, { name: trimmed });
    } catch (err) {
      errorDialog('Переименовать отбор', err);
      return null;
    }
    await load();
    if (opts.selectedId() === entry.id && nameInput.value.trim() === entry.name) {
      nameInput.value = trimmed;
      opts.setName(trimmed);
    }
    return trimmed;
  }

  /** Создаёт полную копию записи со свободным именем «… (копия)». Возвращает
   *  id созданной копии — диалог позиционируется на ней (правило 7 требования
   *  11ddd910). */
  async function copyEntry(entry: SavedFilterEntry): Promise<string | null> {
    const copyName = duplicateFilterName(
      entry.name,
      entries.map((e) => e.name),
    );
    let created: SavedFilterEntry;
    try {
      created = await opts.store.create(copyName, entry.definition);
    } catch (err) {
      errorDialog('Скопировать отбор', err);
      return null;
    }
    await load();
    return created.id;
  }

  /** Открывает диалог выбора сохранённого отбора. */
  function openPicker(): void {
    openSavedFilterDialog({
      entries: () => entries,
      selectedId: () => opts.selectedId(),
      onPick: (entry) => {
        opts.applyEntry(entry);
        nameInput.value = entry.name;
        opts.setName(entry.name);
      },
      onRename: renameEntry,
      onCopy: copyEntry,
      onDelete: removeEntry,
      onRefresh: load,
    });
  }

  void load();

  return { root, reload };
}

// ---------------------------------------------------------------------------
// Диалог выбора сохранённого отбора
// ---------------------------------------------------------------------------

/** Параметры диалога выбора сохранённого отбора. */
interface SavedFilterDialogOptions {
  /** Текущий список отборов (читается на каждой отрисовке). */
  entries: () => SavedFilterEntry[];
  /** id применённого отбора — подсветка строки. */
  selectedId: () => string | null;
  onPick: (entry: SavedFilterEntry) => void;
  onRename: (entry: SavedFilterEntry) => Promise<string | null>;
  /** Создаёт копию; возвращает id копии — диалог на ней позиционируется (правило 7). */
  onCopy: (entry: SavedFilterEntry) => Promise<string | null>;
  onDelete: (entry: SavedFilterEntry) => Promise<void>;
  /** Перечитать список после переименования/копирования/удаления. */
  onRefresh: () => Promise<void>;
}

/**
 * Диалог списка сохранённых отборов: поиск по именам сверху, навигация ↑/↓,
 * выбор подтверждают Enter, двойной клик и кнопка «Выбрать» (правило 6
 * требования 11ddd910), контекстное меню строки. Остаётся открытым после
 * переименования/копирования/удаления — список перерисовывается на месте.
 */
/** Счётчик диалогов сохранённых отборов: у каждого свой контекст поля поиска. */
let savedFilterSearchSeq = 0;

export function openSavedFilterDialog(opts: SavedFilterDialogOptions): void {
  const body = div('sfd list-dialog-body');

  // Правило 1 требования 11ddd910: поле горячего поиска — ПЕРВАЯ строка
  // диалога, над строкой управления и списком.
  const search = el('input', 'st-f-input sfd-search') as HTMLInputElement;
  search.type = 'text';
  search.placeholder = t('actions.search');

  // Правило 2 требования 11ddd910: строка управления НАД списком. «Изменить»
  // (переименовать), «Копировать» и «Удалить» действуют на ТЕКУЩУЮ строку и
  // гаснут без неё (`updateButtons`). «Добавить» диалогу не положено: новый
  // отбор создаёт строка сохранённых отборов из текущих настроек панели
  // (карточка 284d6a56).
  const toolbar = div('form-row type-list-toolbar sfd-toolbar');
  const editBtn = uiButton({
    label: t('listActions.edit'),
    role: 'secondary',
    size: 's',
    title: t('listActions.editHint'),
    disabled: true,
    onClick: () => {
      const entry = currentEntry();
      if (entry !== null) void opts.onRename(entry).then(render);
    },
  });
  const copyBtn = uiButton({
    label: t('listActions.copy'),
    role: 'secondary',
    size: 's',
    title: t('listActions.copyHint'),
    disabled: true,
    onClick: () => {
      const entry = currentEntry();
      // Правило 7: созданная копия становится текущей строкой — список на неё
      // позиционируется (реализует `render` через `pendingCurrentId`).
      if (entry !== null) {
        void opts.onCopy(entry).then((id) => {
          if (id !== null) pendingCurrentId = id;
          render();
        });
      }
    },
  });
  const deleteBtn = uiButton({
    label: t('actions.delete'),
    role: 'secondary',
    size: 's',
    title: t('listActions.deleteHint'),
    disabled: true,
    onClick: () => {
      const entry = currentEntry();
      if (entry !== null) void opts.onDelete(entry).then(opts.onRefresh).then(render);
    },
  });
  toolbar.append(editBtn, copyBtn, deleteBtn);

  const listHost = div('sfd-list');
  // Высоту области списка задаёт раскладка диалога-списка (`.list-dialog-body`,
  // правило 9 требования 11ddd910): она тянется на свободную высоту роли и не
  // схлопывается при пустом поиске (ошибка f68bb43c).
  // Правила 1–2 требования 11ddd910: поиск, под ним управление, затем список.
  body.append(search, toolbar, listHost);

  /** Видимые строки текущей отрисовки — источник массива для фасада. */
  let visible: SavedFilterEntry[] = [];
  /** Закрытие диалога; присваивается сразу после `showDialog`. */
  let close: () => void = () => undefined;
  /** id только что созданного отбора — цель позиционирования (правило 7). */
  let pendingCurrentId: string | null = null;
  /** Кнопка решения «Выбрать» футера — гаснет без текущей строки. */
  let selectBtn: HTMLButtonElement | null = null;

  const table = createTable<SavedFilterEntry>({
    ariaLabel: t('savedFilters.aria'),
    columns: [
      {
        key: 'name',
        header: t('savedFilters.col.name'),
        sortable: true,
        sortValue: (entry) => entry.name,
        text: (entry) => entry.name,
        // Применённый отбор подсвечиваем жирным: фасад держит только текущую
        // (клавиатурную) строку, а «применённый» — отдельное состояние экрана.
        render: (entry) => {
          const node = span(entry.name);
          if (entry.id === opts.selectedId()) node.style.fontWeight = '600';
          return node;
        },
      },
    ],
    rows: [],
    rowKey: (entry) => entry.id,
    emptyText: t('savedFilters.empty'),
    emptyHint: t('savedFilters.emptyHint'),
    // Правило 6 требования 11ddd910 (выбор одиночного значения, ошибка
    // 03f63297): клик ТОЛЬКО делает строку текущей, а выбор ПОДТВЕРЖДАЮТ Enter,
    // двойной клик и кнопка «Выбрать» — все три идут в `onActivate` и закрывают
    // диалог. `onDblActivate` намеренно НЕ задан: фасад на двойной клик без него
    // зовёт `onActivate` (эквивалент «Выбрать»), а не редактор строки.
    onActivate: (entry) => pick(entry),
    onCurrentChange: () => updateButtons(),
    rowMenu: (entry) => rowMenu(entry),
  });
  listHost.append(table.element);

  /** Текущая строка списка — на неё действует строка управления (правило 2). */
  function currentEntry(): SavedFilterEntry | null {
    return table.getCurrent()?.row ?? null;
  }

  /** Гасит кнопки текущей строки и решение «Выбрать» без неё. */
  function updateButtons(): void {
    const has = table.getCurrent() !== null;
    editBtn.disabled = !has;
    copyBtn.disabled = !has;
    deleteBtn.disabled = !has;
    if (selectBtn !== null) selectBtn.disabled = !has;
  }

  const pick = (entry: SavedFilterEntry): void => {
    opts.onPick(entry);
    close();
  };

  /** Контекстное меню строки из общего словаря пунктов (`lib/menu.ts`). */
  const rowMenu = (entry: SavedFilterEntry): MenuItem[] => [
    menuAction(t('savedFilters.menu.rename'), () => void opts.onRename(entry).then(render)),
    menuAction(t('savedFilters.menu.copy'), () =>
      void opts.onCopy(entry).then((id) => {
        if (id !== null) pendingCurrentId = id;
        render();
      }),
    ),
    menuAction(
      t('actions.delete'),
      () => void opts.onDelete(entry).then(opts.onRefresh).then(render),
      { danger: true },
    ),
  ];

  const render = (): void => {
    visible = filterSavedByName(opts.entries(), search.value);
    // Пустое состояние зависит от поиска: без сохранённых — свой текст с
    // подсказкой, без совпадений — «Ничего не найдено». Рисует общий компонент
    // `lib/ui/empty-state.ts` через `table.setEmpty`.
    table.setEmpty(
      opts.entries().length === 0
        ? { title: t('savedFilters.empty'), hint: t('savedFilters.emptyHint') }
        : { title: t('savedFilters.emptySearch'), hint: t('savedFilters.emptySearchHint') },
    );
    table.setRows(visible);
    // Правило 7: цель позиционирования — только что созданный отбор, иначе
    // применённый. Фасад прокручивает список к текущей строке (setCurrent).
    const target = pendingCurrentId ?? opts.selectedId();
    pendingCurrentId = null;
    table.setCurrent(
      target !== null && visible.some((entry) => entry.id === target) ? target : null,
    );
    updateButtons();
  };

  // Ввод в поле поиска фильтрует список; стрелки/Enter перенаправляем таблице,
  // чтобы клавиатура оставалась от фасада (текущая строка и подсветка видны).
  search.addEventListener('input', () => render());
  // Клавиатура поля — через общеклиентский диспетчер (ADR b420b08c, задача
  // fd3d84f4): пока фокус в поиске, его контекст на вершине стека.
  const searchContextId = `saved-filter-search-${(savedFilterSearchSeq += 1)}`;
  const handleSearchKey = (event: KeyboardEvent): boolean => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter') return false;
    table.focus();
    table.element.dispatchEvent(new KeyboardEvent('keydown', { key: event.key, bubbles: true }));
    return true;
  };
  defineKeyContext({
    id: searchContextId,
    bindings: [
      { command: 'savedFilter.search.down', chord: 'ArrowDown', run: handleSearchKey },
      { command: 'savedFilter.search.up', chord: 'ArrowUp', run: handleSearchKey },
      // Прежний обработчик срабатывал на Enter независимо от модификаторов —
      // нажатие выражено привязкой на каждое подмножество (`lib/keymap-chords.ts`).
      ...modifierChordVariants('Enter').map((chord) => ({
        command: 'savedFilter.search.enter',
        chord,
        run: handleSearchKey,
      })),
    ],
  });
  let releaseSearchContext: (() => void) | null = null;
  const onSearchFocusIn = (): void => {
    releaseSearchContext ??= pushKeyContext(searchContextId);
  };
  const onSearchFocusOut = (): void => {
    releaseSearchContext?.();
    releaseSearchContext = null;
  };
  search.addEventListener('focusin', onSearchFocusIn as EventListener);
  search.addEventListener('focusout', onSearchFocusOut as EventListener);

  close = showDialog({
    title: t('savedFilters.title'),
    body,
    size: 's',
    // Высота диалога стабильна: задана ролью, не содержимым списка/поиска
    // (правило 9 требования 11ddd910, ошибка f68bb43c).
    fixedHeight: true,
    // Правило 3: футер — кнопки решения. «Выбрать» применяет текущую строку,
    // «Отмена» закрывает без выбора.
    buttons: [
      {
        label: t('actions.select'),
        primary: true,
        ref: (btn) => {
          selectBtn = btn;
          btn.disabled = true;
        },
        onClick: () => {
          const entry = currentEntry();
          if (entry !== null) pick(entry);
        },
      },
      { label: t('actions.cancel') },
    ],
    onMount: () => search.focus(),
  });
  render();
}

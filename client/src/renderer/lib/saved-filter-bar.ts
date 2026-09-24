/**
 * Строка сохранённых отборов и диалог выбора сохранённого отбора
 * (задача 2ebe4206, версия 0.8.2).
 *
 * Панель отбора каждого экрана заканчивается одной строкой: поле «имя отбора»,
 * кнопка-дискета («записать настройки отбора»), кнопка-крестик («удалить
 * настройки отбора») и кнопка с многоточием («выбрать сохранённый отбор»).
 * Список сохранённых отборов показывается ОТДЕЛЬНЫМ ДИАЛОГОМ: сверху поиск по
 * именам, навигация ↑/↓, выбор кликом или Enter, у каждой строки контекстное
 * меню «Переименовать» / «Скопировать» (копия с « (копия)») / «Удалить».
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
import { div, el } from './dom.js';
import { svgIcon } from './icons.js';
import { showMenuAt, type MenuItem } from './menu.js';
import { notice } from './notice.js';
import { iconButton } from './ui/button.js';
import {
  duplicateFilterName,
  filterSavedByName,
  moveSavedFilterCursor,
} from './pure.js';

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

  /** Создаёт полную копию записи со свободным именем «… (копия)». */
  async function copyEntry(entry: SavedFilterEntry): Promise<string | null> {
    const copyName = duplicateFilterName(
      entry.name,
      entries.map((e) => e.name),
    );
    try {
      await opts.store.create(copyName, entry.definition);
    } catch (err) {
      errorDialog('Скопировать отбор', err);
      return null;
    }
    await load();
    return copyName;
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
  onCopy: (entry: SavedFilterEntry) => Promise<string | null>;
  onDelete: (entry: SavedFilterEntry) => Promise<void>;
  /** Перечитать список после переименования/копирования/удаления. */
  onRefresh: () => Promise<void>;
}

/**
 * Диалог списка сохранённых отборов: поиск по именам сверху, навигация ↑/↓,
 * выбор кликом или Enter, контекстное меню строки. Остаётся открытым после
 * переименования/копирования/удаления — список перерисовывается на месте.
 */
export function openSavedFilterDialog(opts: SavedFilterDialogOptions): void {
  const body = div('sfd');
  const search = el('input', 'st-f-input sfd-search') as HTMLInputElement;
  search.type = 'text';
  search.placeholder = t('actions.search');
  const list = div('sfd-list');
  body.append(search, list);

  let cursor = 0;
  /** Видимые строки текущей отрисовки — по ним ходит клавиатура. */
  let visible: SavedFilterEntry[] = [];
  /** Закрытие диалога; присваивается сразу после `showDialog`. */
  let close: () => void = () => undefined;

  const render = (): void => {
    visible = filterSavedByName(opts.entries(), search.value);
    cursor = visible.length === 0 ? -1 : Math.min(Math.max(cursor, 0), visible.length - 1);
    list.replaceChildren();
    if (visible.length === 0) {
      list.append(
        el(
          'div',
          'st-f-empty',
          opts.entries().length === 0 ? 'Нет сохранённых отборов' : 'Ничего не найдено',
        ),
      );
      return;
    }
    visible.forEach((entry, index) => {
      const row = el('button', 'sfd-row');
      row.type = 'button';
      if (entry.id === opts.selectedId()) row.classList.add('active');
      if (index === cursor) row.classList.add('cursor');
      row.textContent = entry.name;
      row.addEventListener('click', () => pick(entry));
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        cursor = index;
        render();
        openRowMenu(entry, event.clientX, event.clientY);
      });
      list.append(row);
    });
  };

  const pick = (entry: SavedFilterEntry): void => {
    opts.onPick(entry);
    close();
  };

  const openRowMenu = (entry: SavedFilterEntry, x: number, y: number): void => {
    const items: MenuItem[] = [
      { label: 'Переименовать', onClick: () => void opts.onRename(entry).then(render) },
      { label: 'Скопировать', onClick: () => void opts.onCopy(entry).then(render) },
      {
        label: t('actions.delete'),
        danger: true,
        onClick: () => void opts.onDelete(entry).then(opts.onRefresh).then(render),
      },
    ];
    showMenuAt(x, y, items);
  };

  search.addEventListener('input', () => {
    cursor = 0;
    render();
  });
  search.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (visible.length === 0) return;
      cursor = moveSavedFilterCursor(cursor, visible.length, event.key === 'ArrowDown' ? 1 : -1);
      render();
      const row = list.children[cursor];
      if (row instanceof HTMLElement) row.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const entry = visible[cursor];
      if (entry !== undefined) pick(entry);
    }
  });

  close = showDialog({
    title: 'Сохранённые отборы',
    body,
    size: 's',
    buttons: [{ label: t('actions.close'), onClick: (c) => c() }],
    onMount: () => search.focus(),
  });
  render();
}

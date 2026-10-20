/**
 * Общий контроллер личных сохранённых отборов места применения (0.13.3,
 * задача c0c7b834).
 *
 * Три места — «Структуры», «Дневник» и «События» — работают с личными
 * `saved_filters` одинаково: перечитывают список (в т.ч. по realtime
 * `saved-filter.*`), сохраняют текущее определение (имя изменено — копия),
 * открывают общий диалог выбора `openSavedFilterDialog` (переименование,
 * копия, удаление) и применяют выбранный отбор. До 0.13.3 эта логика была
 * скопирована в двух панелях; третья копия не заводится — экраны передают
 * сюда только своё (хранилище вида, конвертеры определения и применение).
 *
 * Контроллер НЕ держит модели отбора: определения для него — непрозрачные
 * значения (стандарт S4), парсит и применяет их место применения. Вид
 * (`structures`/`chronicle`/`events`) задаёт переданное хранилище.
 */

import { confirmDialog, errorDialog, promptDialog } from './dialog.js';
import { duplicateFilterName } from './pure.js';
import { openSavedFilterDialog } from './saved-filter-bar.js';
import { notice } from './notice.js';

/** Запись сохранённого отбора; `definition` — непрозрачное определение вида. */
export interface SavedFilterRow {
  id: string;
  name: string;
  definition: unknown;
  /** Условия строки совпали с предопределённым набором (метка в списке). */
  predefined?: boolean;
}

/** Хранилище отборов одного вида (REST-обёртка экрана). */
export interface SavedFilterStore {
  list(): Promise<SavedFilterRow[]>;
  create(name: string, definition: unknown): Promise<SavedFilterRow>;
  update(id: string, patch: { name?: string; definition?: unknown }): Promise<SavedFilterRow>;
  remove(id: string): Promise<void>;
}

/** Параметры общего контроллера сохранённых отборов. */
export interface SavedFilterControllerOptions {
  /** Хранилище вида: «Структуры» / «Дневник» / «События». */
  store: SavedFilterStore;
  /** Текущее имя в поле футера. */
  getName: () => string;
  /** Запись имени из поля в состояние экрана. */
  setName: (name: string) => void;
  /** Текущие настройки отбора → определение для сохранения. */
  buildDefinition: () => unknown;
  /** Применить сохранённый отбор к панели и выполнить запрос. */
  applyEntry: (entry: SavedFilterRow) => void;
  /** id применённого отбора — подсветка в диалоге. */
  getSelectedId: () => string | null;
  /** Запись id применённого отбора в состояние экрана. */
  setSelectedId: (id: string | null) => void;
  /** Отбор записан (создан/перезаписан): экран обновляет baseline и savedName. */
  onSaved?: (saved: { id: string; name: string; definition: unknown }) => void;
  /** Отбор переименован: экран обновляет подпись, если это текущий отбор. */
  onRenamed?: (id: string, name: string) => void;
  /** Текущий отбор исчез (удалён, в т.ч. другим клиентом): снять идентичность. */
  onUnselected?: (id: string) => void;
  /** Экран сохраняет своё L4-состояние после смены выбора/списка. */
  onPersist?: () => void;
  /** Экран обновляет футер (имя, маркер ●). */
  onRefresh?: () => void;
  /**
   * Хук перед открытием списка (посев предопределённых наборов «Структур»/
   * «Дневника»). После него список обязан быть перечитан.
   */
  beforePicker?: () => Promise<void>;
  /** Подготовка загруженных строк (метки предопределённых наборов). */
  afterReload?: (rows: SavedFilterRow[]) => void;
}

/** Рукоятка общего контроллера. */
export interface SavedFilterController {
  /** Текущий кэш списка (читается диалогом на каждой отрисовке). */
  rows(): readonly SavedFilterRow[];
  /** Перечитать список отборов. */
  reload(): Promise<void>;
  /**
   * Realtime `saved-filter.*`: перечитать список; если текущий отбор исчез —
   * снять идентичность (`onUnselected`), условия панели остаются.
   */
  syncRealtime(): Promise<void>;
  /** Записать текущий отбор (пустое имя — понятное сообщение). */
  save(request: { name: string; asCopy: boolean }): Promise<void>;
  /** Открыть общий диалог выбора сохранённого отбора. */
  openPicker(): Promise<void>;
}

/**
 * Собрать контроллер места применения. Список читается лениво:
 * `mount`-путь места вызывает {@link SavedFilterController.reload}.
 */
export function createSavedFilterController(
  opts: SavedFilterControllerOptions,
): SavedFilterController {
  let rows: SavedFilterRow[] = [];

  async function reload(): Promise<void> {
    try {
      rows = (await opts.store.list()).map((row) => ({
        id: row.id,
        name: row.name,
        definition: row.definition,
      }));
    } catch {
      rows = [];
    }
    opts.afterReload?.(rows);
  }

  async function syncRealtime(): Promise<void> {
    await reload();
    const selected = opts.getSelectedId();
    if (selected !== null && !rows.some((row) => row.id === selected)) {
      opts.setSelectedId(null);
      opts.onUnselected?.(selected);
      opts.onPersist?.();
      opts.onRefresh?.();
    }
  }

  async function save(request: { name: string; asCopy: boolean }): Promise<void> {
    const name = request.name.trim();
    if (name === '') {
      notice('Введите имя отбора');
      return;
    }
    const definition = opts.buildDefinition();
    try {
      await reload();
      const existing = rows.find((row) => row.name.toLowerCase() === name.toLowerCase());
      // Имя изменено относительно сохранённого — запись идёт КОПИЕЙ
      // (элемент ca905fbc: смена имени + «Сохранить» = «Сохранить как»).
      const target = request.asCopy ? undefined : existing;
      let saved: SavedFilterRow;
      if (target !== undefined) {
        saved = await opts.store.update(target.id, { name, definition });
      } else {
        saved = await opts.store.create(name, definition);
      }
      opts.setSelectedId(saved.id);
      opts.setName(name);
      opts.onSaved?.({ id: saved.id, name, definition });
    } catch (err) {
      errorDialog('Сохранить отбор', err);
      return;
    }
    opts.onPersist?.();
    opts.onRefresh?.();
    await reload();
    notice(`Отбор «${name}» сохранён`);
  }

  async function openPicker(): Promise<void> {
    await reload();
    if (opts.beforePicker !== undefined) await opts.beforePicker();
    // Перечитывание списка в ходе диалога: предопределённые наборы ВНУТРИ
    // сессии не досоздаются (посев — только при открытии); метка пересчитывается.
    const refresh = async (): Promise<void> => {
      await reload();
    };
    openSavedFilterDialog({
      entries: () => rows,
      selectedId: () => opts.getSelectedId(),
      onPick: (entry) => {
        opts.applyEntry(entry);
        opts.setName(entry.name);
      },
      onRename: async (entry) => {
        const name = (await promptDialog('Переименовать отбор', 'Имя', entry.name) ?? '').trim();
        if (name === '' || name === entry.name) return null;
        try {
          await opts.store.update(entry.id, { name });
        } catch (err) {
          errorDialog('Переименовать отбор', err);
          return null;
        }
        await refresh();
        opts.onRenamed?.(entry.id, name);
        opts.onPersist?.();
        opts.onRefresh?.();
        return name;
      },
      onCopy: async (entry) => {
        const copyName = duplicateFilterName(
          entry.name,
          rows.map((row) => row.name),
        );
        try {
          const created = await opts.store.create(copyName, entry.definition);
          await refresh();
          opts.onPersist?.();
          return created.id;
        } catch (err) {
          errorDialog('Скопировать отбор', err);
          return null;
        }
      },
      onDelete: async (entry) => {
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
        if (opts.getSelectedId() === entry.id) {
          opts.setSelectedId(null);
          opts.onUnselected?.(entry.id);
        }
        opts.onPersist?.();
        opts.onRefresh?.();
        await refresh();
      },
      onRefresh: refresh,
    });
  }

  return {
    rows: () => rows,
    reload,
    syncRealtime,
    save,
    openPicker,
  };
}

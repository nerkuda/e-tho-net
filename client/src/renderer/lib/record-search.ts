/**
 * Строка поиска дневниковых записей — переиспользуемый компонент (0.10.1,
 * задача 46057359).
 *
 * Компонент собирает строку поиска того же вида и поведения, что строка поиска
 * карты (`search/search.ts`), но ищет ЗАПИСИ (хроно-комментарии) и отдаёт выбор
 * записи хозяину экрана. Общий он не только кодом: сюда же вынесены правила
 * набора (мини-синтаксис keywords), debounce/Enter, клавиатурная навигация,
 * выпадающая панель результатов, кнопка настроек и размещение зоны настроек по
 * ширине — поэтому на любом будущем экране поведение одинаково (требование 6
 * задачи).
 *
 * Отличия от строки поиска карты:
 *  * результаты — записи, а не мысли; у хитов нет облачка и групп по местам
 *    поиска: один список «Найденные записи» с датой, заголовком и сниппетом с
 *    серверной подсветкой;
 *  * настройки — две опции: «включать неактивные мысли» и «включать корзину»
 *    (речь о мыслях-целях записей). Флаги применяются КЛИЕНТСКИМ отбором
 *    результатов ({@link recordVisibleBySettings}) — серверный путь ключевых
 *    слов возвращает записи и по скрытым мыслям, а настройка решает, показывать
 *    их или нет;
 *  * панель позиционируется CSS-ом под строкой (`.record-search` —
 *    `position: relative`), JS-анкеринг, как у карты, не нужен: хост панели
 *    живёт внутри самой строки.
 *
 * Настройки строки хозяин экрана сохраняет сам (L4 `ui_state`): компонент
 * получает геттер/сеттер, поэтому переиспользуется без знания о состоянии сети.
 */

import type { ChronicleRow } from '@etn/shared';

import { div, el, fmtDate, renderHtml, span } from './dom.js';
import { t } from './i18n.js';
import { svgIcon } from './ui/icon.js';
import { iconButton } from './ui/button.js';
import { checkboxRow } from './ui/choice-row.js';
import { fieldInput } from './ui/field.js';
import { operationError } from './ui/messages.js';
import { isInsideDialog } from './dialog.js';
import { isInsideSuggestDropdown } from './suggest-dropdown.js';
import { defineKeyContext, pushKeyContext } from './keymap.js';
import { watchOutsideTap } from './ui/popover.js';
import { searchPanelClosesOnTap, searchSettingsPlacement } from './pure.js';

/** Минимальная длина запроса для запуска поиска (как у строки поиска карты). */
export const RECORD_SEARCH_MIN_QUERY = 3;
/** Задержка живого поиска по мере набора. */
export const RECORD_SEARCH_DEBOUNCE_MS = 250;
/** Сколько ближайших записей запрашивать у сервера под список совпадений. */
export const RECORD_SEARCH_MAX_RESULTS = 25;

/**
 * Настройки строки: обе опции — про МЫСЛИ-ЦЕЛИ найденных записей (требование 3
 * задачи). По умолчанию скрытые неактуальные мысли и содержимое корзины в
 * результатах не показываются.
 */
export interface RecordSearchSettings {
  includeInactive: boolean;
  includeTrashed: boolean;
}

/** Пустые настройки строки. */
export function defaultRecordSearchSettings(): RecordSearchSettings {
  return { includeInactive: false, includeTrashed: false };
}

/** Разобрать сохранённые настройки (неизвестное значение — настройки по умолчанию). */
export function parseRecordSearchSettings(raw: unknown): RecordSearchSettings {
  const next = defaultRecordSearchSettings();
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return next;
  const parsed = raw as { includeInactive?: unknown; includeTrashed?: unknown };
  if (parsed.includeInactive === true) next.includeInactive = true;
  if (parsed.includeTrashed === true) next.includeTrashed = true;
  return next;
}

/** Сериализовать настройки для L4 `ui_state`. */
export function serializeRecordSearchSettings(settings: RecordSearchSettings): string {
  return JSON.stringify({
    includeInactive: settings.includeInactive,
    includeTrashed: settings.includeTrashed,
  });
}

/**
 * Проходит ли запись по настройкам строки: у всех её мыслей-целей актуальность
 * и корзина должны быть разрешены (запись, привязанная к неактуальной мысли,
 * скрывается, пока не включена опция «включать неактивные мысли»). У записи без
 * мыслей-целей исключать нечего — она проходит.
 */
export function recordVisibleBySettings(
  row: ChronicleRow,
  settings: RecordSearchSettings,
): boolean {
  const thoughts = row.targets.flatMap((target) =>
    target.kind === 'thought' ? [target.thought] : [],
  );
  if (thoughts.length === 0) return true;
  return thoughts.every(
    (thought) =>
      (settings.includeInactive || thought.active) &&
      (settings.includeTrashed || !thought.marked_for_deletion),
  );
}

/** Параметры сборки строки поиска записей. */
export interface RecordSearchOptions {
  /** Выполнить поиск записей по мини-синтаксису keywords. */
  search: (query: string, settings: RecordSearchSettings) => Promise<ChronicleRow[]>;
  /** Выбор записи в результатах: хозяин экрана выполняет переход. */
  onPick: (row: ChronicleRow) => void;
  /** Прочитать настройки строки (L4); `null` — настроек нет. */
  loadSettings?: () => Promise<RecordSearchSettings | null>;
  /** Сохранить настройки строки (L4). */
  saveSettings?: (settings: RecordSearchSettings) => void;
  /** Плейсхолдер поля поиска. */
  placeholder?: string;
  /** Заголовок списка результатов. */
  resultsTitle?: string;
}

/** Рукоятка строки поиска записей. */
export interface RecordSearchHandle {
  /** Поле ввода (его выставляет хозяин, если нужен доступ). */
  input: HTMLInputElement;
  /** Панель результатов (для доступа хозяина в тестах/зондах). */
  host: HTMLElement;
  /** Скрыть выпадающую панель. */
  hide(): void;
  /** Текущие настройки строки. */
  settings(): RecordSearchSettings;
  /** Перерисовать панель из текущих настроек. */
  refresh(): void;
  /** Снять слушатели (размонтирование вида). */
  destroy(): void;
}

/** Одна строка результатов. */
interface HitRow {
  el: HTMLElement;
  row: ChronicleRow;
}

/**
 * Собирает строку поиска записей в переданном контейнере. Контейнер получает
 * класс `record-search`; в него кладутся поле ввода и выпадающая панель
 * результатов (позиционируется CSS-ом относительно контейнера).
 */
/** Счётчик панелей поиска записей: у каждой свой набор контекстов сочетаний. */
let recordSearchSeq = 0;

export function mountRecordSearch(
  container: HTMLElement,
  opts: RecordSearchOptions,
): RecordSearchHandle {
  let settings = defaultRecordSearchSettings();
  let timer: number | null = null;
  let cursor: number | null = null;
  let lastQuery = '';
  let destroyed = false;
  /** Идентификатор контекста панели результатов (Escape при открытой панели). */
  const panelContextId = `record-search-panel-${(recordSearchSeq += 1)}`;
  /** Снятие контекста панели результатов (пока панель открыта). */
  let releasePanelContext: (() => void) | null = null;

  const input = fieldInput({ extraClass: 'record-search-input', bare: true });
  input.type = 'text';
  input.placeholder = opts.placeholder ?? t('recordSearch.placeholder');
  input.setAttribute('aria-label', t('recordSearch.aria'));

  const panel = div('search-panel record-search-panel hidden');
  const header = div('search-panel-header');
  const toggle = iconButton({
    icon: svgIcon('filter'),
    title: t('recordSearch.settings'),
    role: 'ghost',
    class: 'search-settings-toggle',
    onClick: () => {
      settingsOpen = !settingsOpen;
      applySettingsOpen();
    },
  });
  toggle.setAttribute('aria-pressed', 'false');
  toggle.setAttribute('aria-label', t('recordSearch.settings'));
  header.append(toggle);

  const body = div('search-panel-body');
  const results = div('search-results');
  const settingsZone = div('search-settings');
  buildSettingsZone(settingsZone);
  body.append(results, settingsZone);
  panel.append(header, body);

  let settingsOpen = false;

  const applySettingsOpen = (): void => {
    settingsZone.classList.toggle('hidden', !settingsOpen);
    toggle.classList.toggle('pressed', settingsOpen);
    toggle.setAttribute('aria-pressed', settingsOpen ? 'true' : 'false');
  };

  const applySettingsPlacement = (): void => {
    const mode = searchSettingsPlacement(window.innerWidth);
    panel.classList.toggle('search-settings-side', mode === 'side');
    panel.classList.toggle('search-settings-top', mode === 'top');
  };

  function buildSettingsZone(zone: HTMLElement): void {
    zone.replaceChildren(
      checkboxRow({
        label: t('recordSearch.includeInactive'),
        checked: settings.includeInactive,
        onChange: (checked) => {
          settings = { ...settings, includeInactive: checked };
          persistSettings();
          void run();
        },
      }).row,
      checkboxRow({
        label: t('recordSearch.includeTrashed'),
        checked: settings.includeTrashed,
        onChange: (checked) => {
          settings = { ...settings, includeTrashed: checked };
          persistSettings();
          void run();
        },
      }).row,
    );
  }

  function persistSettings(): void {
    opts.saveSettings?.(settings);
  }

  /** Показать панель и запустить поиск; при первом открытии — прочитать настройки. */
  const openPanel = (): void => {
    applySettingsPlacement();
    panel.classList.remove('hidden');
    // Пока панель открыта, её контекст на стеке: Escape закрывает панель, даже
    // если фокус ушёл из поля (ADR b420b08c, задача fd3d84f4).
    releasePanelContext ??= pushKeyContext(panelContextId);
    if (!settingsLoaded) {
      settingsLoaded = true;
      void loadSettings();
    }
    if (isSearchable(lastQuery)) void run();
  };

  let settingsLoaded = false;

  async function loadSettings(): Promise<void> {
    const stored = await opts.loadSettings?.().catch(() => null);
    if (destroyed || stored === null || stored === undefined) return;
    settings = stored;
    buildSettingsZone(settingsZone);
  }

  function hidePanel(): void {
    panel.classList.add('hidden');
    cursor = null;
    releasePanelContext?.();
    releasePanelContext = null;
  }

  /** Запись строки: пометить выбранной, спрятать панель, отдать хосту. */
  function pick(row: ChronicleRow, element: HTMLElement): void {
    markSelected(element);
    hidePanel();
    input.blur();
    opts.onPick(row);
  }

  function hitRows(): HitRow[] {
    return Array.from(results.querySelectorAll<HTMLElement>('.search-hit')).flatMap((element) => {
      const id = element.dataset['recordId'] ?? '';
      const row = lastRows.find((candidate) => candidate.id === id);
      return row === undefined ? [] : [{ el: element, row }];
    });
  }

  function markSelected(element: HTMLElement): void {
    for (const node of Array.from(results.querySelectorAll('.selected'))) {
      node.classList.remove('selected');
    }
    element.classList.add('selected');
    const rows = hitRows();
    cursor = rows.findIndex((hit) => hit.el === element);
  }

  function moveCursor(delta: 1 | -1): void {
    const rows = hitRows();
    if (rows.length === 0) return;
    const base = cursor === null ? (delta === 1 ? -1 : rows.length) : cursor;
    const next = Math.min(rows.length - 1, Math.max(0, base + delta));
    cursor = next;
    rows.forEach((hit, index) => hit.el.classList.toggle('selected', index === cursor));
    rows[next]?.el.scrollIntoView?.({ block: 'nearest' });
  }

  function activeRow(): HitRow | undefined {
    if (cursor === null) return undefined;
    return hitRows()[cursor];
  }

  input.addEventListener('focus', () => openPanel());
  input.addEventListener('input', () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      void run();
    }, RECORD_SEARCH_DEBOUNCE_MS);
  });
  // Клавиатура поля поиска — через общеклиентский диспетчер (ADR b420b08c,
  // задача fd3d84f4): пока фокус в поле, его контекст на вершине стека.
  const contextId = `record-search-field-${(recordSearchSeq += 1)}`;
  const handleFieldKey = (event: KeyboardEvent): boolean => {
    if (event.key === 'Enter') {
      if (timer !== null) window.clearTimeout(timer);
      const hit = activeRow();
      if (hit !== undefined) pick(hit.row, hit.el);
      else void run();
      return true;
    } else if (event.key === 'Escape') {
      if (timer !== null) window.clearTimeout(timer);
      hidePanel();
      input.blur();
      return true;
    } else if (event.ctrlKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      const rows = hitRows();
      if (rows.length === 0) return false;
      cursor = event.key === 'ArrowUp' ? 0 : rows.length - 1;
      rows.forEach((hit, index) => hit.el.classList.toggle('selected', index === cursor));
      rows[cursor]?.el.scrollIntoView?.({ block: 'nearest' });
      return true;
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (hitRows().length === 0) return false;
      moveCursor(event.key === 'ArrowDown' ? 1 : -1);
      return true;
    }
    return false;
  };
  defineKeyContext({
    id: contextId,
    bindings: [
      { command: 'recordSearch.enter', chord: 'Enter', run: handleFieldKey },
      { command: 'recordSearch.escape', chord: 'Escape', run: handleFieldKey },
      { command: 'recordSearch.first', chord: 'Ctrl+ArrowUp', run: handleFieldKey },
      { command: 'recordSearch.last', chord: 'Ctrl+ArrowDown', run: handleFieldKey },
      { command: 'recordSearch.up', chord: 'ArrowUp', run: handleFieldKey },
      { command: 'recordSearch.down', chord: 'ArrowDown', run: handleFieldKey },
    ],
  });
  let releaseFieldContext: (() => void) | null = null;
  const onFieldFocusIn = (): void => {
    releaseFieldContext ??= pushKeyContext(contextId);
  };
  const onFieldFocusOut = (): void => {
    releaseFieldContext?.();
    releaseFieldContext = null;
  };
  input.addEventListener('focusin', onFieldFocusIn as EventListener);
  input.addEventListener('focusout', onFieldFocusOut as EventListener);

  // Закрытие кликом вне — общая механика `lib/ui` (`watchOutsideTap`), политика
  // «что удерживает панель» — общий предикат `searchPanelClosesOnTap`: клик по
  // общей выпадашке подсказок и модальному диалогу панель не прячет.
  const stopOutsideTap = watchOutsideTap(
    (target) =>
      !searchPanelClosesOnTap({
        insidePanel: container.contains(target),
        insideSuggest: isInsideSuggestDropdown(target),
        insideDialog: isInsideDialog(target),
      }),
    () => {
      if (!panel.classList.contains('hidden')) hidePanel();
    },
  );
  // Контекст панели: Escape при открытой панели, даже когда фокус не в поле
  // (раньше — document-слушатель; ADR b420b08c, задача fd3d84f4).
  defineKeyContext({
    id: panelContextId,
    bindings: [
      {
        command: 'recordSearch.panel.escape',
        chord: 'Escape',
        run: () => {
          if (!panel.classList.contains('hidden')) hidePanel();
          return true;
        },
      },
    ],
  });
  window.addEventListener('resize', applySettingsPlacement);

  /** Запрос длиннее минимума? (совпадает с правилом строки поиска карты). */
  function isSearchable(query: string): boolean {
    return query.length >= RECORD_SEARCH_MIN_QUERY;
  }

  function renderMessage(text: string): void {
    results.replaceChildren(el('p', 'search-empty', text));
    cursor = null;
  }

  let lastRows: ChronicleRow[] = [];

  async function run(): Promise<void> {
    if (destroyed) return;
    const query = input.value.trim();
    lastQuery = query;
    if (!isSearchable(query)) {
      lastRows = [];
      renderMessage(t('recordSearch.tooShort', [String(RECORD_SEARCH_MIN_QUERY)]));
      return;
    }
    renderMessage(t('common.loading'));
    try {
      const found = await opts.search(query, settings);
      if (destroyed || input.value.trim() !== query) return;
      const visible = found.filter((row) => recordVisibleBySettings(row, settings));
      lastRows = visible;
      renderResults(visible);
    } catch (err) {
      if (destroyed) return;
      results.replaceChildren(operationError(err, t('recordSearch.failed')));
    }
  }

  function renderResults(rows: ChronicleRow[]): void {
    results.replaceChildren();
    cursor = null;
    if (rows.length === 0) {
      renderMessage(t('recordSearch.empty'));
      return;
    }
    const caption = div('search-group-header');
    caption.append(span(opts.resultsTitle ?? t('recordSearch.results'), 'group-title'));
    results.append(caption);
    for (const row of rows) results.append(buildHit(row));
  }

  function buildHit(row: ChronicleRow): HTMLElement {
    const element = div('search-hit');
    element.dataset['recordId'] = row.id;
    element.dataset['key'] = `record:${row.id}`;
    const info = div('search-hit-info');
    info.style.flex = '1';
    info.style.minWidth = '0';
    const label = row.title !== null && row.title.trim() !== '' ? row.title : t('recordSearch.untitled');
    info.append(el('div', 'hit-title', `${fmtDate(row.valid_from)} — ${label}`));
    const snippet = el('div', 'hit-snippet');
    renderHtml(snippet, row.snippet);
    info.append(snippet);
    element.append(span('📅', 'search-hit-lead'), info);
    element.addEventListener('click', () => pick(row, element));
    return element;
  }

  container.classList.add('record-search');
  container.replaceChildren(input, panel);
  applySettingsOpen();
  applySettingsPlacement();

  return {
    input,
    host: panel,
    hide: hidePanel,
    settings: () => settings,
    refresh: () => {
      if (!panel.classList.contains('hidden')) void run();
    },
    destroy: () => {
      destroyed = true;
      if (timer !== null) window.clearTimeout(timer);
      releaseFieldContext?.();
      releaseFieldContext = null;
      releasePanelContext?.();
      releasePanelContext = null;
      window.removeEventListener('resize', applySettingsPlacement);
      stopOutsideTap();
    },
  };
}

/**
 * Футер редактора отбора (задача c74f17a0 ТП 11b2509a «Редактор: базовый
 * компонент»; элемент интерфейса ca905fbc «Футер редактора отбора»).
 *
 * Нижняя панель редактора: имя отбора — редактируемое поле с ✕ очистки; маркер
 * изменённости ● (появляется при отличии от сохранённого); фраза-превью отбора
 * (показывается ≤3 строк, полный текст и список ошибок — в тултипе); кнопки
 * «Сохранить» / «Применить» / «Очистить». Смена имени + «Сохранить» = сохранение
 * КОПИЕЙ. Состав кнопок — параметр профиля места применения: модальный слой
 * под-выборки передаёт свой набор («Готово»/«Отмена»), базовый футер —
 * под-проект внедрения.
 *
 * Своей модели отбора модуль не ведёт: имя, определение и фраза-превью берутся
 * из единой модели хоста (`FilterCriteriaState` — ADR 30ff83bb), маркер ●
 * вычисляется сравнением определения со снимком. Право применить отбор с красной
 * диагностикой футер снимает сам ({@link hasBlockingIssues}, требование 44d61c8a):
 * «Применить» блокируется, остальные действия остаются.
 *
 * Вид — из дизайн-системы: поле `fieldInput` + `wrapClearable` (✕ очистки —
 * фасад поля, требование e64083b5), кнопки `uiButton`. Свой CSS-модуль
 * (`styles/filter-editor.css`) несёт только роли футера, секции сортировки и
 * подсветки строк.
 *
 * Фраза-превью — точка расширения: её текст и список ошибок даёт хост
 * (`preview`), футер отвечает за показ ≤3 строк, окраску по серьёзности и
 * тултип с полным текстом и перечнем ошибок.
 */

import { div, setTooltip, span } from './dom.js';
import {
  filterIssueReason,
  hasBlockingIssues,
  worstFilterIssueSeverity,
  type FilterIssue,
} from './filter-diagnostics.js';
import { fieldInput, wrapClearable } from './ui/field.js';
import { uiButton, type ButtonRole } from './ui/button.js';
import { deepEqual } from './ui/state.js';

// ---------------------------------------------------------------------------
// Вид и имена классов
// ---------------------------------------------------------------------------

export const FILTER_FOOTER_CLASS = 'ff';
export const FILTER_FOOTER_CHANGED_CLASS = 'ff-changed';
export const FILTER_FOOTER_PREVIEW_CLASS = 'ff-preview';

/**
 * Число строк фразы-превью (элемент ca905fbc: «≤3 строк»). Значение объявлено
 * правилом CSS `.ff-preview__text` (`line-clamp`), тест сверяет их друг с другом —
 * хардкод числа в разметке не нужен.
 */
export const FILTER_FOOTER_PREVIEW_LINES = 3;

// ---------------------------------------------------------------------------
// Параметры
// ---------------------------------------------------------------------------

/** Фраза-превью и записи диагностики, которые показывает футер. */
export interface FilterFooterPreview {
  /** Фраза отбора (полный текст; показывается ≤3 строк, тултип — весь). */
  text: string;
  /** Записи диагностики: красное запрещает применение, жёлтое — нет. */
  issues?: readonly FilterIssue[];
}

/** Кнопка футера, задаваемая профилем места применения. */
export interface FilterFooterButtonSpec {
  id: string;
  label: string;
  role?: ButtonRole;
  title?: string;
  /** Заблокирована ли кнопка (например, «Применить» при красной диагностике). */
  disabled?: boolean;
  onClick: () => void;
}

/** Параметры футера редактора отбора. */
export interface FilterFooterOptions {
  /** Текущее имя отбора (поле ввода). */
  getName: () => string;
  /** Запись имени из поля в состояние хоста. */
  setName: (name: string) => void;
  /** Имя применённого сохранённого отбора; `null` — отбор ещё не сохранён. */
  savedName: () => string | null;
  /** Снимок определения на момент сохранения (для маркера ●); `null` — нет. */
  baseline: () => unknown;
  /** Текущее определение отбора (сравнивается со снимком). */
  current: () => unknown;
  /** Фраза-превью и диагностика; отсутствует — превью не рисуется. */
  preview?: () => FilterFooterPreview | undefined;
  /** Записать отбор: `asCopy` — имя изменено, сохраняем копией. */
  onSave: (request: { name: string; asCopy: boolean }) => void | Promise<void>;
  /** Применить отбор (запуск запроса). */
  onApply: () => void;
  /** Очистить условия отбора. */
  onClear: () => void;
  /** Дополнительные кнопки профиля места применения. */
  extraButtons?: readonly FilterFooterButtonSpec[];
  /** Показывать стандартный набор «Сохранить/Применить/Очистить» (по умолчанию да). */
  standardButtons?: boolean;
}

/** Рукоятка футера. */
export interface FilterFooterHandle {
  /** Корень футера — нижняя панель каркаса отбора. */
  root: HTMLElement;
  /** Перечитать маркер, превью и состояния кнопок из модели хоста. */
  refresh: () => void;
}

// ---------------------------------------------------------------------------
// Чистые помощники
// ---------------------------------------------------------------------------

/**
 * Отбор отличается от сохранённого снимка (маркер ●). Снимка нет (`null`) —
 * сравнивать не с чем: маркер не показывается (новый отбор не «изменён»).
 */
export function filterChangedAgainst(baseline: unknown, current: unknown): boolean {
  if (baseline === null || baseline === undefined) return false;
  return !deepEqual(baseline, current);
}

/**
 * Запрос записи отбора по текущему имени: имя изменено относительно сохранённого
 * (`savedName`) — «Сохранить» записывает КОПИЮ (элемент ca905fbc).
 */
export function filterSaveRequest(
  name: string,
  savedName: string | null,
): { name: string; asCopy: boolean } {
  const trimmed = name.trim();
  return { name: trimmed, asCopy: savedName !== null && savedName !== trimmed };
}

/** Показывать ли красное предупреждение «применение запрещено». */
export function filterFooterApplyBlocked(preview: FilterFooterPreview | undefined): boolean {
  return hasBlockingIssues(preview?.issues ?? []);
}

/**
 * Тултип превью: полный текст фразы и список ошибок — включая те, что редактор
 * не смог локализовать в строку (требование cf8fdd4d).
 */
export function filterFooterTooltip(preview: FilterFooterPreview): string {
  const lines: string[] = [preview.text];
  const issues = preview.issues ?? [];
  if (issues.length > 0) {
    lines.push('', ...issues.map((issue) => `• ${filterIssueReason(issue)}`));
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Сборка
// ---------------------------------------------------------------------------

/**
 * Собрать футер редактора отбора. Возвращает корень (кладётся в футер каркаса) и
 * `refresh` — перечитать маркер/превью/состояния кнопок из модели хоста.
 */
export function buildFilterFooter(opts: FilterFooterOptions): FilterFooterHandle {
  const root = div(FILTER_FOOTER_CLASS);

  // --- Имя отбора: поле с ✕ очистки + маркер изменённости ------------------
  const nameRow = div('ff-name');
  const nameInput = fieldInput({
    type: 'text',
    placeholder: 'имя отбора',
    maxLength: 200,
    ariaLabel: 'Имя отбора',
    extraClass: 'ff-name__input',
    value: opts.getName(),
    onInput: (value) => {
      opts.setName(value);
      refresh();
    },
  });
  const clearName = (): void => {
    opts.setName('');
    nameInput.value = '';
    refresh();
  };
  const changed = span('●', FILTER_FOOTER_CHANGED_CLASS);
  setTooltip(changed, 'отбор изменён с момента сохранения');
  nameRow.append(wrapClearable(nameInput, clearName), changed);
  root.append(nameRow);

  // --- Фраза-превью: ≤3 строк, полный текст и ошибки — в тултипе ----------
  const previewBox = div(FILTER_FOOTER_PREVIEW_CLASS);
  const previewText = span('', 'ff-preview__text');
  previewBox.append(previewText);
  if (opts.preview !== undefined) root.append(previewBox);

  // --- Кнопки: стандартный набор + кнопки профиля места применения --------
  const save = (): void => {
    void opts.onSave(filterSaveRequest(opts.getName(), opts.savedName()));
  };
  const actions = div('ff-actions');
  let applyButton: HTMLButtonElement | null = null;
  if (opts.standardButtons !== false) {
    const saveNode = uiButton({
      label: 'Сохранить',
      role: 'secondary',
      class: 'ff-save',
      title: 'Записать настройки отбора',
      onClick: save,
    });
    const applyNode = uiButton({
      label: 'Применить',
      role: 'primary',
      class: 'ff-apply',
      title: 'Применить отбор',
      onClick: () => opts.onApply(),
    });
    const clearNode = uiButton({
      label: 'Очистить',
      role: 'secondary',
      class: 'ff-clear',
      title: 'Очистить условия отбора',
      onClick: () => opts.onClear(),
    });
    applyButton = applyNode;
    actions.append(saveNode, applyNode, clearNode);
  }
  for (const spec of opts.extraButtons ?? []) {
    actions.append(
      uiButton({
        label: spec.label,
        role: spec.role ?? 'secondary',
        class: `ff-extra ff-extra--${spec.id}`,
        title: spec.title,
        disabled: spec.disabled,
        onClick: spec.onClick,
      }),
    );
  }
  root.append(actions);

  // --- Обновление представления из модели ---------------------------------
  function refresh(): void {
    const name = opts.getName();
    if (nameInput.value !== name) nameInput.value = name;
    changed.hidden = !filterChangedAgainst(opts.baseline(), opts.current());

    if (opts.preview !== undefined) {
      const preview = opts.preview();
      if (preview !== undefined) {
        const issues = preview.issues ?? [];
        previewText.textContent = preview.text;
        setTooltip(previewBox, filterFooterTooltip(preview));
        const severity = worstFilterIssueSeverity(issues);
        if (severity === null) delete previewBox.dataset['severity'];
        else previewBox.dataset['severity'] = severity;
        if (applyButton !== null) applyButton.disabled = filterFooterApplyBlocked(preview);
      }
    }
  }

  refresh();
  return { root, refresh };
}

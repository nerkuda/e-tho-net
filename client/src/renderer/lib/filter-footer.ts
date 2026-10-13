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
  firstLocalizedErrorIssue,
  hasBlockingIssues,
  worstFilterIssueSeverity,
  type FilterIssue,
} from './filter-diagnostics.js';
import {
  composeFilterPhrase,
  type FilterPhraseContext,
  type FilterPhraseState,
} from './filter-phrase.js';
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

/**
 * Источник фразы-превью по умолчанию: состояние отбора из единой модели и
 * контекст композера (`lib/filter-phrase.ts`, задача 3cb50258). Задан — футер
 * строит фразу сам; явный `preview` хоста сильнее (хосту виднее диагностика).
 */
export interface FilterFooterPhraseSource {
  /** Текущее состояние отбора (дерево + ключи сортировки). */
  state: () => FilterPhraseState;
  /** Данные подписей и предел длины фразы. */
  phrase: FilterPhraseContext;
}

/** Параметры футера редактора отбора. */
export interface FilterFooterOptions {
  /**
   * Текущее имя отбора (поле ввода). Не задан — у места НЕТ сохранённых
   * отборов (лента «События»): строка имени и маркер ● не рисуются, остаются
   * фраза-превью и кнопки места.
   */
  getName?: () => string;
  /** Запись имени из поля в состояние хоста. */
  setName?: (name: string) => void;
  /** Имя применённого сохранённого отбора; `null` — отбор ещё не сохранён. */
  savedName: () => string | null;
  /** Снимок определения на момент сохранения (для маркера ●); `null` — нет. */
  baseline: () => unknown;
  /** Текущее определение отбора (сравнивается со снимком). */
  current: () => unknown;
  /** Фраза-превью и диагностика; отсутствует — превью не рисуется. */
  preview?: () => FilterFooterPreview | undefined;
  /**
   * Источник фразы-превью из композера: используется, когда `preview` не задан
   * (элемент ca905fbc; пустая фраза — превью не рисуется).
   */
  phrase?: FilterFooterPhraseSource;
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
  /**
   * Переход к проблемной строке из сообщения о запрете применения (требования
   * 0fd1dc5d, 44d61c8a). Кнопка «исправить» появляется только когда применение
   * запрещено (красное) и у записи есть адрес строки; саму логику перехода
   * держит каркас дерева — футер лишь передаёт адрес.
   */
  onFixIssue?: (path: string) => void;
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

/**
 * Стандартный источник превью из композера: фраза дерева с хвостом сортировки
 * (задача 3cb50258, элемент ca905fbc). Пустая фраза — «превью нет»: отбор без
 * условий и сортировки футер не подписывает.
 */
export function filterFooterPhrasePreview(source: FilterFooterPhraseSource): FilterFooterPreview | undefined {
  const text = composeFilterPhrase(source.state(), source.phrase);
  return text === '' ? undefined : { text };
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
  /** Маркер ● у строки имени (нет строки — нет и маркера). */
  let nameChangedMarker: HTMLElement | null = null;

  // --- Имя отбора: поле с ✕ очистки + маркер изменённости ------------------
  // Место без сохранённых отборов (getName не задан) имя не рисует: у него нет
  // ни записи, ни маркера «изменён относительно сохранённого».
  const getName = opts.getName;
  let nameInput: HTMLInputElement | null = null;
  if (getName !== undefined) {
    const nameRow = div('ff-name');
    nameInput = fieldInput({
      type: 'text',
      placeholder: 'имя отбора',
      maxLength: 200,
      ariaLabel: 'Имя отбора',
      extraClass: 'ff-name__input',
      value: getName(),
      onInput: (value) => {
        opts.setName?.(value);
        refresh();
      },
    });
    const clearName = (): void => {
      opts.setName?.('');
      if (nameInput !== null) nameInput.value = '';
      refresh();
    };
    const changed = span('●', FILTER_FOOTER_CHANGED_CLASS);
    setTooltip(changed, 'отбор изменён с момента сохранения');
    nameRow.append(wrapClearable(nameInput, clearName), changed);
    root.append(nameRow);
    /** Маркер ● (вне области видимости `refresh` ниже). */
    nameChangedMarker = changed;
  }

  // --- Фраза-превью: ≤3 строк, полный текст и ошибки — в тултипе ----------
  // Фраза — из композера, если хост не дал свою (`preview` сильнее: хосту виднее
  // диагностика). Ни того, ни другого — превью не рисуется.
  const phraseSource = opts.phrase;
  const previewFn =
    opts.preview ??
    (phraseSource === undefined ? undefined : () => filterFooterPhrasePreview(phraseSource));
  const previewBox = div(FILTER_FOOTER_PREVIEW_CLASS);
  const previewText = span('', 'ff-preview__text');
  previewBox.append(previewText);
  if (previewFn !== undefined) root.append(previewBox);

  // --- Кнопки: стандартный набор + кнопки профиля места применения --------
  const save = (): void => {
    void opts.onSave(filterSaveRequest(getName?.() ?? '', opts.savedName()));
  };
  const actions = div('ff-actions');
  let applyButton: HTMLButtonElement | null = null;
  // Кнопка «исправить» — переход к проблемной строке из сообщения о запрете
  // (требования 0fd1dc5d, 44d61c8a). Живёт в футере, а логику перехода держит
  // каркас дерева; показывается только при запрещённом применении с адресом.
  let fixButton: HTMLButtonElement | null = null;
  /** Адрес строки, к которой ведёт текущая кнопка «исправить». */
  let fixPath: string | null = null;
  if (opts.onFixIssue !== undefined) {
    fixButton = uiButton({
      label: 'исправить',
      role: 'ghost',
      size: 's',
      class: 'ff-fix',
      title: 'Перейти к строке с ошибкой',
      onClick: () => {
        if (fixPath !== null) opts.onFixIssue?.(fixPath);
      },
    });
    fixButton.hidden = true;
    actions.append(fixButton);
  }
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
    if (getName !== undefined && nameInput !== null) {
      const name = getName();
      if (nameInput.value !== name) nameInput.value = name;
    }
    if (nameChangedMarker !== null) {
      nameChangedMarker.hidden = !filterChangedAgainst(opts.baseline(), opts.current());
    }

    if (previewFn !== undefined) {
      const preview = previewFn();
      if (preview === undefined) {
        // Фразы нет (пустой отбор) — подпись снимается, запрет применения тоже.
        previewText.textContent = '';
        delete previewBox.dataset['severity'];
        if (applyButton !== null) applyButton.disabled = false;
        if (fixButton !== null) {
          fixButton.hidden = true;
          fixPath = null;
        }
      } else {
        const issues = preview.issues ?? [];
        previewText.textContent = preview.text;
        setTooltip(previewBox, filterFooterTooltip(preview));
        const severity = worstFilterIssueSeverity(issues);
        if (severity === null) delete previewBox.dataset['severity'];
        else previewBox.dataset['severity'] = severity;
        const blocked = filterFooterApplyBlocked(preview);
        if (applyButton !== null) applyButton.disabled = blocked;
        if (fixButton !== null) {
          // Переход есть только к ЛОКАЛИЗОВАННОЙ красной записи: сообщение о
          // запрете без адреса строки переводить некуда (требование 0fd1dc5d).
          const target = blocked ? firstLocalizedErrorIssue(issues) : null;
          fixPath = target === null ? null : target.path;
          fixButton.hidden = fixPath === null;
        }
      }
    }
  }

  refresh();
  return { root, refresh };
}

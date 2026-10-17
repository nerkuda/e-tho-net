/**
 * Футер редактора отбора (задача c74f17a0 ТП 11b2509a «Редактор: базовый
 * компонент»; элемент интерфейса ca905fbc «Футер редактора отбора»).
 *
 * Нижняя панель редактора: имя отбора — редактируемое поле с ✕ очистки; маркер
 * изменённости ● (появляется при отличии от сохранённого); фраза-превью отбора
 * (показывается ≤3 строк, полный текст и список ошибок — в тултипе); кнопки.
 * Смена имени + «Сохранить» = сохранение КОПИЕЙ. Состав кнопок — параметр
 * профиля места применения: модальный слой под-выборки передаёт свой набор
 * («Готово»/«Отмена»), базовый футер — под-проект внедрения.
 *
 * Компоновка футера — ДВУХРЯДНАЯ, как на прежней панели отборов (решение
 * заказчика 2026-10-14, ошибка 4258e694 п.2):
 *   • ВЕРХНИЙ ряд (`.ff-actions`) — действия над ТЕКУЩИМ отбором и его
 *     результатами: «Применить», «Очистить», кнопки места (`place: 'actions'`);
 *   • НИЖНИЙ ряд (`.ff-name`) — манипуляции с СОХРАНЁННЫМИ отборами: поле имени,
 *     «Сохранить» (иконка 💾), ✕ очистки имени, кнопки места (`place: 'name'` —
 *     «…» выбора сохранённого отбора).
 * Оба ряда лежат в непрокручиваемом низу редактора (`.fe-foot`), с деревом
 * условий не уезжают.
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
 * Фраза-превью — точка расширения: её текст, токены раскраски и список ошибок
 * даёт хост (`preview`), футер отвечает за показ ≤3 строк, окраску по серьёзности
 * и тултип с полным текстом и перечнем ошибок. Когда красная запись запрещает
 * применение и у неё есть адрес строки, текст фразы становится точкой перехода
 * к проблемной строке (клик) — отдельной кнопки «исправить» нет (требование
 * заказчика 2026-10-14, п.10).
 *
 * Раскраска фразы (правка заказчика 2026-10-14, п.12в; задача 58f77990): строка
 * фразы и её тултип собираются ИЗ ОДНИХ токенов композера — операторы И/ИЛИ/НЕ
 * и скобки уровней вложенности отдельными спанами (`ff-ph-op--*`,
 * `ff-ph-paren--t*`, цвета — токены темы). Разметка строится ТОЛЬКО узлами
 * (`renderFilterPhrase`, `innerHTML` не используется), поэтому имена мыслей и
 * значения во фразу попадают текстом и разметкой стать не могут. Тултип —
 * элемент `.ff-preview__tip` (нативный `title` разметку не умеет), показывается
 * наведением/фокусом; текстовая форма тултипа (`filterFooterTooltip`) остаётся
 * для потребителей без DOM.
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
  filterPhraseTokens,
  type FilterPhraseContext,
  type FilterPhraseOperator,
  type FilterPhraseState,
  type FilterPhraseToken,
} from './filter-phrase.js';
// Цикл тонов вложенности — ОДИН источник на дерево и фразу (`filterTreeToneIndex`).
import { filterTreeToneIndex } from './filter-tree.js';
import { fieldInput, wrapClearable } from './ui/field.js';
import { iconButton, uiButton, type ButtonRole } from './ui/button.js';
import { svgIcon } from './ui/icon.js';
import { deepEqual } from './ui/state.js';

// ---------------------------------------------------------------------------
// Вид и имена классов
// ---------------------------------------------------------------------------

export const FILTER_FOOTER_CLASS = 'ff';
export const FILTER_FOOTER_CHANGED_CLASS = 'ff-changed';
export const FILTER_FOOTER_PREVIEW_CLASS = 'ff-preview';
/**
 * Класс текста фразы, когда клик по нему ведёт к проблемной строке
 * (требование заказчика 2026-10-14, п.10): отдельной кнопки «исправить» нет.
 */
export const FILTER_FOOTER_PREVIEW_ACTION_CLASS = 'ff-preview__text--action';

/**
 * Класс горизонтальной линии-разделителя между фразой-превью и командами
 * (имя отбора + кнопки) — требование заказчика 2026-10-14, п.1: фраза относится
 * к редактору отбора, имя и кнопки — команды места применения.
 */
export const FILTER_FOOTER_DIVIDER_CLASS = 'ff-divider';

/**
 * Число строк фразы-превью (элемент ca905fbc: «≤3 строк»). Значение объявлено
 * правилом CSS `.ff-preview__text` (`line-clamp`), тест сверяет их друг с другом —
 * хардкод числа в разметке не нужен.
 */
export const FILTER_FOOTER_PREVIEW_LINES = 3;

/**
 * Класс тултипа фразы (задача 58f77990, п.12в): подсказка несёт ТУ ЖЕ разметку
 * раскраски, что и строка фразы. Нативный `title` разметку не умеет, поэтому
 * тултип — элемент превью, показываемый наведением/фокусом (`styles/filter-editor.css`).
 */
export const FILTER_FOOTER_TIP_CLASS = 'ff-preview__tip';

/** Базовый класс токена-оператора коннекции во фразе. */
export const FILTER_FOOTER_OPERATOR_BASE_CLASS = 'ff-ph-op';

/** Базовый класс токена-скобки во фразе. */
export const FILTER_FOOTER_PAREN_BASE_CLASS = 'ff-ph-paren';

/**
 * Классы операторов коннекции И/ИЛИ/НЕ (цвета — `styles/filter-editor.css`,
 * токены темы; hex в модуле и его CSS нет).
 */
export const FILTER_FOOTER_OPERATOR_CLASSES: Readonly<Record<FilterPhraseOperator, string>> = {
  and: `${FILTER_FOOTER_OPERATOR_BASE_CLASS} ${FILTER_FOOTER_OPERATOR_BASE_CLASS}--and`,
  or: `${FILTER_FOOTER_OPERATOR_BASE_CLASS} ${FILTER_FOOTER_OPERATOR_BASE_CLASS}--or`,
  not: `${FILTER_FOOTER_OPERATOR_BASE_CLASS} ${FILTER_FOOTER_OPERATOR_BASE_CLASS}--not`,
};

/**
 * Класс скобки по уровню вложенности группы: тон берётся из цикла тонов
 * вложенности дерева условий ({@link filterTreeToneIndex}, `lib/filter-tree.ts`) —
 * источник тонов один, второго словаря цветов нет. Цвета классов — токены темы.
 */
export function filterPhraseParenClass(depth: number): string {
  return `${FILTER_FOOTER_PAREN_BASE_CLASS} ${FILTER_FOOTER_PAREN_BASE_CLASS}--t${filterTreeToneIndex(depth) + 1}`;
}

/**
 * Токен фразы узлом разметки: текст — инертный спан-текст (пользовательские
 * данные идут текстом, разметку из имени мысли собрать нельзя), оператор и
 * скобка — спаны раскраски. `innerHTML` не используется нигде: фраза собирается
 * узлами, поэтому экранирование не требуется по построению.
 */
export function filterPhraseTokenNode(token: FilterPhraseToken): HTMLSpanElement {
  if (token.kind === 'operator' && token.operator !== undefined) {
    return span(token.text, FILTER_FOOTER_OPERATOR_CLASSES[token.operator]);
  }
  if (token.kind === 'paren') return span(token.text, filterPhraseParenClass(token.depth ?? 0));
  return span(token.text);
}

/**
 * Заполняет узел разметкой фразы. Токенов нет (хост дал только текст) —
 * текстовая деградация: текст кладётся текстом, а не разметкой. Прежний текст
 * снимается ДО вставки узлов: `replaceChildren` шима не чистит `textContent`,
 * а в реальном DOM сброс `textContent` безопасен — узлы ставятся следом.
 */
export function renderFilterPhrase(
  host: HTMLElement,
  tokens: readonly FilterPhraseToken[] | undefined,
  text: string,
): void {
  if (tokens === undefined || tokens.length === 0) {
    host.textContent = text;
    host.replaceChildren();
    return;
  }
  host.textContent = '';
  host.replaceChildren(...tokens.map((token) => filterPhraseTokenNode(token)));
}

// ---------------------------------------------------------------------------
// Параметры
// ---------------------------------------------------------------------------

/** Фраза-превью и записи диагностики, которые показывает футер. */
export interface FilterFooterPreview {
  /** Фраза отбора (полный текст; показывается ≤3 строк, тултип — весь). */
  text: string;
  /**
   * Токены раскраски фразы (задача 58f77990, п.12в): из них собирается И строка
   * фразы, И тултип — разметка одна. Не заданы (хост дал только текст) —
   * текстовая деградация без раскраски.
   */
  tokens?: readonly FilterPhraseToken[];
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
  /**
   * Ряд компоновки футера (решение заказчика 2026-10-14, ошибка 4258e694 п.2):
   * `actions` (по умолчанию) — верхний ряд действий над отбором; `name` —
   * нижний ряд манипуляций с сохранёнными отборами, рядом с полем имени
   * (кнопка «…» выбора сохранённого). Без строки имени кнопка `name` уходит в
   * верхний ряд — потерять её нельзя.
   */
  place?: 'actions' | 'name';
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
   * 0fd1dc5d, 44d61c8a). Срабатывает ПО КЛИКУ НА ТЕКСТ фразы, когда применение
   * запрещено (красное) и у записи есть адрес строки; отдельной кнопки
   * «исправить» нет (требование заказчика 2026-10-14, п.10). Саму логику
   * перехода держит каркас дерева — футер лишь передаёт адрес.
   */
  onFixIssue?: (path: string) => void;
}

/** Рукоятка футера. */
export interface FilterFooterHandle {
  /** Корень футера — нижняя панель каркаса отбора. */
  root: HTMLElement;
  /**
   * Строка имени отбора (`.ff-name`) — `null`, если у места нет сохранённых
   * отборов. Отдаётся хосту, чтобы он мог ПЕРЕМЕСТИТЬ её (диалог отбора типа
   * ставит имя ПЕРВЫМ полем — ошибка 50d9bf4e п. A1): реализация строки остаётся
   * одна, футер лишь перестаёт ею владеть в разметке.
   */
  nameRow: HTMLElement | null;
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
 * Подсказка о переходе к проблемной строке — ОДИН текст на текстовый тултип
 * ({@link filterFooterTooltip}) и на разметочный тултип фразы.
 */
export const FILTER_FOOTER_TIP_HINT = 'Нажмите на текст, чтобы перейти к строке с ошибкой';

/** Классы частей разметочного тултипа фразы (вид — `styles/filter-editor.css`). */
const TIP_ISSUES_CLASS = 'ff-preview__tip-issues';
const TIP_ISSUE_CLASS = 'ff-preview__tip-issue';
const TIP_HINT_CLASS = 'ff-preview__tip-hint';

/**
 * Тултип превью: полный текст фразы и список ошибок — включая те, что редактор
 * не смог локализовать в строку (требование cf8fdd4d). Это ТЕКСТОВАЯ форма для
 * потребителей без DOM; футер показывает тултип разметкой (`fillPreviewTip`).
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
 * (задача 3cb50258, элемент ca905fbc) — токенами раскраски и строкой (задача
 * 58f77990). Пустая фраза — «превью нет»: отбор без условий и сортировки футер
 * не подписывает.
 */
export function filterFooterPhrasePreview(source: FilterFooterPhraseSource): FilterFooterPreview | undefined {
  const tokens = filterPhraseTokens(source.state(), source.phrase);
  if (tokens.length === 0) return undefined;
  return { text: tokens.map((token) => token.text).join(''), tokens };
}

/**
 * Наполняет тултип фразы той же разметкой, что и строку фразы, плюс список
 * ошибок и подсказка о переходе (задача 58f77990, п.12в). Строку и тултип
 * собирает одна функция ({@link renderFilterPhrase}) — разойтись не могут.
 */
function fillPreviewTip(tip: HTMLElement, preview: FilterFooterPreview, fixPath: string | null): void {
  const line = span('');
  renderFilterPhrase(line, preview.tokens, preview.text);
  const parts: Node[] = [line];
  const issues = preview.issues ?? [];
  if (issues.length > 0) {
    const list = div(TIP_ISSUES_CLASS);
    for (const issue of issues) list.append(span(`• ${filterIssueReason(issue)}`, TIP_ISSUE_CLASS));
    parts.push(list);
  }
  if (fixPath !== null) parts.push(span(FILTER_FOOTER_TIP_HINT, TIP_HINT_CLASS));
  tip.textContent = '';
  tip.replaceChildren(...parts);
}

/** Кнопка профиля места применения — общий вид для обоих рядов футера. */
function footerExtraButton(spec: FilterFooterButtonSpec): HTMLButtonElement {
  return uiButton({
    label: spec.label,
    role: spec.role ?? 'secondary',
    class: `ff-extra ff-extra--${spec.id}`,
    title: spec.title,
    disabled: spec.disabled,
    onClick: spec.onClick,
  });
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

  // Кнопка «Сохранить» строится ЗАРАНЕЕ: она стоит в НИЖНЕМ ряду рядом с полем
  // имени (иконка 💾, как на прежней панели отборов — решение заказчика
  // 2026-10-14, ошибка 4258e694 п.2). Без строки имени — уходит в верхний ряд.
  const save = (): void => {
    void opts.onSave(filterSaveRequest(getName?.() ?? '', opts.savedName()));
  };
  const saveNode =
    opts.standardButtons !== false
      ? iconButton({
          icon: svgIcon('save', 15),
          role: 'secondary',
          size: 's',
          class: 'ff-save',
          title: 'Записать настройки отбора',
          onClick: save,
        })
      : null;

  // --- Имя отбора: поле с ✕ очистки + маркер изменённости + «Сохранить» -----
  // Место без сохранённых отборов (getName не задан) имя не рисует: у него нет
  // ни записи, ни маркера «изменён относительно сохранённого».
  const getName = opts.getName;
  const hasNameRow = getName !== undefined;
  /** Кнопки нижнего ряда (`place: 'name'`): рядом с именем; без строки — вверху. */
  const nameRowButtons = (): readonly FilterFooterButtonSpec[] =>
    hasNameRow ? (opts.extraButtons ?? []).filter((spec) => spec.place === 'name') : [];
  let nameInput: HTMLInputElement | null = null;
  /**
   * Строка имени (`.ff-name`) собирается здесь, но кладётся в футер ПОСЛЕ
   * фразы-превью и её разделителя (порядок «фраза → линия → имя + кнопки»,
   * требование заказчика 2026-10-14, п.1).
   */
  let nameRowEl: HTMLElement | null = null;
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
    if (saveNode !== null) nameRow.append(saveNode);
    for (const spec of nameRowButtons()) nameRow.append(footerExtraButton(spec));
    nameRowEl = nameRow;
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
  /** Тултип фразы: та же разметка раскраски (нативный `title` её не умеет). */
  const previewTip = div(FILTER_FOOTER_TIP_CLASS);
  previewBox.append(previewText, previewTip);
  // Разделитель под фразой: отделяет «редактор отбора» (фраза) от команд —
  // имени отбора и кнопок (требование заказчика 2026-10-14, п.1).
  const divider = div(FILTER_FOOTER_DIVIDER_CLASS);
  if (previewFn !== undefined) root.append(previewBox, divider);

  // Переход к проблемной строке из сообщения о запрете (требования 0fd1dc5d,
  // 44d61c8a) — ПО КЛИКУ НА САМ ТЕКСТ фразы, отдельной кнопки «исправить» нет
  // (требование заказчика 2026-10-14, п.10). Логику перехода держит каркас
  // дерева; футер лишь передаёт адрес записи. Адрес есть только у ЛОКАЛИЗОВАННОЙ
  // красной записи — тогда текст помечается классом-действием.
  /** Адрес строки, к которой ведёт текущий клик по тексту; `null` — перехода нет. */
  let fixPath: string | null = null;
  previewText.addEventListener('click', () => {
    if (fixPath !== null) opts.onFixIssue?.(fixPath);
  });

  // --- Кнопки: стандартный набор + кнопки профиля места применения --------
  const actions = div('ff-actions');
  let applyButton: HTMLButtonElement | null = null;
  if (opts.standardButtons !== false) {
    // «Сохранить» уже стоит в строке имени (если строка есть); иначе — здесь.
    if (saveNode !== null && getName === undefined) actions.append(saveNode);
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
    actions.append(applyNode, clearNode);
  }
  // Кнопки места верхнего ряда: всё, что не ушло в строку имени (кнопки
  // `place: 'name'` при наличии строки уже нарисованы там).
  for (const spec of opts.extraButtons ?? []) {
    if (nameRowButtons().includes(spec)) continue;
    actions.append(footerExtraButton(spec));
  }
  // Порядок футера (сверху вниз): фраза-превью → линия-разделитель → строка
  // имени → ряд кнопок (требование заказчика 2026-10-14, п.1). Фраза и линия уже
  // добавлены; строка имени идёт перед кнопками.
  if (nameRowEl !== null) root.append(nameRowEl);
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
        // Фразы нет (пустой отбор) — подпись снимается, тултип прячется, запрет
        // применения тоже.
        renderFilterPhrase(previewText, undefined, '');
        previewText.classList.remove(FILTER_FOOTER_PREVIEW_ACTION_CLASS);
        delete previewBox.dataset['severity'];
        previewTip.style.display = 'none';
        previewTip.replaceChildren();
        if (applyButton !== null) applyButton.disabled = false;
        fixPath = null;
      } else {
        const issues = preview.issues ?? [];
        // Фраза и её тултип — ОДНА разметка из одних токенов (п.12в).
        renderFilterPhrase(previewText, preview.tokens, preview.text);
        const severity = worstFilterIssueSeverity(issues);
        if (severity === null) delete previewBox.dataset['severity'];
        else previewBox.dataset['severity'] = severity;
        const blocked = filterFooterApplyBlocked(preview);
        if (applyButton !== null) applyButton.disabled = blocked;
        // Переход есть только к ЛОКАЛИЗОВАННОЙ красной записи: сообщение о
        // запрете без адреса строки переводить некуда (требование 0fd1dc5d).
        const target = blocked ? firstLocalizedErrorIssue(issues) : null;
        fixPath = target === null ? null : target.path;
        previewText.classList.toggle(FILTER_FOOTER_PREVIEW_ACTION_CLASS, fixPath !== null);
        // Тултип показывается, когда есть что показать: фразу или диагностику.
        fillPreviewTip(previewTip, preview, fixPath);
        if (preview.text !== '' || issues.length > 0) {
          previewTip.style.display = '';
        } else {
          previewTip.style.display = 'none';
          previewTip.replaceChildren();
        }
      }
      // Линия-разделитель есть только под непустой фразой: пустой отбор не
      // отделяет «ничего» от команд (п.1).
      divider.hidden = preview === undefined || preview.text === '';
    }
  }

  refresh();
  return { root, nameRow: nameRowEl, refresh };
}

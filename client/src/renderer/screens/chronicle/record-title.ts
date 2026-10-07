/**
 * Заголовок дневниковой записи — ЕДИНЫЙ компонент «просмотр ↔ правка» (0.10.2,
 * ошибка 36c330a3; элемент «Лента дневных записей» e01f383a, требование 165323a7).
 *
 * Заголовок одинаков в карточке существующей записи и в слоте создания
 * («Добавить запись дневника»). Раньше их собирали двумя независимыми
 * реализациями, и поведение расходилось: в карточке `Enter` завершал правку, а
 * в слоте заголовок был голым полем без обработчика `Enter` — нажатие не делало
 * ничего, запись создавалась только по `blur`. Здесь пара «просмотр/правка»
 * живёт в одном месте, и оба потребителя обязаны брать её отсюда (сторож
 * `guard-chronicle-record-title`).
 *
 * Контракт:
 *  • ПРОСМОТР — кнопка-заголовок (класс {@link RECORD_TITLE_CLASS}). У
 *    сворачиваемой записи перед надписью индикатор-стрелка `chevron-down`:
 *    одиночный клик откладывается на время двойного (`deferSingleClick`) и
 *    сворачивает ТЕЛО, двойной клик входит в правку. Узел кнопки создаётся ОДИН
 *    раз и не пересоздаётся при смене надписи — иначе терялись бы класс
 *    `is-collapsed` (поворот стрелки, задача 472457bf) и фокус.
 *  • ПРАВКА — поле ввода (классы {@link RECORD_TITLE_CLASS} +
 *    {@link RECORD_TITLE_INPUT_CLASS}): `Enter` завершает правку и возвращает
 *    заголовок в просмотр, `Escape` отменяет, уход фокуса (`blur`) завершает.
 *    Пока поле в фокусе, сворачивание записи недоступно (клавиши — вводу).
 *
 * Модуль оперирует только DOM (без Electron/сети) и проверяется DOM-тестом на
 * шиме. Классы заголовка объявлены в `./record-groups.ts` — там же живёт
 * in-place сворачивание и поиск карточки/дня.
 */

import { fieldInput } from '../../lib/ui/field.js';
import { defineKeyContext, pushKeyContext } from '../../lib/keymap.js';
import { modifierChordVariants } from '../../lib/keymap-chords.js';
import { uiButton } from '../../lib/ui/button.js';
import { svgIcon } from '../../lib/ui/icon.js';
import { deferSingleClick } from '../../lib/thought-cloud.js';
import { RECORD_TITLE_CLASS, RECORD_TITLE_INPUT_CLASS } from './record-groups.js';

/** Опции компонента заголовка записи. */
export interface RecordTitleOptions {
  /** Начальное значение (поле `title` записи; у слота — пусто). */
  value?: string;
  /** Надпись в режиме ПРОСМОТРА (производный заголовок либо «Пустая запись»). */
  label: string;
  /** Подсказка кнопки-заголовка (как войти в правку). */
  editHint: string;
  /** Приглашение пустого поля правки. */
  placeholder: string;
  /** Предел длины поля (по умолчанию 200). */
  maxLength?: number;
  /**
   * Сворачиваемая ли группа: рисует индикатор-стрелку и реагирует на одиночный
   * клик (по умолчанию `true`). `false` оставляет только правку по двойному
   * клику.
   */
  collapsible?: boolean;
  /** Одиночный клик в просмотре (сворачивание/разворачивание тела записи). */
  onToggle?: () => void;
  /**
   * Завершение правки с сохранением: получает введённое значение, возвращает
   * новую надпись просмотра. Вызывается и по `Enter`, и по `blur`.
   */
  onCommit?: (value: string) => string;
  /** Отмена правки (`Escape`): значение не сохраняется. */
  onCancel?: () => void;
}

/** Публичный дескриптор компонента заголовка. */
export interface RecordTitleHandle {
  /** Текущий корневой узел (кнопка просмотра или поле правки). */
  node(): HTMLElement;
  /** Текущее значение заголовка (последнее показанное). */
  value(): string;
  /** Открыта ли правка сейчас. */
  isEditing(): boolean;
  /** Войти в правку (уже в правке — сфокусировать поле). */
  beginEdit(): void;
  /** Завершить правку: `commit` — сохранить, иначе отменить. */
  endEdit(commit: boolean, refocus: boolean): void;
}

/**
 * Обновить надпись кнопки-заголовка, сохранив индикатор-стрелку (первый узел):
 * `textContent` затирает дочерние узлы вместе с `svg`, поэтому содержимое
 * собирается заново — индикатор, затем новый текст (задача 472457bf,
 * d586f340).
 */
export function setRecordTitleLabel(view: HTMLElement, label: string): void {
  const icon = view.firstChild;
  if (icon === null) {
    view.textContent = label;
    return;
  }
  view.replaceChildren(icon, label);
}

/** Счётчик правок заголовка записи: уникальный id контекста клавиатуры. */
let recordTitleEditSeq = 0;

/** Создать компонент заголовка записи. */
export function createRecordTitle(opts: RecordTitleOptions): RecordTitleHandle {
  const collapsible = opts.collapsible !== false;
  const maxLength = opts.maxLength ?? 200;
  let value = opts.value ?? '';
  let label = opts.label;
  let field: HTMLInputElement | null = null;
  /** Снятие контекста клавиатуры активной правки (null — правки нет). */
  let releaseEditContext: (() => void) | null = null;
  let pendingClick: { cancel: () => void } | null = null;

  function buildView(): HTMLButtonElement {
    const view = uiButton({
      label,
      role: 'ghost',
      class: RECORD_TITLE_CLASS,
      title: opts.editHint,
      onClick: () => {
        pendingClick?.cancel();
        pendingClick = deferSingleClick(() => {
          pendingClick = null;
          opts.onToggle?.();
        });
      },
    });
    if (collapsible) view.prepend(svgIcon('chevron-down', 18));
    view.addEventListener('dblclick', (event) => {
      event.preventDefault();
      pendingClick?.cancel();
      pendingClick = null;
      beginEdit();
    });
    return view;
  }

  // Кнопка-заголовок создаётся ОДИН раз: её идентичность держит класс
  // `is-collapsed` (поворот стрелки) и фокус — пересоздание узла потеряло бы
  // состояние свёрнутой записи (задача 472457bf).
  const view = buildView();
  let node: HTMLElement = view;

  function showView(refocus: boolean): void {
    setRecordTitleLabel(view, label);
    if (node !== view) {
      node.replaceWith(view);
      node = view;
    }
    if (refocus) view.focus();
  }

  function beginEdit(): void {
    if (field !== null) {
      field.focus();
      field.select();
      return;
    }
    const next = fieldInput({
      extraClass: `${RECORD_TITLE_CLASS} ${RECORD_TITLE_INPUT_CLASS}`,
    });
    next.type = 'text';
    next.value = value;
    next.placeholder = opts.placeholder;
    next.maxLength = maxLength;
    // Клавиатура правки — через общеклиентский диспетчер (ADR b420b08c,
    // задача fd3d84f4). Поле фокусируется ниже, поэтому контекст кладём сразу,
    // а снимаем в `endEdit`.
    const contextId = `record-title-edit-${(recordTitleEditSeq += 1)}`;
    defineKeyContext({
      id: contextId,
      bindings: [
        // Прежний обработчик завершал правку на Enter НЕЗАВИСИМО от модификаторов —
        // набор выражен привязками (`lib/keymap-chords.ts`).
        ...modifierChordVariants('Enter').map((chord) => ({
          command: 'recordTitle.commit',
          chord,
          run: (event: KeyboardEvent) => (event.key === 'Enter' ? endEdit(true, true) : false),
        })),
        {
          command: 'recordTitle.cancel',
          chord: 'Escape',
          run: (event) => (event.key === 'Escape' ? endEdit(false, true) : false),
        },
      ],
    });
    releaseEditContext = pushKeyContext(contextId);
    next.addEventListener('blur', () => endEdit(true, false));
    node.replaceWith(next);
    field = next;
    node = next;
    next.focus();
    next.select();
  }

  function endEdit(commit: boolean, refocus: boolean): void {
    const current = field;
    if (current === null) return;
    field = null;
    releaseEditContext?.();
    releaseEditContext = null;
    if (commit) {
      value = current.value;
      label = opts.onCommit !== undefined ? opts.onCommit(value) : value;
    } else {
      opts.onCancel?.();
    }
    showView(refocus);
  }

  return {
    node: () => node,
    value: () => value,
    isEditing: () => field !== null,
    beginEdit,
    endEdit,
  };
}

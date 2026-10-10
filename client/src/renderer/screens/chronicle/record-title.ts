/**
 * Заголовок дневниковой записи — единый компонент «просмотр ↔ правка» (0.10.2,
 * ошибка 36c330a3; элемент «Лента дневных записей» e01f383a, требование 165323a7).
 *
 * Заголовок один для карточки записи: пара «просмотр/правка» живёт в одном
 * месте, потребитель обязан брать её отсюда (сторож
 * `guard-chronicle-record-title`). Слот создания демонтирован (ТП «Дневник без
 * псевдослота»).
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
  /** Начальное значение (поле `title` записи; пусто — незаполненный заголовок). */
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
   * новую надпись просмотра. Вызывается по `Enter` и `blur` — когда поле ведёт
   * правку САМО (одиночный режим).
   */
  onCommit?: (value: string) => string;
  /** Отмена правки (`Escape`): значение не сохраняется (одиночный режим). */
  onCancel?: () => void;
  /**
   * Единая правка записи (ТП «Дневник без псевдослота»): `Enter` в поле не
   * завершает правку, а зовёт хозяина — карточка/вкладка переводит фокус в тело
   * записи (обычный `Enter`) либо записывает оба поля (`Ctrl`/`Cmd`+`Enter`).
   * Событие передаётся, чтобы хозяин различил модификаторы. Задан — перекрывает
   * `onCommit` для `Enter`.
   */
  onEnter?: (event: KeyboardEvent) => void;
  /**
   * Единая правка записи: `Escape` в поле зовёт хозяина (откат обоих полей).
   * Задан — перекрывает `onCancel` для `Escape`.
   */
  onEscape?: () => void;
  /**
   * Завершать ли правку по уходу фокуса (по умолчанию `true`). В единой правке
   * — `false`: переход фокуса заголовок↔тело правку не закрывает.
   */
  commitOnBlur?: boolean;
  /**
   * Вход в правку заголовка (двойной клик, программный `beginEdit`): хозяин
   * открывает и тело записи. Вызывается до фокуса поля — фокус, выставленный
   * хозяином раньше, не потеряется.
   */
  onBeginEdit?: () => void;
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
  beginEdit(focus?: boolean): void;
  /** Завершить правку: `commit` — сохранить, иначе отменить. */
  endEdit(commit: boolean, refocus: boolean): void;
  /**
   * Задать показанное значение/надпись без входа в правку (хозяин применил
   * сохранённые значения после единой записи). При открытой правке обновляется
   * только поле ввода; надпись просмотра — при следующем выходе.
   */
  setContent(value: string, label?: string): void;
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

  function beginEdit(focus = true): void {
    if (field !== null) {
      if (focus) {
        field.focus();
        field.select();
      }
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
        // набор выражен привязками (`lib/keymap-chords.ts`). В единой правке
        // записи Enter зовёт хозяина (фокус → тело), а не завершает правку.
        ...modifierChordVariants('Enter').map((chord) => ({
          command: 'recordTitle.commit',
          chord,
          run: (event: KeyboardEvent) => (event.key === 'Enter' ? onEnterKey(event) : false),
        })),
        {
          command: 'recordTitle.cancel',
          chord: 'Escape',
          run: (event) => (event.key === 'Escape' ? onEscapeKey() : false),
        },
      ],
    });
    releaseEditContext = pushKeyContext(contextId);
    next.addEventListener('blur', () => {
      if (opts.commitOnBlur !== false) endEdit(true, false);
    });
    node.replaceWith(next);
    field = next;
    node = next;
    // Хозяин единой правки открывает тело записи ДО фокуса: фокус заголовка,
    // выставленный ниже, не будет перехвачен асинхронным входом в тело.
    opts.onBeginEdit?.();
    if (focus) {
      next.focus();
      next.select();
    }
  }

  /** `Enter`: в единой правке — хозяину (фокус в тело / запись), иначе — завершение. */
  function onEnterKey(event: KeyboardEvent): boolean {
    if (opts.onEnter !== undefined) {
      opts.onEnter(event);
      return true;
    }
    endEdit(true, true);
    return true;
  }

  /** `Escape`: в единой правке — хозяину (откат обоих полей), иначе — отмена. */
  function onEscapeKey(): boolean {
    if (opts.onEscape !== undefined) {
      opts.onEscape();
      return true;
    }
    endEdit(false, true);
    return true;
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

  function setContent(nextValue: string, nextLabel?: string): void {
    value = nextValue;
    label = nextLabel ?? nextValue;
    if (field !== null) field.value = value;
    else setRecordTitleLabel(view, label);
  }

  return {
    node: () => node,
    // В правке — живое значение поля (единая запись читает его в момент коммита).
    value: () => (field !== null ? field.value : value),
    isEditing: () => field !== null,
    beginEdit,
    endEdit,
    setContent,
  };
}

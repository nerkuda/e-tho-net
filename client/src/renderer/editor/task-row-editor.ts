/**
 * Правка ОДНОЙ строки задачи компонентой редактирования комментария (0.16.1,
 * задача `cfb8cb72`, пункт 1 ТЗ живой приёмки).
 *
 * **Зачем отдельный модуль.** Строка задачи правится ТЕМ ЖЕ редактором markdown,
 * что и комментарий (`editor/markdown-field.ts`): требование пользователя —
 * «использовать компоненту редактирования комментария». Поведение, которое
 * обязано совпадать:
 *  • сохранение ЕДИНОЕ — `Ctrl+Enter` (`Cmd+Enter` на macOS), и у однострочной,
 *    и у многострочной строки; `Enter` — перевод строки, продолжение списка
 *    (`- `, `1. `) делает markdown-расширение CM6;
 *  • `Tab`/`Shift+Tab` — отступ/сдвиг влево (подзадача/повышение), а НЕ выход из
 *    правки (`comment.indentList`/`comment.outdentList` под `Prec.high`);
 *  • `Escape` — отмена правки; клик вне поля — тоже выход БЕЗ записи (единая
 *    точка сохранения — `Ctrl+Enter`, п.1);
 *  • контекстное меню правого клика — команды форматирования комментария.
 *
 * **Почему `Ctrl+Enter` перехватывается здесь, а не `onSave` поля.** Поле
 * пишет на коммите (`onSave` → `finishEdit`) и на отказе экрана осталось бы в
 * правке только через исключение — с лишним общим сообщением «не удалось
 * сохранить» поверх конкретной ошибки экрана. Правка строки сохраняется сама:
 * `Ctrl+Enter` ловится в capture-фазе (раньше keymap CM6), текст берётся у поля,
 * результат (`true`/`false`) решает экран. Так у строки ровно одно основание
 * записи и нет второго сообщения об ошибке.
 *
 * **Границы.** Модуль живёт в слое редактора, а не в `lib/ui`: `lib/ui` — фасады
 * визуальных компонент и не тянет CodeMirror (иначе цикл `lib/ui` ↔ `editor`).
 * Панель задач получает фабрику правки из экрана
 * (`TaskPanelOptions.createRowEditor`), поэтому сама о CM6 не знает.
 *
 * **Одна правка = один экземпляр.** Поле создаётся при входе в правку и
 * уничтожается при выходе: строка в просмотре рисуется снапшотом панели, а не
 * полем (иначе на каждую строку списка приходился бы CM6).
 */

import {
  createMarkdownField,
  disposeMarkdownField,
  editMarkdownField,
  markdownFieldValue,
} from './markdown-field.js';

/** Что нужно строке от редактора правки (данные и колбэки панели). */
export interface TaskRowEditorOptions {
  /** Начальный markdown: СЫРАЯ строка/блок `body_md` (маркер и чекбокс на месте). */
  md: string;
  /**
   * Классы поля СПИСКОМ: `ui-task-row-edit` и, у блочной правки, ещё
   * `ui-task-row-block-edit`. Список, а не строка через пробел: `DOMTokenList.add`
   * отвергает токен с пробелом (`InvalidCharacterError`) — строка из двух классов
   * роняла открытие блочной правки (блокер 84c71c37).
   */
  classes: readonly string[];
  /** Подпись для скринридера («Правка строки задачи» / «Правка блока»). */
  ariaLabel: string;
  /**
   * Сохранить правку. `true` — записано (правка закрывается), `false` — отказ
   * (поле остаётся в правке, сообщение показал экран).
   */
  save(md: string): Promise<boolean>;
  /** Правка закрыта (сохранена, отменена или кликнули вне): панель перерисует строку. */
  closed(): void;
}

/** Дескриптор поля правки строки. */
export interface TaskRowEditorHandle {
  /** Корень поля (панель вставляет его в текст строки). */
  root: HTMLElement;
  /** Поставить фокус в правку (каретка — начало документа). */
  focus(): void;
  /** Снять поле и его глобальные слушатели. */
  dispose(): void;
}

/**
 * Открыть правку строки задачи компонентой комментария. Поле сразу — в режиме
 * правки: строка задачи не имеет отдельного «просмотра» внутри редактора.
 */
export function createTaskRowEditor(options: TaskRowEditorOptions): TaskRowEditorHandle {
  let closed = false;
  let saving = false;
  const notifyClosed = (): void => {
    if (closed) return;
    closed = true;
    options.closed();
  };

  const root = createMarkdownField({
    md: options.md,
    html: '',
    // Строка задачи — короткий текст: минимум две строки, чтобы было видно
    // продолжение списка/дописанное «что сделано».
    minRows: 2,
    // Выход из правки (Esc, клик вне) — единственная точка закрытия: панель
    // возвращает строку к снапшоту. Запись здесь не выполняется (см. шапку).
    onEditChange: (editing) => {
      if (!editing) notifyClosed();
    },
    onCancel: () => notifyClosed(),
  });

  root.classList.add('ui-task-row-md', ...options.classes);
  root.setAttribute('aria-label', options.ariaLabel);

  /** Записать правку и закрыть поле; отказ экрана оставляет правку открытой. */
  const submit = async (): Promise<void> => {
    if (saving || closed) return;
    const md = markdownFieldValue(root);
    if (md === options.md) {
      // Нечего записывать: Ctrl+Enter без изменений просто закрывает правку.
      notifyClosed();
      return;
    }
    saving = true;
    try {
      if (await options.save(md)) notifyClosed();
    } finally {
      saving = false;
    }
  };

  // Ctrl/Cmd+Enter — единая точка сохранения строки (п.1): capture-фаза до
  // keymap CM6, чтобы поле не ушло в собственный коммит.
  root.addEventListener(
    'keydown',
    (event) => {
      const key = (event as KeyboardEvent).key;
      const withModifier = (event as KeyboardEvent).ctrlKey || (event as KeyboardEvent).metaKey;
      if (key !== 'Enter' || !withModifier) return;
      event.preventDefault();
      event.stopPropagation();
      void submit();
    },
    true,
  );

  editMarkdownField(root);
  root.querySelector<HTMLElement>('.cm-content')?.setAttribute('aria-label', options.ariaLabel);

  return {
    root,
    focus: () => {
      root.querySelector<HTMLElement>('.cm-content')?.focus?.();
    },
    dispose: () => {
      closed = true;
      disposeMarkdownField(root);
    },
  };
}

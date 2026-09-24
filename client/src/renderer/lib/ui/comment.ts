/**
 * Оболочка просмотра и редактирования комментария (задача 9cb87c42, требование
 * 24ca6770 «Оболочка комментария: единый просмотр и редактирование», ADR
 * 03eb2c61, каталог 3fc7c54d).
 *
 * Единый каркас комментария: шапка (панель действий), тело (встроенное поле
 * markdown либо состояние «загрузка / пустота / ошибка») и футер действий.
 * Каждая экранная и диалоговая точка входа собирает комментарий этой оболочкой,
 * а не собственным контейнером — сторож `guard-ui-comment.test.ts`.
 *
 * Режимы «просмотр / правка» ведёт встроенное поле markdown
 * (`editor/markdown-field.ts` — общий модуль, не дубль): двойной клик —
 * правка с живым предпросмотром, blur — сохранение и возврат в просмотр,
 * Esc — отмена. Оболочка отражает текущий режим атрибутом `data-mode`
 * (`.ui-comment[data-mode='edit']`), поэтому он единообразен во всех местах.
 *
 * Поле создаёт потребитель и передаёт в {@link CommentShellOptions.field}:
 * `lib/ui` не зависит от `editor/` (обратный импорт связал бы дизайн-систему с
 * прикладным слоем). Требование «поле markdown внутри оболочки — общий модуль,
 * не дубль» выполняется тем, что все потребители вставляют один и тот же
 * `createMarkdownField`.
 *
 * Строки берутся из словаря (`lib/i18n.ts`), состояния — из словаря строк
 * ошибок (`./messages.js`).
 */

import { div, el } from '../dom.js';
import { t } from '../i18n.js';
import { operationError } from './messages.js';

/** Класс корня комментария — единственная точка определения (вид в `./comment.css`). */
export const COMMENT_CLASS = 'ui-comment';
/** Класс шапки (панель действий). */
export const COMMENT_HEAD_CLASS = 'ui-comment__head';
/** Класс панели действий шапки. */
export const COMMENT_TOOLS_CLASS = 'ui-comment__tools';
/** Класс тела (поле markdown или состояние). */
export const COMMENT_BODY_CLASS = 'ui-comment__body';
/** Класс футера действий. */
export const COMMENT_FOOT_CLASS = 'ui-comment__foot';
/** Класс блока состояния (загрузка / пустота / ошибка). */
export const COMMENT_STATE_CLASS = 'ui-comment__state';
/** Модификатор «тело растягивается на остаток высоты». */
export const COMMENT_FILL_CLASS = 'ui-comment--fill';
/** Модификатор «корень прокручивается по вертикали». */
export const COMMENT_SCROLL_CLASS = 'ui-comment--scroll';

/** Режим комментария, отражаемый в `data-mode`. */
export type CommentMode = 'view' | 'edit';

/** Раскладка оболочки: обычная или растягивающаяся на остаток высоты. */
export type CommentVariant = 'plain' | 'fill';

/** Состояние тела комментария. */
export type CommentState =
  | { kind: 'ready' }
  | { kind: 'loading'; text?: string }
  | { kind: 'empty'; text?: string }
  | { kind: 'error'; error: unknown; text?: string };

/** Опции сборки оболочки комментария. */
export interface CommentShellOptions {
  /** Раскладка корня (по умолчанию `plain`). */
  variant?: CommentVariant;
  /** Прокрутка корня по вертикали (растянутый комментарий на всю высоту). */
  scroll?: boolean;
  /** Начальный режим (по умолчанию `view`). */
  mode?: CommentMode;
  /** Встроенное поле markdown (общий модуль `createMarkdownField`). */
  field?: HTMLElement | null;
  /** Панель действий шапки (метаданные, удаление, чипы целей). */
  tools?: readonly HTMLElement[];
  /** Действия футера. */
  footer?: readonly HTMLElement[];
  /** Начальное состояние тела (по умолчанию `ready`). */
  state?: CommentState;
}

/** Собранная оболочка комментария. */
export interface CommentShell {
  /** Корень `.ui-comment` — вставляется потребителем в свой слот. */
  readonly root: HTMLDivElement;
  /** Тело — слот встроенного поля/состояния. */
  readonly body: HTMLDivElement;
  /** Панель действий шапки. */
  readonly tools: HTMLDivElement;
  /** Панель действий футера. */
  readonly foot: HTMLDivElement;
  /** Заменяет панель действий шапки. */
  setTools(nodes: readonly HTMLElement[]): void;
  /** Заменяет действия футера. */
  setFooter(nodes: readonly HTMLElement[]): void;
  /** Задаёт встроенное поле markdown (показывается в состоянии `ready`). */
  setField(field: HTMLElement | null): void;
  /** Переводит тело в состояние «загрузка / пустота / ошибка / готово». */
  setState(state: CommentState): void;
  /** Отражает режим «просмотр / правка» (`data-mode`). */
  setMode(mode: CommentMode): void;
}

/** Собирает оболочку комментария. */
export function commentShell(opts: CommentShellOptions = {}): CommentShell {
  const root = div(COMMENT_CLASS);
  root.dataset['mode'] = opts.mode ?? 'view';
  if (opts.variant === 'fill') root.classList.add(COMMENT_FILL_CLASS);
  if (opts.scroll === true) root.classList.add(COMMENT_SCROLL_CLASS);

  const head = div(COMMENT_HEAD_CLASS);
  const tools = div(COMMENT_TOOLS_CLASS);
  head.append(tools);
  const body = div(COMMENT_BODY_CLASS);
  const foot = div(COMMENT_FOOT_CLASS);
  root.append(head, body, foot);

  let field: HTMLElement | null = opts.field ?? null;
  let state: CommentState = opts.state ?? { kind: 'ready' };

  /** Показывает панель только с содержимым (пустая — не занимает место). */
  const refreshPanels = (): void => {
    head.hidden = tools.childElementCount === 0;
    foot.hidden = foot.childElementCount === 0;
  };

  const renderBody = (): void => {
    if (state.kind === 'ready') {
      body.replaceChildren(
        field ?? el('div', `${COMMENT_STATE_CLASS} muted`, t('comment.empty')),
      );
      return;
    }
    if (state.kind === 'loading') {
      body.replaceChildren(
        el('div', `${COMMENT_STATE_CLASS} muted`, state.text ?? t('common.loading')),
      );
      return;
    }
    if (state.kind === 'empty') {
      body.replaceChildren(
        el('div', `${COMMENT_STATE_CLASS} muted`, state.text ?? t('comment.empty')),
      );
      return;
    }
    const holder = div(COMMENT_STATE_CLASS);
    holder.append(operationError(state.error, state.text ?? t('comment.loadError')));
    body.replaceChildren(holder);
  };

  const setTools = (nodes: readonly HTMLElement[]): void => {
    tools.replaceChildren(...nodes);
    refreshPanels();
  };
  const setFooter = (nodes: readonly HTMLElement[]): void => {
    foot.replaceChildren(...nodes);
    refreshPanels();
  };

  if (opts.tools !== undefined) setTools(opts.tools);
  if (opts.footer !== undefined) setFooter(opts.footer);
  refreshPanels();
  renderBody();

  return {
    root,
    body,
    tools,
    foot,
    setTools,
    setFooter,
    setField: (next: HTMLElement | null): void => {
      field = next;
      if (state.kind === 'ready') renderBody();
    },
    setState: (next: CommentState): void => {
      state = next;
      renderBody();
    },
    setMode: (next: CommentMode): void => {
      root.dataset['mode'] = next;
    },
  };
}

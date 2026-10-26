/**
 * Неблокирующая обратная связь клиента: всплывающие уведомления (тосты) и
 * строка сообщений статус-бара.
 *
 * Решение заказчика 2026-10-25 (задача 28d22b8a):
 * - **Стек тостов** — не более {@link NOTICE_STACK_LIMIT} одновременно; стек
 *   растёт снизу вверх (новый тост появляется внизу, показанные раньше
 *   поднимаются); шестой вытесняет самый старый (верхний), у вытесненного
 *   отменяется таймер;
 * - **Тосты — только важное**: сбой (`error`) и предупреждение (`warning`) —
 *   доступность сервера, ошибки соединения, потеря данных;
 * - **Рутинные подтверждения** (`info`/`success`) — не тост, а сообщение в
 *   зоне статусной строки (`lib/status-message.ts`).
 *
 * Поэтому {@link notice} — единая точка неблокирующей обратной связи: канал
 * выбирается по виду сообщения. Важное подтверждение, которое обязано быть
 * тостом (например, восстановление соединения), вызывается напрямую через
 * {@link toast}.
 *
 * Блокирующие вопросы идут через `lib/dialog.ts`; ошибки диалога — строкой в
 * панели кнопок (`lib/ui/messages.ts`, требование 397c5a56), тост для них не
 * используется.
 */

import { button, div, span } from './dom.js';
import { statusMessage } from './status-message.js';

/** Сколько тостов одновременно живёт в стеке. */
export const NOTICE_STACK_LIMIT = 5;

/** Задержка автозакрытия тоста, мс. */
export const NOTICE_TTL_MS = 4_000;

/** Вид тоста: `success` — успех, `warning` — внимание, `error` — сбой.
 *  Цветная полоса слева — токен ETN (`--ok`/`--warn`/`--danger`). */
export type ToastKind = 'success' | 'warning' | 'error';

/** Вид сообщения {@link notice}: важные (`error`/`warning`) — тост,
 *  рутинные (`info`/`success`) — статус-бар. */
export type NoticeKind = 'info' | ToastKind;

/** Дополнительный класс по виду (стили — `styles/notifications.css`). */
const KIND_CLASS: Record<ToastKind, string> = {
  success: 'success',
  warning: 'warning',
  error: 'error',
};

/** Контейнер стека; создаётся лениво и переживает пустоту. */
let stack: HTMLDivElement | null = null;

/** Таймеры автозакрытия по тосту — вытеснение обязано их отменять. */
const timers = new Map<HTMLElement, number>();

/**
 * Стек тостов в `document.body`. Проверка `contains` (а не кэш «навсегда»)
 * переживает пересоздание body/снятие рабочего стола и тестовый DOM-шим.
 */
function noticeStack(): HTMLDivElement {
  if (stack !== null && document.body.contains(stack)) return stack;
  stack = div('notice-stack');
  document.body.append(stack);
  return stack;
}

/** Снимает тост вместе с его таймером (закрытие крестиком, TTL, вытеснение). */
function removeToast(box: HTMLElement): void {
  const timer = timers.get(box);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    timers.delete(box);
  }
  box.remove();
}

/**
 * Показывает важное сообщение тостом. Вид окрашивает левую кромку: `error` —
 * красная, `warning` — жёлтая, `success` — зелёная.
 */
export function toast(text: string, kind: ToastKind): void {
  const box = div(`notice ${KIND_CLASS[kind]}`);
  box.append(span(text, 'notice-text'));
  const close = button('×', () => removeToast(box), 'notice-close');
  // Закрытие по НАЖАТИЮ, а не только по `click` (ошибка 90ef5cfa): `click`
  // браузер шлёт общему предку целей mousedown и mouseup. Если над крестиком
  // успевает лечь новый тост (повторяемое уведомление), mouseup попадает в
  // него, `click` уходит мимо кнопки, и нажатый тост не закрывается — «крестик
  // не закрывает, тень уплотняется». `pointerdown` срабатывает сразу и не
  // зависит от того, что окажется под курсором к моменту отпускания; `click`
  // оставлен для активации с клавиатуры (Enter/Space).
  close.addEventListener('pointerdown', () => removeToast(box));
  box.append(close);

  const host = noticeStack();
  // Новый тост — ВНИЗУ: стек растёт снизу вверх (`column-reverse` в CSS),
  // поэтому он вставляется первым ребёнком; показанные раньше поднимаются.
  host.prepend(box);
  // Вытеснение: за лимитом остаётся самый старый — он верхний, то есть
  // ПОСЛЕДНИЙ ребёнок стека.
  while (host.children.length > NOTICE_STACK_LIMIT) {
    const oldest = host.children[host.children.length - 1] as HTMLElement | undefined;
    if (oldest === undefined) break;
    removeToast(oldest);
  }
  timers.set(
    box,
    window.setTimeout(() => removeToast(box), NOTICE_TTL_MS),
  );
}

/**
 * Единая точка неблокирующей обратной связи. Канал выбирается по важности
 * (вид сообщения): сбой и предупреждение — тост, рутинное подтверждение —
 * зона сообщений статусной строки.
 */
export function notice(text: string, kind: NoticeKind = 'info'): void {
  if (kind === 'error' || kind === 'warning') {
    toast(text, kind);
    return;
  }
  statusMessage(text);
}

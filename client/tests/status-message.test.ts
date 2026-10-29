/**
 * Зона сообщений статусной строки (задача 28d22b8a, решение заказчика
 * 2026-10-25): рутинные подтверждения клиента — не тост, а одна строка справа
 * от индикации сервера.
 *
 * Обязательства:
 * 1. запись сообщения — текст и подсказка (полный текст при обрезке);
 * 2. новое сообщение ЗАМЕНЯЕТ предыдущее и перезапускает TTL — накопления нет;
 * 3. по TTL зона гаснет (не висит вечно);
 * 4. сообщение, пришедшее до монтирования статус-бара (или между
 *    монтированиями), не теряется — показывается при монтировании;
 * 5. пустой текст гасит зону.
 */

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { ShimElement } from './dom-shim.js';

/* ------------------------------------------------------------------ *
 * DOM-шим и таймеры
 * ------------------------------------------------------------------ */

const body = new ShimElement('body');
interface FakeTimer {
  callback: () => void;
  ms: number;
  cancelled: boolean;
}
const timers: FakeTimer[] = [];
const cleared: number[] = [];
/* eslint-disable @typescript-eslint/no-explicit-any */
(globalThis as any).document = {
  createElement: (tag: string) => new ShimElement(tag),
  createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
  documentElement: new ShimElement('html'),
  body,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  activeElement: null,
  querySelector: () => null,
};
const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
win['setTimeout'] = (callback: () => void, ms: number) => {
  timers.push({ callback, ms, cancelled: false });
  return timers.length;
};
win['clearTimeout'] = (id: number) => {
  cleared.push(id);
  const timer = timers[id - 1];
  if (timer !== undefined) timer.cancelled = true;
};
win['addEventListener'] = () => undefined;
win['removeEventListener'] = () => undefined;
/* eslint-enable @typescript-eslint/no-explicit-any */

import {
  mountStatusMessage,
  STATUS_MESSAGE_TTL_MS,
  statusMessage,
  unmountStatusMessage,
} from '../src/renderer/lib/status-message.js';

/** Узел зоны: имитирует `span` статусной строки. */
let host: ShimElement;

beforeEach(() => {
  unmountStatusMessage();
  body.replaceChildren();
  timers.length = 0;
  cleared.length = 0;
  host = new ShimElement('span', 'sb-item sb-message');
  body.append(host);
  mountStatusMessage(host);
});

// ---------------------------------------------------------------------------
// 1. Запись, замена, TTL
// ---------------------------------------------------------------------------

test('рутинное сообщение пишется в зону: текст и подсказка', () => {
  statusMessage('Комментарий записан.');

  assert.equal(host.textContent, 'Комментарий записан.');
  assert.equal(host.title, 'Комментарий записан.', 'полный текст — в подсказке');
  assert.equal(timers.length, 1, 'TTL поставлен');
  assert.equal(timers[0]!.ms, STATUS_MESSAGE_TTL_MS, 'осмысленный TTL');
});

test('новое сообщение заменяет предыдущее, накопления нет', () => {
  statusMessage('Сохранено.');
  statusMessage('Скопировано.');
  statusMessage('Связь создана.');

  assert.equal(host.textContent, 'Связь создана.', 'в зоне ровно последнее сообщение');
  assert.equal(host.children.length, 0, 'зона не накапливает узлы');
  // Предыдущие таймеры сняты — иначе более раннее сообщение погасило бы новое.
  assert.deepEqual(cleared, [1, 2], 'таймеры заменённых сообщений отменены');
  assert.equal(timers[2]!.cancelled, false, 'таймер последнего сообщения активен');
});

test('по TTL зона гаснет — сообщение не висит вечно', () => {
  statusMessage('Применено.');
  assert.equal(host.textContent, 'Применено.');

  timers[0]!.callback();

  assert.equal(host.textContent, '', 'текст погашен');
  assert.equal(host.title, '', 'подсказка погашена');
});

test('пустой текст гасит зону и отменяет таймер', () => {
  statusMessage('Применено.');
  statusMessage('');

  assert.equal(host.textContent, '');
  assert.equal(host.title, '');
  assert.equal(timers[0]!.cancelled, true, 'таймер снят');
});

// ---------------------------------------------------------------------------
// 2. Сообщение не теряется до монтирования статус-бара
// ---------------------------------------------------------------------------

test('сообщение до монтирования показывается при монтировании', () => {
  unmountStatusMessage();
  statusMessage('Отбор сохранён.');

  mountStatusMessage(host);

  assert.equal(host.textContent, 'Отбор сохранён.', 'запомненное сообщение не потеряно');
});

test('сообщение при снятом статус-баре не теряется до следующего монтирования', () => {
  unmountStatusMessage();
  statusMessage('Применено к 3 мыслям.');

  mountStatusMessage(host);
  assert.equal(host.textContent, 'Применено к 3 мыслям.');
});

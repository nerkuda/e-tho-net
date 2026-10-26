/**
 * Стек тостов (задача 28d22b8a, решение заказчика 2026-10-25).
 *
 * Обязательства:
 * 1. одновременно в стеке не более {@link NOTICE_STACK_LIMIT} тостов;
 * 2. шестой (и каждый следующий) вытесняет САМЫЙ СТАРЫЙ — у вытесненного
 *    отменяется таймер автозакрытия;
 * 3. стек растёт СНИЗУ ВВЕРХ: новый тост встаёт первым ребёнком, а CSS
 *    контейнера (`flex-direction: column-reverse`) кладёт первого ребёнка
 *    вниз — значит DOM-порядок и есть порядок снизу вверх;
 * 4. закрытие по таймеру снимает именно свой тост и не задевает соседей.
 *
 * Раскладку проверяет и CSS-утверждение (позиция контейнера, column-reverse):
 * без него «первый ребёнок — нижний» осталось бы соглашением без основания.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

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
/** Какие id отменяли через `clearTimeout` (в порядке вызовов). */
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

import { NOTICE_STACK_LIMIT, NOTICE_TTL_MS, notice } from '../src/renderer/lib/notice.js';

/** Контейнер стека (единственный в body). */
function stackOf(): ShimElement {
  const stacks = body.children.filter((child) => child.classList.contains('notice-stack'));
  assert.equal(stacks.length, 1, 'в body ровно один контейнер стека');
  return stacks[0]!;
}

/** Тексты тостов в DOM-порядке (0 — самый новый, нижний). */
function texts(): string[] {
  return stackOf().children.map(
    (box) => box.children.find((child) => child.classList.contains('notice-text'))?.textContent ?? '',
  );
}

beforeEach(() => {
  body.replaceChildren();
  timers.length = 0;
  cleared.length = 0;
});

// ---------------------------------------------------------------------------
// 1. Лимит и вытеснение старейшего
// ---------------------------------------------------------------------------

test('в стеке не более пяти тостов, шестой вытесняет самый старый', () => {
  for (let i = 1; i <= 6; i += 1) notice(`сообщение ${i}`, 'error');

  assert.equal(stackOf().childElementCount, NOTICE_STACK_LIMIT, 'в стеке ровно 5 тостов');
  assert.deepEqual(
    texts(),
    ['сообщение 6', 'сообщение 5', 'сообщение 4', 'сообщение 3', 'сообщение 2'],
    'вытеснен самый старый, новые впереди (внизу)',
  );
  assert.ok(!texts().includes('сообщение 1'), 'первого (самого старого) тоста нет');
});

test('у вытесненного тоста отменён таймер автозакрытия', () => {
  for (let i = 1; i <= 6; i += 1) notice(`сообщение ${i}`, 'warning');

  // Таймер первого тоста — id 1; при вытеснении он обязан быть снят, иначе
  // отложенное удаление трогало бы уже чужой узел стека.
  assert.ok(cleared.includes(1), 'таймер вытесненного тоста отменён');
  assert.equal(timers[0]!.cancelled, true, 'первый таймер помечен отменённым');
});

// ---------------------------------------------------------------------------
// 2. Порядок снизу вверх (DOM + CSS)
// ---------------------------------------------------------------------------

test('порядок снизу вверх: первый ребёнок — самый новый', () => {
  notice('первое', 'error');
  notice('второе', 'error');
  notice('третье', 'error');

  assert.deepEqual(texts(), ['третье', 'второе', 'первое'], 'новый тост встаёт вниз стека');

  // DOM-порядок = «снизу вверх» только вместе с колоночным реверсом и
  // фиксированной позицией контейнера: у отдельного fixed-тоста прежней
  // раскладки все сообщения накладывались бы в одну точку.
  const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const css = fs.readFileSync(
    path.join(clientRoot, 'src', 'renderer', 'styles', 'notifications.css'),
    'utf8',
  );
  assert.match(css, /\.notice-stack\s*\{[^}]*flex-direction:\s*column-reverse/s);
  assert.match(css, /\.notice-stack\s*\{[^}]*position:\s*fixed/s);
  assert.doesNotMatch(css, /\.notice\s*\{[^}]*position:\s*fixed/s, 'тост не позиционируется сам');
});

// ---------------------------------------------------------------------------
// 3. Таймаут закрывает свой тост и не задевает соседей
// ---------------------------------------------------------------------------

test('таймаут снимает свой тост, соседи остаются', () => {
  notice('старое', 'error');
  notice('новое', 'error');
  assert.deepEqual(texts(), ['новое', 'старое']);

  // timers[1] — таймер второго (нового) тоста.
  assert.equal(timers[1]!.ms, NOTICE_TTL_MS, 'TTL — 4 с');
  timers[1]!.callback();

  assert.deepEqual(texts(), ['старое'], 'исчез именно свой тост');
});

// ---------------------------------------------------------------------------
// 4. Дедупликация повторов: серия одинаковых сообщений не занимает стек
// ---------------------------------------------------------------------------

test('повтор того же текста обновляет тост и перезапускает его TTL', () => {
  notice('Правка недоступна: держит другой пользователь.', 'warning');
  notice('Потеря данных: правка не сохранена.', 'error');
  assert.deepEqual(texts(), [
    'Потеря данных: правка не сохранена.',
    'Правка недоступна: держит другой пользователь.',
  ]);

  // Пять повторных попыток войти в заблокированную правку: каждая приходит
  // тем же текстом и не должна ни добавлять дубль, ни вытеснять важное.
  for (let i = 0; i < 5; i += 1) {
    notice('Правка недоступна: держит другой пользователь.', 'warning');
  }

  assert.deepEqual(
    texts(),
    ['Потеря данных: правка не сохранена.', 'Правка недоступна: держит другой пользователь.'],
    'одинаковые сообщения не плодят дубли и не вытесняют соседей',
  );
  assert.equal(cleared.filter((id) => id === 1).length, 1, 'старый таймер повтора снят');
  assert.equal(timers[0]!.cancelled, true, 'первый таймер отменён');
  assert.equal(timers.length, 7, 'на каждый повтор поставлен новый таймер');
  assert.equal(timers[6]!.ms, NOTICE_TTL_MS, 'TTL перезапущен');
});

/**
 * Юнит-тесты сверки ТОЧКИ ВВОДА GUI-стенда (`client/scripts/ui-probe-point.mjs`,
 * ошибка af96d388): выражение проверки попадания, текст промаха и диагностика
 * в отчёте. Модуль чистый — проверяется без клиента; сам раннер (`ui-probe.mjs`)
 * требует живого клиента, здесь тестируется его вынесенная проверка.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  POINT_CHECK_ATTEMPTS,
  describeUnder,
  hitExpression,
  mismatchMessage,
  pointCheckText,
} from '../scripts/ui-probe-point.mjs';

interface HitResult {
  matched: boolean;
  element: { tag: string; className: string; text: string } | null;
}

/** Элемент-фальшивка: ровно те DOM-члены, которые читает выражение проверки. */
interface FakeElement {
  tagName: string;
  className: string;
  textContent: string;
  getAttribute(name: string): string;
  closest(selector: string): unknown;
}

function fakeElement(className: string, closest: (selector: string) => unknown): FakeElement {
  const element: FakeElement = {
    tagName: 'DIV',
    className,
    textContent: 'видимая часть',
    getAttribute: (name) => (name === 'class' ? className : ''),
    closest: (selector) => closest(selector),
  };
  return element;
}

/** Выполнить сгенерированное выражение проверки на фальшивом `document`. */
function runHit(
  expression: string,
  under: FakeElement | null,
  seenPoints: Array<[number, number]> = [],
): HitResult {
  const doc = {
    elementFromPoint: (x: number, y: number) => {
      seenPoints.push([x, y]);
      return under;
    },
  };
  const run = new Function('document', `return ${expression}`) as unknown as (
    document: unknown,
  ) => HitResult;
  return run(doc);
}

test('hitExpression: попадание в элемент и в его предка — matched', () => {
  const element = fakeElement('cloud cloud--small', (selector) => (selector === '.cloud' ? element : null));
  const result = runHit(hitExpression(10, 20, '.cloud'), element);
  assert.equal(result.matched, true);
  assert.deepEqual(result.element, {
    tag: 'DIV',
    className: 'cloud cloud--small',
    text: 'видимая часть',
  });
});

test('hitExpression: координата передаётся в elementFromPoint как есть', () => {
  const seen: Array<[number, number]> = [];
  const element = fakeElement('cloud', () => null);
  runHit(hitExpression(321, 654, '.cloud'), element, seen);
  assert.deepEqual(seen, [[321, 654]]);
});

test('hitExpression: чужой элемент и пустое место — not matched', () => {
  const foreign = fakeElement('panel', () => null);
  const foreignResult = runHit(hitExpression(1, 2, '.cloud'), foreign);
  assert.equal(foreignResult.matched, false);
  assert.equal(foreignResult.element?.className, 'panel');

  const emptyResult = runHit(hitExpression(1, 2, '.cloud'), null);
  assert.deepEqual(emptyResult, { matched: false, element: null });
});

test('hitExpression: кавычки и обратный слеш в селекторе не ломают выражение', () => {
  const selector = '.x[data-q="a\'b\\\\c"]';
  let seenSelector: string | null = null;
  const element = fakeElement('x', (received) => {
    seenSelector = received;
    return element;
  });
  const result = runHit(hitExpression(5, 6, selector), element);
  assert.equal(result.matched, true);
  assert.equal(seenSelector, selector);
});

test('describeUnder: пусто и элемент — текстом для отчёта', () => {
  assert.equal(describeUnder(null), 'под указателем пусто');
  assert.equal(describeUnder(undefined), 'под указателем пусто');
  assert.equal(describeUnder({ tag: 'DIV', className: 'cloud' }), 'DIV class="cloud"');
});

test('mismatchMessage: действие, координата, селектор, перемеры и элемент', () => {
  assert.equal(
    mismatchMessage('наведение не выполнено', '.cloud', {
      px: 9999,
      py: 9999,
      retries: POINT_CHECK_ATTEMPTS - 1,
      hit: null,
    }),
    'наведение не выполнено: точка 9999,9999 не попадает в «.cloud» за 3 перемеров — под указателем пусто',
  );
  assert.equal(
    mismatchMessage('перетаскивание не начато', '#handle', {
      px: 5,
      py: 6,
      hit: { tag: 'SPAN', className: 'row' },
    }),
    'перетаскивание не начато: точка 5,6 не попадает в «#handle» за 3 перемеров — SPAN class="row"',
  );
  assert.equal(
    mismatchMessage('клик не выполнен', '#a', { px: 1, py: 2, retries: 0, hit: null }),
    'клик не выполнен: точка 1,2 не попадает в «#a» за 0 перемеров — под указателем пусто',
  );
});

test('pointCheckText: без перемеров и с перемерами, промах и разрешённый промах', () => {
  const base = { x: 10, y: 20, retries: 0, mismatched: false, under: null };
  assert.equal(pointCheckText(base), ' [точка 10,20]');
  assert.equal(pointCheckText({ ...base, retries: 2 }), ' [точка 10,20, перемер 2]');
  assert.equal(
    pointCheckText({ ...base, mismatched: true, under: { tag: 'DIV', className: 'panel' } }),
    ' [точка 10,20] — ПРОМАХ: DIV class="panel"',
  );
  assert.equal(
    pointCheckText(
      { ...base, mismatched: true, under: null },
      true,
    ),
    ' [точка 10,20] — ПРОМАХ (разрешён allowMismatch): под указателем пусто',
  );
});

test('POINT_CHECK_ATTEMPTS: общий лимит перемеров для click/hover/drag.from', () => {
  assert.equal(POINT_CHECK_ATTEMPTS, 4);
});

/**
 * Стек слоёв `Escape` (`client/src/renderer/lib/escape-layers.ts`, ошибка
 * 9ff6b606).
 *
 * Контракт: слой регистрируется при открытии и снимается идемпотентной
 * функцией; диалог берёт снимок в момент показа и уступает нажатие, если после
 * снимка появился слой. Слой, открытый ДО диалога (и оказавшийся под ним),
 * приоритет не меняет.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  escapeLayerInternals,
  escapeLayerSnapshot,
  hasEscapeLayerAbove,
  pushEscapeLayer,
} from '../src/renderer/lib/escape-layers.js';

beforeEach(() => {
  escapeLayerInternals.reset();
});

describe('стек слоёв Escape', () => {
  it('пустой стек: снимок пуст, слоёв выше нет', () => {
    assert.equal(escapeLayerInternals.count(), 0);
    assert.deepEqual(escapeLayerSnapshot(), []);
    assert.equal(hasEscapeLayerAbove(escapeLayerSnapshot()), false);
  });

  it('слой, открытый после снимка, забирает Escape у диалога', () => {
    const snapshot = escapeLayerSnapshot();
    const release = pushEscapeLayer();
    assert.equal(escapeLayerInternals.count(), 1);
    assert.equal(hasEscapeLayerAbove(snapshot), true);
    release();
    assert.equal(escapeLayerInternals.count(), 0, 'снятие закрывает слой');
    assert.equal(hasEscapeLayerAbove(snapshot), false);
  });

  it('слой, открытый ДО снимка, приоритет не меняет', () => {
    const releaseOld = pushEscapeLayer();
    const snapshot = escapeLayerSnapshot();
    assert.equal(hasEscapeLayerAbove(snapshot), false, 'слой под диалогом не считается верхним');
    releaseOld();
    assert.equal(hasEscapeLayerAbove(snapshot), false, 'и его закрытие ничего не ломает');
  });

  it('снятие идемпотентно и снимает только свой слой', () => {
    const snapshot = escapeLayerSnapshot();
    const first = pushEscapeLayer();
    const second = pushEscapeLayer();
    first();
    first();
    assert.equal(escapeLayerInternals.count(), 1, 'повторное снятие не трогает чужой слой');
    assert.equal(hasEscapeLayerAbove(snapshot), true, 'второй слой всё ещё верхний');
    second();
    assert.equal(hasEscapeLayerAbove(snapshot), false);
  });
});

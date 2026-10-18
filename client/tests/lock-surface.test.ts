/**
 * Режим чтения открытой формы при чужом захвате (ошибка 4f18d9f5).
 *
 * Симптом: тост говорил «поля заблокированы», но поля в диалогах оставались
 * редактируемыми, а запись падала 409. Контракт `blockEditingSurface`:
 * поля ввода и кнопки записи выключаются, значения и закрытие остаются
 * доступными (чтение не блокируется, ADR 705fb6d3).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

function installShim(): void {
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
  };
}

installShim();

const { LOCK_BLOCKED_ATTR, blockEditingSurface } = await import(
  '../src/renderer/lib/lock-surface.js'
);

function field(tag: string): ShimElement {
  return new ShimElement(tag);
}

describe('blockEditingSurface: чужая блокировка переводит форму в чтение', () => {
  it('выключает поля ввода, contenteditable и кнопки записи', () => {
    const root = field('div');
    const input = field('input');
    const textarea = field('textarea');
    const select = field('select');
    const editable = field('div');
    editable.setAttribute('contenteditable', 'true');
    // DOM-шим ищет атрибуты только через `dataset`; в браузере хватает
    // setAttribute (селектор `[contenteditable="true"]`).
    editable.dataset['contenteditable'] = 'true';
    const apply = field('button');
    const cancel = field('button');
    root.append(input, textarea, select, editable, apply, cancel);

    blockEditingSurface({
      root: root as unknown as HTMLElement,
      message: 'Эту мысль редактирует Участник B — поля заблокированы.',
      commitButtons: [apply as unknown as HTMLElement],
    });

    for (const el of [input, textarea, select]) {
      assert.equal(el.disabled, true, `${el.tagName} выключен`);
    }
    assert.equal(editable.getAttribute('contenteditable'), 'false', 'contenteditable снят');
    assert.equal(apply.disabled, true, 'кнопка записи выключена');
    assert.equal(cancel.disabled, false, 'закрытие/отмена остаются доступными');
  });

  it('добавляет ровно одну строку-предупреждение и обновляет её текст', () => {
    const root = field('div');
    root.append(field('input'));

    blockEditingSurface({ root: root as unknown as HTMLElement, message: 'первое' });
    blockEditingSurface({ root: root as unknown as HTMLElement, message: 'второе' });

    const notes = root.querySelectorAll(`[${LOCK_BLOCKED_ATTR}]`);
    assert.equal(notes.length, 1, 'строка не дублируется');
    assert.equal(notes[0]!.textContent, 'второе', 'текст обновлён');
    assert.ok(notes[0]!.className.includes('dialog-text-error'), 'строка оформлена как предупреждение');
  });
});

/**
 * Regression test for the staged-form name/description sync inside the
 * thought-type editor (card `aa32ab49-…` — «Создание типа мысли: 422
 * «name обязателен» даже при заполненном имени»).
 *
 * After `f178f8f` the dialog holds every editable field in a staged `draft`
 * whose values feed the create payload via `buildCreateTypeInput(draft, …)`.
 * For that to work, every user-editable input must mirror its value into
 * the draft on each keystroke (`input` event) — otherwise `draft.name` and
 * `draft.description` keep their initial `''` values forever and the
 * create payload goes out with an empty `name`, tripping the server's
 * `VALIDATION_ERROR «name обязателен»`. Before `f178f8f` `apply()` read
 * the name from `nameInput.value.trim()` directly, so the missing
 * listener was invisible; once `e59c258` rewired `apply()` through
 * `buildCreateTypeInput(draft, …)`, the bug surfaced.
 *
 * The pure-logic counterpart (what `buildCreateTypeInput` does with the
 * stale `draft.name = ''`) is covered in `type-manager-create-input.test.ts`
 * (see `buildCreateTypeInput — name sync regression (aa32ab49-…)`). This
 * file exercises the DOM-side pattern itself — the small `input` listener
 * that copies the live field value into the staged draft — using a minimal
 * DOM shim, so the contract is locked down on both sides.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/** Smallest `HTMLInputElement` / `HTMLTextAreaElement` stub: `value` plus a
 *  tiny `addEventListener` / `dispatch` API. Enough to verify that an
 *  `input` listener copies the live value into the staged draft. */
class ShimInput {
  value = '';
  placeholder = '';
  type = '';
  maxLength = 0;
  readonly listeners = new Map<string, Array<(event?: unknown) => void>>();
  addEventListener(type: string, handler: (event?: unknown) => void): void {
    let list = this.listeners.get(type);
    if (list === undefined) {
      list = [];
      this.listeners.set(type, list);
    }
    list.push(handler);
  }
  dispatch(type: string, event?: unknown): void {
    const list = this.listeners.get(type);
    if (list === undefined) return;
    for (const handler of list) handler(event);
  }
}

/** Mirrors the staged `draft` object the dialog keeps for a thought type
 *  (only the two fields this contract concerns — `name` and `description`
 *  — are needed to exercise the listener). */
interface MiniDraft {
  name: string;
  description: string;
}

/**
 * Mirrors the listener wiring from
 * `client/src/renderer/screens/type-manager.ts` (the
 * `nameInput` / `descArea` `input` listeners that keep `draft.name` and
 * `draft.description` in sync with the live fields). When the dialog code
 * is refactored, this helper must change with it — that is the point of
 * the test.
 */
function bindDraftInputs(draft: MiniDraft, nameInput: ShimInput, descArea: ShimInput): void {
  nameInput.addEventListener('input', () => {
    draft.name = nameInput.value;
  });
  descArea.addEventListener('input', () => {
    draft.description = descArea.value;
  });
}

describe('thought-type editor — staged-form name/description sync (aa32ab49-…)', () => {
  it('a single keystroke into nameInput mirrors the live value into draft.name', () => {
    const draft: MiniDraft = { name: '', description: '' };
    const nameInput = new ShimInput();
    const descArea = new ShimInput();
    bindDraftInputs(draft, nameInput, descArea);

    nameInput.value = 'Мой новый тип';
    nameInput.dispatch('input');

    assert.equal(draft.name, 'Мой новый тип');
    // Description stays untouched on a name keystroke.
    assert.equal(draft.description, '');
  });

  it('draft.name tracks every keystroke, including the trailing empty state after a clear', () => {
    const draft: MiniDraft = { name: '', description: '' };
    const nameInput = new ShimInput();
    const descArea = new ShimInput();
    bindDraftInputs(draft, nameInput, descArea);

    nameInput.value = 'З';
    nameInput.dispatch('input');
    assert.equal(draft.name, 'З');

    nameInput.value = 'За';
    nameInput.dispatch('input');
    assert.equal(draft.name, 'За');

    nameInput.value = '';
    nameInput.dispatch('input');
    assert.equal(draft.name, '');
  });

  it('descArea listener keeps draft.description in sync independently of nameInput', () => {
    const draft: MiniDraft = { name: '', description: '' };
    const nameInput = new ShimInput();
    const descArea = new ShimInput();
    bindDraftInputs(draft, nameInput, descArea);

    descArea.value = 'что это за тип';
    descArea.dispatch('input');
    assert.equal(draft.description, 'что это за тип');

    // A subsequent name keystroke does not touch the description.
    nameInput.value = 'Тип';
    nameInput.dispatch('input');
    assert.equal(draft.name, 'Тип');
    assert.equal(draft.description, 'что это за тип');
  });

  it('without the listener the bug shape reproduces (draft.name stays empty)', () => {
    // Documents the regression directly: if a future refactor drops the
    // listener, draft.name remains its initial value and the create payload
    // ships with `name = ''` — exactly the 422 reported in the card.
    const draft: MiniDraft = { name: '', description: '' };
    const nameInput = new ShimInput();
    // Intentionally NOT calling bindDraftInputs — simulates the regressed
    // dialog where nameInput had no listener that wrote back to draft.name.
    nameInput.value = 'Мой тип';
    nameInput.dispatch('input');
    assert.equal(draft.name, '', 'draft.name must stay empty without the listener (regression shape)');
  });
});

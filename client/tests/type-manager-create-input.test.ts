/**
 * Regression test for `buildCreateTypeInput` (client/src/renderer/screens/type-manager.ts,
 * карточка ETN 0ab4749b — «Создание нового типа мысли падает: font_bold должен
 * быть логическим значением»).
 *
 * The new-type dialog used to ship every staged field on «Применить и
 * закрыть», including the default `null` values. After the refactor, the
 * payload is built field-by-field: each entry is included only when it
 * differs from the create-time default (`null` for colours/font flags/
 * icon, empty description, no template). Pure-logic helper — no DOM.
 *
 * A bonus coverage for the explicit user setting (`font_bold = true`,
 * `icon = '🎯'`) confirms those fields DO land in the payload, so the
 * minimal-payload logic does not accidentally drop real edits.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildCreateTypeInput, type ThoughtTypeDraft } from '../src/renderer/screens/type-manager.js';

function defaults(): ThoughtTypeDraft {
  return {
    name: 'Мой тип',
    parent_id: null,
    description: '',
    icon: null,
    icon_kind: 'emoji',
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
  };
}

describe('buildCreateTypeInput — new thought type (regression for 0ab4749b)', () => {
  it('omits font_bold / font_italic / font_underline / font_strike when the user did not set them', () => {
    const input = buildCreateTypeInput(defaults(), '', null);
    assert.equal(input.name, 'Мой тип');
    // The four font flags MUST be absent — not `null`, not `false`, but
    // simply not present — so the server never sees a literal `null` for
    // them on the create path.
    assert.ok(
      !('font_bold' in input),
      'font_bold must be absent (not null) when the user did not set it',
    );
    assert.ok(!('font_italic' in input));
    assert.ok(!('font_underline' in input));
    assert.ok(!('font_strike' in input));
    // Other inheritable fields stay absent too.
    assert.ok(!('icon' in input));
    assert.ok(!('icon_kind' in input));
    assert.ok(!('fg_color' in input));
    assert.ok(!('bg_color' in input));
    assert.ok(!('parent_id' in input));
    assert.ok(!('description' in input));
    assert.ok(!('comment_template_md' in input));
  });

  it('trims description; empty description stays omitted', () => {
    assert.ok(!('description' in buildCreateTypeInput(defaults(), '', null)));
    assert.ok(!('description' in buildCreateTypeInput(defaults(), '   ', null)));
    assert.equal(buildCreateTypeInput(defaults(), '  описание  ', null).description, 'описание');
  });

  it('trims the comment template; empty template stays omitted', () => {
    assert.ok(
      !('comment_template_md' in buildCreateTypeInput(defaults(), '', null)),
      'null template → omitted',
    );
    assert.equal(
      buildCreateTypeInput(defaults(), '', 'шаблон').comment_template_md,
      'шаблон',
    );
  });

  it('sends font_bold = true when the user flipped the checkbox', () => {
    const draft = { ...defaults(), font_bold: true as const };
    const input = buildCreateTypeInput(draft, '', null);
    assert.equal(input.font_bold, true);
    // Sibling flags still absent.
    assert.ok(!('font_italic' in input));
  });

  it('sends font_bold = false when the user explicitly turned it off', () => {
    // `false !== null` → the field is included so the server records an
    // explicit «no bold» instead of inheriting from the parent.
    const draft = { ...defaults(), font_bold: false as const };
    const input = buildCreateTypeInput(draft, '', null);
    assert.equal(input.font_bold, false);
  });

  it('sends icon + icon_kind together when the user picked an icon', () => {
    const draft: ThoughtTypeDraft = { ...defaults(), icon: '🎯', icon_kind: 'emoji' as const };
    const input = buildCreateTypeInput(draft, '', null);
    assert.equal(input.icon, '🎯');
    assert.equal(input.icon_kind, 'emoji');
  });

  it('sends fg_color / bg_color when set', () => {
    const draft: ThoughtTypeDraft = {
      ...defaults(),
      fg_color: '#fe3939',
      bg_color: '#20232a',
    };
    const input = buildCreateTypeInput(draft, '', null);
    assert.equal(input.fg_color, '#fe3939');
    assert.equal(input.bg_color, '#20232a');
  });

  it('sends parent_id when chosen', () => {
    const draft: ThoughtTypeDraft = { ...defaults(), parent_id: 'parent-uuid' };
    const input = buildCreateTypeInput(draft, '', null);
    assert.equal(input.parent_id, 'parent-uuid');
  });

  it('combines every set field in one payload', () => {
    const draft: ThoughtTypeDraft = {
      ...defaults(),
      parent_id: 'p1',
      icon: '⭐',
      icon_kind: 'emoji' as const,
      fg_color: '#fff',
      font_bold: true,
      font_strike: true,
    };
    const input = buildCreateTypeInput(draft, 'описание', 'шаблон');
    assert.deepEqual(input, {
      name: 'Мой тип',
      parent_id: 'p1',
      description: 'описание',
      icon: '⭐',
      icon_kind: 'emoji',
      fg_color: '#fff',
      font_bold: true,
      font_strike: true,
      comment_template_md: 'шаблон',
    });
  });
});

/**
 * Regression for card `aa32ab49-…` («Создание типа мысли: 422 «name
 * обязателен» даже при заполненном имени»). After `f178f8f` the new-type
 * dialog staged every editable field in a `draft` object whose `name` was
 * initialised once from `type?.name ?? extras?.initialName ?? ''`; the
 * subsequent `e59c258` switched `apply()` to build the create payload via
 * `buildCreateTypeInput(draft, …)`, which reads `draft.name` — but no
 * `input` listener was keeping `draft.name` in sync with `nameInput.value`.
 * The user-typed name therefore never reached the wire (payload `name` =
 * `''`) and the server rejected the create with
 * `VALIDATION_ERROR «name обязателен»`.
 *
 * These cases pin the pure-logic side of the contract: if `draft.name` is
 * empty, the payload IS empty (the bug); if `draft.name` holds the typed
 * value, the payload IS that value (the fix, conditional on the staged-form
 * listener that mirrors `nameInput.value` into `draft.name` on every
 * keystroke). The matching DOM-side test lives in
 * `type-manager-name-sync.test.ts`.
 */
describe('buildCreateTypeInput — name sync regression (aa32ab49-…)', () => {
  it('payload has `name = ""` when draft.name was never updated (the bug shape)', () => {
    // Mirrors the regressed dialog: `draft.name` initialised from
    // `type?.name ?? extras?.initialName ?? ''`, no listener keeps it in
    // sync. With a new type this is `''`.
    const draft = { ...defaults(), name: '' };
    const input = buildCreateTypeInput(draft, '', null);
    assert.equal(input.name, '');
  });

  it('payload carries the typed name once draft.name is updated (the fix shape)', () => {
    // Mirrors the staged-form fix: every keystroke writes `nameInput.value`
    // into `draft.name`, so by the time `apply()` runs the staged draft
    // reflects the live field.
    const draft = { ...defaults(), name: '' };
    const typed = 'Мой новый тип';
    draft.name = typed;
    const input = buildCreateTypeInput(draft, '', null);
    assert.equal(input.name, typed);
  });

  it('recovered name is sent alongside every other staged field', () => {
    // Sanity check: after `draft.name` recovers from the user typing, every
    // other field the dialog stages continues to flow into the payload
    // exactly as before — the listener fix must not regress the existing
    // minimal-payload logic from card `0ab4749b`.
    const draft: ThoughtTypeDraft = {
      ...defaults(),
      name: '',
      parent_id: 'parent-uuid',
      icon: '🎯',
      icon_kind: 'emoji' as const,
      fg_color: '#fe3939',
      font_bold: true,
    };
    draft.name = 'Восстановленный тип';
    const input = buildCreateTypeInput(draft, 'описание', null);
    assert.deepEqual(input, {
      name: 'Восстановленный тип',
      parent_id: 'parent-uuid',
      description: 'описание',
      icon: '🎯',
      icon_kind: 'emoji',
      fg_color: '#fe3939',
      font_bold: true,
    });
  });
});

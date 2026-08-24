/**
 * Unit tests for the dialog shortcut predicates (client/src/renderer/lib/dialog.ts).
 *
 * Regression guard for the add-dialog Ctrl+Shift+Enter bug: the plain
 * Ctrl+Enter confirm listener is registered on `window` FIRST, so when it
 * accepted Ctrl+Shift+Enter (it never checked `shiftKey`) it called
 * `preventDefault` and clicked the primary button — the thought was created
 * without the focus flag, and the apply-with-focus handler never saw the
 * press. The predicates must split the two shortcuts apart.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isConfirmShortcut,
  isCtrlShiftEnterShortcut,
  type ShortcutEventLike,
} from '../src/renderer/lib/dialog.js';

/** Builds a minimal keydown-like event (the exact shape the predicates read). */
function ev(overrides: Partial<ShortcutEventLike> = {}): ShortcutEventLike {
  return {
    key: 'Enter',
    repeat: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

describe('isConfirmShortcut', () => {
  it('accepts plain Ctrl+Enter and Cmd+Enter', () => {
    assert.equal(isConfirmShortcut(ev({ ctrlKey: true })), true);
    assert.equal(isConfirmShortcut(ev({ metaKey: true })), true);
  });

  it('rejects Ctrl+Shift+Enter — it must reach the apply+focus shortcut', () => {
    assert.equal(isConfirmShortcut(ev({ ctrlKey: true, shiftKey: true })), false);
    assert.equal(isConfirmShortcut(ev({ metaKey: true, shiftKey: true })), false);
  });

  it('rejects Shift+Enter and Alt-modified presses', () => {
    assert.equal(isConfirmShortcut(ev({ shiftKey: true })), false);
    assert.equal(isConfirmShortcut(ev({ ctrlKey: true, altKey: true })), false);
  });

  it('rejects key auto-repeat and non-Enter keys', () => {
    assert.equal(isConfirmShortcut(ev({ ctrlKey: true, repeat: true })), false);
    assert.equal(isConfirmShortcut(ev({ ctrlKey: true, key: 'a' })), false);
  });
});

describe('isCtrlShiftEnterShortcut', () => {
  it('accepts Ctrl+Shift+Enter and Cmd+Shift+Enter', () => {
    assert.equal(isCtrlShiftEnterShortcut(ev({ ctrlKey: true, shiftKey: true })), true);
    assert.equal(isCtrlShiftEnterShortcut(ev({ metaKey: true, shiftKey: true })), true);
  });

  it('rejects plain Ctrl+Enter and plain Shift+Enter', () => {
    assert.equal(isCtrlShiftEnterShortcut(ev({ ctrlKey: true })), false);
    assert.equal(isCtrlShiftEnterShortcut(ev({ shiftKey: true })), false);
  });

  it('rejects key auto-repeat', () => {
    assert.equal(
      isCtrlShiftEnterShortcut(ev({ ctrlKey: true, shiftKey: true, repeat: true })),
      false,
    );
  });
});

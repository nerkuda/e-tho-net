/**
 * Tests for the renderer milestone-event bridge
 * (`client/src/renderer/lib/ui-log.ts`, task 92b89e6f).
 *
 * The bridge is fire-and-forget: it forwards to `window.etn.logEvent` when
 * present and silently no-ops otherwise (unit-test shims, early boot) —
 * diagnostics must never be able to break the UI path it instruments.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/** Loads the module after the `window` shim is in place (Proxy-free import). */
async function loadModule(): Promise<typeof import('../src/renderer/lib/ui-log.js')> {
  return import('../src/renderer/lib/ui-log.js');
}

describe('logUiEvent', () => {
  it('передаёт событие и данные в window.etn.logEvent', async () => {
    const seen: Array<{ name: string; data?: Record<string, unknown> }> = [];
    (globalThis as Record<string, unknown>).window = {
      etn: { logEvent: (name: string, data?: Record<string, unknown>) => seen.push({ name, data }) },
    };
    const { logUiEvent } = await loadModule();
    logUiEvent('ui.cloud.click', { id: 'abc' });
    assert.deepEqual(seen, [{ name: 'ui.cloud.click', data: { id: 'abc' } }]);
  });

  it('no-op без window.etn и не роняет вызывающего при ошибке моста', async () => {
    (globalThis as Record<string, unknown>).window = {};
    const { logUiEvent } = await loadModule();
    assert.doesNotThrow(() => logUiEvent('ui.editor.opened', { id: 'x' }));

    (globalThis as Record<string, unknown>).window = {
      etn: {
        logEvent: (): void => {
          throw new Error('bridge is broken');
        },
      },
    };
    assert.doesNotThrow(() => logUiEvent('ui.focus.applied'));
  });
});

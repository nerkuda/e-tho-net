/**
 * Unit tests for the preload IPC error unwrapping: Electron wraps every
 * rejected `ipcRenderer.invoke` promise as
 * `Error invoking remote method 'etn:invoke': <Name>: <message>` — the UI
 * must see the server's message verbatim (L21 polish).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cleanIpcError } from '../src/preload/ipc-error.js';

describe('cleanIpcError', () => {
  it('strips the invoke prefix and the EtnError name', () => {
    const err = cleanIpcError(
      new Error(
        `Error invoking remote method 'etn:invoke': EtnError: родительский тип изменить нельзя: тип используется в 2 мыслях`,
      ),
    );
    assert.equal(err.message, 'родительский тип изменить нельзя: тип используется в 2 мыслях');
  });

  it('strips the prefix for plain Error and other built-in names', () => {
    assert.equal(
      cleanIpcError(new Error(`Error invoking remote method 'etn:invoke': Error: boom`)).message,
      'boom',
    );
    assert.equal(
      cleanIpcError(new Error(`Error invoking remote method 'etn:invoke': TypeError: bad arg`))
        .message,
      'bad arg',
    );
  });

  it('passes unwrapped errors and non-Error values through', () => {
    const plain = cleanIpcError(new Error('свое сообщение'));
    assert.equal(plain.message, 'свое сообщение');
    assert.equal(cleanIpcError('строка-ошибка').message, 'строка-ошибка');
  });

  it('keeps the original stack', () => {
    const original = new Error(`Error invoking remote method 'etn:invoke': EtnError: x`);
    const clean = cleanIpcError(original);
    assert.equal(clean.stack, original.stack);
  });
});

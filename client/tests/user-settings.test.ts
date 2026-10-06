/**
 * Юнит-тесты слоя серверных пользовательских настроек (0.12.1, задача
 * d534eb35, ADR 3a829d25): `lib/user-settings.ts`.
 *
 * Проверяют связку «настройки ↔ диспетчер»: разбор серверного значения
 * `comment_hotkeys`, применение его к диспетчеру сочетаний и формирование
 * payload для `PUT /me/settings/comment_hotkeys`.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

type Settings = typeof import('../src/renderer/lib/user-settings.js');
type Keymap = typeof import('../src/renderer/lib/keymap.js');

let settings: Settings;
let keymap: Keymap;

/** Подменяет `window.etn.me` минимальным моком. */
function stubMe(me: Record<string, unknown>): void {
  (globalThis as unknown as { window: { etn: unknown } }).window.etn = { me };
}

describe('слой серверных пользовательских настроек (lib/user-settings.ts)', () => {
  beforeEach(async () => {
    (globalThis as unknown as { window: Record<string, unknown> }).window = {};
    keymap = (await import('../src/renderer/lib/keymap.js')) as Keymap;
    keymap.keymapInternals.reset();
    settings = (await import('../src/renderer/lib/user-settings.js')) as Settings;
  });

  afterEach(() => {
    keymap.setKeymapOverrides({});
  });

  it('parseCommentHotkeys: только карта «строка → непустая строка»', () => {
    assert.deepEqual(settings.parseCommentHotkeys(null), {});
    assert.deepEqual(settings.parseCommentHotkeys('Ctrl+B'), {});
    assert.deepEqual(settings.parseCommentHotkeys(['Ctrl+B']), {});
    assert.deepEqual(
      settings.parseCommentHotkeys({
        'comment.bold': 'Ctrl+Alt+B',
        'comment.italic': '',
        'comment.h3': 42,
        '': 'Ctrl+Q',
      }),
      { 'comment.bold': 'Ctrl+Alt+B' },
    );
  });

  it('loadUserSettings: читает comment_hotkeys и применяет к диспетчеру', async () => {
    stubMe({
      getSettings: async () => ({
        comment_hotkeys: { 'comment.bold': 'Ctrl+Alt+B' },
        other_setting: 1,
      }),
    });
    await settings.loadUserSettings();
    assert.deepEqual(keymap.getKeymapOverrides(), { 'comment.bold': 'Ctrl+Alt+B' });
  });

  it('saveCommentHotkeys: шлёт ключ comment_hotkeys с непустой картой', async () => {
    let captured: { key: string; value: unknown } | null = null;
    stubMe({
      setSetting: async (key: string, value: unknown) => {
        captured = { key, value };
      },
    });
    await settings.saveCommentHotkeys({ 'comment.italic': 'Ctrl+Alt+I', 'comment.bold': null });
    assert.deepEqual(captured, {
      key: 'comment_hotkeys',
      value: { 'comment.italic': 'Ctrl+Alt+I' },
    });
  });

  it('resetUserSettings: возвращает умолчания', () => {
    keymap.setKeymapOverrides({ 'comment.bold': 'Ctrl+Alt+B' });
    settings.resetUserSettings();
    assert.deepEqual(keymap.getKeymapOverrides(), {});
  });
});

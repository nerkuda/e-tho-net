/**
 * Разбор служебных кадров языка сокета (ADR daab6ac4 §3, задачи f99f0542 и
 * faba9ff4): `ready` при подключении и `settings.language` при смене языка
 * сети/сервера. Кадры не несут `seq`/`network_id` — обычный событийный конверт
 * их отвергает, поэтому их ловит отдельный разбор.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseLanguageFrame } from '../src/main/net/ws-client.js';

describe('parseLanguageFrame: кадры ready/settings.language', () => {
  it('ready с языком и источником', () => {
    assert.deepEqual(parseLanguageFrame({ type: 'ready', language: 'en', source: 'server' }), {
      language: 'en',
      source: 'server',
    });
  });

  it('settings.language применяется так же', () => {
    assert.deepEqual(
      parseLanguageFrame({ type: 'settings.language', language: 'zh-Hans', source: 'network' }),
      { language: 'zh-Hans', source: 'network' },
    );
  });

  it('неизвестный тип, пустой язык и чужой источник отвергаются', () => {
    assert.equal(parseLanguageFrame({ type: 'thought.updated', language: 'en', source: 'user' }), null);
    assert.equal(parseLanguageFrame({ type: 'ready', language: '', source: 'user' }), null);
    assert.equal(parseLanguageFrame({ type: 'ready', language: 'en', source: 'os' }), null);
    assert.equal(parseLanguageFrame(null), null);
    assert.equal(parseLanguageFrame('ready'), null);
  });

  it('событийный конверт не считается кадром языка', () => {
    assert.equal(
      parseLanguageFrame({
        type: 'thought.updated',
        seq: 12,
        network_id: 'n1',
        data: { id: 't1' },
      }),
      null,
    );
  });
});

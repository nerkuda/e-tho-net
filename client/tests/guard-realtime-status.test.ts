/**
 * Сторож статусов realtime-соединения (ошибка de34b35b).
 *
 * Правило: каждое значение `RtStatus` имеет цвет и видимый текст в статус-баре,
 * а эффективный статус активной сети читается только через `getRtStatus`
 * (прямое чтение `state.rtStatus` в потребителях разъезжается с per-network
 * картой — «зелёный не там»).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { listSourceFiles } from './guard-helpers.js';
import { RENDERER_ROOT } from './renderer-css.js';
import { statusGlyph } from '../src/renderer/screens/workspace.js';
import type { RtStatus } from '../src/renderer/state.js';

const ALL_STATUSES: RtStatus[] = [
  'idle',
  'connecting',
  'connected',
  'reconnecting',
  'offline',
  'suspect',
];

describe('guard: статусы realtime-соединения', () => {
  it('каждому RtStatus соответствует цвет и непустой текст', () => {
    for (const status of ALL_STATUSES) {
      const glyph = statusGlyph(status, null);
      assert.ok(
        ['ok', 'warn', 'bad', ''].includes(glyph.cls),
        `${status}: неизвестный класс «${glyph.cls}»`,
      );
      assert.ok(glyph.text.trim().length > 0, `${status}: пустой текст`);
    }
    // Специальная подпись detail`server-restart` — жёлтая, отдельный текст.
    const restart = statusGlyph('reconnecting', 'server-restart');
    assert.equal(restart.cls, 'warn');
    assert.equal(restart.text, 'Сервер перезапускается…');
    // `idle` — нейтральный, не красный (нет открытой сети — не авария).
    assert.equal(statusGlyph('idle', null).cls, '');
    // Красный только у настоящей потери связи.
    assert.equal(statusGlyph('offline', null).cls, 'bad');
  });

  it('эффективный статус читается только через getRtStatus', () => {
    // state.ts — владелец поля, realtime.ts — точка его пересчёта. Любой
    // другой потребитель обязан звать getRtStatus (per-network карта).
    const allowed = new Set(['state.ts', 'realtime.ts']);
    const violations: string[] = [];
    for (const abs of listSourceFiles(RENDERER_ROOT, { extensions: ['.ts'] })) {
      const rel = path.relative(RENDERER_ROOT, abs).split(path.sep).join('/');
      if (rel.startsWith('main/')) continue;
      if (allowed.has(path.basename(rel))) continue;
      const lines = fs.readFileSync(abs, 'utf8').split('\n');
      lines.forEach((line, i) => {
        // Прямое чтение именно плоского поля (не ByNetwork/DetailByNetwork).
        if (/\.rtStatus(?!ByNetwork|DetailByNetwork)\b/.test(line)) {
          violations.push(`  • ${rel}:${i + 1} — ${line.trim()}`);
          return;
        }
        // Деструктуризация обходит точечную проверку: `const { rtStatus } = state`.
        if (/\{[^}]*\brtStatus\b[^}]*\}\s*=\s*[^;]*\bstate\b/.test(line)) {
          violations.push(`  • ${rel}:${i + 1} — ${line.trim()}`);
        }
      });
    }
    assert.equal(
      violations.length,
      0,
      `Прямое чтение rtStatus вне getRtStatus:\n${violations.join('\n')}`,
    );
  });
});

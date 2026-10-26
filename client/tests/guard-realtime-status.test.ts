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
  it('каждому RtStatus соответствует цвет, непустая подпись и тултип', () => {
    for (const status of ALL_STATUSES) {
      const glyph = statusGlyph(status, null);
      assert.ok(
        ['ok', 'warn', 'bad', ''].includes(glyph.cls),
        `${status}: неизвестный класс «${glyph.cls}»`,
      );
      assert.ok(glyph.text.trim().length > 0, `${status}: пустая подпись`);
      assert.ok(glyph.title.trim().length > 0, `${status}: пустой тултип`);
    }
    // `idle` — нейтральный, не красный (нет открытой сети — не авария).
    assert.equal(statusGlyph('idle', null).cls, '');
    // Красный только у настоящей потери связи.
    assert.equal(statusGlyph('offline', null).cls, 'bad');
  });

  it('подписи и тултипы совпадают с таблицей заказчика', () => {
    const server = 'ETN Local';
    assert.deepEqual(statusGlyph('connected', null, server), {
      cls: 'ok',
      text: 'Сервер: ОК',
      title: `Подключено к ${server}`,
    });
    assert.deepEqual(statusGlyph('connecting', null, server), {
      cls: 'warn',
      text: 'Сервер: ???',
      title: `Подключение к ${server}…`,
    });
    const recovering = `Попытка восстановить соединение с ${server}…`;
    for (const [status, detail] of [
      ['suspect', null],
      ['reconnecting', null],
      ['reconnecting', 'server-restart'],
    ] as const) {
      assert.deepEqual(statusGlyph(status, detail, server), {
        cls: 'warn',
        text: 'Сервер: ???',
        title: recovering,
      });
    }
    assert.deepEqual(statusGlyph('offline', null, server), {
      cls: 'bad',
      text: 'Нет соединения',
      title: 'Соединения с сервером нет. Данные доступны только для просмотра',
    });
    assert.deepEqual(statusGlyph('idle', null, server), {
      cls: '',
      text: 'Сервер: —',
      title: 'Сеть не открыта',
    });
    // Имя сервера неизвестно — общие формулировки без подстановки.
    assert.equal(statusGlyph('connected', null, null).title, 'Подключено к серверу');
    assert.equal(statusGlyph('connecting', null, null).title, 'Подключение к серверу…');
    assert.equal(
      statusGlyph('suspect', null, null).title,
      'Попытка восстановить соединение с сервером…',
    );
  });

  it('индикатор живёт в правой event-area, бейджа «Только чтение» нет', () => {
    // Замечание заказчика: точка и подпись — один блок, первый элемент
    // правой области после сплиттера; отдельного read-only бейджа нет.
    const workspace = fs.readFileSync(
      path.join(RENDERER_ROOT, 'screens', 'workspace.ts'),
      'utf8',
    );
    assert.match(workspace, /const sbStatus = div\('sb-status'\)/);
    assert.match(workspace, /sbStatus\.append\(statusLeft, statusText\)/);
    // Зона сообщений статус-бара (задача 28d22b8a) стоит СРАЗУ справа от
    // индикатора соединения и монтируется вместе со статус-баром; тостовая
    // зона — отдельный стек, не статус-бар.
    assert.match(workspace, /const sbMessage = span\('', 'sb-item sb-message'\)/);
    assert.match(workspace, /eventArea\.append\(sbStatus, sbMessage, countsLabel, eventLabel\)/);
    assert.match(workspace, /mountStatusMessage\(sbMessage\)/);
    assert.match(workspace, /onWorkspaceTeardown\(unmountStatusMessage\)/);
    assert.match(
      workspace,
      /statusbar\.append\(\s*zoomLabel,\s*historyHost,\s*eventAreaResizer,\s*eventArea,\s*conflictHost,?\s*\)/,
    );
    assert.doesNotMatch(workspace, /sb-readonly/);
    assert.doesNotMatch(workspace, /isReadOnlyStatus/);
    const layout = fs.readFileSync(
      path.join(RENDERER_ROOT, 'styles', 'layout.css'),
      'utf8',
    );
    assert.doesNotMatch(layout, /\.sb-readonly/);
    const dictionary = fs.readFileSync(
      path.join(RENDERER_ROOT, 'lib', 'locales', 'ru.ts'),
      'utf8',
    );
    assert.doesNotMatch(dictionary, /'realtime\.readOnly'/);
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

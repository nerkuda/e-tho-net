/**
 * Инкрементальное применение realtime-событий к ленте «Дневника» (задача
 * afcfb144, уровень 3 тех.проекта `1d48df6d`).
 *
 * Проверяется чистая логика `screens/chronicle/realtime-apply.ts` и ПРОВОДКА
 * `chronicle.ts` / `realtime-ui.ts` структурно по исходнику (экран в node-тесте
 * не поднимается — тянет `app.js`/редактор).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { ChronicleRow, Comment, CommentTarget } from '@etn/shared';

import {
  chronicleAllowsIncremental,
  commentUpdateNeedsReload,
  hasDiaryAttachment,
  mergeCommentChanges,
  rowVisibleInPeriod,
} from '../src/renderer/screens/chronicle/realtime-apply.js';
import { localDay } from '../src/renderer/screens/chronicle/diary.js';

const RENDERER_ROOT = path.resolve(import.meta.dirname, '..', 'src', 'renderer');

const FROM = '2026-09-23T22:00:00.000Z';
const DAY = localDay(FROM);

function makeRow(overrides: Partial<ChronicleRow> = {}): ChronicleRow {
  return {
    id: 'c1',
    title: 'Запись',
    valid_from: FROM,
    valid_to: FROM,
    use_time: false,
    version: 1,
    created_at: FROM,
    updated_at: FROM,
    created_by: 'u1',
    updated_by: 'u1',
    snippet: '',
    body_html: '<p>текст</p>',
    targets: [],
    ...overrides,
  };
}

const CRITERIA = { keywords: '', hasTargetCriteria: false, hasAuthorCriteria: false };

describe('chronicle realtime: классификация', () => {
  it('инкрементально только при отборе «период/порядок»', () => {
    assert.equal(chronicleAllowsIncremental(CRITERIA), true);
    assert.equal(chronicleAllowsIncremental({ ...CRITERIA, keywords: 'abc' }), false);
    assert.equal(chronicleAllowsIncremental({ ...CRITERIA, hasTargetCriteria: true }), false);
    assert.equal(chronicleAllowsIncremental({ ...CRITERIA, hasAuthorCriteria: true }), false);
  });

  it('в ленту попадает хроно-запись хотя бы с одной привязкой', () => {
    const targets: CommentTarget[] = [{ owner_type: 'thought', owner_id: 'other' }];
    assert.equal(hasDiaryAttachment(targets), true);
    assert.equal(hasDiaryAttachment([{ owner_type: 'link', owner_id: 'l1' }]), true);
    assert.equal(hasDiaryAttachment([]), false);
  });

  it('правка текста при доп. критериях уходит в полный путь', () => {
    const heavy = { ...CRITERIA, keywords: 'x' };
    assert.equal(commentUpdateNeedsReload({ body_md: 'new' }, heavy), true);
    assert.equal(commentUpdateNeedsReload({ title: 'new' }, heavy), true);
    assert.equal(commentUpdateNeedsReload({ targets: [] }, heavy), true);
    assert.equal(commentUpdateNeedsReload({ valid_from: FROM }, heavy), false, 'дата точечно безопасна');
    assert.equal(commentUpdateNeedsReload({ body_md: 'new' }, CRITERIA), false);
  });
});

describe('chronicle realtime: слияние и видимость', () => {
  it('mergeCommentChanges обновляет поля строки', () => {
    const row = makeRow();
    const changes: Partial<Comment> = {
      title: 'Новый заголовок',
      body_html: '<p>обновлено</p>',
      version: 2,
      valid_to: '2026-09-26T22:00:00.000Z',
    };
    const next = mergeCommentChanges(row, changes);
    assert.equal(next.title, 'Новый заголовок');
    assert.equal(next.body_html, '<p>обновлено</p>');
    assert.equal(next.version, 2);
    assert.equal(next.valid_to, '2026-09-26T22:00:00.000Z');
    assert.equal(row.title, 'Запись', 'исходная строка не мутируется');
  });

  it('запись вне периода в ленте не видна', () => {
    const row = makeRow();
    assert.equal(rowVisibleInPeriod(row, DAY, DAY), true);
    assert.equal(rowVisibleInPeriod(row, '2099-01-01', '2099-12-31'), false);
  });

  it('правка даты может вывести строку из периода', () => {
    const row = makeRow();
    const next = mergeCommentChanges(row, { valid_from: '2100-01-01T00:00:00.000Z', valid_to: '2100-01-01T00:00:00.000Z' });
    assert.equal(rowVisibleInPeriod(next, DAY, DAY), false);
  });
});

describe('chronicle realtime: проводка экрана и шины', () => {
  const chronicle = fs.readFileSync(
    path.join(RENDERER_ROOT, 'screens', 'chronicle', 'chronicle.ts'),
    'utf8',
  );
  const realtimeUi = fs.readFileSync(path.join(RENDERER_ROOT, 'realtime-ui.ts'), 'utf8');

  it('экран коалессирует события и держит один renderFeed на окно', () => {
    assert.match(chronicle, /export function applyChronicleRealtime\(evt: AnyRealtimeEvent\)/);
    assert.match(chronicle, /createRealtimeBatch<ChronicleRealtimeOp>\(/);
    assert.match(chronicle, /applyBatch: \(ops\) => \{\s*void applyChronicleOps\(ops\);/);
    assert.match(chronicle, /applyFull: \(\) => \{\s*void reloadAndSync\(\);/);
    const body = chronicle.slice(chronicle.indexOf('async function applyChronicleOps('));
    const end = body.indexOf('\n}\n');
    const callCount = (body.slice(0, end).match(/renderFeed\(\);/g) ?? []).length;
    assert.equal(callCount, 1, 'один renderFeed на батч окна');
  });

  it('событие по записи вне ленты доустанавливается точечным додаром (замечание проверки)', () => {
    const body = chronicle.slice(chronicle.indexOf('async function applyChronicleOps('));
    const end = body.indexOf('\n}\n');
    const ops = body.slice(0, end);
    assert.match(ops, /if \(idx < 0\) \{[\s\S]*?await etn\.comments\.get\(requireNetworkId\(\), op\.id\)/);
    assert.match(ops, /if \(!rowVisibleInPeriod\(built, from, to\)[\s\S]*?rows = insertRowByDay\(rows, built, order, home\)/);
    assert.match(ops, /pendingReconcile = true;/g, 'локальная вставка помечает страницу к сверке');
  });

  it('правка даты переставляет строку по серверному порядку', () => {
    const body = chronicle.slice(chronicle.indexOf('async function applyChronicleOps('));
    const end = body.indexOf('\n}\n');
    assert.match(
      body.slice(0, end),
      /rows = insertRowByDay\(\s*rows\.filter\(\(r\) => r\.id !== op\.id\),\s*row,/,
      'обновлённая строка встаёт на своё место по датам',
    );
  });

  it('realtime-ветки comment.* идут через applyChronicleRealtime', () => {
    assert.match(realtimeUi, /case 'comment\.created':[\s\S]*?applyChronicleRealtime\(evt\)/);
    assert.match(realtimeUi, /case 'comment\.updated':[\s\S]*?applyChronicleRealtime\(evt\)/);
    assert.match(realtimeUi, /case 'comment\.deleted':[\s\S]*?applyChronicleRealtime\(evt\)/);
  });
});

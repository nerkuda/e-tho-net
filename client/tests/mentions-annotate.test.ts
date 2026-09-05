/**
 * Unit tests of the pure offset-mapping helper behind the mentions
 * auto-annotation (L24). Pure — no DOM (client tests run without jsdom; the
 * DOM-wrapping part of `annotateMentions` is covered by manual verification,
 * per the existing convention for DOM-heavy client modules).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { MentionsScanRequest, MentionsScanResponse } from '@etn/shared';

import {
  chunkTextsForScan,
  findRangeAtOffset,
  MentionsScanCache,
  MENTIONS_SCAN_MAX_CHARS,
  MENTIONS_SCAN_MAX_ITEMS,
  scanMentionsTexts,
} from '../src/renderer/editor/mentions-annotate.js';

test('находит диапазон, содержащий смещение', () => {
  const ranges = [
    { start: 0, end: 5 },
    { start: 5, end: 9 },
    { start: 9, end: 20 },
  ];
  assert.equal(findRangeAtOffset(ranges, 0), 0);
  assert.equal(findRangeAtOffset(ranges, 3), 0);
  assert.equal(findRangeAtOffset(ranges, 12), 2);
  assert.equal(findRangeAtOffset(ranges, 20), 2);
});

test('граница между соседними диапазонами отдаётся более раннему', () => {
  const ranges = [
    { start: 0, end: 5 },
    { start: 5, end: 9 },
  ];
  // offset 5 удовлетворяет обоим (start<=5<=end первого и start<=5<=end
  // второго) — побеждает первый найденный (эквивалентная DOM-позиция).
  assert.equal(findRangeAtOffset(ranges, 5), 0);
});

test('смещение вне всех диапазонов — null', () => {
  const ranges = [{ start: 0, end: 5 }];
  assert.equal(findRangeAtOffset(ranges, 6), null);
  assert.equal(findRangeAtOffset(ranges, -1), null);
});

test('пустой список диапазонов — всегда null', () => {
  assert.equal(findRangeAtOffset([], 0), null);
});

// -----------------------------------------------------------------------------
// chunkTextsForScan — splits texts for POST /mentions/scan so each batch fits
// the contract: ≤50 items and ≤20000 chars total. See error
// 8ca4841b-2f2f-4b1a-b34e-70b3d4111ccd.
// -----------------------------------------------------------------------------

test('chunkTextsForScan: пустой вход → пустой результат', () => {
  assert.deepEqual(chunkTextsForScan([]), []);
});

test('chunkTextsForScan: короткий вход помещается в один батч', () => {
  const texts = ['alpha', 'beta', 'gamma'];
  const batches = chunkTextsForScan(texts);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0], texts);
});

test('chunkTextsForScan: 60 коротких текстов → 2 батча (50 + 10)', () => {
  const texts = Array.from({ length: 60 }, (_, i) => `t${i}`);
  const batches = chunkTextsForScan(texts);
  assert.equal(batches.length, 2);
  assert.equal(batches[0]!.length, 50);
  assert.equal(batches[1]!.length, 10);
  // порядок сохраняется
  assert.deepEqual(batches[0]![0], 't0');
  assert.deepEqual(batches[0]![49], 't49');
  assert.deepEqual(batches[1]![0], 't50');
  assert.deepEqual(batches[1]![9], 't59');
});

test('chunkTextsForScan: текст длиннее лимита chars отправляется одним батчем', () => {
  const huge = 'x'.repeat(MENTIONS_SCAN_MAX_CHARS + 5000);
  const texts = [huge, 'next'];
  const batches = chunkTextsForScan(texts);
  // один батч с огромным текстом + один с «next»; пустых батчей нет.
  assert.equal(batches.length, 2);
  assert.equal(batches[0]!.length, 1);
  assert.equal(batches[0]![0], huge);
  assert.deepEqual(batches[1], ['next']);
});

test('chunkTextsForScan: огромный текст без последующих — единственный батч', () => {
  const huge = 'y'.repeat(MENTIONS_SCAN_MAX_CHARS * 2);
  const batches = chunkTextsForScan([huge]);
  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.length, 1);
  assert.equal(batches[0]![0], huge);
});

test('chunkTextsForScan: суммарно > лимита chars делит по границе текста', () => {
  // каждый текст 5000 символов; 5 штук — это 25 000, что больше 20 000.
  const texts = Array.from({ length: 5 }, (_, i) => 'a'.repeat(5000));
  const batches = chunkTextsForScan(texts);
  // 5000 + 5000 + 5000 + 5000 = 20000 — четвёртый уже не влезает.
  assert.equal(batches.length, 2);
  assert.equal(batches[0]!.length, 4);
  assert.equal(batches[1]!.length, 1);
});

test('chunkTextsForScan: каждый батч укладывается в оба лимита контракта', () => {
  // свойства-инварианты, которые должен выполнять любой корректный вход.
  const texts: string[] = [];
  for (let i = 0; i < 200; i += 1) {
    texts.push('z'.repeat(100 + (i % 7) * 50));
  }
  texts.push('w'.repeat(MENTIONS_SCAN_MAX_CHARS + 100));
  const batches = chunkTextsForScan(texts);
  assert.ok(batches.length >= 1);
  for (const batch of batches) {
    assert.ok(batch.length <= MENTIONS_SCAN_MAX_ITEMS, `items=${batch.length}`);
    const chars = batch.reduce((sum, t) => sum + t.length, 0);
    // текст больше лимита chars может попасть один — это исключение из инварианта.
    assert.ok(
      batch.length === 1 || chars <= MENTIONS_SCAN_MAX_CHARS,
      `chars=${chars}, items=${batch.length}`,
    );
  }
  // общий порядок сохраняется
  assert.deepEqual(batches.flat(), texts);
});

test('chunkTextsForScan: ровно 50 текстов влезают в один батч', () => {
  const texts = Array.from({ length: 50 }, () => 'a');
  assert.deepEqual(chunkTextsForScan(texts), [texts]);
});

// -----------------------------------------------------------------------------
// scanMentionsTexts + MentionsScanCache — повторные рендеры комментария не
// должны повторно сканировать те же тексты на сервере, а батчи — лететь
// параллельно. Чистые функции (без DOM), scan-зависимость инжектится.
// -----------------------------------------------------------------------------

/** Scan-stub: помечает каждый ответ длиной текста (для проверки выравнивания). */
function makeScanSpy(): {
  scan: (req: MentionsScanRequest) => Promise<MentionsScanResponse>;
  requests: MentionsScanRequest[];
} {
  const requests: MentionsScanRequest[] = [];
  const scan = (req: MentionsScanRequest): Promise<MentionsScanResponse> => {
    requests.push(req);
    return Promise.resolve({
      results: req.texts.map((t) => [{ start: 0, end: t.length, thoughts: [] }]),
    });
  };
  return { scan, requests };
}

const BASE_SCOPE = { networkId: 'n1', showInactive: false, excludeThoughtId: undefined };

test('scanMentionsTexts: повторный вызов с теми же текстами не шлёт новых запросов', async () => {
  const { scan, requests } = makeScanSpy();
  const cache = new MentionsScanCache();
  const first = await scanMentionsTexts(scan, cache, BASE_SCOPE, ['alpha', 'beta']);
  const second = await scanMentionsTexts(scan, cache, BASE_SCOPE, ['alpha', 'beta']);
  assert.equal(requests.length, 1);
  assert.deepEqual(second, first);
});

test('scanMentionsTexts: смена show_inactive/exclude/сети — новые запросы', async () => {
  const { scan, requests } = makeScanSpy();
  const cache = new MentionsScanCache();
  await scanMentionsTexts(scan, cache, BASE_SCOPE, ['alpha']);
  await scanMentionsTexts(scan, cache, { ...BASE_SCOPE, showInactive: true }, ['alpha']);
  await scanMentionsTexts(scan, cache, { ...BASE_SCOPE, excludeThoughtId: 't1' }, ['alpha']);
  await scanMentionsTexts(scan, cache, { ...BASE_SCOPE, networkId: 'n2' }, ['alpha']);
  assert.equal(requests.length, 4);
  // Все ключи запроса передаются как в скан.
  assert.equal(requests[1]!['show_inactive'], true);
  assert.equal(requests[2]!['exclude_thought_id'], 't1');
});

test('scanMentionsTexts: кэш-хиты смешиваются с новыми текстами, порядок сохранён', async () => {
  const { scan, requests } = makeScanSpy();
  const cache = new MentionsScanCache();
  await scanMentionsTexts(scan, cache, BASE_SCOPE, ['alpha', 'beta']);
  const results = await scanMentionsTexts(scan, cache, BASE_SCOPE, ['alpha', 'gamma', 'beta']);
  // Новый только «gamma» — один запрос ровно с ним.
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1]!['texts'], ['gamma']);
  // Результаты выровнены по входным текстам (end = длина текста).
  assert.deepEqual(
    results.map((r) => r[0]!.end),
    [5, 5, 4],
  );
});

test('scanMentionsTexts: батчи идут строго последовательно, порядок сохранён', async () => {
  let active = 0;
  let maxActive = 0;
  const requests: MentionsScanRequest[] = [];
  const scan = (req: MentionsScanRequest): Promise<MentionsScanResponse> => {
    requests.push(req);
    active += 1;
    maxActive = Math.max(maxActive, active);
    return new Promise((resolve) => {
      setTimeout(() => {
        active -= 1;
        resolve({ results: req.texts.map((t) => [{ start: 0, end: t.length, thoughts: [] }]) });
      }, 5);
    });
  };
  const cache = new MentionsScanCache();
  // 120 текстов → 3 батча (лимит 50 на запрос).
  const texts = Array.from({ length: 120 }, (_, i) => `t${i}`);
  const results = await scanMentionsTexts(scan, cache, BASE_SCOPE, texts);
  assert.equal(requests.length, 3);
  assert.equal(maxActive, 1, 'батчи не должны выполняться параллельно');
  assert.deepEqual(
    results.map((r) => r[0]!.end),
    texts.map((t) => t.length),
  );
  // Батчи сохраняют порядок исходных текстов.
  assert.deepEqual(
    requests.flatMap((r) => r.texts),
    texts,
  );
});

test('MentionsScanCache: переполнение лимита очищает кэш целиком', () => {
  const cache = new MentionsScanCache(2);
  cache.set(BASE_SCOPE, 'a', []);
  cache.set(BASE_SCOPE, 'b', []);
  assert.notEqual(cache.get(BASE_SCOPE, 'a'), undefined);
  cache.set(BASE_SCOPE, 'c', []);
  assert.equal(cache.get(BASE_SCOPE, 'a'), undefined);
  assert.equal(cache.get(BASE_SCOPE, 'b'), undefined);
  assert.notEqual(cache.get(BASE_SCOPE, 'c'), undefined);
});

test('MentionsScanCache: запись протухает по TTL', () => {
  let now = 1_000;
  const cache = new MentionsScanCache(500, 60_000, () => now);
  cache.set(BASE_SCOPE, 'a', []);
  assert.notEqual(cache.get(BASE_SCOPE, 'a'), undefined);
  now += 60_001;
  assert.equal(cache.get(BASE_SCOPE, 'a'), undefined);
});

test('MentionsScanCache: смена сети сбрасывает записи, clear() тоже', () => {
  const cache = new MentionsScanCache();
  // Как в scanMentionsTexts: сеть фиксируется до первых обращений.
  cache.noteNetwork('n1');
  cache.set(BASE_SCOPE, 'a', []);
  cache.noteNetwork('n1'); // та же сеть — записи живут
  assert.notEqual(cache.get(BASE_SCOPE, 'a'), undefined);
  cache.noteNetwork('n2'); // другая сеть — сброс
  assert.equal(cache.get(BASE_SCOPE, 'a'), undefined);
  cache.set(BASE_SCOPE, 'b', []);
  cache.clear();
  assert.equal(cache.get(BASE_SCOPE, 'b'), undefined);
});

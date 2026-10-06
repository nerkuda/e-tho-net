/**
 * Unit-тесты чистой развёртки трансклюзий «как текст» (0.12.1, ТП2, задача
 * `e9f553e5`): `expandTransclusionsToText` в `editor/transclusion.ts`.
 *
 * Разбор и развёртка выполняются единым `@etn/markdown`
 * (сторож `guard-markdown-single-renderer`); здесь проверяется лишь клиентская
 * обвязка — итеративная дозагрузка источников резолвером и запрошенный режим
 * без служебных маркеров/ссылок. Headless, без DOM и сети.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { expandTransclusionsToText, type TransclusionSourceLoader } from '../src/renderer/editor/transclusion.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const NET = 'c4f9a3b2-1111-2222-3333-444455556666';

/** Загрузчик поверх карты `id → тело`; отсутствующие считает ненайденными. */
function mapLoader(bodies: Record<string, string>, calls: string[] = []): TransclusionSourceLoader {
  return async (id) => {
    calls.push(id);
    const body = bodies[id];
    return body === undefined ? { found: false, title: '', body_md: '' } : { found: true, title: id, body_md: body };
  };
}

test('expandTransclusionsToText: полный комментарий разворачивается без маркеров и ссылок', async () => {
  const out = await expandTransclusionsToText(
    `до ![[#${A}]] после`,
    NET,
    mapLoader({ [A]: 'тело A' }),
  );
  assert.equal(out, 'до тело A после');
  assert.ok(!out.includes('etn:transclusion'), 'служебных маркеров нет');
});

test('expandTransclusionsToText: раздел разворачивается вместе с подразделами', async () => {
  const body = '## Раздел\nтело\n### Под\nпод\n## Другой\nчужое\n';
  const out = await expandTransclusionsToText(`![[#${A}#Раздел]]`, NET, mapLoader({ [A]: body }));
  assert.equal(out, '## Раздел\nтело\n### Под\nпод');
});

test('expandTransclusionsToText: вложенные источники догружаются за несколько кругов', async () => {
  const calls: string[] = [];
  const out = await expandTransclusionsToText(
    `![[#${A}]]`,
    NET,
    mapLoader({ [A]: `A\n![[#${B}]]`, [B]: 'B' }, calls),
  );
  assert.equal(out, 'A\nB');
  assert.ok(calls.includes(A) && calls.includes(B), 'оба источника запрошены');
});

test('expandTransclusionsToText: отсутствующий источник проглатывается (ссылка удалена)', async () => {
  const out = await expandTransclusionsToText(`до ![[#${A}]] после`, NET, mapLoader({}));
  assert.equal(out, 'до  после');
});

test('expandTransclusionsToText: текст без трансклюзий возвращается как есть, загрузчик не зовётся', async () => {
  const calls: string[] = [];
  const md = '# Заголовок\nобычный текст';
  assert.equal(await expandTransclusionsToText(md, NET, mapLoader({}, calls)), md);
  assert.deepEqual(calls, []);
});

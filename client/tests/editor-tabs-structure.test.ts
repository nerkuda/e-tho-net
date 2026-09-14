/**
 * Structural checks for the editor «Свойства»/«Связи» tabs (задача
 * 8ab775d9 — недореализованные критерии приёмки, доведены после ревью
 * тех.проекта a94998c6).
 *
 * The DOM-bound code pulls in IPC, realtime and dialog modules — heavy for
 * the unit runner. Like `type-editor-tabs.test.ts`, these tests stay cheap
 * by asserting the structural anchors of the two source files:
 *
 *  - «Свойства»: обе группы клампятся сплиттером высоты (rowSplitter +
 *    applyGroupClamp с persistKey `properties.*` — протяжка запоминается);
 *  - «Связи»: ровно две группы — «Упоминания» и «Локальный граф»; дублирующие
 *    «Прямые связи»/«Использование» (содержимое теперь живёт в свойствах-
 *    связях на вкладке «Свойства») удалены вместе со своими реалтайм-
 *    обработчиками.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const SRC = {
  properties: resolve(import.meta.dirname, '..', 'src', 'renderer', 'editor', 'properties.ts'),
  links: resolve(import.meta.dirname, '..', 'src', 'renderer', 'editor', 'links-tab.ts'),
  css: resolve(import.meta.dirname, '..', 'src', 'renderer', 'styles.css'),
};

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('вкладка «Свойства» — регулятор высоты (8ab775d9, приёмка №7)', () => {
  it('группы оснащены сплиттером с запоминанием высоты (паттерн links-tab)', () => {
    const src = readText(SRC.properties);
    // Сплиттер клампит группу выше себя: «Свойства типа» получает
    // rowSplitter; «Свойства вне типа» (последняя) — только restore-кламп.
    assert.ok(src.includes("persistKey: 'properties.type'"), 'type group splitter key');
    assert.ok(src.includes("applyGroupClamp(typeGroup"), 'type group clamp');
    assert.ok(src.includes("applyGroupClamp(outsideGroup"), 'outside group clamp');
  });

  it('CSS даёт группам flex-вёрстку с клампом (как .links-tab)', () => {
    const css = readText(SRC.css);
    for (const sel of [
      '.properties-tab > .group:has(> .group-body)',
      '.properties-tab > .group > .group-body',
      '.properties-tab .prop-wrap',
    ]) {
      assert.ok(css.includes(sel), `CSS missing selector ${sel}`);
    }
  });
});

describe('вкладка «Связи» — две группы, дубли removed (8ab775d9, приёмка №9)', () => {
  it('содержит «Упоминания» и «Локальный граф», но не «Прямые связи»/«Использование»', () => {
    const src = readText(SRC.links);
    assert.ok(src.includes("title: 'Упоминания'"), 'mentions group present');
    assert.ok(src.includes("title: 'Локальный граф'"), 'local graph group present');
    assert.ok(!src.includes("title: 'Прямые связи'"), 'direct-links group removed');
    assert.ok(!src.includes("title: 'Использование'"), 'usage group removed');
  });

  it('realtime-хук usage-группы и её persistKey удалены', () => {
    const src = readText(SRC.links);
    assert.ok(!src.includes('wireUsageRealtime'), 'usage realtime hook removed');
    assert.ok(!src.includes("'links.direct'"), 'links.direct persist key removed');
  });
});

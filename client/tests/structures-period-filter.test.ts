/**
 * Регресс-тесты перевода полей периода панелей отбора на общий контрол
 * `lib/period-editor.ts` (0.10.1, задача 12a5e719): группы «Создано/Изменено»
 * панели «Структур» и «Период» ленты «Событий» больше не строятся нативными
 * `datetime-local`/редактором значения, а идут через вариант `dialog` редактора
 * периода.
 *
 * Два уровня:
 *  * DOM — `buildDateRangeRow` в режиме `period` рисует поле-значение периода
 *    (кнопка периода, крестик, индикатор времени) и НЕ рисует строки «от/до»;
 *  * источник — панель «Структур» просит режим `period` и не содержит
 *    нативных `datetime-local`.
 *
 * Модуль гоняется под Node с минимальным DOM-шимом (`tests/dom-shim.ts`) — тот
 * же подход, что у `structures-dates-filter.test.ts`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const RENDERER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'renderer',
);

function readRenderer(rel: string): string {
  return fs.readFileSync(path.join(RENDERER_ROOT, rel), 'utf8');
}

/** Installs the minimal DOM/window shims the form builders need. */
function installShim(): void {
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
  };
  (globalThis as any).window = {
    innerWidth: 1200,
    innerHeight: 800,
    setTimeout: (fn: () => void) => {
      fn();
      return 1;
    },
    clearTimeout: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    localStorage: { getItem: () => null, setItem: () => undefined },
    etn: {
      propertyRegistry: { list: async () => [] },
      savedFilters: { list: async () => [] },
      thoughts: { resolve: async () => [], findDuplicates: async () => [] },
    },
  };
}

before(() => {
  installShim();
});

describe('панели отбора — период через period-editor (12a5e719)', () => {
  it('buildDateRangeRow(mode: period) рисует поле-значение периода, не «от/до»', async () => {
    const { buildDateRangeRow } = await import('../src/renderer/lib/filter-form.js');
    const ctx = {
      networkId: 'net',
      getState: () => ({}) as never,
      registry: new Map(),
      touch: () => undefined,
    };
    const row = buildDateRangeRow(ctx as never, {
      mode: 'period',
      label: 'Создано',
      after: '2024-02-01T10:30:00',
      before: '',
      onAfterChange: () => undefined,
      onBeforeChange: () => undefined,
    });
    const shim = row as unknown as ShimElement;
    assert.ok(shim.querySelector('.pe-dialog-value'), 'кнопка-значение периода');
    assert.ok(shim.querySelector('.pe-dialog-clear'), 'крестик очистки периода');
    assert.ok(shim.querySelector('.pe-dialog-time'), 'индикатор «Учитывать время»');
    assert.equal(shim.querySelector('.st-f-date-field'), null, 'строк «от/до» больше нет');
    assert.equal(shim.querySelector('.pe-dialog-value')!.textContent, 'с 2024-02-01 10:30');
  });

  it('панель «Структур»: режим `period`, без нативных datetime-local', () => {
    const src = readRenderer('screens/structures/filter-panel.ts');
    assert.match(src, /mode: 'period'/, 'группа дат панели переведена на period-editor');
    assert.ok(!src.includes('datetime-local'), 'нативных datetime-local в панели нет');
    assert.ok(!src.includes("mode: 'datetime'"), 'исторический режим datetime не используется');
  });

  it('каркас формы: строки дат знают режим `period` и не знают `datetime`', () => {
    const src = readRenderer('lib/filter-form.ts');
    assert.ok(src.includes("mode?: 'editor' | 'period'"), 'режим period объявлен');
    assert.ok(src.includes("variant: 'dialog'"), 'использован вариант dialog редактора периода');
    assert.ok(!src.includes('datetime-local'), 'нативных datetime-local в каркасе нет');
  });

  it('лента «Событий»: поле «Период» переведено на period-editor', () => {
    const src = readRenderer('screens/activity/activity.ts');
    assert.match(src, /mode: "period"/, 'период событий переведён на period-editor');
  });
});

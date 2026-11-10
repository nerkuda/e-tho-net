/**
 * Сторож языка-независимого поиска вкладок в GUI-сценариях стенда (0.15.4,
 * ошибка 34077dcb, продолжение bfc8e6d6).
 *
 * Правило: вкладку редактора (`.editor-tab`) нельзя искать по подписи —
 * `find(... textContent ...)`. Порядок вкладок мысли фиксирован контрактом
 * `TABS_THOUGHT` (`client/src/renderer/editor/editor.ts`: комментарий, свойства,
 * вложения, упоминания, дневник, граф, метаданные; «не менять порядок: на него
 * опираются тесты вёрстки»), поэтому сценарий адресует вкладку ИНДЕКСОМ.
 * С 0.15.2 язык интерфейса берётся из профиля/сети/сервера (ADR `daab6ac4`),
 * сервер стенда по умолчанию `en` — поиск по русской подписи молча возвращает
 * «нет вкладки» и валит прогон таймаутом следующего шага.
 *
 * Проверка `.editor-tab-title` (карта подписей всех вкладок) правилом не
 * задевается: это осознанная проверка локализации (`ui-probe.ebed42d3-i18n-lazy`),
 * она читает тексты `map`, а не выбирает вкладку.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { assertGuardClean, collectViolations, type GuardRule } from './guard-helpers.js';

const CLIENT_ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPTS_ROOT = path.join(CLIENT_ROOT, 'scripts');

/**
 * Выбор вкладки редактора по тексту: коллекция `.editor-tab` и `find(...)` с
 * `textContent` в предикате. Индексный доступ (`[...document.querySelectorAll('.editor-tab')][1]`)
 * правилу не соответствует — он и предписан.
 */
const TAB_BY_LABEL = /\.editor-tab'[\s\S]*\.find\([\s\S]*textContent/;

const RULES: GuardRule[] = [
  {
    name: 'no-tab-lookup-by-label',
    description:
      'Вкладки редактора ищутся по позиции в фиксированном наборе TABS_THOUGHT ' +
      '(editor.ts), а не по подписи: подписи локализованы (ADR daab6ac4), у стенда ' +
      'по умолчанию en.',
    pattern: TAB_BY_LABEL,
    include: (rel) => rel.endsWith('.scenario.json'),
  },
];

describe('guard: вкладки стенда ищутся по позиции, а не по подписи (34077dcb)', () => {
  it('в сценариях стенда нет поиска вкладки по локализованной подписи', () => {
    assertGuardClean(SCRIPTS_ROOT, RULES, { extensions: ['.json'] });
  });

  it('эталонный сценарий bfc8e6d6 адресует вкладки индексами TABS_THOUGHT', () => {
    const file = path.join(SCRIPTS_ROOT, 'ui-probe.7f017ce1-blank-lines.scenario.json');
    const raw = fs.readFileSync(file, 'utf8');
    assert.match(raw, /querySelectorAll\('\.editor-tab'\)\)\[4\]/, 'дневник — индекс 4');
    assert.match(raw, /querySelectorAll\('\.editor-tab'\)\)\[2\]/, 'вложения — индекс 2');
  });

  it('правило краснеет на умышленном нарушении', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-tab-lookup-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'ui-probe.demo.scenario.json'),
        [
          '{',
          '  "steps": [',
          '    { "name": "open-properties-tab", "probe": "(() => { const tab=[...document.querySelectorAll(\'.editor-tab\')].find((b)=>b.textContent.includes(\'Свойства\')); if(!tab) return \'no-tab\'; tab.click(); return \'ok\'; })()" }',
          '  ]',
          '}',
          '',
        ].join('\n'),
        'utf8',
      );
      const violations = collectViolations(dir, RULES, { extensions: ['.json'] });
      assert.equal(violations.length, 1, 'нарушение найдено ровно одно');
      assert.equal(violations[0]?.rule, 'no-tab-lookup-by-label');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

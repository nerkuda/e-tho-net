/**
 * Юнит-тесты разбора и валидации JSON-сценария стенда UI-проверок
 * (`client/scripts/ui-probe-scenario.mjs`, задача 5c5b30e2).
 *
 * Модуль чистый (без Electron, сети и CDP), поэтому проверяется без запущенного
 * клиента: основной разбор и все сценарии ошибок — здесь. Сам раннер
 * (`ui-probe.mjs`) требует живого клиента и юнит-тестами не покрывается.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_STEP_TIMEOUT,
  ScenarioError,
  normalizeModifiers,
  parseScenario,
  resolveKey,
  stepKind,
  validateScenario,
} from '../scripts/ui-probe-scenario.mjs';

function scenarioFrom(steps: unknown[]): unknown {
  return { name: 'probe', steps };
}

test('parseScenario: сценарий со всеми действиями разбирается и нормализуется', () => {
  const scenario = parseScenario(
    JSON.stringify(
      scenarioFrom([
        { key: 'ArrowDown' },
        { click: '#feed' },
        { click: { selector: '.card', at: [4, 6] } },
        { click: [640, 400] },
        { text: 'привет' },
        { waitFor: { expression: 'document.readyState === "complete"', frames: 2 } },
        { probe: { name: 'rows', expression: 'document.querySelectorAll(".row").length' } },
        { shot: { file: '01.png', clip: '.feed' } },
        { eval: 'document.querySelector("#x").focus()' },
      ]),
    ),
  );

  assert.equal(scenario.name, 'probe');
  assert.equal(scenario.timeout, DEFAULT_STEP_TIMEOUT);
  assert.equal(scenario.steps.length, 9);
  assert.deepEqual(
    scenario.steps.map((step) => step.kind),
    ['key', 'click', 'click', 'click', 'text', 'waitFor', 'probe', 'shot', 'eval'],
  );
  assert.equal(scenario.steps[0]?.key?.code, 'ArrowDown');
  assert.deepEqual(scenario.steps[1]?.click, { selector: '#feed', at: null, x: null, y: null });
  assert.deepEqual(scenario.steps[2]?.click, { selector: '.card', at: [4, 6], x: null, y: null });
  assert.deepEqual(scenario.steps[3]?.click, { selector: null, at: null, x: 640, y: 400 });
  assert.equal(scenario.steps[4]?.text, 'привет');
  assert.deepEqual(scenario.steps[5]?.waitFor, {
    expression: 'document.readyState === "complete"',
    frames: 2,
  });
  assert.deepEqual(scenario.steps[6]?.probe, {
    name: 'rows',
    expression: 'document.querySelectorAll(".row").length',
  });
  assert.deepEqual(scenario.steps[7]?.shot, { file: '01.png', clip: { selector: '.feed' } });
  assert.deepEqual(scenario.steps[8]?.eval, {
    name: 'eval9',
    expression: 'document.querySelector("#x").focus()',
  });
});

test('parseScenario: битый JSON и неверная форма — ScenarioError', () => {
  assert.throws(() => parseScenario('{ не json'), ScenarioError);
  assert.throws(() => parseScenario('[]'), ScenarioError);
  assert.throws(() => validateScenario(null), ScenarioError);
  assert.throws(() => validateScenario({ steps: [] }), ScenarioError);
  assert.throws(() => validateScenario({ steps: 'nope' }), ScenarioError);
});

test('validateScenario: неизвестные поля сценария и шага отвергаются', () => {
  assert.throws(
    () => validateScenario({ name: 'x', steps: [{ key: 'Tab' }], extra: true }),
    ScenarioError,
  );
  assert.throws(
    () => validateScenario({ steps: [{ key: 'Tab', bogus: 1 }] }),
    ScenarioError,
  );
});

test('stepKind: ровно одно действие на шаг', () => {
  assert.equal(stepKind({ key: 'Enter' }), 'key');
  assert.equal(stepKind({ shot: 'a.png' }), 'shot');
  assert.throws(() => stepKind({ key: 'Enter', click: '#x' }), ScenarioError);
  assert.throws(() => stepKind({ name: 'no-action' }), ScenarioError);
  assert.throws(() => stepKind('not-an-object' as unknown), ScenarioError);
});

test('нормализация шага key: имя → key/code/keyCode', () => {
  const scenario = validateScenario(scenarioFrom([{ key: 'ArrowDown' }, { key: 'a' }]));
  assert.deepEqual(scenario.steps[0]?.key, {
    key: 'ArrowDown',
    code: 'ArrowDown',
    keyCode: 40,
    modifiers: 0,
  });
  assert.deepEqual(scenario.steps[1]?.key, { key: 'a', code: 'KeyA', keyCode: 65, modifiers: 0 });
});

test('шаг key: модификаторы на уровне шага и в объекте', () => {
  const scenario = validateScenario(
    scenarioFrom([
      { key: 'a', modifiers: ['ctrl'] },
      { key: { key: 'ArrowRight', modifiers: ['shift', 'alt'] } },
    ]),
  );
  assert.deepEqual(scenario.steps[0]?.key, { key: 'a', code: 'KeyA', keyCode: 65, modifiers: 2 });
  assert.equal(scenario.steps[1]?.key?.modifiers, 9);
  // Модификаторы либо в объекте, либо рядом — не одновременно.
  assert.throws(
    () => validateScenario(scenarioFrom([{ key: { key: 'a' }, modifiers: ['ctrl'] }])),
    ScenarioError,
  );
});

test('resolveKey: явные code/keyCode для редких клавиш и ошибки на неизвестных', () => {
  assert.deepEqual(resolveKey({ key: 'F5', code: 'F5', keyCode: 116 }), {
    key: 'F5',
    code: 'F5',
    keyCode: 116,
    modifiers: 0,
  });
  assert.throws(() => resolveKey('F5'), ScenarioError);
  assert.throws(() => resolveKey(''), ScenarioError);
  assert.throws(() => resolveKey({ key: 'a', unknown: 1 }), ScenarioError);
});

test('normalizeModifiers: имена, маска и ошибки', () => {
  assert.equal(normalizeModifiers(undefined), 0);
  assert.equal(normalizeModifiers(['shift', 'ctrl']), 10);
  assert.equal(normalizeModifiers(['Shift']), 8);
  assert.equal(normalizeModifiers(3), 3);
  assert.throws(() => normalizeModifiers(['hyper']), ScenarioError);
  assert.throws(() => normalizeModifiers(16), ScenarioError);
  assert.throws(() => normalizeModifiers('shift'), ScenarioError);
});

test('waitFor: формы выражения, кадров и пустого объекта', () => {
  const scenario = validateScenario(
    scenarioFrom([
      { waitFor: 'a === 1' },
      { waitFor: 3 },
      { waitFor: {} },
      { waitFor: { expression: 'b', frames: 1 } },
    ]),
  );
  assert.deepEqual(scenario.steps[0]?.waitFor, { expression: 'a === 1', frames: 0 });
  assert.deepEqual(scenario.steps[1]?.waitFor, { expression: null, frames: 3 });
  assert.deepEqual(scenario.steps[2]?.waitFor, { expression: null, frames: 2 });
  assert.deepEqual(scenario.steps[3]?.waitFor, { expression: 'b', frames: 1 });
  assert.throws(() => validateScenario(scenarioFrom([{ waitFor: { frames: 0 } }])), ScenarioError);
});

test('probe: строка и объект, автоимя', () => {
  const scenario = validateScenario(
    scenarioFrom([{ probe: 'document.title' }, { probe: { name: 'n', expression: '1 + 1' } }]),
  );
  assert.deepEqual(scenario.steps[0]?.probe, { name: 'probe1', expression: 'document.title' });
  assert.deepEqual(scenario.steps[1]?.probe, { name: 'n', expression: '1 + 1' });
});

test('shot: clip-формы и защита от выхода за каталог отчёта', () => {
  const scenario = validateScenario(
    scenarioFrom([
      { shot: '01.png' },
      { shot: { file: 'sub/02.png', clip: [1, 2, 3, 4] } },
      { shot: { file: '03.png', clip: { x: 1, y: 2, width: 3, height: 4 } } },
    ]),
  );
  assert.deepEqual(scenario.steps[0]?.shot, { file: '01.png', clip: null });
  assert.deepEqual(scenario.steps[1]?.shot, {
    file: 'sub/02.png',
    clip: { x: 1, y: 2, width: 3, height: 4 },
  });
  assert.deepEqual(scenario.steps[2]?.shot, {
    file: '03.png',
    clip: { x: 1, y: 2, width: 3, height: 4 },
  });
  assert.throws(() => validateScenario(scenarioFrom([{ shot: '../escape.png' }])), ScenarioError);
  assert.throws(() => validateScenario(scenarioFrom([{ shot: 'C:/abs.png' }])), ScenarioError);
  assert.throws(
    () => validateScenario(scenarioFrom([{ shot: { file: 'a.png', clip: [1, 2, 0, 4] } }])),
    ScenarioError,
  );
});

test('click: селектор и координаты взаимоисключающи, нужен один из них', () => {
  assert.throws(
    () => validateScenario(scenarioFrom([{ click: { selector: '#x', x: 1 } }])),
    ScenarioError,
  );
  assert.throws(() => validateScenario(scenarioFrom([{ click: {} }])), ScenarioError);
  assert.throws(() => validateScenario(scenarioFrom([{ click: [1, 2, 3] }])), ScenarioError);
  assert.throws(() => validateScenario(scenarioFrom([{ click: { selector: '#x', bogus: 1 } }])), ScenarioError);
});

test('text и timeout: пустая строка и нечисловой лимит отвергаются', () => {
  assert.throws(() => validateScenario(scenarioFrom([{ text: '' }])), ScenarioError);
  assert.throws(() => validateScenario(scenarioFrom([{ key: 'Tab', timeout: 0 }])), ScenarioError);
  assert.throws(() => validateScenario({ steps: [{ key: 'Tab' }], timeout: -1 }), ScenarioError);
  const scenario = validateScenario(scenarioFrom([{ key: 'Tab', timeout: 250 }]));
  assert.equal(scenario.steps[0]?.timeout, 250);
});

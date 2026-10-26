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
  REGION_CHECK_KINDS,
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
        { hover: '#card' },
        { hover: { selector: '.row', at: [2, 3] } },
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
  assert.equal(scenario.steps.length, 11);
  assert.deepEqual(
    scenario.steps.map((step) => step.kind),
    ['key', 'click', 'click', 'click', 'hover', 'hover', 'text', 'waitFor', 'probe', 'shot', 'eval'],
  );
  assert.equal(scenario.steps[0]?.key?.code, 'ArrowDown');
  assert.deepEqual(scenario.steps[1]?.click, {
    selector: '#feed',
    at: null,
    x: null,
    y: null,
    count: 1,
    allowMismatch: false,
  });
  assert.deepEqual(scenario.steps[2]?.click, {
    selector: '.card',
    at: [4, 6],
    x: null,
    y: null,
    count: 1,
    allowMismatch: false,
  });
  assert.deepEqual(scenario.steps[3]?.click, {
    selector: null,
    at: null,
    x: 640,
    y: 400,
    count: 1,
    allowMismatch: false,
  });
  assert.deepEqual(scenario.steps[4]?.hover, { selector: '#card', at: null, x: null, y: null });
  assert.deepEqual(scenario.steps[5]?.hover, { selector: '.row', at: [2, 3], x: null, y: null });
  assert.equal(scenario.steps[6]?.text, 'привет');
  assert.deepEqual(scenario.steps[7]?.waitFor, {
    expression: 'document.readyState === "complete"',
    frames: 2,
  });
  assert.deepEqual(scenario.steps[8]?.probe, {
    name: 'rows',
    expression: 'document.querySelectorAll(".row").length',
  });
  assert.deepEqual(scenario.steps[9]?.shot, { file: '01.png', clip: { selector: '.feed' } });
  assert.deepEqual(scenario.steps[10]?.eval, {
    name: 'eval11',
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

test('click.count: двойной клик; ноль/дробь/нечисло отвергаются; у hover поля нет', () => {
  const scenario = validateScenario(scenarioFrom([{ click: { selector: '.cal-day', count: 2 } }]));
  assert.equal(scenario.steps[0]?.click?.count, 2, 'count=2 — двойной клик');
  assert.throws(
    () => validateScenario(scenarioFrom([{ click: { selector: '#x', count: 0 } }])),
    ScenarioError,
  );
  assert.throws(
    () => validateScenario(scenarioFrom([{ click: { selector: '#x', count: 1.5 } }])),
    ScenarioError,
  );
  // У наведения `count` — неизвестное поле (наведение не кликает).
  assert.throws(
    () => validateScenario(scenarioFrom([{ hover: { selector: '#x', count: 2 } }])),
    ScenarioError,
  );
});

test('click.allowMismatch: по умолчанию false; true только с selector; у hover и drag поля нет', () => {
  // По умолчанию промах после перемеров ВАЛИТ шаг (блокер af96d388): флаг
  // обязан быть явным, а значение по умолчанию — false.
  const byDefault = validateScenario(scenarioFrom([{ click: { selector: '.canvas', at: [300, 40] } }]));
  assert.equal(byDefault.steps[0]?.click?.allowMismatch, false, 'по умолчанию промах запрещён');

  const allowed = validateScenario(
    scenarioFrom([{ click: { selector: '.canvas', at: [300, 40], allowMismatch: true } }]),
  );
  assert.equal(allowed.steps[0]?.click?.allowMismatch, true, 'явное разрешение сохраняется');

  // Без селектора попадание не проверяется — разрешать нечего.
  assert.throws(
    () => validateScenario(scenarioFrom([{ click: { x: 10, y: 20, allowMismatch: true } }])),
    ScenarioError,
  );
  // Не булево — ошибка валидации, а не «истинно всё, что не false».
  assert.throws(
    () => validateScenario(scenarioFrom([{ click: { selector: '#x', allowMismatch: 'yes' } }])),
    ScenarioError,
  );
  // У наведения флага нет: точка наведения сверяется с целью, и промах всегда
  // валит шаг — «наведение по пустой точке» стенду не нужно (af96d388).
  assert.throws(
    () => validateScenario(scenarioFrom([{ hover: { selector: '#x', allowMismatch: true } }])),
    ScenarioError,
  );
  // У точек drag флага тоже нет: источник и цель обязаны попадать в свой элемент.
  assert.throws(
    () =>
      validateScenario(
        scenarioFrom([
          { drag: { from: { selector: '#handle', allowMismatch: true }, to: '#row', expect: '#row' } },
        ]),
      ),
    ScenarioError,
  );
  assert.throws(
    () =>
      validateScenario(
        scenarioFrom([
          { drag: { from: '#handle', to: { selector: '#row', allowMismatch: true }, expect: '#row' } },
        ]),
      ),
    ScenarioError,
  );
});

test('hover: та же форма точки, что у click; ошибки называют поле «hover»', () => {
  const scenario = validateScenario(scenarioFrom([{ hover: { selector: '.row', at: [1, 2] } }]));
  assert.deepEqual(scenario.steps[0]?.hover, { selector: '.row', at: [1, 2], x: null, y: null });
  assert.throws(
    () => validateScenario(scenarioFrom([{ hover: { selector: '#x', x: 1 } }])),
    ScenarioError,
  );
  assert.throws(() => validateScenario(scenarioFrom([{ hover: {} }])), ScenarioError);
  // Ошибка обязана называть поле `hover`, а не `click` (общий нормализатор точки).
  assert.throws(
    () => validateScenario(scenarioFrom([{ hover: [1, 2, 3] }])),
    (err: unknown) => err instanceof ScenarioError && /\.hover/.test(err.message),
  );
});

test('drag: составной жест нормализуется; expect обязателен', () => {
  const scenario = validateScenario(
    scenarioFrom([
      {
        drag: {
          from: '#handle',
          to: { selector: '.row', at: [10, 2] },
          expect: '.row',
          steps: 6,
          duration: 120,
          modifiers: ['shift'],
          targetTimeout: 3000,
        },
      },
      { drag: { from: [1, 2], to: [30, 40], expect: '.drop' } },
    ]),
  );
  assert.deepEqual(scenario.steps[0]?.drag, {
    from: { selector: '#handle', at: null, x: null, y: null },
    to: { selector: '.row', at: [10, 2], x: null, y: null },
    expect: '.row',
    steps: 6,
    duration: 120,
    modifiers: 8,
    targetTimeout: 3000,
  });
  assert.deepEqual(scenario.steps[1]?.drag, {
    from: { selector: null, at: null, x: 1, y: 2 },
    to: { selector: null, at: null, x: 30, y: 40 },
    expect: '.drop',
    steps: 8,
    duration: 0,
    modifiers: 0,
    targetTimeout: 2000,
  });
  // expect обязателен: без него промах координат молча давал бы «ok».
  assert.throws(() => validateScenario(scenarioFrom([{ drag: { from: '#h', to: '#t' } }])), ScenarioError);
  assert.throws(() => validateScenario(scenarioFrom([{ drag: { to: '#t', expect: '#t' } }])), ScenarioError);
  assert.throws(() => validateScenario(scenarioFrom([{ drag: { from: '#h', expect: '#t' } }])), ScenarioError);
  assert.throws(
    () => validateScenario(scenarioFrom([{ drag: { from: '#h', to: '#t', expect: '#t', steps: 0 } }])),
    ScenarioError,
  );
  assert.throws(
    () => validateScenario(scenarioFrom([{ drag: { from: '#h', to: '#t', expect: '#t', bogus: 1 } }])),
    ScenarioError,
  );
});

test('text и timeout: пустая строка и нечисловой лимит отвергаются', () => {
  assert.throws(() => validateScenario(scenarioFrom([{ text: '' }])), ScenarioError);
  assert.throws(() => validateScenario(scenarioFrom([{ key: 'Tab', timeout: 0 }])), ScenarioError);
  assert.throws(() => validateScenario({ steps: [{ key: 'Tab' }], timeout: -1 }), ScenarioError);
  const scenario = validateScenario(scenarioFrom([{ key: 'Tab', timeout: 250 }]));
  assert.equal(scenario.steps[0]?.timeout, 250);
});

test('assert: регион и проверки нормализуются с значениями по умолчанию', () => {
  const scenario = validateScenario(
    scenarioFrom([
      {
        assert: {
          name: 'cloud',
          region: '.cloud.halo',
          checks: [
            { kind: 'notBlank' },
            { kind: 'colorAt', at: [3, 4], color: '#ffffff' },
            { kind: 'hasColor', color: '#000000', minPixels: 5 },
            { kind: 'distinct', minColors: 4 },
          ],
        },
      },
      { assert: { region: [10, 20, 30, 40], checks: [{ kind: 'notBlank', minRatio: 0.5 }] } },
    ]),
  );
  assert.ok(REGION_CHECK_KINDS.includes('notBlank'));
  assert.equal(scenario.steps[0]?.kind, 'assert');
  const first = scenario.steps[0]?.assert;
  assert.equal(first?.name, 'cloud');
  assert.deepEqual(first?.region, { selector: '.cloud.halo' });
  assert.equal(first?.checks.length, 4);
  assert.equal(first?.checks[0]?.name, 'notBlank1');
  assert.deepEqual(first?.checks[1], {
    kind: 'colorAt',
    name: 'colorAt2',
    at: [3, 4],
    color: '#ffffff',
    tolerance: 8,
  });
  assert.deepEqual(first?.checks[2], {
    kind: 'hasColor',
    name: 'hasColor3',
    color: '#000000',
    tolerance: 8,
    minPixels: 5,
  });
  assert.deepEqual(first?.checks[3], { kind: 'distinct', name: 'distinct4', minColors: 4 });
  assert.equal(first?.evidence, false);
  const second = scenario.steps[1]?.assert;
  assert.deepEqual(second?.region, { x: 10, y: 20, width: 30, height: 40 });
  assert.equal(second?.name, 'assert2');
});

test('assert: ошибки формы региона и проверок', () => {
  assert.throws(() => validateScenario(scenarioFrom([{ assert: { checks: [{ kind: 'notBlank' }] } }])), ScenarioError);
  assert.throws(() => validateScenario(scenarioFrom([{ assert: { region: '.x', checks: [] } }])), ScenarioError);
  assert.throws(
    () => validateScenario(scenarioFrom([{ assert: { region: '.x', checks: [{ kind: 'blur' }] } }])),
    ScenarioError,
  );
  assert.throws(
    () => validateScenario(scenarioFrom([{ assert: { region: '.x', checks: [{ kind: 'notBlank', bogus: 1 }] } }])),
    ScenarioError,
  );
  assert.throws(
    () => validateScenario(scenarioFrom([{ assert: { region: '.x', checks: [{ kind: 'colorAt', at: [1], color: '#fff' }] } }])),
    ScenarioError,
  );
  assert.throws(
    () => validateScenario(scenarioFrom([{ assert: { region: '.x', checks: [{ kind: 'notBlank' }], evidence: 'да' } }])),
    ScenarioError,
  );
});

test('api: метод/путь/выражение и ожидание как мета-поле', () => {
  const scenario = validateScenario(
    scenarioFrom([
      {
        name: 'db',
        api: {
          name: 'comment-in-db',
          path: '/networks/{{networkId}}/thoughts/{{thoughtId}}/comments',
          expression: "data.find((c) => c.kind === 'permanent').body_md",
        },
        expect: '**текст**',
      },
      { api: { path: '/networks' } },
    ]),
  );
  assert.equal(scenario.steps[0]?.kind, 'api');
  assert.deepEqual(scenario.steps[0]?.api, {
    name: 'comment-in-db',
    method: 'GET',
    path: '/networks/{{networkId}}/thoughts/{{thoughtId}}/comments',
    expression: "data.find((c) => c.kind === 'permanent').body_md",
  });
  assert.equal(scenario.steps[0]?.expect, '**текст**');
  assert.deepEqual(scenario.steps[1]?.api, { name: 'api2', method: 'GET', path: '/networks', expression: null });
});

test('api: необязательное JSON-тело запроса', () => {
  const scenario = validateScenario(
    scenarioFrom([
      {
        name: 'seed',
        api: {
          name: 'seed-record',
          method: 'POST',
          path: '/networks/{{networkId}}/thoughts/{{thoughtId}}/comments',
          body: { kind: 'chronological', body_md: 'текст' },
          expression: 'data.id',
        },
      },
    ]),
  );
  assert.deepEqual(scenario.steps[0]?.api, {
    name: 'seed-record',
    method: 'POST',
    path: '/networks/{{networkId}}/thoughts/{{thoughtId}}/comments',
    expression: 'data.id',
    body: { kind: 'chronological', body_md: 'текст' },
  });
  // Тело не объект — ошибка валидации.
  assert.throws(
    () => validateScenario(scenarioFrom([{ api: { path: '/x', body: 'text' } }])),
    ScenarioError,
  );
});

test('api: ошибки метода/пути и формы', () => {
  assert.throws(() => validateScenario(scenarioFrom([{ api: { path: 'networks' } }])), ScenarioError);
  assert.throws(() => validateScenario(scenarioFrom([{ api: { method: 'TRACE', path: '/x' } }])), ScenarioError);
  assert.throws(() => validateScenario(scenarioFrom([{ api: 'x' }])), ScenarioError);
  assert.throws(() => validateScenario(scenarioFrom([{ api: { path: '/x', bogus: 1 } }])), ScenarioError);
});

test('expect: допустим только у probe и api', () => {
  const ok = validateScenario(scenarioFrom([{ probe: '1 + 1', expect: 2 }]));
  assert.equal(ok.steps[0]?.expect, 2);
  assert.throws(() => validateScenario(scenarioFrom([{ key: 'Tab', expect: 1 }])), ScenarioError);
  assert.throws(() => validateScenario(scenarioFrom([{ shot: 'a.png', expect: 1 }])), ScenarioError);
});

test('expectFrom: ожидание — снимок ранее выполненного шага (делает сценарий самопроверяемым)', () => {
  const scenario = validateScenario(
    scenarioFrom([
      {
        name: 'headings-before',
        api: { name: 'headings-before', path: '/networks/{{networkId}}/publications/{{pubId}}/assembly', expression: 'data.sections.map((s) => s.heading)' },
      },
      { key: 'Tab' },
      {
        name: 'headings-after',
        api: { name: 'headings-after', path: '/networks/{{networkId}}/publications/{{pubId}}/assembly', expression: 'data.sections.map((s) => s.heading)' },
        expectFrom: 'headings-before',
      },
      { probe: { name: 'rows', expression: '[1]' }, expectFrom: 'headings-before' },
    ]),
  );
  assert.equal(scenario.steps[0]?.expectFrom, undefined, 'снимок «до» ожидания не требует');
  assert.equal(scenario.steps[2]?.expectFrom, 'headings-before');
  assert.equal(scenario.steps[2]?.expect, undefined, 'литерал и снимок не смешиваются');
  assert.equal(scenario.steps[3]?.kind, 'probe');
  assert.equal(scenario.steps[3]?.expectFrom, 'headings-before', 'снимок работает и у probe');
  // «expectFrom» допустим только у probe/api (как и «expect»).
  assert.throws(() => validateScenario(scenarioFrom([{ key: 'Tab', expectFrom: 'x' }])), ScenarioError);
  assert.throws(() => validateScenario(scenarioFrom([{ shot: 'a.png', expectFrom: 'x' }])), ScenarioError);
  // Ожидание задаётся либо литералом, либо снимком — не обоими.
  assert.throws(
    () => validateScenario(scenarioFrom([{ api: { path: '/x' }, expect: 1, expectFrom: 'x' }])),
    ScenarioError,
  );
  // Пустое имя шага-снимка отвергается.
  assert.throws(
    () => validateScenario(scenarioFrom([{ api: { path: '/x' }, expectFrom: '' }])),
    ScenarioError,
  );
  // Самоссылка — тавтология: раннер кладёт значение шага в `context.values` под
  // его именем ДО проверки ожидания, поэтому шаг сверялся бы сам с собой и был
  // бы всегда зелёным. Валидация обязана отвергать такую ссылку.
  assert.throws(
    () =>
      validateScenario(
        scenarioFrom([{ name: 'p', probe: { name: 'p', expression: '1' }, expectFrom: 'p' }]),
      ),
    ScenarioError,
  );
  // Автоимя шага — тоже самоссылка (ключ снимка в `context.values` — имя ШАГА,
  // а не вложенное имя пробы).
  assert.throws(
    () => validateScenario(scenarioFrom([{ probe: { expression: '1' }, expectFrom: '1:probe' }])),
    ScenarioError,
  );
});

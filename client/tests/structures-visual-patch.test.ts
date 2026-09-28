/**
 * Уровень 0 тех.проекта «Инкрементальное обновление списков UI» (задача
 * 1a0a607d): точечный визуальный патч дерева «Структур» без пересборки.
 *
 * Клик по облачку меняет только визуальный слой store (текущая мысль/выборка),
 * но раньше это звало `renderTree` с `clear(resultsHost)` — список пересоздавался
 * и прокрутка сбрасывалась вверх. Здесь пинится механика патча
 * (`visual-states.ts`, DOM-шим — jsdom в проекте нет) и ПРОВОДКА экрана
 * `structures.ts`: реакция на store разделена на слои данных и визуальный.
 *
 * Сам `structures.ts` в node-тесте не поднимается (тянет `app.js`/холст/
 * редактор — см. `structures-trash-mark.test.ts`), поэтому его проводка
 * проверяется структурно по исходнику.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';
import { CLOUD_SELECTOR, patchCloudVisualStates } from '../src/renderer/screens/structures/visual-states.js';

const STRUCTURES_TS = path.resolve(
  import.meta.dirname,
  '..',
  'src',
  'renderer',
  'screens',
  'structures',
  'structures.ts',
);

/** Собирает шим-дерево: `.st-results` со строками `.st-row` и облачками. */
function buildCloudTree(ids: string[]): { root: ShimElement; clouds: Map<string, ShimElement> } {
  const root = new ShimElement('div', 'st-results');
  root.scrollTop = 480;
  const clouds = new Map<string, ShimElement>();
  for (const id of ids) {
    const row = new ShimElement('div', 'st-row');
    const cloud = new ShimElement('div', 'st-cloud');
    cloud.dataset['id'] = id;
    row.append(cloud);
    root.append(row);
    clouds.set(id, cloud);
  }
  return { root, clouds };
}

/** Патч на шим-дереве: `stateOf` по карте состояний. */
function patch(
  root: ShimElement,
  states: Record<string, { selected: boolean; halo: boolean }>,
): void {
  patchCloudVisualStates(root as unknown as ParentNode, (id) =>
    states[id] ?? { selected: false, halo: false },
  );
}

const has = (el: ShimElement, cls: string): boolean => el.classList.contains(cls);

describe('структуры: точечный патч облачков (задача 1a0a607d)', () => {
  it('переставляет halo/selected, не пересоздавая узлы и не двигая прокрутку', () => {
    const { root, clouds } = buildCloudTree(['a', 'b', 'c']);
    const before = root.querySelectorAll(CLOUD_SELECTOR);
    const scrollBefore = root.scrollTop;

    patch(root, { c: { selected: false, halo: true }, b: { selected: true, halo: false } });

    const after = root.querySelectorAll(CLOUD_SELECTOR);
    // DOM-identity: те же самые узлы (никакого clear/replaceChildren).
    assert.equal(after.length, before.length);
    for (let i = 0; i < before.length; i++) assert.equal(after[i], before[i]);
    assert.equal(scrollBefore, root.scrollTop, 'прокрутка списка не меняется');
    // halo переехал на новую мысль, у прежней снят; selected — по выборке.
    assert.equal(has(clouds.get('c')!, 'halo'), true);
    assert.equal(has(clouds.get('a')!, 'halo'), false);
    assert.equal(has(clouds.get('b')!, 'selected'), true);
    assert.equal(has(clouds.get('a')!, 'selected'), false);
  });

  it('повторный патч симметрично снимает прежние классы (регресс Ctrl+клик и сброса)', () => {
    const { root, clouds } = buildCloudTree(['a', 'b']);
    patch(root, { a: { selected: true, halo: true } });
    assert.equal(has(clouds.get('a')!, 'halo'), true);
    assert.equal(has(clouds.get('a')!, 'selected'), true);

    // Клик по пустому месту: выборка/текущая мысль сброшены → классы сняты.
    patch(root, {});
    assert.equal(has(clouds.get('a')!, 'halo'), false);
    assert.equal(has(clouds.get('a')!, 'selected'), false);

    // Новая выборка другого облачка — прежнее очищено, узлы те же.
    const aCloud = clouds.get('a')!;
    patch(root, { b: { selected: true, halo: true } });
    assert.equal(clouds.get('a'), aCloud);
    assert.equal(has(clouds.get('b')!, 'selected'), true);
    assert.equal(has(clouds.get('b')!, 'halo'), true);
  });

  it('облачко без data-id пропускается без падения', () => {
    const { root } = buildCloudTree(['a']);
    const orphan = new ShimElement('div', 'st-cloud');
    root.append(orphan);
    assert.doesNotThrow(() => patch(root, { a: { selected: true, halo: false } }));
    assert.equal(has(orphan, 'selected'), false);
  });
});

describe('структуры: проводка слоёв реакции на store (задача 1a0a607d)', () => {
  const source = fs.readFileSync(STRUCTURES_TS, 'utf8');
  const noComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  it('buildCloud берёт классы из общей cloudVisualState (одно определение)', () => {
    assert.match(noComments, /const visual = cloudVisualState\(row\.thoughtId, selection\)/);
    assert.match(noComments, /if \(visual\.halo\) cloud\.classList\.add\('halo'\)/);
  });

  it('реакция на store разделена на данные (renderTree) и визуальный слой (патч)', () => {
    assert.match(noComments, /function reactToStore\(\): void/);
    assert.match(noComments, /function dataSlice\(\): DataSlice/);
    assert.match(noComments, /function visualSlice\(\): VisualSlice/);
    // Визуальный путь идёт через патч и НЕ пересобирает дерево.
    assert.match(noComments, /function patchVisualStates\(\): void \{[\s\S]*?patchCloudVisualStates\(/);
    const patchBody = noComments.slice(noComments.indexOf('function patchVisualStates()'));
    const patchEnd = patchBody.indexOf('\n}\n');
    assert.ok(
      !patchBody.slice(0, patchEnd).includes('renderTree('),
      'визуальный патч не должен звать renderTree',
    );
    // Оба пути фиксируют срезы, чтобы прямой renderTree не «вооружал» rebuild.
    assert.ok(
      (noComments.match(/syncRenderSlices\(dataSlice\(\), visualSlice\(\)\)/g) ?? []).length >= 2,
      'срезы фиксируются и в renderTree, и в patchVisualStates',
    );
  });
});

/**
 * Расширенное перетаскивание мыслей (задача d144ef71).
 *
 * Чистая семантика дропа в поле (`resolveFieldDrop`) и обход приёмников
 * (`walkDropField`) проверяются напрямую. Связывание жестов/фасадов — по
 * якорям исходников (клиентские тесты идут без jsdom, конвенция соседних
 * тестов): поля редактора и панелей отбора регистрируют приёмник; чипы
 * редактора становятся источником pointer-жеста; `drag-cloud` различает
 * перенос в поле и диалог выбора свойства-связи.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  resolveFieldDrop,
  walkDropField,
} from '../src/renderer/lib/thought-drop-pure.js';

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');
const readText = (rel: string): string => readFileSync(resolve(RENDERER, rel), 'utf8');

describe('resolveFieldDrop: перенос vs копирование (d144ef71)', () => {
  it('перенос между полями-связями без Shift снимает мысль из источника', () => {
    assert.deepEqual(
      resolveFieldDrop({
        accepted: true,
        originIsField: true,
        sameField: false,
        copy: false,
        targetMovable: true,
      }),
      { add: true, removeFromSource: true },
    );
  });

  it('Shift — копирование: источник не трогается', () => {
    assert.deepEqual(
      resolveFieldDrop({
        accepted: true,
        originIsField: true,
        sameField: false,
        copy: true,
        targetMovable: true,
      }),
      { add: true, removeFromSource: false },
    );
  });

  it('бросок в своё же поле не снимает источник', () => {
    assert.deepEqual(
      resolveFieldDrop({
        accepted: true,
        originIsField: true,
        sameField: true,
        copy: false,
        targetMovable: true,
      }),
      { add: true, removeFromSource: false },
    );
  });

  it('мысль уже была в приёмнике — не изменение и не снятие из источника', () => {
    assert.deepEqual(
      resolveFieldDrop({
        accepted: false,
        originIsField: true,
        sameField: false,
        copy: false,
        targetMovable: true,
      }),
      { add: false, removeFromSource: false },
    );
  });

  it('драг с карты/панели (не из поля) только добавляет', () => {
    assert.deepEqual(
      resolveFieldDrop({
        accepted: true,
        originIsField: false,
        sameField: false,
        copy: false,
        targetMovable: true,
      }),
      { add: true, removeFromSource: false },
    );
  });

  // Регресс по блокеру проверки: чип поля-связи, брошенный в НЕ-полевой
  // приёмник («Родительские мысли», панель отбора), не должен сниматься из
  // поля-источника — там только добавление.
  it('бросок чипа поля-связи в приёмник-фильтр НЕ снимает значение из источника', () => {
    assert.deepEqual(
      resolveFieldDrop({
        accepted: true,
        originIsField: true,
        sameField: false,
        copy: false,
        targetMovable: false,
      }),
      { add: true, removeFromSource: false },
    );
  });
});

describe('walkDropField: поиск приёмника по цепочке родителей (d144ef71)', () => {
  interface Node {
    id: string;
    parentElement?: Node | null;
    parent?: Node | null;
  }

  it('находит ближайшего зарегистрированного предка', () => {
    const root: Node = { id: 'root' };
    const mid: Node = { id: 'mid', parentElement: root };
    const chip: Node = { id: 'chip', parentElement: mid };
    const registry = { mid: { accept: () => true } };
    const found = walkDropField(chip, (node) => registry[(node as Node).id as 'mid']);
    assert.equal(found?.el, mid);
  });

  it('падает на `parent` (лёгкие тестовые элементы без parentElement)', () => {
    const root: Node = { id: 'root' };
    const chip: Node = { id: 'chip', parent: root };
    const found = walkDropField(chip, (node) => ((node as Node).id === 'root' ? 'FIELD' : undefined));
    assert.equal(found?.handlers, 'FIELD');
  });

  it('нет зарегистрированного предка — null', () => {
    const chip: Node = { id: 'chip', parentElement: { id: 'x', parentElement: null } };
    assert.equal(walkDropField(chip, () => undefined), null);
  });
});

describe('связывание поля редактора (d144ef71)', () => {
  const src = readText('editor/value-editor.ts');

  it('buildLinkValueEditor регистрирует корень как приёмник мыслей', () => {
    assert.match(src, /registerThoughtDropField\(root, \{/);
    assert.match(src, /kind: 'link-value',/);
    assert.match(src, /accept: \(id: string\): boolean =>/);
  });

  it('чипы значения тянутся pointer-жестом из поля (origin field)', () => {
    assert.match(src, /wireExternalDragSource\(cloud, id, 'field-chip', \{/);
    assert.match(src, /sourceField: root,/);
    assert.match(src, /removeFromSource: \(\) => removeEdges\(\[id\], 'auto'\)/);
  });
});

describe('приёмник панелей отбора (d144ef71)', () => {
  const src = readText('lib/filter-form.ts');

  it('«Родительские мысли» регистрируют чип-поле как приёмник-фильтр', () => {
    assert.match(src, /registerThoughtDropField\(section\.fieldRoot, \{/);
    assert.match(src, /kind: 'filter',/);
    assert.match(src, /ctx\.getState\(\)\.parentIds = \[\.\.\.values, id\]/);
    assert.match(src, /resolveClouds\(\);\s*\n\s*ctx\.touch\(\);/);
  });

  it('секция отдаёт корень поля наружу для регистрации', () => {
    assert.match(src, /fieldRoot: HTMLElement;/);
    assert.match(src, /fieldRoot: field\.root/);
  });

  it('панель «Структур» принимает drop в любое место как приёмник-фильтр', () => {
    const structures = readText('screens/structures/filter-panel.ts');
    assert.match(structures, /registerThoughtDropField\(panelHost, \{/);
    assert.match(structures, /kind: 'filter',/);
    assert.match(structures, /state\.parentIds = \[\.\.\.state\.parentIds, id\]/);
    assert.match(structures, /callbacks\?\.onStatePersist\(\)/);
  });
});

describe('единый pointer-канал drag-cloud (d144ef71)', () => {
  const src = readText('canvas/drag-cloud.ts');

  it('источник-поле несёт поле и снятие из источника', () => {
    assert.match(src, /sourceField\?: HTMLElement;/);
    assert.match(src, /removeFromSource\?: \(\) => void;/);
    assert.match(src, /type DragOrigin = 'cloud' \| 'selection' \| 'history' \| 'pinned' \| 'chronicle' \| 'field-chip';/);
  });

  it('дроп в поле разрешается приёмником; перенос снимает источник только у link-value', () => {
    assert.match(src, /const fieldTarget = resolveThoughtDropField\(el\);/);
    assert.match(src, /case 'field-add': \{/);
    assert.match(src, /const field = resolveThoughtDropField\(fieldEl\);/);
    assert.match(src, /const accepted = field\?\.handlers\.accept\(g\.id\) \?\? false;/);
    assert.match(src, /resolveFieldDrop\(\{/);
    assert.match(src, /targetMovable: field\?\.handlers\.kind === 'link-value',/);
    assert.match(src, /if \(plan\.removeFromSource\) g\.removeFromSource\?\.\(\);/);
  });

  it('дроп из поля на облачко открывает диалог свойства-связи', () => {
    assert.match(src, /case 'link-dialog':/);
    assert.match(src, /void openLinkPropertyDropDialog\(\{ draggedId: g\.id, targetId: target\.targetThoughtId! \}\)/);
    assert.match(src, /if \(dragged\.origin === 'field-chip'\) \{/);
  });

  it('чипы вне зарегистрированного поля тоже цель диалога', () => {
    assert.match(src, /'\.cloud\[data-id\], \.prop-ref-cloud\[data-id\]'/);
  });

  it('поле-источник не имеет семантики зон (нет случайного переворота связи)', () => {
    assert.match(src, /if \(dragged\.origin === 'field-chip'\) return \{ kind: 'none' \};/);
  });
});

describe('диалог выбора свойства-связи (d144ef71)', () => {
  const src = readText('lib/thought-drop.ts');

  it('использует готовое комбо link-properties и общий диалог', () => {
    assert.match(src, /kind: 'link-properties'/);
    assert.match(src, /showDialog\(\{/);
    assert.match(src, /onChangeEntity: \(option\) => \{/);
  });

  it('пишет связь через общий модуль записи значения-связи', () => {
    assert.match(src, /import \{ addLinkPropertyValue \} from '\.\/link-property-write\.js';/);
    assert.match(src, /addLinkPropertyValue\(networkId, opts\.draggedId, chosen, opts\.targetId\)/);
    assert.match(src, /notifyPropertyValuesRefreshed\(chosen\.key\)/);
    const write = readText('lib/link-property-write.ts');
    assert.match(write, /signalPublicationCompositionChanged\(\[ownerId, anchorId\]\)/);
  });

  it('строки UI — из словаря', () => {
    assert.match(src, /t\('thoughtDrop\.linkPropertyTitle'\)/);
  });
});

describe('эллипс не расширялся под чипы (возврат претензии, d144ef71)', () => {
  it('селектор цели эллипса НЕ включает чип поля-связи', () => {
    const src = readText('canvas/canvas.ts');
    const selector = /const ELLIPSE_DROP_TARGET_SELECTOR =\s*\n\s*'([^']+)'/;
    const match = selector.exec(src);
    assert.ok(match !== null, 'селектор эллипса объявлен');
    assert.doesNotMatch(match[1] ?? '', /prop-ref-cloud/);
  });
});

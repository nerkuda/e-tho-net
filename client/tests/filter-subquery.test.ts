/**
 * Модальный слой под-выборки (задача 3644342c ТП 11b2509a; элемент интерфейса
 * f5005daa; ADR 4396ca00 «под-выборка в редакторе — модальный слой того же
 * компонента», ADR b0cf5433; требования af7859c9 «подпись чипа ≤ 2 строк»,
 * c088f9e1 «релевантные левые операнды»).
 *
 * Проверяется `lib/filter-subquery.ts` и хук слота значений:
 *   • релевантность операнда — зеркало серверных правил (`property`-ссылка,
 *     `parents`/`children`, `type`; отложенные и нерелевантные — без выборки);
 *   • ячейка даёт переключение «список ↔ выборка»; «выборка» открывает модал с
 *     тем же деревом, «Готово» записывает значение-под-выборку, «Отмена»
 *     не меняет значение;
 *   • повторное открытие — редактирование уже собранного под-дерева;
 *   • вложенность модалов (выборка в выборке) без искусственных ограничений;
 *   • чип с подписью (обрезка до двух строк в CSS) и полным текстом в тултипе;
 *   • смена свойства строки с собранной под-выборкой — сброс с подтверждением.
 *
 * jsdom в проекте нет — минимальный DOM-шим по конвенции диалоговых тестов
 * (`dialog-backdrop-close.test.ts`) плюс окно, которого требуют фасады.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, describe, it } from 'node:test';

import type { NetworkProperty } from '@etn/shared';

import { ShimElement } from './dom-shim.js';

const RENDERER = path.resolve(import.meta.dirname, '..', 'src', 'renderer');

let sub: typeof import('../src/renderer/lib/filter-subquery.js');
let builder: typeof import('../src/renderer/lib/filter-builder.js');

const windowListeners: Array<{ type: string; listener: (event: any) => void }> = [];

function installShim(): void {
  windowListeners.length = 0;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    activeElement: null,
    querySelector: () => null,
  };
  const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
  win['innerWidth'] = 1200;
  win['innerHeight'] = 800;
  win['setTimeout'] = (fn: () => void) => {
    fn();
    return 1;
  };
  win['clearTimeout'] = () => undefined;
  win['addEventListener'] = (type: string, listener: (event: any) => void) => {
    windowListeners.push({ type, listener });
  };
  win['removeEventListener'] = (type: string, listener: (event: any) => void) => {
    const index = windowListeners.findIndex((l) => l.type === type && l.listener === listener);
    if (index >= 0) windowListeners.splice(index, 1);
  };
  win['matchMedia'] = () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
}

function body(): ShimElement {
  return (globalThis as any).document.body as ShimElement;
}

/** Открытые диалоги в порядке отрисовки (верхний — последний). */
function dialogs(): ShimElement[] {
  return body().children.filter((child) => child.classList.contains('dialog-backdrop'));
}

/** Кнопка диалога по надписи (по верхнему открытому слою). */
function dialogButton(label: string): ShimElement {
  const top = dialogs()[dialogs().length - 1]!;
  const button = top
    .findAll((node) => node.tagName === 'button')
    .find((node) => node.flatText().trim() === label);
  assert.notEqual(button, undefined, `в открытом диалоге есть кнопка «${label}»`);
  return button!;
}

/** Открыть модал выборки и вернуть промис его результата. */
function openModal(current: any): Promise<any> {
  return sub.openFilterSubqueryModal(current, { data: DATA, value: VALUE_CTX });
}

/** Разбудить микрозадачи (промисы модала резолвятся через них). */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// Данные сети
// ---------------------------------------------------------------------------

const CITY = {
  id: 'p-city',
  name: 'Город',
  value_type: 'text',
  config: null,
  description: null,
  created_at: '',
  updated_at: '',
} as unknown as NetworkProperty;

const PLACE = {
  id: 'p-place',
  name: 'Место покупки',
  value_type: 'link',
  config: { link_type_id: 'lt-1', multiple: true },
  description: null,
  created_at: '',
  updated_at: '',
} as unknown as NetworkProperty;

const DATE = {
  id: 'p-date',
  name: 'Дата',
  value_type: 'date',
  config: null,
  description: null,
  created_at: '',
  updated_at: '',
} as unknown as NetworkProperty;

const DATA = {
  registry: new Map<string, NetworkProperty>([
    [CITY.id, CITY],
    [PLACE.id, PLACE],
    [DATE.id, DATE],
  ]),
  linkTypes: [{ id: 'lt-1', name_forward: 'Место покупки', name_reverse: 'Покупки здесь' } as any],
};

const VALUE_CTX: any = {
  networkId: 'net-1',
  profile: 'thoughts',
  data: DATA,
};

/** Лист единой модели. */
function leafOf(entity: any, operator: string, value: any = { kind: 'none' }): any {
  return { kind: 'leaf', entity, operator, value };
}

const PLACE_LEAF = (): any => leafOf({ kind: 'property', property_id: PLACE.id }, 'in');

/** Ячейка значения над листом модели: записывает правки значения. */
function buildCell(leaf: any): { cell: ShimElement; values: any[] } {
  const values: any[] = [];
  const api = { setValue: (value: any) => values.push(value) };
  const render = sub.createFilterSubqueryValueRenderer(VALUE_CTX, { data: DATA, value: VALUE_CTX });
  return { cell: render(leaf, api) as unknown as ShimElement, values };
}

function exact(root: ShimElement, cls: string): ShimElement[] {
  return root.findAll((node) => node.classList.contains(cls));
}

function exactOne(root: ShimElement, cls: string): ShimElement | null {
  return exact(root, cls)[0] ?? null;
}

/** Как {@link exactOne}, но учитывает и сам корень (шим ищет только потомков). */
function deepExactOne(root: ShimElement, cls: string): ShimElement | null {
  return root.classList.contains(cls) ? root : exactOne(root, cls);
}

/** Строка выпадающего списка «Что» по ключу каталога (адресу операнда). */
function choiceItem(key: string): ShimElement {
  const item = body()
    .findAll((node) => node.classList.contains('ft-choice__item'))
    .find((node) => node.dataset['key'] === key);
  assert.notEqual(item, undefined, `в списке «Что» есть строка ${key}`);
  return item!;
}

describe('под-выборка: релевантность операнда — зеркало серверных правил (c088f9e1)', () => {
  before(async () => {
    installShim();
    sub = await import('../src/renderer/lib/filter-subquery.js');
    builder = await import('../src/renderer/lib/filter-builder.js');
  });

  it('выборка предлагается на ссылочных операндах, отложенных и нерелевантных — нет', () => {
    const relevant = (entity: any, operator: string) =>
      sub.filterSubqueryRelevantLeaf(leafOf(entity, operator), DATA);

    assert.equal(relevant({ kind: 'property', property_id: PLACE.id }, 'in'), true, 'свойство-ссылка');
    assert.equal(relevant({ kind: 'property', property: 'Покупки здесь', direction: 'in' }, 'not_in'), true, 'обратная сторона');
    assert.equal(relevant({ kind: 'parents' }, 'in'), true, 'структурные «Родители»');
    assert.equal(relevant({ kind: 'children' }, 'all_of'), true);
    assert.equal(relevant({ kind: 'type' }, 'in'), true, '«Тип» с in/not_in');

    assert.equal(relevant({ kind: 'type' }, 'all_of'), false, '«Тип» одиночный — «все в (выборке)» отвергает сервер');
    assert.equal(relevant({ kind: 'property', property_id: CITY.id }, 'in'), false, 'текстовое свойство — не ссылка');
    assert.equal(relevant({ kind: 'property', property_id: PLACE.id }, 'eq'), false, 'оператор вне набора под-выборки');
    assert.equal(relevant({ kind: 'targets' }, 'in'), false, 'отложенный операнд (unsupported)');
    assert.equal(relevant({ kind: 'attachments' }, 'in'), false);
    assert.equal(relevant({ kind: 'chronology' }, 'in'), false);
    assert.equal(relevant({ kind: 'link_type' }, 'in'), false);
    assert.equal(relevant({ kind: 'keywords' }, 'matches'), false, '«Есть слова» — нерелевантный');
    assert.equal(relevant({ kind: 'active' }, 'eq'), false, 'булев предикат — нерелевантный');

    assert.equal(sub.filterSubquerySupported('property'), true);
    assert.equal(sub.filterSubqueryDeferred('targets'), true);
    assert.equal(sub.filterSubqueryValueOperator('in'), 'in');
    assert.equal(sub.filterSubqueryValueOperator('not_in'), 'not_in');
    assert.equal(sub.filterSubqueryValueOperator('all_of'), 'all_in');
  });

  it('подпись условий: коннекторы, скобки вложенности, «без условий»', () => {
    const tree = {
      kind: 'group',
      op: 'and',
      children: [
        leafOf({ kind: 'property', property_id: CITY.id }, 'eq', { kind: 'scalar', value: 'Москва' }),
        {
          kind: 'group',
          op: 'or',
          children: [
            leafOf({ kind: 'property', property_id: DATE.id }, 'gt', { kind: 'scalar', value: '2026-01-01' }),
            leafOf({ kind: 'property', property_id: PLACE.id }, 'is_empty'),
          ],
        },
      ],
    } as any;
    assert.equal(
      sub.filterSubquerySummary(tree, DATA),
      'Город равно Москва И (Дата больше 2026-01-01 ИЛИ Место покупки не заполнено)',
    );
    assert.equal(sub.filterSubquerySummary({ kind: 'group', op: 'and', children: [] } as any, DATA), 'без условий');
    assert.match(
      sub.filterSubquerySummary(
        { kind: 'group', op: 'not', children: [leafOf({ kind: 'parents' }, 'in')] } as any,
        DATA,
      ),
      /^НЕ \(Родители/,
    );
  });
});

describe('под-выборка: ячейка значения «список ↔ выборка» и модал', () => {
  before(async () => {
    installShim();
    sub = await import('../src/renderer/lib/filter-subquery.js');
    builder = await import('../src/renderer/lib/filter-builder.js');
  });

  it('«выборка» открывает модал с тем же деревом; «Готово» пишет значение', async () => {
    const { cell, values } = buildCell(PLACE_LEAF());
    assert.equal(cell.dataset['mode'], 'list');
    assert.ok(exactOne(cell, 'fq-mode') !== null, 'переключатель режима в ячейке');
    assert.ok(exactOne(cell, 'fv') !== null, 'в режиме «список» — прежний виджет значения');

    const mode = exactOne(cell, 'fq-mode')!;
    mode.findAll((node) => node.tagName === 'button' && node.flatText().trim() === 'Выборка')[0]!.emit('click', {});
    await tick();
    assert.equal(dialogs().length, 1, 'модал открылся общей панелью диалогов');
    const modalRoot = dialogs()[0]!.findAll((node) => node.classList.contains('fq-modal'))[0]!;
    assert.notEqual(modalRoot, undefined, 'тело модала — контейнер fq-modal');
    const tree = modalRoot.findAll((node) => node.classList.contains('ft'))[0]!;
    assert.notEqual(tree, undefined, 'внутри — тот же компонент редактора дерева');

    // Правит под-дерево тем же редактором: «+ условие» добавляет строку.
    tree
      .findAll((node) => node.tagName === 'button' && node.flatText().trim() === '+ условие')[0]!
      .emit('click', {});
    const rows = tree.findAll((node) => node.classList.contains('ft-row'));
    assert.equal(rows.length, 1, 'строка условия внутри под-выборки');
    rows[0]!
      .findAll((node) => node.classList.contains('ft-row__what'))[0]!
      .emit('click', {});
    choiceItem('property:p-city').emit('click', {});

    dialogButton('Готово').emit('click', {});
    await tick();
    assert.equal(values.length, 1, 'значение записано один раз');
    assert.equal(values[0].kind, 'subquery');
    assert.equal(values[0].operator, 'in', 'оператор значения — из оператора листа');
    assert.equal(values[0].node.children.length, 1);
    assert.equal(values[0].node.children[0].entity.property_id, CITY.id, 'условие под-выборки — из модала');
    assert.equal(dialogs().length, 0, 'после «Готово» модал закрыт');
  });

  it('«Отмена» не меняет значение; повторное открытие — редактирование', async () => {
    const collected: any[] = [];
    const api = { setValue: (value: any) => collected.push(value) };
    const render = sub.createFilterSubqueryValueRenderer(VALUE_CTX, { data: DATA, value: VALUE_CTX });

    // «Отмена»: значение листа не тронуто.
    const leaf = PLACE_LEAF();
    render(leaf, api);
    sub.openFilterSubqueryModal(null, { data: DATA, value: VALUE_CTX });
    await tick();
    dialogButton('Отмена').emit('click', {});
    await tick();
    assert.deepEqual(collected, [], '«Отмена» не пишет значение');
    assert.equal(dialogs().length, 0);

    // Повторное открытие: в модале видны УЖЕ собранные условия.
    const value = {
      kind: 'subquery',
      operator: 'in',
      node: {
        kind: 'group',
        op: 'and',
        children: [leafOf({ kind: 'property', property_id: CITY.id }, 'eq', { kind: 'scalar', value: 'Москва' })],
      },
    };
    const cell = render({ ...PLACE_LEAF(), value }, api) as unknown as ShimElement;
    assert.equal(cell.dataset['mode'], 'subquery', 'режим вычисляется из вида значения');
    const chip = exactOne(cell, 'fq-chip')!;
    assert.equal(exactOne(cell, 'fv'), null, 'в режиме «выборка» виджет списка не показывается');
    assert.equal(chip.dataset['summary'], 'Город равно Москва');
    assert.equal(exactOne(chip, 'fq-chip__open')!.flatText(), 'Город равно Москва', 'подпись чипа');
    assert.match(exactOne(chip, 'fq-chip__open')!.title, /Город равно Москва/, 'тултип несёт полный текст');
    assert.match(exactOne(chip, 'fq-chip__open')!.title, /модальном слое/, 'и подсказку о повторном открытии');

    exactOne(chip, 'fq-chip__open')!.emit('click', {});
    await tick();
    const reopened = dialogs()[0]!.findAll((node) => node.classList.contains('ft'))[0]!;
    assert.equal(reopened.findAll((node) => node.classList.contains('ft-row')).length, 1, 'условия под-выборки на месте');
    assert.match(
      reopened.findAll((node) => node.classList.contains('ft-row'))[0]!.flatText(),
      /Город/,
      'под-дерево открыто на редактирование',
    );
    dialogButton('Отмена').emit('click', {});
    await tick();
    assert.deepEqual(collected, [], 'правка модала без «Готово» ничего не пишет');

    // Крестик чипа убирает выборку из значения (ячейка вернётся к списку).
    exactOne(chip, 'fq-chip__clear')!.emit('click', {});
    assert.deepEqual(collected, [{ kind: 'none' }]);
  });

  it('вложенность: выборка внутри выборки открывается своим модалом', async () => {
    const seed = {
      kind: 'group',
      op: 'and',
      children: [leafOf({ kind: 'property', property_id: PLACE.id }, 'in')],
    };
    const promise = openModal(seed);
    await tick();
    const outerTree = dialogs()[0]!.findAll((node) => node.classList.contains('ft'))[0]!;
    const innerCell = outerTree.findAll((node) => node.classList.contains('fq-cell'))[0]!;
    assert.notEqual(innerCell, undefined, 'у строки под-выборки своя ячейка с режимом');

    innerCell
      .findAll((node) => node.tagName === 'button' && node.flatText().trim() === 'Выборка')[0]!
      .emit('click', {});
    await tick();
    assert.equal(dialogs().length, 2, 'второй уровень — свой модал (вложенность разрешена)');
    const innerTree = dialogs()[1]!.findAll((node) => node.classList.contains('ft'))[0]!;
    innerTree
      .findAll((node) => node.tagName === 'button' && node.flatText().trim() === '+ условие')[0]!
      .emit('click', {});
    dialogButton('Готово').emit('click', {});
    await tick();
    assert.equal(dialogs().length, 1, 'внутренний модал закрылся, внешний остался');

    dialogButton('Готово').emit('click', {});
    const result = await promise;
    assert.notEqual(result, null);
    const inner = result!.children[0]!;
    assert.notEqual(result, seed, 'результат — копия: модель листа осталась нетронутой');
    assert.equal(seed.children.length, 1, 'правки модала не тронули исходное под-дерево');
    assert.equal((seed.children[0] as any).value.kind, 'none', 'исходный лист без значения');
    assert.equal(inner.kind, 'leaf');
    assert.equal(inner.value.kind, 'subquery', 'во вложенном листе — своя под-выборка');
    assert.equal(inner.value.operator, 'in');
    assert.equal(inner.value.node.children.length, 1, 'условие внутренней выборки сохранено');
  });

  it('нерелевантный лист получает прежний виджет без переключателя режима', () => {
    const { cell } = buildCell(leafOf({ kind: 'property', property_id: CITY.id }, 'in'));
    assert.equal(exactOne(cell, 'fq-mode'), null, 'текстовому свойству выборка не предлагается');
    assert.ok(deepExactOne(cell, 'fv') !== null, 'виджет значения строится как раньше');
  });

  it('CSS чипа клампит подпись двумя строками — как объявлено константой модуля', () => {
    const css = fs.readFileSync(path.join(RENDERER, 'styles', 'filter-subquery.css'), 'utf8');
    const rule = /\.fq-chip__open\s*\{[^}]*-webkit-line-clamp:\s*(\d+)/s.exec(css);
    assert.notEqual(rule, null, 'правило клампинга подписи обязано быть');
    assert.equal(Number(rule![1]), sub.FILTER_SUBQUERY_CHIP_LINES);
    assert.equal(sub.FILTER_SUBQUERY_CHIP_LINES, 2, 'требование af7859c9: не более двух строк');
    for (const file of ['lib/filter-subquery.ts', 'styles/filter-subquery.css']) {
      const source = fs.readFileSync(path.join(RENDERER, file), 'utf8');
      assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b/, `нет hex в ${file}`);
    }
  });
});

describe('под-выборка: сброс при смене свойства — с подтверждением (элемент f5005daa)', () => {
  before(async () => {
    installShim();
    sub = await import('../src/renderer/lib/filter-subquery.js');
    builder = await import('../src/renderer/lib/filter-builder.js');
  });

  it('подтверждение решает судьбу сброса: отказ — строка как есть, согласие — сброс', async () => {
    let applied = 0;
    const apply = (): void => {
      applied += 1;
    };
    sub.confirmFilterSubqueryReset(apply, async () => false);
    await tick();
    assert.equal(applied, 0, 'отказ подтверждения оставляет строку как есть');
    sub.confirmFilterSubqueryReset(apply, async () => true);
    await tick();
    assert.equal(applied, 1, 'согласие выполняет сброс');
  });

  it('смена свойства у строки с собранной под-выборкой спрашивает подтверждение', async () => {
    const mod = await import('../src/renderer/lib/filter-tree.js');
    const state = builder.defaultFilterCriteriaState();
    state.tree = {
      kind: 'group',
      op: 'and',
      children: [
        {
          ...leafOf({ kind: 'property', property_id: PLACE.id }, 'in'),
          value: {
            kind: 'subquery',
            operator: 'in',
            node: { kind: 'group', op: 'and', children: [] },
          },
        },
      ],
    };
    const asked: Array<() => void> = [];
    const tree = mod.buildFilterTree({
      profile: 'thoughts',
      getState: () => state,
      data: DATA,
      confirmSubqueryReset: (apply) => asked.push(apply),
    });
    const row = tree.root as unknown as ShimElement;
    const leaf = (state.tree as any).children[0];

    // Пользователь меняет свойство строки, в которой собрана под-выборка.
    exactOne(row, 'ft-row__what')!.emit('click', {});
    choiceItem('property:p-city').emit('click', {});
    assert.equal(asked.length, 1, 'сброс собранной под-выборки подтверждают, а не делают молча');
    assert.equal(leaf.entity.property_id, PLACE.id, 'до подтверждения строка не меняется');
    assert.equal(leaf.value.kind, 'subquery', 'под-выборка на месте до подтверждения');

    // Отказ — строка как есть: подтверждение вызвано, действие не выполнено.
    assert.equal(leaf.entity.property_id, PLACE.id);

    // Согласие (хост выполняет отложенное действие) — операнд сменился, значение сброшено.
    asked[0]!();
    assert.equal(leaf.entity.property_id, CITY.id);
    assert.equal(leaf.value.kind, 'none');

    // У строки БЕЗ под-выборки подтверждения нет: смена свойства идёт сразу.
    (state.tree as any).children[0] = leafOf({ kind: 'property', property_id: CITY.id }, 'eq');
    tree.rerender();
    exactOne(tree.root as unknown as ShimElement, 'ft-row__what')!.emit('click', {});
    choiceItem('property:p-date').emit('click', {});
    assert.equal(asked.length, 1, 'без под-выборки подтверждение не спрашивают');
    assert.equal((state.tree as any).children[0].entity.property_id, DATE.id, 'смена свойства прошла сразу');
  });
});

/**
 * Регрессионный тест блока «Выбирать из списка» + «Несколько значений»
 * скалярной ветки редактора свойства (ошибка 322a2694).
 *
 * Сценарий пользователя (воспроизведение): редактор свойства → новое
 * свойство типа «строка» → включить флажок «выбирать из списка» (config.options)
 * → появлялась ещё одна копия группы «Скалярное свойство». Каждое
 * переключение флажка добавляло копию.
 *
 * Причина: обработчик `change` флажка звал `renderScalarBody()`,
 * который делал `mainBodyHost.append(...)` без `replaceChildren()` —
 * секция дописывалась, а не перерисовывалась.
 *
 * Фикс: поле вариантов живёт в DOM всё время, видимость управляется
 * флажком через `style.display` (`buildScalarOptionsBlockImpl`). При
 * переключении `renderScalarBody()` НЕ вызывается, DOM-секция одна,
 * значения черновика сохраняются.
 *
 * Тест проверяет на минимальном DOM-шиме:
 *  - начальное состояние флажка/видимости textarea соответствует `draft`;
 *  - включение/выключение флажка не множит поле options и связанные узлы;
 *  - ввод в textarea пишет в `draft.optionsText`, выключение/включение
 *    не теряет значение;
 *  - флажок «несколько значений» независим.
 */

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

// `dom.ts` зовёт `document.createElement` / `document.createTextNode`,
// `positionBodyDropdown` — `window.innerWidth/innerHeight`; сам модуль
// `property-manager.ts` загружается только при первом обращении (ESM-импорты
// поднимаются до выполнения теста), поэтому шим ставим ДО статического
// `import` под тестом.
const body = new ShimElement('body');
(globalThis as any).document = {
  createElement: (tag: string) => new ShimElement(tag),
  createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
  body,
  // `@codemirror/view` на загрузке проверяет `document.documentElement.style`
  // — даём ему пустой style, иначе импорт падает ещё до выполнения тестов.
  documentElement: { style: {} },
};
(globalThis as any).window = { innerWidth: 1200, innerHeight: 800 };

type PropertyDraft = import('../src/renderer/screens/property-manager.js').PropertyDraft;
type BuildScalarOptionsBlockImpl = typeof import('../src/renderer/screens/property-manager.js').buildScalarOptionsBlockImpl;

let buildScalarOptionsBlockImpl: BuildScalarOptionsBlockImpl;

before(async () => {
  // Динамический импорт — глобалы шима уже установлены выше.
  const mod = await import('../src/renderer/screens/property-manager.js');
  buildScalarOptionsBlockImpl = mod.buildScalarOptionsBlockImpl;
});

/** Минимальный черновик скалярной ветки. */
function makeDraft(overrides: Partial<PropertyDraft> = {}): PropertyDraft {
  return {
    name: '',
    description: '',
    valueType: 'text',
    config: null,
    scalarKind: 'text',
    choiceOn: false,
    optionsText: '',
    multipleOn: false,
    nameForward: '',
    nameReverse: '',
    parentLinkTypeId: null,
    linkColor: null,
    linkStyle: null,
    linkWidth: null,
    showOnMap: false,
    blocksTargetDeletion: false,
    defaultValue: null,
    defaultValueTarget: null,
    typeRows: [],
    ...overrides,
  };
}

/** Первый потомок с подстрокой в className. */
function findChild(root: ShimElement, cls: string): ShimElement | undefined {
  return root.children.find((c) => c.className.includes(cls));
}

/** Все потомки (рекурсивно) с подстрокой в className. */
function findAll(root: ShimElement, cls: string): ShimElement[] {
  const out: ShimElement[] = [];
  const walk = (n: ShimElement): void => {
    if (n.className.includes(cls)) out.push(n);
    for (const child of n.children) walk(child);
  };
  walk(root);
  return out;
}

/** Чекбокс «выбирать из списка» в блоке. */
function findChoiceCheck(block: ShimElement): ShimElement {
  const label = findChild(block, 'ui-choice-row');
  if (label === undefined) throw new Error('нет строки флажка');
  const input = label.children.find((c) => c.tagName === 'input');
  if (input === undefined) throw new Error('нет input в строке флажка');
  return input;
}

/** Чекбокс «несколько значений» — вторая строка флажка. */
function findMultiCheck(block: ShimElement): ShimElement {
  const rows = block.children.filter((c) => c.className.includes('ui-choice-row'));
  if (rows.length < 2) throw new Error(`нет второй строки флажка: ${rows.length}`);
  const input = rows[1]!.children.find((c) => c.tagName === 'input');
  if (input === undefined) throw new Error('нет input во второй строке флажка');
  return input;
}

/** Поле вариантов — единственная textarea с классом `prop-options-area`. */
function findArea(block: ShimElement): ShimElement {
  const areas = findAll(block, 'prop-options-area');
  if (areas.length !== 1) throw new Error(`ожидалась 1 textarea, найдено ${areas.length}`);
  return areas[0]!;
}

/** Эмулирует пользовательский клик по флажку (включить/выключить). */
function toggle(check: ShimElement): void {
  check.checked = !check.checked;
  check.emit('change', { target: check });
}

describe('buildScalarOptionsBlockImpl — сценарий ошибки 322a2694', () => {
  it('начальное состояние: флажок выключен, textarea скрыта', () => {
    const draft = makeDraft({ choiceOn: false });
    const block = buildScalarOptionsBlockImpl(draft) as unknown as ShimElement;
    const check = findChoiceCheck(block);
    const area = findArea(block);
    assert.equal(check.checked, false);
    assert.equal(area.style.display, 'none');
  });

  it('начальное состояние: флажок включён, textarea видима и содержит черновик', () => {
    const draft = makeDraft({ choiceOn: true, optionsText: 'low\nmid\nhigh' });
    const block = buildScalarOptionsBlockImpl(draft) as unknown as ShimElement;
    const check = findChoiceCheck(block);
    const area = findArea(block);
    assert.equal(check.checked, true);
    assert.equal(area.style.display, '');
    assert.equal(area.value, 'low\nmid\nhigh');
  });

  it('включение флажка показывает textarea, не создавая копий блока', () => {
    const draft = makeDraft({ choiceOn: false });
    const block = buildScalarOptionsBlockImpl(draft) as unknown as ShimElement;
    const check = findChoiceCheck(block);
    toggle(check);
    assert.equal(draft.choiceOn, true);
    const area = findArea(block);
    assert.equal(area.style.display, '');
    // Секция — ровно один блок с ровно одной textarea и двумя чекбоксами.
    assert.equal(findAll(block, 'prop-options-area').length, 1);
    assert.equal(block.children.filter((c: ShimElement) => c.className.includes('ui-choice-row')).length, 2);
  });

  it('выключение флажка скрывает textarea и сохраняет черновик optionsText', () => {
    const draft = makeDraft({ choiceOn: true, optionsText: 'a\nb' });
    const block = buildScalarOptionsBlockImpl(draft) as unknown as ShimElement;
    const area = findArea(block);
    const check = findChoiceCheck(block);
    toggle(check);
    assert.equal(draft.choiceOn, false);
    assert.equal(area.style.display, 'none');
    // Поле скрыто — в DOM всё равно один экземпляр.
    assert.equal(findAll(block, 'prop-options-area').length, 1);
    // Черновик не теряется: при повторном включении вернётся прежнее значение.
    toggle(check);
    assert.equal(draft.choiceOn, true);
    assert.equal(findArea(block).value, 'a\nb');
  });

  it('многократные переключения не множат блок/textarea/чекбоксы', () => {
    const draft = makeDraft({ choiceOn: false });
    const block = buildScalarOptionsBlockImpl(draft) as unknown as ShimElement;
    const check = findChoiceCheck(block);
    for (let i = 0; i < 8; i++) toggle(check);
    // Контейнер — единственный, чекбоксов — два (choice + multi), textarea — одна.
    assert.equal(findAll(block, 'prop-options-area').length, 1);
    assert.equal(block.children.filter((c) => c.className.includes('ui-choice-row')).length, 2);
    // В контейнере нет «лишних» строк: всего две строки-флажка + одна textarea.
    assert.equal(block.children.length, 3);
  });

  it('ввод в textarea зеркалится в draft.optionsText', () => {
    const draft = makeDraft({ choiceOn: true });
    const block = buildScalarOptionsBlockImpl(draft) as unknown as ShimElement;
    const area = findArea(block);
    area.value = 'red\ngreen\nblue';
    area.emit('input', { target: area });
    assert.equal(draft.optionsText, 'red\ngreen\nblue');
  });

  it('флажок «несколько значений» независим: choiceOn не трогает multipleOn и наоборот', () => {
    const draft = makeDraft({ choiceOn: false, multipleOn: false });
    const block = buildScalarOptionsBlockImpl(draft) as unknown as ShimElement;
    const multi = findMultiCheck(block);
    multi.checked = true;
    multi.emit('change', { target: multi });
    assert.equal(draft.multipleOn, true);
    assert.equal(draft.choiceOn, false);
    const choice = findChoiceCheck(block);
    assert.equal(choice.checked, false);
  });
});

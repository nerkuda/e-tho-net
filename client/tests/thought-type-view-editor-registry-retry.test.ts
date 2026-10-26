/**
 * Диалог редактора отбора: отказ чтения реестра свойств не считается
 * отработанным (ошибка db42100b; класс закрыт в 77f18626/6400d261), а повтор
 * чтения не оставляет ложных следов (ошибка 071acfc2).
 *
 * Половины симптома карточки db42100b:
 *   1. отказ `etn.propertyRegistry.list` глотался и диалог открывался с пустым
 *      реестром МОЛЧА — кейс 1 проверяет видимую диагностику и запрет записи
 *      (мутация «убрать блок `lossRisk` из `onSave`» краснит тест);
 *   2. плоское определение с условием по свойству разбиралось без реестра, и
 *      сохранение фиксировало отбор БЕЗ условия — кейс 2 проверяет повтор
 *      чтения на тике store, переразбор и сохранение с условием (мутация
 *      «не переразбирать определение после повтора» краснит тест).
 *
 * Симптомы карточки 071acfc2 — следствия успешного повтора:
 *   3. база «грязной» проверки не пересчитывалась вместе с состоянием — диалог
 *      без правок выглядел изменённым (кейс 3; мутация «убрать
 *      `criteriaBase = buildViewAst(state)` из повтора» краснит: маркер ●
 *      остаётся видимым);
 *   4. сохранение при правке, сделанной до реестра, блокировалось причиной
 *      «Реестр свойств сети не прочитан», хотя реестр прочитан (кейс 4;
 *      мутация «показывать registryPendingSave при любой причине» краснит:
 *      текст причины не соответствует факту).
 *
 * Диалог открывается по-настоящему (`openViewEditorDialog` → `showDialog`) под
 * минимальным DOM-шимом — тем же приёмом, что `thought-type-view-editor-dialog`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';

import type { NetworkProperty, ThoughtType } from '@etn/shared';
import { BASE_LAYER_ID } from '@etn/shared';

import { store } from '../src/renderer/state.js';
import { ShimElement } from './dom-shim.js';

const NETWORK_ID = '00000000-0000-4000-8000-000000000001';
const TYPE_ID = '00000000-0000-4000-8000-000000000010';
const PROPERTY_ID = '00000000-0000-4000-8000-0000000000bb';

/** Строка реестра: текстовое свойство «Версия». */
const PROPERTY_ROW: NetworkProperty = {
  id: PROPERTY_ID,
  name: 'Версия',
  value_type: 'text',
  config: null,
  description: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

function typeFixture(): ThoughtType {
  return {
    id: TYPE_ID,
    name: 'МЛИ-инструмент',
    parent_id: null,
    is_root: false,
    icon: null,
    icon_kind: 'emoji',
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    description: null,
    comment_template_md: null,
    version: 1,
    created_at: '2026-10-23T00:00:00.000Z',
    updated_at: '2026-10-23T00:00:00.000Z',
    created_by: '00000000-0000-4000-8000-000000000000',
  };
}

/** Сколько раз диалог прочитал реестр свойств (включая отказные). */
let registryCalls = 0;
/** Поведение чтения реестра по номеру вызова (1-based): можно разрешить отказ. */
let registryImpl: (call: number) => Promise<NetworkProperty[]> = async () => [PROPERTY_ROW];

/** Вызовы записи отбора типа — журнал сохранений. */
const updates: any[] = [];

function installFakeApi(): void {
  updates.length = 0;
  registryCalls = 0;
  const viewCard = (id: string, name: string): Record<string, unknown> => ({
    id,
    name,
    name_key: name.toLowerCase(),
    description: null,
    definition: JSON.stringify({ version: 1 }),
    position: 0,
    is_default: false,
    version: 2,
    created_at: '2026-10-23T00:00:00.000Z',
    updated_at: '2026-10-23T00:00:00.000Z',
    created_by: '00000000-0000-4000-8000-000000000000',
    scope: 'type',
    defined_on: TYPE_ID,
    inherited: false,
    own_default: false,
  });
  (globalThis as any).etn = {
    propertyRegistry: {
      list: async (): Promise<NetworkProperty[]> => {
        registryCalls += 1;
        return registryImpl(registryCalls);
      },
    },
    thoughtTypeViews: {
      create: async () => viewCard('t-new', 'X'),
      update: async (...args: any[]) => {
        updates.push(args);
        return viewCard(args[2] as string, 'X');
      },
    },
    thoughtCustomViews: {
      create: async () => viewCard('c-new', 'X'),
      update: async () => viewCard('c-1', 'X'),
    },
  };
}

function installShim(): void {
  (globalThis as any).HTMLElement = class {};
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
    activeElement: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  win.setTimeout = () => 0;
  win.clearTimeout = () => undefined;
  win.requestAnimationFrame = (cb: (t: number) => void) => {
    cb(0);
    return 0;
  };
  win.etn = (globalThis as any).etn;
  (globalThis as any).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  (globalThis as any).getComputedStyle = () => ({ paddingLeft: '0px', paddingRight: '0px' });
}

/** Узлы диалога и его тела. */
function bodyEl(): ShimElement {
  return (globalThis as any).document.body as ShimElement;
}

/** Текст поддерева: шим агрегирует `textContent` как браузер (ошибка cca54310). */
function textOf(node: ShimElement): string {
  return node.textContent;
}

function lastDialog(): ShimElement | undefined {
  const dialogs = bodyEl().children.filter((child) => child.classList.contains('dialog-backdrop'));
  return dialogs[dialogs.length - 1];
}

function dialogText(): string {
  const dialog = lastDialog();
  return dialog === undefined ? '' : textOf(dialog);
}

function dialogButton(label: string): ShimElement | undefined {
  const dialog = lastDialog();
  return dialog?.querySelectorAll('button').find((btn) => textOf(btn).trim() === label);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function closeDialogIfAny(): void {
  const cancel = dialogButton('Отмена');
  if (cancel !== undefined) cancel.click();
}

let openViewEditorDialog: typeof import('../src/renderer/screens/thought-type/filter-dialog.js')['openViewEditorDialog'];

before(async () => {
  installFakeApi();
  installShim();
  ({ openViewEditorDialog } = await import(
    '../src/renderer/screens/thought-type/filter-dialog.js'
  ));
});

afterEach(() => {
  closeDialogIfAny();
  const body = bodyEl();
  while (body.children.length > 0) body.children.pop();
});

function setBaseLayer(): void {
  store.update({
    networkId: NETWORK_ID,
    currentLayer: { id: BASE_LAYER_ID, title: 'Основа' },
    thoughtTypes: [typeFixture()],
    linkTypes: [],
  });
}

/**
 * Открыть диалог правки отбора типа. Определение — ПРЕЖНЯЯ плоская форма с
 * условием по свойству: без реестра конвертер его выбрасывает.
 */
async function open(): Promise<void> {
  setBaseLayer();
  installFakeApi();
  (globalThis as any).window.etn = (globalThis as any).etn;
  openViewEditorDialog({
    networkId: NETWORK_ID,
    thoughtTypeId: TYPE_ID,
    typeName: 'МЛИ-инструмент',
    view: {
      id: 't-1',
      name: 'Работы типа',
      description: null,
      definition: JSON.stringify({
        properties: [{ property_id: PROPERTY_ID, op: 'eq', value: '2.0' }],
        order: 'asc',
      }),
      is_default: false,
      version: 1,
    },
  });
  await settle();
  assert.ok(lastDialog() !== undefined, 'диалог обязан открыться');
}

/** Сохранённое определение последнего вызова update — объект AST. */
function savedDefinition(): any {
  assert.equal(updates.length, 1, 'ожидается ровно одна запись отбора');
  const patch = updates[0]![3] as { definition: string };
  return JSON.parse(patch.definition) as any;
}

/** Условия по свойствам в произвольном теле (обход всех полей). */
function propertyNodes(value: unknown, out: any[] = []): any[] {
  if (value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) propertyNodes(item, out);
    return out;
  }
  const rec = value as Record<string, unknown>;
  const entity = rec['entity'];
  if (
    entity !== null &&
    typeof entity === 'object' &&
    (entity as Record<string, unknown>)['kind'] === 'property'
  ) {
    out.push(rec);
  }
  for (const [key, child] of Object.entries(rec)) {
    if (key === 'entity') continue;
    propertyNodes(child, out);
  }
  return out;
}

describe('редактор отбора: отказ реестра свойств (db42100b)', () => {
  it('1. сохранение при непрочитанном реестре запрещено с явной причиной', async () => {
    registryImpl = async () => {
      throw new Error('сеть недоступна');
    };
    await open();
    assert.equal(registryCalls, 1, 'открытие диалога прочитало реестр (и получило отказ)');

    dialogButton('Применить')!.click();
    await settle();
    assert.equal(updates.length, 0, 'молчаливой перезаписи потерянного определения нет');
    assert.ok(
      dialogText().includes('Реестр свойств сети не прочитан'),
      `ожидалась явная причина отказа в футере: ${dialogText()}`,
    );
  });

  it('2. тик store перечитывает реестр, переразбирает определение и сохраняет условие', async () => {
    registryImpl = async (call) => {
      if (call === 1) throw new Error('сеть недоступна');
      return [PROPERTY_ROW];
    };
    await open();
    assert.equal(registryCalls, 1, 'первое чтение получило отказ');

    // Штатный тик store (в т.ч. переход в `connected`) — повтор чтения.
    store.update({});
    await settle();
    assert.equal(registryCalls, 2, 'отказ не признан отработанным — чтение повторено');

    dialogButton('Применить')!.click();
    await settle();
    const definition = savedDefinition();
    const properties = propertyNodes(definition);
    assert.equal(properties.length, 1, 'условие по свойству сохранено, а не потеряно');
    assert.equal(properties[0]?.entity.property_id, PROPERTY_ID);
  });

  it('3. успешный повтор не делает диалог «грязным» без правок пользователя', async () => {
    registryImpl = async (call) => {
      if (call === 1) throw new Error('сеть недоступна');
      return [PROPERTY_ROW];
    };
    await open();
    store.update({});
    await settle();
    assert.equal(registryCalls, 2, 'реестр перечитан');
    // База «грязной» проверки пересчитана вместе с состоянием: маркер ● строки
    // имени (ff-changed) не виден, значит и подтверждение закрытия не спросится
    // (обе проверки читают один и тот же снимок/состояние).
    const marker = lastDialog()!.querySelector('.ff-changed');
    assert.ok(marker !== undefined && marker !== null, 'маркер изменения отбора отрисован');
    assert.equal(
      marker.hidden,
      true,
      'после успешного переразбора диалог не должен считаться «грязным»',
    );
  });

  it('4. правка, сделанная до чтения реестра, блокируется причиной по факту', async () => {
    registryImpl = async (call) => {
      if (call === 1) throw new Error('сеть недоступна');
      return [PROPERTY_ROW];
    };
    await open();
    // Пользователь правит отбор, пока реестра нет: добавляет условие «+ условие»
    // (без реестра условие по свойству разобрать было нельзя — оно в форме
    // отсутствует).
    dialogButton('+ условие')!.click();
    await settle();
    // Повтор чтения успешен, но правку переразбор не перетирает: условие по
    // свойству из сохранённого определения остаётся не восстановленным.
    store.update({});
    await settle();
    assert.equal(registryCalls, 2, 'реестр перечитан');

    dialogButton('Применить')!.click();
    await settle();
    assert.equal(updates.length, 0, 'перезапись без восстановленного условия запрещена');
    const text = dialogText();
    assert.ok(
      text.includes('не восстановлены после чтения реестра'),
      `ожидалась причина по факту (условия не восстановлены): ${text}`,
    );
    assert.ok(
      !text.includes('Реестр свойств сети не прочитан'),
      `ложная причина «реестр не прочитан» после успешного чтения запрещена: ${text}`,
    );
  });
});

/**
 * Диалог редактора отбора (задача c2bbffab, спека e0257ca5, 0.14.1).
 *
 * Закрывает замечания независимой проверки раунда 1 (хроноза 5d6fe917):
 *   * четыре заголовка диалога называют вид владельца — «Создать/Изменить
 *     отбор типа «X»» и «Создать/Изменить отбор мысли «Y»» (спека e0257ca5,
 *     решение пользователя 2026-10-23);
 *   * guard `onSave` «только Основа»: в рабочем слое сохранение не уходит в
 *     API (notice «Основы»), в Основе тот же клик доходит до валидации имени
 *     (ошибка в футере) — гейт стоит первым и не глушит штатный путь.
 *
 * Диалог открывается по-настоящему (`openViewEditorDialog` → `showDialog`) под
 * минимальным DOM-шимом — тем же приёмом, что `focus-filter-strip.test.ts`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';

import type { ThoughtType } from '@etn/shared';
import { BASE_LAYER_ID } from '@etn/shared';

import { store } from '../src/renderer/state.js';
import { ShimElement } from './dom-shim.js';
import { mountStatusMessage } from '../src/renderer/lib/status-message.js';

const NETWORK_ID = '00000000-0000-4000-8000-000000000001';
const TYPE_ID = '00000000-0000-4000-8000-000000000010';
const THOUGHT_ID = '00000000-0000-4000-8000-000000000100';
const WORKING_LAYER_ID = '11111111-2222-3333-4444-555555555555';

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

interface SaveCalls {
  typeCreate: any[];
  typeUpdate: any[];
  customCreate: any[];
  customUpdate: any[];
}

let calls: SaveCalls;

function installFakeApi(): void {
  calls = { typeCreate: [], typeUpdate: [], customCreate: [], customUpdate: [] };
  const viewCard = (id: string, name: string): Record<string, unknown> => ({
    id,
    name,
    name_key: name.toLowerCase(),
    description: null,
    definition: JSON.stringify({ version: 1 }),
    position: 0,
    is_default: false,
    version: 1,
    created_at: '2026-10-23T00:00:00.000Z',
    updated_at: '2026-10-23T00:00:00.000Z',
    created_by: '00000000-0000-4000-8000-000000000000',
    scope: 'type',
    defined_on: TYPE_ID,
    inherited: false,
    own_default: false,
  });
  (globalThis as any).etn = {
    propertyRegistry: { list: async () => [] },
    thoughtTypeViews: {
      create: async (...args: any[]) => {
        calls.typeCreate.push(args);
        return viewCard('t-new', 'X');
      },
      update: async (...args: any[]) => {
        calls.typeUpdate.push(args);
        return viewCard(args[2] as string, 'X');
      },
    },
    thoughtCustomViews: {
      create: async (...args: any[]) => {
        calls.customCreate.push(args);
        return { ...viewCard('c-new', 'X'), scope: 'thought', defined_on: args[1] };
      },
      update: async (...args: any[]) => {
        calls.customUpdate.push(args);
        return { ...viewCard(args[2] as string, 'X'), scope: 'thought', defined_on: args[1] };
      },
    },
  };
}

function installShim(): void {
  (globalThis as any).HTMLElement = class {};
  const body = new ShimElement('body');
  // С 0.14.1 (задача 28d22b8a) рутинные подсказки — не тосты, а зона
  // сообщений статус-бара: тест монтирует её, чтобы видеть текст.
  const statusHost = new ShimElement('span', 'sb-item sb-message');
  body.append(statusHost);
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body,
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
  mountStatusMessage(statusHost);
}

/** Узлы диалога и его тела. */
function bodyEl(): ShimElement {
  return (globalThis as any).document.body as ShimElement;
}

function textOf(node: ShimElement): string {
  let out = node.textContent;
  for (const child of node.children) out += textOf(child);
  return out;
}

function lastDialog(): ShimElement | undefined {
  const dialogs = bodyEl().children.filter((child) => child.classList.contains('dialog-backdrop'));
  return dialogs[dialogs.length - 1];
}

function dialogTitle(): string {
  const dialog = lastDialog();
  return dialog?.querySelector('.dialog-title')?.textContent ?? '';
}

function dialogText(): string {
  const dialog = lastDialog();
  return dialog === undefined ? '' : textOf(dialog);
}

function dialogButton(label: string): ShimElement | undefined {
  const dialog = lastDialog();
  return dialog?.querySelectorAll('button').find((btn) => textOf(btn).trim() === label);
}

/** Тексты сообщений зоны статус-бара (рутинные подсказки; 0.14.1). */
function noticesOnBody(): string[] {
  const message = bodyEl().querySelector('.sb-message');
  const text = message?.textContent ?? '';
  return text === '' ? [] : [text];
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Закрывает открытый диалог крестиком/отменой — между проверками. */
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
  // Зона сообщений — часть статус-бара: переживает очистку body между
  // тестами, иначе ссылка модуля указывала бы на снятый узел (0.14.1).
  const keep = body.children.filter((child) => child.classList.contains('sb-message'));
  body.replaceChildren(...keep);
});

function setLayer(id: string): void {
  store.update({
    networkId: NETWORK_ID,
    currentLayer: { id, title: id === BASE_LAYER_ID ? 'Основа' : 'Черновик' },
    thoughtTypes: [typeFixture()],
    linkTypes: [],
  });
}

/** Открывает диалог и дожидается его появления. */
async function open(opts: Parameters<typeof openViewEditorDialog>[0]): Promise<void> {
  setLayer((opts as { layerId?: string }).layerId ?? BASE_LAYER_ID);
  installFakeApi();
  (globalThis as any).window.etn = (globalThis as any).etn;
  openViewEditorDialog(opts);
  await settle();
  assert.ok(lastDialog() !== undefined, 'диалог обязан открыться');
}

describe('редактор отбора: заголовки по владельцу (e0257ca5, c2bbffab)', () => {
  it('создание отбора типа', async () => {
    await open({ networkId: NETWORK_ID, thoughtTypeId: TYPE_ID, typeName: 'МЛИ-инструмент', view: null });
    assert.equal(dialogTitle(), 'Создать отбор типа «МЛИ-инструмент»');
  });

  it('изменение отбора типа', async () => {
    await open({
      networkId: NETWORK_ID,
      thoughtTypeId: TYPE_ID,
      typeName: 'МЛИ-инструмент',
      view: {
        id: 't-1',
        name: 'Работы типа',
        description: null,
        definition: JSON.stringify({ version: 1 }),
        is_default: false,
        version: 1,
      },
    });
    assert.equal(dialogTitle(), 'Отбор типа «МЛИ-инструмент»');
  });

  it('создание отбора мысли', async () => {
    await open({
      networkId: NETWORK_ID,
      ownerThoughtId: THOUGHT_ID,
      thoughtName: 'МЛИ-инструменты',
      view: null,
    });
    assert.equal(dialogTitle(), 'Создать отбор мысли «МЛИ-инструменты»');
  });

  it('изменение отбора мысли', async () => {
    await open({
      networkId: NETWORK_ID,
      ownerThoughtId: THOUGHT_ID,
      thoughtName: 'МЛИ-инструменты',
      view: {
        id: 'c-1',
        name: 'В гараже',
        description: null,
        definition: JSON.stringify({ version: 1 }),
        is_default: true,
        version: 3,
      },
    });
    assert.equal(dialogTitle(), 'Отбор мысли «МЛИ-инструменты»');
  });
});

describe('редактор отбора: guard «только Основа» в onSave (e0257ca5, c2bbffab)', () => {
  it('рабочий слой: «Применить» не уходит в API, показывается notice Основы', async () => {
    await open({
      networkId: NETWORK_ID,
      thoughtTypeId: TYPE_ID,
      typeName: 'МЛИ-инструмент',
      view: null,
      layerId: WORKING_LAYER_ID,
    } as any);
    dialogButton('Применить')!.click();
    await settle();
    assert.deepEqual(
      [calls.typeCreate.length, calls.typeUpdate.length, calls.customCreate.length, calls.customUpdate.length],
      [0, 0, 0, 0],
      'в рабочем слое запись запрещена до валидации',
    );
    assert.ok(
      noticesOnBody().some((text) => text.includes('Правка отборов доступна только в Основе')),
      `ожидался notice про Основу: ${JSON.stringify(noticesOnBody())}`,
    );
  });

  it('Основа: тот же клик проходит гейт и упирается в валидацию имени (футер)', async () => {
    await open({ networkId: NETWORK_ID, thoughtTypeId: TYPE_ID, typeName: 'МЛИ-инструмент', view: null });
    dialogButton('Применить')!.click();
    await settle();
    assert.deepEqual(
      [calls.typeCreate.length, calls.typeUpdate.length, calls.customCreate.length, calls.customUpdate.length],
      [0, 0, 0, 0],
      'пустая форма не пишется',
    );
    assert.ok(
      dialogText().includes('Укажите имя отбора'),
      `ожидалась ошибка имени в футере: ${dialogText()}`,
    );
  });
});

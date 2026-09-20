/**
 * Юнит-тесты отбора кандидатов свойства-связи по допустимым типам значения
 * (ошибка a6513df0 — переделка фикса cfbf3855, 0.8.2).
 *
 * Источник ограничения — привязки ПРОТИВОПОЛОЖНОЙ стороны свойства в реестре
 * `type_properties`, а не ключи `config` (их модель 0.8.1 не предусматривает:
 * у реального свойства они всегда пусты). Сервер считает набор по реестру и
 * отдаёт его в `EffectiveTypeProperty.allowed_opposite_type_ids`; редактор
 * значения расширяет список до поддеревьев типов (L21) и применяет его и к
 * живому поиску поля, и к диалогу «выбрать». Пусто — фильтра нет (любые мысли).
 *
 * Харнесс повторяет editor-link-value-chip.test.ts: DOM-shim без dispatch
 * асинхронной отрисовки выпадашки. Мы НЕ фокусируем поле — тогда `render`
 * выпадашки не вызывается (условие `focused` в wireSuggest), а `source.load`
 * доходит до `etn.thoughts.findDuplicates`, чьи аргументы и перехватываются.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Element-stub с поддержкой listeners / dataset / setAttribute. */
class ShimElement {
  tagName: string;
  className = '';
  children: ShimElement[] = [];
  textContent = '';
  value = '';
  type = '';
  checked = false;
  title = '';
  placeholder = '';
  autocomplete = '';
  isConnected = true;
  tabIndex = -1;
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  listeners: Record<string, Array<(event?: any) => void>> = {};
  style: Record<string, string> = {};
  parent: ShimElement | null = null;
  classList = {
    add: () => undefined,
    remove: () => undefined,
    toggle: () => undefined,
    contains: () => false,
  };
  constructor(tag: string, className?: string, text?: string) {
    this.tagName = tag;
    if (className !== undefined) this.className = className;
    if (text !== undefined) this.textContent = text;
  }
  append(...nodes: ShimElement[]): void {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: ShimElement[]): void {
    this.children = nodes;
  }
  removeChild(node: ShimElement): void {
    this.children = this.children.filter((c) => c !== node);
  }
  remove(): void {
    this.parent = null;
  }
  addEventListener(type: string, handler: (event?: any) => void): void {
    (this.listeners[type] ??= []).push(handler);
  }
  removeEventListener(): void {}
  dispatch(type: string, event?: any): void {
    for (const handler of this.listeners[type] ?? []) handler(event);
  }
  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }
  contains(): boolean {
    return false;
  }
  focus(): void {}
  click(): void {
    this.dispatch('click');
  }
  querySelector(): ShimElement | null {
    return null;
  }
  querySelectorAll(): ShimElement[] {
    return [];
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 };
  }
}

let sharedWindow: Record<string, unknown> = {};
/** Аргументы каждого вызова `etn.thoughts.findDuplicates` (живой поиск). */
let searchCalls: Array<{ query: string; typeIds: string[] }> = [];

/**
 * Шим: document/window + `etn.thoughts.findDuplicates`/`resolve`. Один
 * глобальный объект на файл (`lib/etn.ts` привязывается к `window.etn` при
 * первом импорте).
 */
function installShim(): void {
  searchCalls = [];
  if ((globalThis as any).document === undefined) {
    (globalThis as any).document = {
      createElement: (tag: string) => new ShimElement(tag),
      createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
      documentElement: { style: {} },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => undefined,
      querySelector: () => null,
      activeElement: null,
      body: new ShimElement('body'),
    };
  }
  sharedWindow = (globalThis as any).window ?? {};
  (globalThis as any).window = sharedWindow;
  if (sharedWindow['etn'] === undefined) sharedWindow['etn'] = {};
  const etnApi = sharedWindow['etn'] as Record<string, unknown>;
  etnApi['thoughts'] = {
    findDuplicates: async (_n: string, query: string, _s: string[], typeIds: string[] = []) => {
      searchCalls.push({ query, typeIds: [...typeIds] });
      return [];
    },
    resolve: async (_n: string, ids: string[]) =>
      ids.map((id) => ({
        id,
        title: `Title of ${id}`,
        type_id: null,
        icon: null,
        icon_kind: 'emoji',
        icon_attachment_id: null,
        active: true,
        marked_for_deletion: false,
        fg_color: null,
        bg_color: null,
        font_bold: null,
        font_italic: null,
        font_underline: null,
        font_strike: null,
      })),
  };
  if (etnApi['system'] === undefined) etnApi['system'] = {};
  (etnApi['system'] as Record<string, unknown>)['openExternal'] = async () => '';
  sharedWindow['innerWidth'] = 1024;
  sharedWindow['innerHeight'] = 768;
  sharedWindow['setTimeout'] = setTimeout;
  sharedWindow['clearTimeout'] = clearTimeout;
  sharedWindow['addEventListener'] = () => undefined;
  sharedWindow['removeEventListener'] = () => undefined;
  sharedWindow['dispatchEvent'] = () => undefined;
}

/** Поле ввода живого поиска чип-редактора значения свойства-связи. */
function addInputOf(editor: ShimElement): ShimElement {
  const row = editor.children[0]!;
  const field = row.children[0]!.children[0]!;
  const input = field.children.find((c) => c.tagName === 'input');
  assert.ok(input !== undefined, 'в чип-поле есть поле живого поиска');
  return input!;
}

/** Набирает текст в поле и ждёт, пока источник живого поиска загрузится. */
async function typeAndSettle(input: ShimElement, text: string): Promise<void> {
  input.value = text;
  input.dispatch('input');
  await new Promise((r) => setTimeout(r, 0));
}

/**
 * Определение свойства-связи для редактора значения. `allowedOppositeTypeIds` —
 * то, что сервер посчитал по реестру привязок противоположной стороны;
 * `side` нужен только определениям-фикстурам (редактор по нему больше не
 * фильтрует).
 */
const linkDefinition = (
  allowedOppositeTypeIds: string[] | undefined,
  side?: 'source' | 'target',
) => ({
  property_id: 'lk-prop',
  key: 'Связь',
  value_type: 'link' as const,
  config: { link_type_id: 'lt-1' },
  required: false,
  side: side ?? null,
  allowed_opposite_type_ids: allowedOppositeTypeIds,
  inherited: false,
  defined_on: 'thought_type',
  defined_on_name: 'Тест',
});

describe('linkAllowedTypeIds — нормализация допустимых типов значения (a6513df0)', () => {
  it('отдаёт список как есть и отбрасывает пустые id', async () => {
    installShim();
    const { linkAllowedTypeIds } = await import('../src/renderer/editor/value-editor.js');
    assert.deepEqual(linkAllowedTypeIds(['tt-ver', '']), ['tt-ver']);
    assert.deepEqual(linkAllowedTypeIds(['tt-a', 'tt-b']), ['tt-a', 'tt-b']);
  });

  it('нет ограничения (пусто/undefined) — фильтра нет', async () => {
    installShim();
    const { linkAllowedTypeIds } = await import('../src/renderer/editor/value-editor.js');
    assert.deepEqual(linkAllowedTypeIds([]), []);
    assert.deepEqual(linkAllowedTypeIds(undefined), []);
    assert.deepEqual(linkAllowedTypeIds(null), []);
  });

  it('config-ключи allowed_*_type_ids в UI-логике не участвуют', () => {
    const src = readFileSync(
      resolve(import.meta.dirname, '..', 'src', 'renderer', 'editor', 'value-editor.ts'),
      'utf8',
    );
    assert.equal(
      /allowed_(target|source)_type_ids/.test(src),
      false,
      'редактор значения больше не читает config-ключи ограничения типов',
    );
  });
});

describe('buildLinkValueEditor — живой поиск фильтруется по допустимым типам (a6513df0)', () => {
  it('прямое имя (мысль-источник): допустимые цели из привязок назначения', async () => {
    installShim();
    const { buildLinkValueEditor } = await import('../src/renderer/editor/value-editor.js');
    const editor = buildLinkValueEditor({
      networkId: 'n1',
      definition: linkDefinition(['tt-ver'], 'source') as any,
      values: [],
      save: async () => true,
    }) as unknown as ShimElement;

    await typeAndSettle(addInputOf(editor), 'версия');
    assert.equal(searchCalls.length, 1, 'живой поиск обратился к серверу');
    assert.deepEqual(
      searchCalls[0]!.typeIds,
      ['tt-ver'],
      'поиск ограничен типами назначений свойства',
    );
  });

  it('обратное имя (мысль-назначение): допустимые источники из привязок источника', async () => {
    installShim();
    const { buildLinkValueEditor } = await import('../src/renderer/editor/value-editor.js');
    const editor = buildLinkValueEditor({
      networkId: 'n1',
      definition: linkDefinition(['tt-work', 'tt-task'], 'target') as any,
      values: [],
      save: async () => true,
    }) as unknown as ShimElement;

    await typeAndSettle(addInputOf(editor), 'работа');
    assert.deepEqual(
      searchCalls[0]!.typeIds,
      ['tt-work', 'tt-task'],
      'у привязки со стороны назначения ограничены источники',
    );
  });

  it('противоположная таблица пуста — поиск не сужается (любые мысли)', async () => {
    installShim();
    const { buildLinkValueEditor } = await import('../src/renderer/editor/value-editor.js');
    const editor = buildLinkValueEditor({
      networkId: 'n1',
      definition: linkDefinition([], 'source') as any,
      values: [],
      save: async () => true,
    }) as unknown as ShimElement;

    await typeAndSettle(addInputOf(editor), 'любая');
    assert.deepEqual(searchCalls[0]!.typeIds, [], 'пустой фильтр — сервер вернёт любые мысли');
  });

  it('фильтр берётся из привязок КОНКРЕТНОГО свойства, а не глобально', async () => {
    installShim();
    const { buildLinkValueEditor } = await import('../src/renderer/editor/value-editor.js');
    const restricted = buildLinkValueEditor({
      networkId: 'n1',
      definition: linkDefinition(['tt-a'], 'source') as any,
      values: [],
      save: async () => true,
    }) as unknown as ShimElement;
    const free = buildLinkValueEditor({
      networkId: 'n1',
      definition: linkDefinition([], 'source') as any,
      values: [],
      save: async () => true,
    }) as unknown as ShimElement;

    await typeAndSettle(addInputOf(restricted), 'a');
    await typeAndSettle(addInputOf(free), 'b');
    assert.deepEqual(searchCalls[0]!.typeIds, ['tt-a'], 'свойство с привязками фильтрует');
    assert.deepEqual(searchCalls[1]!.typeIds, [], 'свойство без ограничения не фильтрует');
  });

  it('допустимый родительский тип раскрывается до поддерева (L21)', async () => {
    installShim();
    const { store } = await import('../src/renderer/state.js');
    const { buildLinkValueEditor } = await import('../src/renderer/editor/value-editor.js');
    store.update({
      thoughtTypes: [
        { id: 'root', name: 'основной тип', parent_id: null, is_root: true },
        { id: 'tt-par', name: 'Раздел', parent_id: 'root', is_root: false },
        { id: 'tt-child', name: 'Подраздел', parent_id: 'tt-par', is_root: false },
      ] as any,
    });
    const editor = buildLinkValueEditor({
      networkId: 'n1',
      definition: linkDefinition(['tt-par'], 'source') as any,
      values: [],
      save: async () => true,
    }) as unknown as ShimElement;

    await typeAndSettle(addInputOf(editor), 'подраздел');
    const ids = new Set(searchCalls[0]!.typeIds);
    assert.ok(ids.has('tt-par') && ids.has('tt-child'), 'родитель вместе с потомком');
    store.update({ thoughtTypes: [] });
  });
});

describe('buildLinkValueEditor — диалог «выбрать» получает тот же отбор (a6513df0)', () => {
  it('openPicker передаёт computed filterIds в searchTypeIds диалога', () => {
    // Диалог (`pickThoughtsDialog`) — статический импорт; в shim-среде его
    // открытие требует document.body. Проверяем связку по исходнику: тот же
    // набор, что ушёл в живой поиск, уезжает в диалог.
    const src = readFileSync(
      resolve(import.meta.dirname, '..', 'src', 'renderer', 'editor', 'value-editor.ts'),
      'utf8',
    );
    const start = src.indexOf('const openPicker = (): void => {');
    assert.ok(start > 0, 'openPicker не найден');
    const body = src.slice(start, src.indexOf('};', start));
    assert.ok(
      /searchTypeIds:\s*filterIds/.test(body),
      'диалог выбора получает отбор по тем же допустимым типам',
    );
    assert.ok(
      /linkAllowedTypeIds\(definition\.allowed_opposite_type_ids\)/.test(src),
      'filterIds вычисляются из серверного набора допустимых типов (одно правило на поле и диалог)',
    );
    assert.ok(
      /linkSearchSource\(networkId,\s*filterIds\)/.test(src),
      'живой поиск поля использует тот же filterIds',
    );
  });
});

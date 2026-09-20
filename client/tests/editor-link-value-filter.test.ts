/**
 * Юнит-тесты отбора кандидатов свойства-связи по ограничению типов
 * (ошибка cfbf3855, 0.8.2): редактор мысли обязан применять к живому поиску
 * поля И к диалогу «выбрать» только допустимые типы из конфига свойства —
 * ключ конфига зависит от стороны привязки (0.8.1, требование b9562306):
 * у привязки со стороны источника ограничены ЦЕЛИ
 * (`config.allowed_target_type_ids`), у привязки со стороны назначения —
 * ИСТОЧНИКИ (`config.allowed_source_type_ids`). Нет ограничения — фильтра нет
 * (любые мысли, как раньше).
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

const linkDefinition = (config: Record<string, unknown>, side?: 'source' | 'target') => ({
  property_id: 'lk-prop',
  key: 'Связь',
  value_type: 'link',
  config,
  required: false,
  side: side ?? null,
  inherited: false,
  defined_on: 'thought_type',
  defined_on_name: 'Тест',
});

describe('linkAllowedTypeIds — ключ конфига по стороне привязки (cfbf3855)', () => {
  it('сторона источника: ограничение целей из allowed_target_type_ids', async () => {
    installShim();
    const { linkAllowedTypeIds } = await import('../src/renderer/editor/value-editor.js');
    assert.deepEqual(
      linkAllowedTypeIds('source', {
        allowed_target_type_ids: ['tt-ver'],
        allowed_source_type_ids: ['tt-work'],
      }),
      ['tt-ver'],
    );
  });

  it('сторона назначения: ограничение источников из allowed_source_type_ids', async () => {
    installShim();
    const { linkAllowedTypeIds } = await import('../src/renderer/editor/value-editor.js');
    assert.deepEqual(
      linkAllowedTypeIds('target', {
        allowed_target_type_ids: ['tt-ver'],
        allowed_source_type_ids: ['tt-work'],
      }),
      ['tt-work'],
    );
  });

  it('нет ограничения или пустой конфиг — фильтра нет', async () => {
    installShim();
    const { linkAllowedTypeIds } = await import('../src/renderer/editor/value-editor.js');
    assert.deepEqual(linkAllowedTypeIds('source', {}), []);
    assert.deepEqual(linkAllowedTypeIds('target', {}), []);
    assert.deepEqual(linkAllowedTypeIds(null, null), []);
    assert.deepEqual(linkAllowedTypeIds('source', { allowed_target_type_ids: [] }), []);
  });
});

describe('buildLinkValueEditor — живой поиск фильтруется по допустимым типам (cfbf3855)', () => {
  it('allowed_target_type_ids сужает живой поиск поля', async () => {
    installShim();
    const { buildLinkValueEditor } = await import('../src/renderer/editor/value-editor.js');
    const editor = buildLinkValueEditor({
      networkId: 'n1',
      definition: linkDefinition({ allowed_target_type_ids: ['tt-ver'] }, 'source') as any,
      values: [],
      save: async () => true,
    }) as unknown as ShimElement;

    await typeAndSettle(addInputOf(editor), 'версия');
    assert.equal(searchCalls.length, 1, 'живой поиск обратился к серверу');
    assert.deepEqual(
      searchCalls[0]!.typeIds,
      ['tt-ver'],
      'поиск ограничен допустимыми типами цели свойства',
    );
  });

  it('сторона назначения: поиск фильтруется по allowed_source_type_ids, не по целям', async () => {
    installShim();
    const { buildLinkValueEditor } = await import('../src/renderer/editor/value-editor.js');
    const editor = buildLinkValueEditor({
      networkId: 'n1',
      definition: linkDefinition(
        {
          allowed_target_type_ids: ['tt-ver'],
          allowed_source_type_ids: ['tt-work'],
        },
        'target',
      ) as any,
      values: [],
      save: async () => true,
    }) as unknown as ShimElement;

    await typeAndSettle(addInputOf(editor), 'работа');
    assert.deepEqual(
      searchCalls[0]!.typeIds,
      ['tt-work'],
      'у привязки со стороны назначения ограничены источники',
    );
  });

  it('без ограничений поиск не сужается (любые мысли)', async () => {
    installShim();
    const { buildLinkValueEditor } = await import('../src/renderer/editor/value-editor.js');
    const editor = buildLinkValueEditor({
      networkId: 'n1',
      definition: linkDefinition({ link_type_id: 'lt-1' }, 'source') as any,
      values: [],
      save: async () => true,
    }) as unknown as ShimElement;

    await typeAndSettle(addInputOf(editor), 'любая');
    assert.deepEqual(searchCalls[0]!.typeIds, [], 'пустой фильтр — сервер вернёт любые мысли');
  });

  it('фильтр берётся из конфига КОНКРЕТНОГО свойства, а не глобально', async () => {
    installShim();
    const { buildLinkValueEditor } = await import('../src/renderer/editor/value-editor.js');
    const restricted = buildLinkValueEditor({
      networkId: 'n1',
      definition: linkDefinition({ allowed_target_type_ids: ['tt-a'] }, 'source') as any,
      values: [],
      save: async () => true,
    }) as unknown as ShimElement;
    const free = buildLinkValueEditor({
      networkId: 'n1',
      definition: linkDefinition({}, 'source') as any,
      values: [],
      save: async () => true,
    }) as unknown as ShimElement;

    await typeAndSettle(addInputOf(restricted), 'a');
    await typeAndSettle(addInputOf(free), 'b');
    assert.deepEqual(searchCalls[0]!.typeIds, ['tt-a'], 'свойство с ограничением фильтрует');
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
      definition: linkDefinition({ allowed_target_type_ids: ['tt-par'] }, 'source') as any,
      values: [],
      save: async () => true,
    }) as unknown as ShimElement;

    await typeAndSettle(addInputOf(editor), 'подраздел');
    const ids = new Set(searchCalls[0]!.typeIds);
    assert.ok(ids.has('tt-par') && ids.has('tt-child'), 'родитель вместе с потомком');
    store.update({ thoughtTypes: [] });
  });
});

describe('buildLinkValueEditor — диалог «выбрать» получает тот же отбор (cfbf3855)', () => {
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
      /linkAllowedTypeIds\(definition\.side\s*\?\?\s*null,\s*definition\.config\s*\?\?\s*null\)/.test(
        src,
      ),
      'filterIds вычисляются из стороны и конфига определения (одно правило на поле и диалог)',
    );
    assert.ok(
      /linkSearchSource\(networkId,\s*filterIds\)/.test(src),
      'живой поиск поля использует тот же filterIds',
    );
  });
});

/**
 * Тесты черновиков правок источников трансклюзий (0.12.1, ТП `fcde7c55` «Живой
 * блок трансклюзии — сплошная правка в одном окне», задача `6a085e01`; ADR
 * `f3adf3d3`).
 *
 * Проверяют обязательства задачи:
 * 1. черновик блока переживает «перезапуск» (новое поле того же владельца):
 *    сохранённый текст находится по ключу и восстанавливается во вложенный
 *    редактор, блок сразу «грязный»;
 * 2. успешная запись чистит черновики записанных источников (адресно по ключам);
 * 3. отмена (`Esc`) чистит все черновики источников владельца;
 * 4. черновик окружения (комментария) и черновик блока не конфликтуют — разные
 *    ключи (`entityType`/`field`).
 *
 * Плюс сторож проводки `markdown-field.ts`/`transclusion.ts`: реальный
 * `EditorView` в DOM-шиме не поднимается, поэтому связь поля с хранилищем
 * проверяется по исходнику (мутация «убрать вызов» обязана красить тест).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EditorState, type Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

import { ShimElement } from './dom-shim.js';
import {
  NestedEditorStore,
  type NestedViewFactory,
} from '../src/renderer/editor/transclusion-nested.js';
import { blockEditorKey, dirtyBlockSaves } from '../src/renderer/editor/transclusion.js';
import {
  clearSourceDrafts,
  findSourceDraft,
  listSourceDrafts,
  parseSourceDraftField,
  saveDraft,
  saveSourceDraft,
  sourceDraftField,
} from '../src/renderer/drafts.js';

const ID_A = '8e0d670e-de61-4da7-b13e-9232cd1c6ca5';
const ID_B = '11111111-2222-3333-4444-555555555555';
const NET = 'c4f9a3b2-1111-2222-3333-444455556666';
const OWNER = `comment:perm-1`;

/** Дублёр вложенного инстанса: EditorState + сигнал ввода (настоящий CM в шиме не живёт). */
class FakeNestedView {
  state: EditorState;
  onInput: ((md: string) => void) | null = null;
  constructor(doc: string, extensions: Extension[]) {
    this.state = EditorState.create({ doc, extensions });
  }
  dispatch(spec: unknown): void {
    const before = this.state.doc.toString();
    this.state = this.state.update(spec as never).state;
    const after = this.state.doc.toString();
    if (after !== before) this.onInput?.(after);
  }
  focus(): void {}
}

/** Фабрика-дублёр: запоминает инстансы по ключу, отдаёт шим-DOM. */
function fakeFactory(registry: Map<string, FakeNestedView>): NestedViewFactory {
  return (params) => {
    const v = new FakeNestedView(params.initialText, params.extensions);
    v.onInput = params.onInput;
    registry.set(params.key, v);
    return { view: v as unknown as EditorView, dom: new ShimElement('div') as unknown as HTMLElement };
  };
}

/** Осиротевшие опции: минимальный набор для монтирования инстанса. */
const noopOptions = {
  depth: 1,
  onDirty: () => undefined,
  onExit: () => undefined,
  onCommit: () => undefined,
  onCancel: () => undefined,
};

interface StoredDraft {
  id: string;
  networkId: string;
  entityType: string;
  entityId: string;
  field: string;
  value: string | null;
  baseVersion: number | null;
}

/**
 * In-memory заглушка хранилища черновиков (`etn.ui.*`): upsert по
 * (networkId, entityType, entityId, field), как реальный `localDb.upsertDraft`.
 */
function stubDraftStore(): { rows: () => StoredDraft[] } {
  const rows: StoredDraft[] = [];
  let seq = 0;
  (globalThis as unknown as { etn: unknown }).etn = {
    ui: {
      draftSave: async (input: StoredDraft) => {
        const hit = rows.find(
          (r) =>
            r.networkId === input.networkId &&
            r.entityType === input.entityType &&
            r.entityId === input.entityId &&
            r.field === input.field,
        );
        if (hit !== undefined) {
          hit.value = input.value;
          hit.baseVersion = input.baseVersion;
          return hit.id;
        }
        const id = `draft-${++seq}`;
        rows.push({ ...input, id });
        return id;
      },
      draftList: async (networkId: string) =>
        rows
          .filter((r) => r.networkId === networkId)
          .map((r) => ({ ...r, status: 'pending', createdAt: '2026-10-08T00:00:00.000Z' })),
      draftDelete: async (id: string) => {
        const at = rows.findIndex((r) => r.id === id);
        if (at >= 0) rows.splice(at, 1);
      },
    },
  };
  return { rows: () => rows };
}

// ---------------------------------------------------------------------------
// Схема ключа
// ---------------------------------------------------------------------------

test('sourceDraftField/parseSourceDraftField: источник и раздел обратимы', () => {
  assert.equal(sourceDraftField(ID_A, null), `${ID_A}#`);
  assert.equal(sourceDraftField(ID_A, 'Раздел A'), `${ID_A}#Раздел A`);
  assert.deepEqual(parseSourceDraftField(sourceDraftField(ID_A, null)), {
    sourceId: ID_A,
    section: null,
  });
  assert.deepEqual(parseSourceDraftField(sourceDraftField(ID_A, 'Раздел A')), {
    sourceId: ID_A,
    section: 'Раздел A',
  });
  // Раздел со знаком `#` внутри не ломает разбор: отделяется первый `#`.
  assert.deepEqual(parseSourceDraftField(sourceDraftField(ID_A, 'C# и .NET')), {
    sourceId: ID_A,
    section: 'C# и .NET',
  });
});

// ---------------------------------------------------------------------------
// Обязательство 1: черновик переживает «перезапуск» и поднимает «грязный» блок
// ---------------------------------------------------------------------------

test('черновик блока переживает «перезапуск» и восстанавливается во вложенный редактор', async () => {
  const stub = stubDraftStore();
  const key = blockEditorKey(ID_A, 'Раздел A');

  // Первое поле: правку блока отзеркалил debounce-поток.
  await saveSourceDraft({
    networkId: NET,
    ownerKey: OWNER,
    sourceId: ID_A,
    section: 'Раздел A',
    value: 'ЧЕРНОВИК ТЕКСТА',
  });
  assert.equal(stub.rows().length, 1, 'черновик источника записан');

  // «Перезапуск»: новое поле того же владельца читает черновик.
  const hit = await findSourceDraft(NET, OWNER, ID_A, 'Раздел A');
  assert.ok(hit !== null, 'черновик найден по ключу владельца/источника/раздела');
  assert.equal(hit.value, 'ЧЕРНОВИК ТЕКСТА');

  // Монтаж вложенного редактора на черновике: текст — из черновика, блок грязный.
  const registry = new Map<string, FakeNestedView>();
  const store = new NestedEditorStore(fakeFactory(registry));
  store.mount(key, 'СЕРВЕРНЫЙ ТЕКСТ', noopOptions, hit.value);
  assert.equal(store.text(key), 'ЧЕРНОВИК ТЕКСТА', 'восстановленный текст черновика');
  assert.equal(store.isDirty(key), true, 'восстановленный блок «грязный»');
  assert.equal(registry.get(key)!.state.doc.toString(), 'ЧЕРНОВИК ТЕКСТА', 'документ инстанса — черновик');
  const saves = dirtyBlockSaves(store);
  assert.deepEqual(saves, [
    { key, sourceId: ID_A, section: 'Раздел A', text: 'ЧЕРНОВИК ТЕКСТА' },
  ]);

  // Откат возвращает к СЕРВЕРНОМУ тексту (база сравнения — загруженный источник).
  store.rollback(key);
  assert.equal(store.text(key), 'СЕРВЕРНЫЙ ТЕКСТ');
  assert.equal(store.isDirty(key), false, 'после отката блок чистый');
});

test('mount без черновика: инстанс чистый, документ — загруженный источник', () => {
  const registry = new Map<string, FakeNestedView>();
  const store = new NestedEditorStore(fakeFactory(registry));
  const key = blockEditorKey(ID_A, null);
  store.mount(key, 'ТЕЛО', noopOptions, null);
  assert.equal(store.text(key), 'ТЕЛО');
  assert.equal(store.isDirty(key), false);
});

test('mount с черновиком, равным источнику: блок остаётся чистым', () => {
  const registry = new Map<string, FakeNestedView>();
  const store = new NestedEditorStore(fakeFactory(registry));
  const key = blockEditorKey(ID_A, null);
  store.mount(key, 'ТЕЛО', noopOptions, 'ТЕЛО');
  assert.equal(store.isDirty(key), false, 'совпадающий черновик не делает блок грязным');
});

// ---------------------------------------------------------------------------
// Обязательство 2: успешная запись чистит черновики записанных источников
// ---------------------------------------------------------------------------

test('успешная запись: clearSourceDrafts по ключам чистит только записанные источники', async () => {
  const stub = stubDraftStore();
  const keyA = blockEditorKey(ID_A, null);
  const keyB = blockEditorKey(ID_B, 'Раздел');
  await saveSourceDraft({ networkId: NET, ownerKey: OWNER, sourceId: ID_A, section: null, value: 'A' });
  await saveSourceDraft({
    networkId: NET,
    ownerKey: OWNER,
    sourceId: ID_B,
    section: 'Раздел',
    value: 'B',
  });
  assert.equal(stub.rows().length, 2, 'два черновика источников');

  // Записан только A (частичный сбой B) — чистим лишь записанные ключи.
  await clearSourceDrafts(NET, OWNER, [keyA]);
  const left = await listSourceDrafts(NET, OWNER);
  assert.deepEqual(
    left.map((d) => sourceDraftField(d.sourceId, d.section)),
    [keyB],
    'остался только незаписанный источник',
  );

  // Полная запись — чистим всё.
  await clearSourceDrafts(NET, OWNER);
  assert.deepEqual(stub.rows(), [], 'после полной записи черновиков нет');
});

// ---------------------------------------------------------------------------
// Обязательство 3: отмена чистит все черновики источников владельца
// ---------------------------------------------------------------------------

test('Esc: clearSourceDrafts без ключей чистит все черновики владельца', async () => {
  const stub = stubDraftStore();
  await saveSourceDraft({ networkId: NET, ownerKey: OWNER, sourceId: ID_A, section: null, value: 'A' });
  await saveSourceDraft({
    networkId: NET,
    ownerKey: OWNER,
    sourceId: ID_B,
    section: 'Раздел',
    value: 'B',
  });
  // Чужой владелец того же источника — не трогаем.
  await saveSourceDraft({
    networkId: NET,
    ownerKey: 'thought:other',
    sourceId: ID_A,
    section: null,
    value: 'чужое',
  });

  await clearSourceDrafts(NET, OWNER);
  assert.equal(stub.rows().length, 1, 'чужой владелец сохранён');
  assert.equal(stub.rows()[0]!.entityId, 'thought:other');
});

// ---------------------------------------------------------------------------
// Обязательство 4: черновик окружения и черновик блока не конфликтуют
// ---------------------------------------------------------------------------

test('черновик комментария и черновик блока живут под разными ключами', async () => {
  const stub = stubDraftStore();
  // Черновик окружения — существующий механизм (`comment`/`body_md`).
  await saveDraft({
    networkId: NET,
    entityType: 'comment',
    entityId: 'perm-1',
    field: 'body_md',
    value: 'ТЕКСТ КОММЕНТАРИЯ',
    baseVersion: 1,
  });
  await saveSourceDraft({
    networkId: NET,
    ownerKey: OWNER,
    sourceId: ID_A,
    section: null,
    value: 'ТЕКСТ ИСТОЧНИКА',
  });

  const comment = stub.rows().find((r) => r.entityType === 'comment')!;
  const source = stub.rows().find((r) => r.entityType === 'transclusion')!;
  assert.notEqual(comment.entityType, source.entityType, 'разные типы сущностей');
  assert.notEqual(comment.field, source.field, 'разные поля ключа');

  // Поиск/очистка источника не задевают черновик комментария.
  assert.equal((await findSourceDraft(NET, OWNER, ID_A, null))!.value, 'ТЕКСТ ИСТОЧНИКА');
  await clearSourceDrafts(NET, OWNER);
  assert.deepEqual(
    stub.rows().map((r) => r.entityType),
    ['comment'],
    'черновик окружения пережил очистку черновиков источников',
  );
});

// ---------------------------------------------------------------------------
// Сторож проводки поля: реальный EditorView headless не поднимается
// ---------------------------------------------------------------------------

test('markdown-field: проводка черновиков источников (6a085e01)', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '../src/renderer/editor/markdown-field.ts'), 'utf8');
  const checks: Array<[boolean, string]> = [
    [/onBlockDirty: \(key\) => scheduleSourceDraft\(key\)/.test(src), '«грязный» блок зеркалится в черновик'],
    [/getBlockDraft:/.test(src) && /findSourceDraft\(/.test(src), 'монтаж блока читает черновик'],
    [/saveSourceDraft\(/.test(src), 'черновик источника пишется через saveSourceDraft'],
    [
      /clearSourceDrafts\(networkId, collapseOwnerKey\)/.test(src),
      'Esc чистит все черновики источников поля',
    ],
    [
      /clearSourceDrafts\(networkId, collapseOwnerKey, result\.savedKeys\)/.test(src),
      'успешная запись чистит черновики записанных источников',
    ],
    [/!canSave\(\)/.test(src) && /offlineNotice\(\)/.test(src), 'офлайн-уход сохраняет черновики'],
    [/cancelSourceDraftTimers\(\)/.test(src), 'запись/отмена гасят отложенную запись черновиков'],
  ];
  for (const [ok, what] of checks) assert.ok(ok, what);
});

test('transclusion: монтаж блока передаёт черновик в хранилище (6a085e01)', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '../src/renderer/editor/transclusion.ts'), 'utf8');
  assert.ok(/host\.getBlockDraft\(ref\.sourceId, ref\.section\)/.test(src), 'блок спрашивает черновик у хоста');
  assert.ok(/store\.mount\(/.test(src), 'монтаж идёт через store.mount');
  assert.ok(/draft,\s*\n\s*\)/.test(src) || /draft,/.test(src), 'черновик передан в mount');
});

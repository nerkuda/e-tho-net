/**
 * Тесты единой записи и пакетного захвата источников трансклюзий (0.12.1,
 * ТП `fcde7c55` «Живой блок трансклюзии — сплошная правка в одном окне»,
 * задача `e9dfc2df`; ADR `f3adf3d3`, решение 3).
 *
 * Проверяют:
 * 1. сбор id источников документа и разбор ключа блока (`sourceId#section`);
 * 2. `TransclusionLockSet` — пакетный захват всех источников, чужой захват не
 *    удерживается, пачечное снятие (`releaseHeld`);
 * 3. `dirtyBlockSaves` — «грязные» блоки хранилища к записи (ключ + текст +
 *    ссылка из ключа, включая вложенные);
 * 4. `commitTransclusionEdit` — единая запись: окружение + N источников, слияние
 *    раздела, ЧАСТИЧНЫЙ сбой (один источник не записан — остальные записаны);
 * 5. `NestedEditorStore` — `markSaved`/`markError`/`rollbackAll`/`dirtyKeys`.
 *
 * Headless: реальный CodeMirror в DOM-шиме не поднимается, вложенные инстансы —
 * лёгкий дублёр (`NestedViewFactory`); сеть — заглушка `globalThis.etn`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EditorState, type Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { EtnError } from '@etn/shared';

import { ShimElement } from './dom-shim.js';
import {
  NESTED_SAVE_ERROR_CLASS,
  NestedEditorStore,
  type NestedViewFactory,
} from '../src/renderer/editor/transclusion-nested.js';
import {
  TransclusionLockSet,
  blockEditorKey,
  cachedTransclusionLoader,
  commitTransclusionEdit,
  dirtyBlockSaves,
  parseBlockEditorKey,
  reportCommitFailures,
  transclusionBlockLabel,
  transclusionSourceIds,
  type TransclusionCommitResult,
} from '../src/renderer/editor/transclusion.js';
import { __resetForTests, __setForTests } from '../src/renderer/lib/lock-cache.js';
import type { LockRow } from '@etn/shared';

const ID_A = '8e0d670e-de61-4da7-b13e-9232cd1c6ca5';
const ID_B = '11111111-2222-3333-4444-555555555555';
const NET = 'c4f9a3b2-1111-2222-3333-444455556666';

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

/** Строка кэша захватов: источник держит другой участник. */
function foreignLock(entityId: string): LockRow {
  return {
    id: `lock-${entityId}`,
    entity_type: 'thought',
    entity_id: entityId,
    user_id: 'Алиса',
    client_id: 'client-1',
    acquired_at_ms: 1,
  };
}

// ---------------------------------------------------------------------------
// Сбор источников и разбор ключа
// ---------------------------------------------------------------------------

test('transclusionSourceIds: уникальные источники в порядке появления', () => {
  const doc = `до ![[#${ID_A}]] и ![[#${ID_B}#Раздел]] и снова ![[#${ID_A}]]`;
  assert.deepEqual(transclusionSourceIds(doc), [ID_A, ID_B]);
  assert.deepEqual(transclusionSourceIds('текст без ссылок'), []);
});

// Ошибка 7399c9ec: обычная wiki-ссылка `[[#id]]` (автокомплит по `[[`) НЕ
// является трансклюзией — блоков у поля нет, значит и блок-сообщений быть не
// должно. Трансклюзия отличается ведущим `!`.
test('transclusionSourceIds: wiki-ссылка [[#id]] не считается трансклюзией (7399c9ec)', () => {
  assert.deepEqual(transclusionSourceIds(`до [[#${ID_A}|имя]] после`), []);
  assert.deepEqual(transclusionSourceIds(`до [[#${ID_A}]] после`), []);
  assert.deepEqual(transclusionSourceIds(`до ![[#${ID_A}]] после`), [ID_A]);
});

test('parseBlockEditorKey: источник и раздел из ключа инстанса', () => {
  assert.deepEqual(parseBlockEditorKey(blockEditorKey(ID_A, null)), { sourceId: ID_A, section: null });
  assert.deepEqual(parseBlockEditorKey(blockEditorKey(ID_A, 'Раздел A')), {
    sourceId: ID_A,
    section: 'Раздел A',
  });
});

// ---------------------------------------------------------------------------
// Пакетный захват
// ---------------------------------------------------------------------------

test('TransclusionLockSet: берёт захват на все источники и снимает пачкой', async () => {
  __resetForTests();
  const acquired: string[] = [];
  const released: string[] = [];
  (globalThis as unknown as { etn: unknown }).etn = {
    locks: {
      acquire: async (_net: string, _type: string, id: string) => {
        acquired.push(id);
        return { id: `lock-${id}`, entity_type: 'thought', entity_id: id, user_id: 'me', client_id: null, acquired_at_ms: 1 };
      },
      release: async (_net: string, lockId: string) => {
        released.push(lockId);
      },
    },
  };
  const { store } = await import('../src/renderer/state.js');
  store.update({ networkId: NET, me: { id: 'me' } as never });
  try {
    const lockSet = new TransclusionLockSet();
    await lockSet.acquire([ID_A, ID_B]);
    assert.deepEqual(acquired.sort(), [ID_A, ID_B].sort(), 'взят захват на каждый источник');
    assert.deepEqual(lockSet.heldIds().sort(), [ID_A, ID_B].sort(), 'оба захвата удержаны');

    await lockSet.release();
    assert.deepEqual(released.sort(), [`lock-${ID_A}`, `lock-${ID_B}`].sort(), 'снятие пачкой — по одному на источник');
    assert.deepEqual(lockSet.heldIds(), [], 'после снятия ничего не удержано');
  } finally {
    store.update({ networkId: null, me: null });
    __resetForTests();
  }
});

test('TransclusionLockSet: чужой захват не удерживается и не запрашивается у сети', async () => {
  __resetForTests();
  let acquireCalls = 0;
  (globalThis as unknown as { etn: unknown }).etn = {
    locks: {
      acquire: async () => {
        acquireCalls += 1;
        return { id: 'x', entity_type: 'thought', entity_id: ID_A, user_id: 'me', client_id: null, acquired_at_ms: 1 };
      },
      release: async () => undefined,
    },
  };
  const { store } = await import('../src/renderer/state.js');
  store.update({ networkId: NET, me: { id: 'me' } as never });
  __setForTests([foreignLock(ID_B)]);
  try {
    const lockSet = new TransclusionLockSet();
    await lockSet.acquire([ID_A, ID_B]);
    assert.deepEqual(lockSet.heldIds(), [ID_A], 'удержан только свободный источник');
    assert.equal(acquireCalls, 1, 'по чужому захвату сеть не дёргается (кэш знает держателя)');
  } finally {
    store.update({ networkId: null, me: null });
    __resetForTests();
  }
});

// ---------------------------------------------------------------------------
// «Грязные» блоки хранилища
// ---------------------------------------------------------------------------

test('dirtyBlockSaves: собирает грязные блоки (источник/раздел из ключа, вложенные тоже)', () => {
  const registry = new Map<string, FakeNestedView>();
  const store = new NestedEditorStore(fakeFactory(registry));
  const keyA = blockEditorKey(ID_A, null);
  const keyB = blockEditorKey(ID_B, 'Раздел');
  store.mount(keyA, 'ТЕЛО A', noopOptions);
  store.mount(keyB, 'ТЕЛО B', noopOptions);
  assert.deepEqual(dirtyBlockSaves(store), [], 'свежие инстансы не грязные');

  registry.get(keyA)!.dispatch({ changes: { from: 0, to: 0, insert: 'X' } });
  const saves = dirtyBlockSaves(store);
  assert.equal(saves.length, 1, 'грязный только правленный блок');
  assert.deepEqual(saves[0], { key: keyA, sourceId: ID_A, section: null, text: 'XТЕЛО A' });
});

// ---------------------------------------------------------------------------
// Единая запись
// ---------------------------------------------------------------------------

/** Заглушка `etn.comments` для единой записи: счётчики + сбой по id. */
function stubComments(opts: {
  bodies?: Record<string, string>;
  failUpdateFor?: string;
} = {}): {
  updates: Array<{ id: string; body_md: string; version: number }>;
  lists: string[];
} {
  const updates: Array<{ id: string; body_md: string; version: number }> = [];
  const lists: string[] = [];
  (globalThis as unknown as { etn: unknown }).etn = {
    comments: {
      list: async (_net: string, _ownerType: string, id: string) => {
        lists.push(id);
        return [
          {
            id: `perm-${id}`,
            kind: 'permanent',
            body_md: opts.bodies?.[id] ?? 'ТЕЛО ИСТОЧНИКА',
            body_html: '',
            version: 1,
          },
        ];
      },
      update: async (_net: string, id: string, payload: { body_md: string }, version: number) => {
        if (opts.failUpdateFor !== undefined && id === `perm-${opts.failUpdateFor}`) {
          throw new EtnError('VERSION_CONFLICT', 'conflict');
        }
        updates.push({ id, body_md: payload.body_md, version });
        return { id, body_md: payload.body_md, body_html: '', version: version + 1 };
      },
    },
  };
  return { updates, lists };
}

test('commitTransclusionEdit: пишет окружение и N источников (числа)', async () => {
  const stub = stubComments();
  let envWrites = 0;
  const keyA = blockEditorKey(ID_A, null);
  const keyB = blockEditorKey(ID_B, null);
  const result = await commitTransclusionEdit({
    networkId: NET,
    saves: [
      { key: keyA, sourceId: ID_A, section: null, text: 'новое A' },
      { key: keyB, sourceId: ID_B, section: null, text: 'новое B' },
    ],
    writeEnv: async () => {
      envWrites += 1;
      return '<p>env</p>';
    },
  });
  assert.equal(envWrites, 1, 'окружение записано один раз');
  assert.equal(result.envOk, true);
  assert.equal(result.envHtml, '<p>env</p>');
  assert.equal(stub.updates.length, 2, 'записано N=2 источника');
  assert.deepEqual(result.savedKeys.sort(), [keyA, keyB].sort());
  assert.deepEqual(result.failedKeys, [], 'сбоев нет');
  assert.deepEqual(stub.updates.map((u) => u.body_md).sort(), ['новое A', 'новое B']);
  assert.deepEqual(stub.lists.sort(), [ID_A, ID_B].sort(), 'источники прочитаны по разу');
});

test('commitTransclusionEdit: правка раздела сливается в тело источника', async () => {
  const stub = stubComments({
    bodies: { [ID_A]: '## Раздел A\nстарое\n## Раздел B\nбэ' },
  });
  const result = await commitTransclusionEdit({
    networkId: NET,
    saves: [{ key: blockEditorKey(ID_A, 'Раздел A'), sourceId: ID_A, section: 'Раздел A', text: 'новое' }],
    writeEnv: null,
  });
  assert.equal(result.envOk, true, 'записи окружения не требовалось');
  assert.equal(result.savedKeys.length, 1);
  assert.equal(
    stub.updates[0]!.body_md,
    '## Раздел A\nновое\n## Раздел B\nбэ',
    'раздел заменён, соседний сохранён',
  );
});

test('commitTransclusionEdit: частичный сбой — остальные записаны, сбойный в failedKeys', async () => {
  const stub = stubComments({ failUpdateFor: ID_B });
  const keyA = blockEditorKey(ID_A, null);
  const keyB = blockEditorKey(ID_B, null);
  const result = await commitTransclusionEdit({
    networkId: NET,
    saves: [
      { key: keyA, sourceId: ID_A, section: null, text: 'A2' },
      { key: keyB, sourceId: ID_B, section: null, text: 'B2' },
    ],
    writeEnv: async () => '',
  });
  assert.equal(result.envOk, true, 'окружение записано несмотря на сбой источника');
  assert.deepEqual(result.savedKeys, [keyA], 'исправный источник записан');
  assert.deepEqual(result.failedKeys, [keyB], 'сбойный блок помечен к записи');
  assert.deepEqual(result.failedSourceIds, [ID_B]);
  assert.equal(stub.updates.length, 1, 'сбойный источник не попал в updates');
});

test('commitTransclusionEdit: сбой окружения — envOk false, источники всё равно записаны', async () => {
  const stub = stubComments();
  const keyA = blockEditorKey(ID_A, null);
  const result = await commitTransclusionEdit({
    networkId: NET,
    saves: [{ key: keyA, sourceId: ID_A, section: null, text: 'A2' }],
    writeEnv: async () => {
      throw new Error('env failed');
    },
  });
  assert.equal(result.envOk, false, 'сбой окружения отражён');
  assert.ok(result.envError instanceof Error, 'ошибку окружения сохранили для сообщения (7399c9ec)');
  assert.deepEqual(result.savedKeys, [keyA], 'источник записан независимо');
  assert.equal(stub.updates.length, 1);
});

// ---------------------------------------------------------------------------
// Сообщения о сбоях единой записи (ошибка 7399c9ec): поле без трансклюзий не
// должно получать блок-специфичное сообщение; сбойные блоки называются по имени
// и разделу. Шов `reportCommitFailures` — чистый, с инъекцией `notify`.
// ---------------------------------------------------------------------------

test('reportCommitFailures: простое поле (без блоков) записано — сообщений нет (7399c9ec)', async () => {
  let envWrites = 0;
  const result = await commitTransclusionEdit({
    networkId: NET,
    saves: [],
    writeEnv: async () => {
      envWrites += 1;
      return '<p>ok</p>';
    },
  });
  const notices: string[] = [];
  reportCommitFailures({ networkId: NET, result, notify: (m) => notices.push(m) });
  assert.equal(envWrites, 1, 'окружение записано');
  assert.equal(result.envOk, true);
  assert.deepEqual(result.failedKeys, [], 'блоков нет — сбойных нет');
  assert.deepEqual(notices, [], 'никаких блок-уведомлений при записи простого поля');
});

test('reportCommitFailures: сбой окружения без блоков — своё сообщение, не блок-текст (7399c9ec)', async () => {
  const result = await commitTransclusionEdit({
    networkId: NET,
    saves: [],
    writeEnv: async () => {
      throw new EtnError('VERSION_CONFLICT', 'конфликт версии комментария');
    },
  });
  assert.equal(result.envOk, false);
  const notices: string[] = [];
  reportCommitFailures({ networkId: NET, result, notify: (m) => notices.push(m) });
  assert.equal(notices.length, 1, 'ровно одно сообщение о сбое окружения');
  assert.match(notices[0]!, /Не удалось сохранить комментарий/);
  assert.match(notices[0]!, /конфликт версии комментария/, 'названа причина');
  assert.ok(
    !/исправьте помеченные блоки/i.test(notices[0]!),
    'блок-текст не показывается при нуле сбойных блоков',
  );
});

test('reportCommitFailures: сбой блока называет имя и раздел (7399c9ec)', async () => {
  // Прогреваем кэш имён источников тем же загрузчиком, что рисует блоки.
  (globalThis as unknown as { etn: unknown }).etn = {
    thoughts: {
      resolve: async (_net: string, ids: string[]) =>
        ids.map((id) => ({ id, title: 'Источник А', synonyms: [], type_id: null })),
    },
    comments: {
      list: async () => [
        { id: 'perm', kind: 'permanent', body_md: '## Раздел A\nстарое', version: 1 },
      ],
    },
  };
  await cachedTransclusionLoader(NET)(ID_A);
  const key = blockEditorKey(ID_A, 'Раздел A');
  assert.equal(transclusionBlockLabel(NET, key), 'Источник А · Раздел A');

  const result: TransclusionCommitResult = {
    envOk: true,
    envHtml: '<p>env</p>',
    savedKeys: [],
    failedKeys: [key],
    failedSourceIds: [ID_A],
    envError: null,
  };
  const notices: string[] = [];
  reportCommitFailures({ networkId: NET, result, notify: (m) => notices.push(m) });
  assert.equal(notices.length, 1, 'только блок-сообщение (окружение записано)');
  assert.match(notices[0]!, /Источник А · Раздел A/, 'назван конкретный блок');
  assert.match(notices[0]!, /исправьте помеченные блоки/i);
});

test('reportCommitFailures: сбой блока и окружения — оба сообщения (7399c9ec)', () => {
  const key = blockEditorKey(ID_B, null);
  const result: TransclusionCommitResult = {
    envOk: false,
    envHtml: null,
    savedKeys: [],
    failedKeys: [key],
    failedSourceIds: [ID_B],
    envError: new Error('сеть недоступна'),
  };
  const notices: string[] = [];
  reportCommitFailures({ networkId: NET, result, notify: (m) => notices.push(m) });
  assert.equal(notices.length, 2, 'два разных сбоя — два разных сообщения');
  assert.ok(notices.some((m) => /Не удалось сохранить комментарий/.test(m)), 'сообщение о сбое окружения');
  assert.ok(notices.some((m) => /исправьте помеченные блоки/i.test(m)), 'сообщение о сбойных блоках');
});

// ---------------------------------------------------------------------------
// Хранилище: пометки успеха/ошибки, откат
// ---------------------------------------------------------------------------

test('NestedEditorStore: markSaved сдвигает базу, markError помечает DOM', () => {
  const registry = new Map<string, FakeNestedView>();
  const store = new NestedEditorStore(fakeFactory(registry));
  const key = blockEditorKey(ID_A, null);
  const handle = store.mount(key, 'ТЕЛО', noopOptions);
  const dom = handle.dom!;
  registry.get(key)!.dispatch({ changes: { from: 0, to: 0, insert: 'X' } });
  assert.equal(store.isDirty(key), true);

  store.markSaved(key);
  assert.equal(store.isDirty(key), false, 'успешная запись снимает грязность');
  assert.equal(store.hasError(key), false);
  // Правка относительно НОВОЙ базы снова помечает блок грязным.
  registry.get(key)!.dispatch({ changes: { from: 0, to: 0, insert: 'Y' } });
  assert.equal(store.isDirty(key), true, 'после markSaved база — записанный текст');

  store.markSaved(key);
  store.markError(key);
  assert.equal(store.hasError(key), true, 'сбойный блок помечен');
  assert.equal(dom.classList.contains(NESTED_SAVE_ERROR_CLASS), true, 'пометка видна на DOM');
  store.markSaved(key);
  assert.equal(store.hasError(key), false, 'успешная запись снимает пометку');
  assert.equal(dom.classList.contains(NESTED_SAVE_ERROR_CLASS), false);
});

test('NestedEditorStore: rollbackAll возвращает все инстансы к загруженному тексту', () => {
  const registry = new Map<string, FakeNestedView>();
  const store = new NestedEditorStore(fakeFactory(registry));
  const keyA = blockEditorKey(ID_A, null);
  const keyB = blockEditorKey(ID_B, null);
  store.mount(keyA, 'A', noopOptions);
  store.mount(keyB, 'B', noopOptions);
  registry.get(keyA)!.dispatch({ changes: { from: 0, to: 0, insert: 'X' } });
  registry.get(keyB)!.dispatch({ changes: { from: 0, to: 0, insert: 'Y' } });
  assert.deepEqual(store.dirtyKeys().sort(), [keyA, keyB].sort());

  store.rollbackAll();
  assert.equal(store.text(keyA), 'A');
  assert.equal(store.text(keyB), 'B');
  assert.deepEqual(store.dirtyKeys(), [], 'после отката грязных нет');
});

// ---------------------------------------------------------------------------
// Сторож проводки поля (задача e9dfc2df): поле обязано вызывать пакетный
// захват, единую запись и откат. `showEdit` с реальным EditorView headless не
// поднимается, поэтому проводка проверяется по исходнику — мутация «убрать
// вызов» обязана красить тест.
// ---------------------------------------------------------------------------

test('markdown-field: проводка пакетного захвата и единой записи (e9dfc2df)', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '../src/renderer/editor/markdown-field.ts'), 'utf8');
  const checks: Array<[boolean, string]> = [
    [/new TransclusionLockSet\(\)/.test(src), 'поле создаёт набор захватов источников'],
    [
      /sourceLocks\.acquire\(transclusionSourceIds\(currentMd\)\)/.test(src),
      'вход в правку берёт пакетный захват источников документа',
    ],
    [/void sourceLocks\?\.release\(\)/.test(src), 'выход из правки снимает захваты'],
    [/dirtyBlockSaves\(store\)/.test(src), 'единая запись собирает «грязные» блоки'],
    [/commitTransclusionEdit\(/.test(src), 'единая запись идёт через commitTransclusionEdit'],
    [/store\?\.rollbackAll\(\)/.test(src), 'Esc откатывает вложенные редакторы'],
    [/markSaved\(key\)/.test(src), 'успешные блоки помечаются записанными'],
    [/markError\(key\)/.test(src), 'сбойные блоки помечаются визуально'],
    [
      /reportCommitFailures\(\{/.test(src) && !/comment\.transclusion\.savePartial/.test(src),
      'сообщения о сбоях различают окружение и блоки (7399c9ec)',
    ],
    [/onCommitEdit:/.test(src) && /onCancelEdit:/.test(src), 'хост блока связан с единой записью и отменой'],
    [/onBlockMounted:/.test(src), 'монтирование вложенного блока догружает захват источника'],
  ];
  for (const [ok, what] of checks) assert.ok(ok, what);
});

test('transclusion: блок не хранит отдельного сохранения/Esc (e9dfc2df)', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const nested = fs.readFileSync(
    path.join(here, '../src/renderer/editor/transclusion-nested.ts'),
    'utf8',
  );
  assert.ok(!/onRollback/.test(nested), 'отдельного отката блока по Esc нет');
  assert.ok(/options\.onCommit\(key\)/.test(nested), 'Ctrl+Enter в блоке идёт в единую запись поля');
  assert.ok(/options\.onCancel\(key\)/.test(nested), 'Esc в блоке отменяет всю правку поля');
});

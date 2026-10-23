/**
 * Жизненный цикл черновиков правок (ошибка 5726744b).
 *
 * Симптом заказчика: при запуске клиента сразу появляется «Черновик не
 * отправлен: comment version mismatch» и повторяется на каждом запуске.
 *
 * Проверяются обязательства исправления:
 * 1. набор → досылка: успешная отправка удаляет черновик;
 * 2. набор → закрытие сессии: оставшийся pending-черновик досылается при
 *    подключении сети (первый `connected` сессии тоже считается);
 * 3. первая же `VERSION_CONFLICT` переводит черновик в `conflict`: он больше
 *    не отправляется на следующие connect'ы, уведомление — одно, текст цел;
 * 4. конфликтный черновик не удаляется автоматически, а следующая правка
 *    переводит его обратно в `pending` с актуальной версией — и он уходит;
 * 5. поздно пришедшая запись debounce после сохранения/отмены удаляет себя
 *    (источник «вечного» черновика с устаревшей baseVersion).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EtnError } from '@etn/shared';

import { ShimElement } from './dom-shim.js';

/* ------------------------------------------------------------------ *
 * DOM-шим: notice() рисует тост в document.body
 * ------------------------------------------------------------------ */

const body = new ShimElement('body');
/* eslint-disable @typescript-eslint/no-explicit-any */
(globalThis as any).document = {
  createElement: (tag: string) => new ShimElement(tag),
  createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
  documentElement: new ShimElement('html'),
  body,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  activeElement: null,
  querySelector: () => null,
};
const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
// Тост не должен сам исчезать в тесте — считаем показанные уведомления.
win['setTimeout'] = () => 1;
win['clearTimeout'] = () => undefined;
win['addEventListener'] = () => undefined;
win['removeEventListener'] = () => undefined;
/* eslint-enable @typescript-eslint/no-explicit-any */

import {
  clearDraftsFor,
  createDraftMirror,
  findDraft,
  retryPendingDrafts,
  saveDraft,
  type DraftRecord,
  type DraftStatus,
} from '../src/renderer/drafts.js';

const NET = 'c4f9a3b2-1111-2222-3333-444455556666';
const OTHER_NET = 'c4f9a3b2-1111-2222-3333-444455556677';
const COMMENT_ID = '44444444-5555-6666-7777-888888888888';

interface Row {
  id: string;
  networkId: string;
  entityType: string;
  entityId: string;
  field: string;
  value: string | null;
  baseVersion: number | null;
  status: DraftStatus;
  createdAt: string;
}

/** Наблюдаемые вызовы серверной/локальной стороны. */
interface Harness {
  rows: Row[];
  updateVersions: number[];
  /** Сколько раз `comments.update` намеренно упал конфликтом. */
  conflictOnce: boolean;
  /** Сколько раз `draftSetStatus` вызван. */
  statusCalls: number;
  setRow(input: {
    entityType: string;
    entityId: string;
    field: string;
    value: string;
    baseVersion: number | null;
    status?: DraftStatus;
    networkId?: string;
  }): Row;
}

/** Ставит дублёр `window.etn` с хранилищем черновиков по ключу поля. */
function installHarness(): Harness {
  const harness: Harness = {
    rows: [],
    updateVersions: [],
    conflictOnce: false,
    statusCalls: 0,
    setRow(input) {
      const networkId = input.networkId ?? NET;
      const hit = harness.rows.find(
        (r) =>
          r.networkId === networkId &&
          r.entityType === input.entityType &&
          r.entityId === input.entityId &&
          r.field === input.field,
      );
      if (hit !== undefined) {
        hit.value = input.value;
        hit.baseVersion = input.baseVersion;
        hit.status = input.status ?? 'pending';
        return hit;
      }
      const row: Row = {
        id: `draft-${harness.rows.length + 1}`,
        networkId,
        entityType: input.entityType,
        entityId: input.entityId,
        field: input.field,
        value: input.value,
        baseVersion: input.baseVersion,
        status: input.status ?? 'pending',
        createdAt: '2026-10-23T00:00:00.000Z',
      };
      harness.rows.push(row);
      return row;
    },
  };

  const api = {
    ui: {
      draftSave: async (input: {
        networkId: string;
        entityType: string;
        entityId: string;
        field: string;
        value: string;
        baseVersion: number | null;
      }) => {
        return harness.setRow({ ...input, status: 'pending' }).id;
      },
      draftList: async (networkId: string, filter?: 'pending' | 'conflict' | 'all') => {
        const effective = filter ?? 'pending';
        return harness.rows
          .filter(
            (r) =>
              r.networkId === networkId && (effective === 'all' || r.status === effective),
          )
          .map(
            (r): DraftRecord => ({
              id: r.id,
              networkId: r.networkId,
              entityType: r.entityType,
              entityId: r.entityId,
              field: r.field,
              value: r.value,
              baseVersion: r.baseVersion,
              status: r.status,
              createdAt: r.createdAt,
            }),
          );
      },
      draftDelete: async (id: string) => {
        const at = harness.rows.findIndex((r) => r.id === id);
        if (at >= 0) harness.rows.splice(at, 1);
      },
      draftSetStatus: async (id: string, status: DraftStatus) => {
        harness.statusCalls += 1;
        const row = harness.rows.find((r) => r.id === id);
        if (row !== undefined) row.status = status;
      },
    },
    comments: {
      update: async (
        _networkId: string,
        _commentId: string,
        _patch: { body_md: string },
        expectedVersion: number,
      ) => {
        harness.updateVersions.push(expectedVersion);
        if (harness.conflictOnce) {
          harness.conflictOnce = false;
          throw new EtnError('VERSION_CONFLICT', 'comment version mismatch');
        }
        return { id: COMMENT_ID, version: expectedVersion + 1 };
      },
      create: async () => ({ id: COMMENT_ID, version: 1 }),
    },
    thoughts: {
      update: async () => ({ id: 'thought-1', version: 2 }),
    },
  };
  // `etn` — live-Proxy над `window.etn`; в шиме window уже создан выше, поэтому
  // мост ставим именно туда (плюс в globalThis для прямых тестов).
  (globalThis as unknown as { window: { etn: unknown } }).window.etn = api;
  (globalThis as unknown as { etn: unknown }).etn = api;
  return harness;
}

/** Даёт отработать таймерам зеркала и async-цепочкам досылки. */
async function settleAsync(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function noticeCount(): number {
  return body.children.length;
}

// ---------------------------------------------------------------------------
// 1. Набор → успешная отправка → черновик удалён
// ---------------------------------------------------------------------------

test('pending-черновик уходит по connect и удаляется после успешной отправки', async () => {
  const h = installHarness();
  await saveDraft({
    networkId: NET,
    entityType: 'comment',
    entityId: COMMENT_ID,
    field: 'body_md',
    value: 'ТЕКСТ ПРАВКИ',
    baseVersion: 3,
  });
  assert.equal(h.rows.length, 1);

  await retryPendingDrafts(NET);

  assert.deepEqual(h.updateVersions, [3], 'черновик отправлен с версией-основой');
  assert.equal(h.rows.length, 0, 'успешная отправка удалила черновик');
});

// ---------------------------------------------------------------------------
// 2. Набор → закрытие сессии → досылка при connect
// ---------------------------------------------------------------------------

test('первый connect сессии досылает pending-черновик прошлого запуска', async () => {
  const h = installHarness();
  // Прошлый запуск: пользователь набрал текст и закрыл клиент.
  h.setRow({
    entityType: 'comment',
    entityId: COMMENT_ID,
    field: 'body_md',
    value: 'ЧЕРНОВИК ПРОШЛОЙ СЕССИИ',
    baseVersion: 5,
  });

  // Сеть подключилась: статусов ещё не было → любой переход в `connected`
  // считается досылкой (в т.ч. первый в сессии).
  const { store } = await import('../src/renderer/state.js');
  const { initDrafts } = await import('../src/renderer/drafts.js');
  const networkId = NET;
  store.update({ networkId });
  initDrafts();
  store.update({ rtStatusByNetwork: { [networkId]: 'connecting' }, rtStatus: 'connecting' });
  store.update({ rtStatusByNetwork: { [networkId]: 'connected' }, rtStatus: 'connected' });
  await settleAsync();

  assert.deepEqual(h.updateVersions, [5], 'черновик дослан при подключении');
  assert.equal(h.rows.length, 0, 'успешная досылка удалила черновик');

  // Повторный тот же статус (снапшот) не должен слать повторно.
  store.update({ rtStatusByNetwork: { [networkId]: 'connected' }, rtStatus: 'connected' });
  await settleAsync();
  assert.deepEqual(h.updateVersions, [5], 'повторный снапшот не досылает');
});

// ---------------------------------------------------------------------------
// 3. Конфликт: одна попытка, статус conflict, одно уведомление, текст цел
// ---------------------------------------------------------------------------

test('VERSION_CONFLICT: одна попытка досылки, статус conflict, текст сохранён', async () => {
  const h = installHarness();
  h.setRow({
    entityType: 'comment',
    entityId: COMMENT_ID,
    field: 'body_md',
    value: 'УСТАРЕВШИЙ ТЕКСТ',
    baseVersion: 1,
  });
  h.conflictOnce = true;
  const before = noticeCount();

  await retryPendingDrafts(NET);

  assert.deepEqual(h.updateVersions, [1], 'попытка ровно одна');
  assert.equal(h.rows.length, 1, 'конфликтный черновик НЕ удалён (текст пользователя цел)');
  assert.equal(h.rows[0]!.status, 'conflict', 'черновик помечен конфликтным');
  assert.equal(noticeCount() - before, 1, 'одно внятное уведомление');

  // Следующий connect (и следующий запуск) не повторяет попытку.
  await retryPendingDrafts(NET);
  await retryPendingDrafts(NET);
  assert.deepEqual(h.updateVersions, [1], 'конфликтный черновик исключён из авто-досылки');
  assert.equal(noticeCount() - before, 1, 'уведомление не повторяется');
});

// ---------------------------------------------------------------------------
// 4. Следующая правка переводит conflict → pending с актуальной версией
// ---------------------------------------------------------------------------

test('следующая правка сущности переотправляет черновик с новой версией', async () => {
  const h = installHarness();
  h.setRow({
    entityType: 'comment',
    entityId: COMMENT_ID,
    field: 'body_md',
    value: 'УСТАРЕВШИЙ ТЕКСТ',
    baseVersion: 1,
  });
  h.conflictOnce = true;
  await retryPendingDrafts(NET);
  assert.equal(h.rows[0]!.status, 'conflict');

  // Пользователь правит ту же сущность снова: upsert по ключу возвращает
  // строку в очередь с актуальной версией (5).
  await saveDraft({
    networkId: NET,
    entityType: 'comment',
    entityId: COMMENT_ID,
    field: 'body_md',
    value: 'НОВЫЙ ТЕКСТ',
    baseVersion: 5,
  });
  assert.equal(h.rows.length, 1, 'строка одна (upsert по ключу)');
  assert.equal(h.rows[0]!.status, 'pending');

  await retryPendingDrafts(NET);
  assert.deepEqual(h.updateVersions, [1, 5], 'повторная отправка — с новой версией');
  assert.equal(h.rows.length, 0, 'успешная отправка удалила черновик');
});

// ---------------------------------------------------------------------------
// 5. Сохранение поля вычищает и конфликтные строки (они перекрыты)
// ---------------------------------------------------------------------------

test('clearDraftsFor удаляет все статусы поля по ключу', async () => {
  const h = installHarness();
  h.setRow({
    entityType: 'comment',
    entityId: COMMENT_ID,
    field: 'body_md',
    value: 'КОНФЛИКТ',
    baseVersion: 1,
    status: 'conflict',
  });
  h.setRow({
    entityType: 'comment',
    entityId: 'another-comment',
    field: 'body_md',
    value: 'ЧУЖОЕ',
    baseVersion: 1,
  });

  await clearDraftsFor(NET, 'comment', COMMENT_ID);

  assert.equal(h.rows.length, 1, 'удалена только строка своего поля');
  assert.equal(h.rows[0]!.entityId, 'another-comment');
});

test('findDraft не возвращает конфликтный черновик для восстановления в поле', async () => {
  const h = installHarness();
  h.setRow({
    entityType: 'thought',
    entityId: 'thought-1',
    field: 'title',
    value: 'старый заголовок',
    baseVersion: 1,
    status: 'conflict',
  });
  assert.equal(await findDraft(NET, 'thought', 'thought-1'), null);
});

// ---------------------------------------------------------------------------
// 6. Debounce-зеркало: отмена, выгрузка, опоздавшая запись
// ---------------------------------------------------------------------------

const TARGET = {
  networkId: NET,
  entityType: 'comment' as const,
  entityId: COMMENT_ID,
  field: 'body_md',
  baseVersion: 4,
};

test('зеркало: отложенная запись отменяется подтверждённым сохранением', async () => {
  const h = installHarness();
  const mirror = createDraftMirror({ target: () => TARGET, delayMs: 0 });
  mirror.schedule('ТЕКСТ');
  mirror.settle(); // сохранение/отмена до срабатывания debounce
  await settleAsync();
  assert.equal(h.rows.length, 0, 'отменённая запись не пишется');
  assert.equal(await findDraft(NET, 'comment', COMMENT_ID), null);
});

test('зеркало: опоздавшая запись удаляет себя после сохранения', async () => {
  const h = installHarness();
  // Управляемая запись: строка появляется ПОСЛЕ того, как поле уже сохранили.
  // Обёртка-объект: поля, присвоенные в замыкании, TS не сужает до `never`.
  const deferred: { resolve: ((id: string) => void) | null; row: Row | null } = {
    resolve: null,
    row: null,
  };
  (globalThis as unknown as { etn: { ui: Record<string, unknown> } }).etn.ui['draftSave'] =
    async (input: {
      networkId: string;
      entityType: string;
      entityId: string;
      field: string;
      value: string;
      baseVersion: number | null;
    }) => {
      deferred.row = h.setRow({ ...input, status: 'pending' });
      return await new Promise<string>((resolve) => {
        deferred.resolve = (id) => resolve(id);
      });
    };

  const mirror = createDraftMirror({ target: () => TARGET, delayMs: 0 });
  mirror.schedule('ТЕКСТ');
  await settleAsync(); // таймер сработал, запись «в полёте»
  assert.ok(deferred.row !== null, 'запись начата');
  assert.ok(deferred.resolve !== null, 'запись ждёт ответа');
  mirror.settle(); // пользователь сохранил/отменил правку
  deferred.resolve(deferred.row.id); // строка долетела уже после очистки
  await settleAsync();

  assert.equal(h.rows.length, 0, 'опоздавшая строка удалена — вечного черновика нет');
});

test('зеркало: выгрузка редактора не теряет несохранённый текст', async () => {
  const h = installHarness();
  const mirror = createDraftMirror({ target: () => TARGET, delayMs: 5000 });
  mirror.schedule('НЕСОХРАНЁННЫЙ ТЕКСТ');
  mirror.dispose(); // вкладка/панель выгружается до срабатывания debounce
  await settleAsync();

  assert.equal(h.rows.length, 1, 'черновик записан при выгрузке');
  assert.equal(h.rows[0]!.value, 'НЕСОХРАНЁННЫЙ ТЕКСТ');
});

test('зеркало: штатный debounce пишет черновик и отдаёт его id', async () => {
  const h = installHarness();
  let writtenId: string | null = null;
  const mirror = createDraftMirror({
    target: () => TARGET,
    delayMs: 0,
    onWritten: (id) => {
      writtenId = id;
    },
  });
  mirror.schedule('ТЕКСТ');
  await settleAsync();

  assert.equal(h.rows.length, 1);
  assert.equal(writtenId, h.rows[0]!.id, 'id отдан для адресной очистки после отправки');
});

// ---------------------------------------------------------------------------
// 7. Чужая сеть не попадает в досылку своей
// ---------------------------------------------------------------------------

test('retryPendingDrafts досылает только черновики запрошенной сети', async () => {
  const h = installHarness();
  h.setRow({
    entityType: 'comment',
    entityId: COMMENT_ID,
    field: 'body_md',
    value: 'СВОЯ СЕТЬ',
    baseVersion: 2,
  });
  h.setRow({
    entityType: 'comment',
    entityId: COMMENT_ID,
    field: 'body_md',
    value: 'ЧУЖАЯ СЕТЬ',
    baseVersion: 9,
    networkId: OTHER_NET,
  });

  await retryPendingDrafts(NET);

  assert.deepEqual(h.updateVersions, [2], 'отправлена только своя сеть');
  assert.equal(h.rows.length, 1, 'черновик чужой сети не тронут');
  assert.equal(h.rows[0]!.networkId, OTHER_NET);
});

// ---------------------------------------------------------------------------
// 8. Проводка «программная замена текста — не набор пользователя»
//
// Настоящий CodeMirror `EditorView` в headless-шиме не поднимается (та же
// причина, что у сторожей `guard-comment-*`), поэтому связь «откат по Esc →
// onInput → черновик» проверяется по исходнику: удаление `silent` возвращает
// мёртвый черновик сохранённого текста — корень ошибки 5726744b.
// ---------------------------------------------------------------------------

test('программная замена текста поля не уходит в черновики (silent setValue)', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const field = fs.readFileSync(
    path.join(here, '../src/renderer/editor/markdown-field.ts'),
    'utf8',
  );
  const editor = fs.readFileSync(
    path.join(here, '../src/renderer/editor/md-editor.ts'),
    'utf8',
  );
  const checks: Array<[boolean, string]> = [
    [
      field.includes('editor.setValue(currentMd, true)'),
      'откат/возврат к сохранённому тексту — silent',
    ],
    [field.includes('editor.setValue(md, true)'), 'внешнее обновление текста — silent'],
    [
      /if \(!suppressInput\) cb\.onInput\?\.\(md\)/.test(editor),
      'программная замена документа не зовёт onInput',
    ],
  ];
  for (const [ok, what] of checks) assert.ok(ok, what);
});


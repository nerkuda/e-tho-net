/**
 * Жизненный цикл черновиков правок (ошибки 5726744b, fb9d6058).
 *
 * Симптом заказчика: при запуске клиента сразу появляется «Черновик не
 * отправлен: comment version mismatch» и повторяется на каждом запуске.
 *
 * Проверяются обязательства исправления:
 * 1. набор → досылка: успешная отправка удаляет черновик;
 * 2. набор в ТЕКУЩЕЙ сессии → первый `connected` досылает накопленное (H19,
 *    п.6 решений fb9d6058). Черновики прошлых запусков сюда уже не попадают:
 *    их удаляет main сразу после открытия local.db (чистка при старте);
 * 3. первая же `VERSION_CONFLICT` переводит черновик в `conflict`: он больше
 *    не отправляется на следующие connect'ы, уведомление — одно, текст цел;
 * 4. конфликтный черновик не удаляется автоматически, а следующая правка
 *    переводит его обратно в `pending` с актуальной версией — и он уходит;
 * 5. `NOT_FOUND` переводит черновик в терминальный `failed` (fb9d6058):
 *    ретраев больше нет, сообщение одно агрегированное на волну, текст цел до
 *    чистки при следующем запуске. Прочие ошибки остаются ретраибельными;
 * 6. стартовое сообщение о чистке черновиков прошлой сессии показывается один
 *    раз и очищает ключ `client_meta` (п.5 решений fb9d6058);
 * 7. поздно пришедшая запись debounce после сохранения/отмены удаляет себя
 *    (источник «вечного» черновика с устаревшей baseVersion).
 */

import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { CLIENT_META_KEY, EtnError } from '@etn/shared';

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
  reportStartupPurge,
  retryPendingDrafts,
  saveDraft,
  type DraftRecord,
  type DraftStatus,
} from '../src/renderer/drafts.js';

// Тосты живут в общем body: чистим стек между тестами, иначе дедупликация
// (28d22b8a) засчитает повтор того же текста как обновление старого тоста.
beforeEach(() => {
  body.replaceChildren();
});

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
  /** Код ошибки, которым падает `comments.update` (`null` — успех). */
  updateErrorCode: string | null;
  /** Код ошибки, которым падает `comments.create` (`null` — успех). */
  createErrorCode: string | null;
  /** `client_meta` (стартовое сообщение о чистке черновиков). */
  meta: Record<string, string>;
  /** Сколько раз `draftSetStatus` вызван. */
  statusCalls: number;
  /** `comments.create` отвергает создание: постоянный комментарий уже есть. */
  permanentExists: boolean;
  /** Текст существующего постоянного комментария; `null` — чтение его не видит. */
  permanentBody: string | null;
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
    updateErrorCode: null,
    createErrorCode: null,
    meta: {},
    statusCalls: 0,
    permanentExists: false,
    permanentBody: null,
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
    meta: {
      get: async (key: string) => harness.meta[key] ?? null,
      set: async (key: string, value: string) => {
        harness.meta[key] = value;
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
        if (harness.updateErrorCode !== null) {
          throw new EtnError(harness.updateErrorCode as never, 'server rejected the write');
        }
        return { id: COMMENT_ID, version: expectedVersion + 1 };
      },
      create: async () => {
        if (harness.createErrorCode !== null) {
          throw new EtnError(harness.createErrorCode as never, 'server rejected the create');
        }
        if (harness.permanentExists) {
          throw new EtnError('DUPLICATE', 'a permanent comment already exists for this owner');
        }
        return { id: COMMENT_ID, version: 1 };
      },
      list: async () =>
        harness.permanentBody === null
          ? []
          : [
              {
                id: COMMENT_ID,
                kind: 'permanent',
                body_md: harness.permanentBody,
                body_html: '',
                version: 9,
              },
            ],
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

/** Число важных сообщений в стеке тостов (0 — сообщений нет).
 *  С 0.14.1 (задача 28d22b8a) тосты живут в контейнере `.notice-stack`, а
 *  рутинные подтверждения уходят в статус-бар и здесь не считаются. */
function noticeCount(): number {
  const stack = body.children.find((child) => child.classList.contains('notice-stack'));
  return stack?.childElementCount ?? 0;
}

/** Тексты тостов в стеке (для проверки формулировок и отсутствия UUID). */
function noticeTexts(): string[] {
  const stack = body.children.find((child) => child.classList.contains('notice-stack'));
  if (stack === undefined) return [];
  return stack.children.map((box) => box.children.map((child) => child.textContent).join(' '));
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
// 2. Набор в этой сессии → первый connect — досылка
//
// С fb9d6058 (решение пользователя 2026-10-29) черновики ПРОШЛЫХ запусков не
// доживают до connect: их удаляет main сразу после открытия local.db. Первый
// `connected` сессии досылает строки, набранные в ТЕКУЩЕЙ сессии, пока сеть
// была `connecting`/`suspect` (сохранение блокируется, зеркало дебаунса
// пишет). Кейс ниже моделирует именно это.
// ---------------------------------------------------------------------------

test('первый connect сессии досылает pending-черновик текущей сессии', async () => {
  const h = installHarness();
  // Сеть ещё `connecting`: пользователь набрал текст, сохранение заблокировано,
  // debounce-зеркало записало черновик этой сессии.
  h.setRow({
    entityType: 'comment',
    entityId: COMMENT_ID,
    field: 'body_md',
    value: 'ЧЕРНОВИК ТЕКУЩЕЙ СЕССИИ',
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

  // Черновик, набранный в окне пробы живости: подтверждённая проба — досыл
  // (351068ed п.1). Иначе текст остаётся pending до реального обрыва и
  // удаляется при следующем запуске, хотя пользователь видел «отправится
  // после восстановления связи».
  h.setRow({
    entityType: 'comment',
    entityId: COMMENT_ID,
    field: 'body_md',
    value: 'ЧЕРНОВИК ИЗ ОКНА ПРОБЫ',
    baseVersion: 6,
  });
  store.update({ rtStatusByNetwork: { [networkId]: 'suspect' }, rtStatus: 'suspect' });
  store.update({ rtStatusByNetwork: { [networkId]: 'connected' }, rtStatus: 'connected' });
  await settleAsync();

  assert.deepEqual(h.updateVersions, [5, 6], 'черновик, набранный в окне suspect, дослан');
  assert.equal(h.rows.length, 0, 'подтверждённая проба очистила очередь');
});

test('перекрывающиеся волны досыла: одна отправка на сеть, без ложного conflict', async () => {
  const h = installHarness();
  h.setRow({
    entityType: 'comment',
    entityId: COMMENT_ID,
    field: 'body_md',
    value: 'ТЕКСТ ПОД ГОНКОЙ',
    baseVersion: 3,
  });
  // Сервер эмулирует запись: строка, удалённая первой волной, для второй
  // выглядит «уже не той версии» — ответ VERSION_CONFLICT.
  const api = (globalThis as unknown as { window: { etn: { comments: { update: unknown } } } })
    .window.etn.comments;
  const originalUpdate = api.update as (...args: unknown[]) => Promise<unknown>;
  let updates = 0;
  api.update = async (...args: unknown[]) => {
    updates += 1;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    if (h.rows.length === 0) throw new EtnError('VERSION_CONFLICT', 'comment version mismatch');
    return originalUpdate(...args);
  };
  const before = noticeCount();

  // Два `connected` подряд (второй — снапшот/повторный кадр) порождают две
  // волны в одном тике. Вторая обязана не отправлять устаревший снимок.
  await Promise.all([retryPendingDrafts(NET), retryPendingDrafts(NET)]);

  assert.equal(updates, 1, 'вторая волна не отправляет уже удалённую строку');
  assert.equal(noticeCount() - before, 0, 'ложного «запись изменена в другом месте» нет');
  assert.equal(h.rows.length, 0, 'черновик отправлен и удалён');
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

// ---------------------------------------------------------------------------
// 9. Досылка создания постоянного комментария после обрыва связи
//    (ошибка ecdb2e7a)
//
// Обрыв ПОСЛЕ того, как сервер создал комментарий, но ДО того, как клиент
// получил ответ, оставляет pending-черновик `comment-new`. Повторный `create`
// на восстановлении связи получает `DUPLICATE`; досылка обязана усыновить
// существующий комментарий, а не повторять отказ на каждом переподключении.
// ---------------------------------------------------------------------------

/** Ряд черновика создания постоянного комментария (текст — JSON). */
function commentNewDraft(h: Harness, bodyMd: string, ownerId = 'thought-1'): Row {
  return h.setRow({
    entityType: 'comment-new',
    entityId: ownerId,
    field: 'body_md',
    value: JSON.stringify({ ownerType: 'thought', ownerId, bodyMd }),
    baseVersion: null,
  });
}

test('DUPLICATE при досылке comment-new: сервер хранит тот же текст — черновик выполнен', async () => {
  const h = installHarness();
  commentNewDraft(h, 'НАБРАННЫЙ ТЕКСТ');
  // Сервер уже создал комментарий с ровно этим текстом — ответ потерялся.
  h.permanentExists = true;
  h.permanentBody = 'НАБРАННЫЙ ТЕКСТ';
  const before = noticeCount();

  await retryPendingDrafts(NET);

  assert.equal(h.rows.length, 0, 'черновик выполнен и удалён');
  assert.equal(noticeCount() - before, 0, 'пользователю нечего сообщать');
  assert.deepEqual(h.updateVersions, [], 'лишняя запись не понадобилась');
});

test('DUPLICATE при досылке comment-new: серверный текст другой — conflict, одно уведомление', async () => {
  const h = installHarness();
  commentNewDraft(h, 'МОЙ ТЕКСТ');
  h.permanentExists = true;
  h.permanentBody = 'ЧУЖОЙ ТЕКСТ';
  const before = noticeCount();

  await retryPendingDrafts(NET);

  assert.equal(h.rows.length, 1, 'текст пользователя не потерян');
  assert.equal(h.rows[0]!.status, 'conflict', 'расхождение не затирается молча');
  assert.equal(h.rows[0]!.value, JSON.stringify({ ownerType: 'thought', ownerId: 'thought-1', bodyMd: 'МОЙ ТЕКСТ' }));
  assert.equal(noticeCount() - before, 1, 'одно внятное уведомление');

  // Следующие connect'ы не повторяют ни попытку, ни уведомление.
  await retryPendingDrafts(NET);
  await retryPendingDrafts(NET);
  assert.equal(noticeCount() - before, 1, 'уведомление не повторяется');
});

test('DUPLICATE при досылке comment-new: комментарий не читается — черновик ждёт связи', async () => {
  const h = installHarness();
  commentNewDraft(h, 'МОЙ ТЕКСТ');
  h.permanentExists = true;
  h.permanentBody = null; // list вернул пусто: слой/гонка — усыновлять нечего
  const before = noticeCount();

  await retryPendingDrafts(NET);

  assert.equal(h.rows.length, 1, 'черновик остался');
  assert.equal(h.rows[0]!.status, 'pending', 'не помечен конфликтным — попытка повторится');
  assert.equal(noticeCount() - before, 1, 'исходный отказ показан один раз');
});

test('обрыв связи в момент усыновления: черновик остаётся pending, цикл остановлен', async () => {
  const h = installHarness();
  commentNewDraft(h, 'МОЙ ТЕКСТ');
  h.permanentExists = true;
  h.permanentBody = 'ЧУЖОЙ ТЕКСТ';
  // Второй (и последний) черновик не должен отправляться после обрыва.
  commentNewDraft(h, 'ВТОРОЙ', 'thought-2');
  const api = (globalThis as unknown as { window: { etn: { comments: { list: unknown } } } }).window
    .etn.comments;
  api.list = async () => {
    throw new EtnError('INTERNAL', 'server unavailable', { kind: 'connection-lost' });
  };
  const before = noticeCount();

  await retryPendingDrafts(NET);

  assert.equal(h.rows.length, 2, 'ни один черновик не потерян');
  assert.equal(noticeCount() - before, 1, 'одно уведомление об обрыве');
});

// ---------------------------------------------------------------------------
// 10. NOT_FOUND — терминальный статус failed (ошибка fb9d6058)
//
// Цель черновика удалена (или существует только в другом слое): повтор на
// каждом connect — вечный цикл и серия «Черновик не отправлен: … not found».
// Терминален ТОЛЬКО NOT_FOUND; прочие ошибки остаются ретраибельными.
// ---------------------------------------------------------------------------

test('NOT_FOUND: черновик становится терминальным failed, больше не ретраится, текст цел', async () => {
  const h = installHarness();
  h.setRow({
    entityType: 'comment',
    entityId: COMMENT_ID,
    field: 'body_md',
    value: 'ТЕКСТ В УДАЛЁННЫЙ КОММЕНТАРИЙ',
    baseVersion: 2,
  });
  h.updateErrorCode = 'NOT_FOUND';
  const before = noticeCount();

  await retryPendingDrafts(NET);

  assert.deepEqual(h.updateVersions, [2], 'попытка ровно одна');
  assert.equal(h.rows.length, 1, 'текст пользователя не потерян');
  assert.equal(h.rows[0]!.status, 'failed', 'терминальный статус failed');
  assert.equal(h.rows[0]!.value, 'ТЕКСТ В УДАЛЁННЫЙ КОММЕНТАРИЙ', 'value не тронут');
  assert.equal(noticeCount() - before, 1, 'одно агрегированное уведомление');
  const text = noticeTexts().at(-1) ?? '';
  assert.ok(text.includes('1 черновик'), `счётчик в сообщении: ${text}`);
  assert.ok(!text.includes(COMMENT_ID), `без UUID: ${text}`);
  assert.ok(!/not found/i.test(text), `без серверного английского: ${text}`);

  // Следующие connect'ы не повторяют ни попытку, ни уведомление: строка
  // вышла из очереди `pending`.
  h.updateErrorCode = null;
  await retryPendingDrafts(NET);
  await retryPendingDrafts(NET);
  assert.deepEqual(h.updateVersions, [2], 'failed исключён из авто-досылки');
  assert.equal(h.rows[0]!.status, 'failed', 'статус не откатился');
  assert.equal(noticeCount() - before, 1, 'уведомление не повторяется');
});

test('NOT_FOUND: одно сообщение на волну со счётчиком всех недостижимых черновиков', async () => {
  const h = installHarness();
  h.setRow({
    entityType: 'comment',
    entityId: COMMENT_ID,
    field: 'body_md',
    value: 'ПЕРВЫЙ',
    baseVersion: 1,
    networkId: NET,
  });
  h.setRow({
    entityType: 'comment',
    entityId: 'another-comment',
    field: 'body_md',
    value: 'ВТОРОЙ',
    baseVersion: 1,
    networkId: NET,
  });
  h.updateErrorCode = 'NOT_FOUND';
  const before = noticeCount();

  await retryPendingDrafts(NET);

  assert.equal(h.rows.filter((r) => r.status === 'failed').length, 2, 'обе строки терминальны');
  assert.equal(noticeCount() - before, 1, 'ровно одно сообщение на волну');
  assert.ok(
    (noticeTexts().at(-1) ?? '').includes('2 черновика'),
    `счётчик и форма слова: ${noticeTexts().at(-1) ?? ''}`,
  );
});

test('NOT_FOUND при создании comment-new: цель удалена — терминальный failed', async () => {
  const h = installHarness();
  commentNewDraft(h, 'НАБРАННЫЙ ТЕКСТ');
  h.createErrorCode = 'NOT_FOUND';
  const before = noticeCount();

  await retryPendingDrafts(NET);

  assert.equal(h.rows.length, 1, 'текст не потерян');
  assert.equal(h.rows[0]!.status, 'failed', 'терминальный статус');
  assert.equal(noticeCount() - before, 1, 'одно сообщение');
});

test('обрыв связи после терминального черновика: агрегат показан до выхода из волны', async () => {
  const h = installHarness();
  // Первый черновик терминален (цель удалена), на втором связь обрывается.
  h.setRow({
    entityType: 'comment',
    entityId: COMMENT_ID,
    field: 'body_md',
    value: 'УДАЛЁННАЯ ЦЕЛЬ',
    baseVersion: 1,
  });
  h.setRow({
    entityType: 'comment',
    entityId: 'comment-after-lost',
    field: 'body_md',
    value: 'НЕ ОТПРАВЛЯЛСЯ',
    baseVersion: 1,
  });
  const api = (globalThis as unknown as { window: { etn: { comments: { update: unknown } } } }).window
    .etn.comments;
  let calls = 0;
  api.update = async () => {
    calls += 1;
    if (calls === 1) throw new EtnError('NOT_FOUND', 'comment not found');
    throw new EtnError('INTERNAL', 'server unavailable', { kind: 'connection-lost' });
  };
  const before = noticeCount();

  await retryPendingDrafts(NET);

  assert.equal(h.rows[0]!.status, 'failed', 'терминальный черновик помечен до обрыва');
  assert.equal(h.rows[1]!.status, 'pending', 'второй черновик остался в очереди');
  assert.equal(noticeCount() - before, 2, 'сбой волны и агрегат о недоступных');
  assert.ok(
    noticeTexts().some((text) => text.includes('запись недоступна')),
    `агрегат показан перед выходом: ${noticeTexts().join(' | ')}`,
  );
});

test('прочие ошибки остаются ретраибельными: VALIDATION_ERROR не терминален', async () => {
  const h = installHarness();
  h.setRow({
    entityType: 'comment',
    entityId: COMMENT_ID,
    field: 'body_md',
    value: 'ТЕКСТ',
    baseVersion: 1,
  });
  h.updateErrorCode = 'VALIDATION_ERROR';
  const before = noticeCount();

  await retryPendingDrafts(NET);

  assert.equal(h.rows.length, 1, 'черновик остался');
  assert.equal(h.rows[0]!.status, 'pending', 'не терминален — попытка повторится');
  assert.equal(noticeCount() - before, 1, 'сбой показан (drafts.retry.failed)');
  // Пользовательский текст — русский (351068ed п.7): серверное сообщение
  // `server rejected the write` адресовано API и в тосте не показывается.
  const text = noticeTexts().at(-1) ?? '';
  assert.ok(!text.includes('server rejected the write'), `без серверного английского: ${text}`);
  assert.ok(text.includes('отклонил'), `русская формулировка: ${text}`);

  // Причина исчезла — следующая волна досылает тот же черновик.
  h.updateErrorCode = null;
  await retryPendingDrafts(NET);
  assert.deepEqual(h.updateVersions, [1, 1], 'повторная попытка состоялась');
  assert.equal(h.rows.length, 0, 'успешная отправка удалила черновик');
});

// ---------------------------------------------------------------------------
// 10а. Неисправимые локальные дефекты черновика (351068ed п.8)
//
// Битый JSON-конверт `comment-new` и неизвестный `entityType` не могут стать
// отправляемыми ни при каком восстановлении связи. Раньше они бросали на
// каждом connect: вечный ретрай и технический английский в тосте. Теперь это
// терминальный `failed` с одним русским сообщением на волну.
// ---------------------------------------------------------------------------

test('битый JSON comment-new: терминальный failed, одно русское сообщение, без ретрая', async () => {
  const h = installHarness();
  // Синтаксически битый конверт.
  h.setRow({
    entityType: 'comment-new',
    entityId: 'thought-1',
    field: 'body_md',
    value: '{"ownerType":"thought",',
    baseVersion: null,
  });
  // Синтаксически валидный, но структурно непригодный (неизвестный владелец).
  h.setRow({
    entityType: 'comment-new',
    entityId: 'thought-2',
    field: 'body_md',
    value: JSON.stringify({ ownerType: 'planet', ownerId: 'thought-2', bodyMd: 'ТЕКСТ' }),
    baseVersion: null,
  });
  const before = noticeCount();

  await retryPendingDrafts(NET);

  assert.equal(h.rows.filter((r) => r.status === 'failed').length, 2, 'обе строки терминальны');
  assert.equal(noticeCount() - before, 1, 'одно сообщение на волну');
  const text = noticeTexts().at(-1) ?? '';
  assert.ok(!/Unexpected|JSON|SyntaxError/i.test(text), `без технического английского: ${text}`);
  assert.ok(text.includes('поврежд'), `русская формулировка: ${text}`);
  assert.ok(text.includes('2 черновика'), `счётчик и форма слова: ${text}`);

  // Следующие connect'ы не повторяют ни попытку, ни сообщение.
  await retryPendingDrafts(NET);
  assert.equal(h.rows.filter((r) => r.status === 'failed').length, 2, 'статус не откатился');
  assert.equal(noticeCount() - before, 1, 'вечного ретрая нет');
});

test('неизвестный тип черновика: терминальный failed, без вечного ретрая', async () => {
  const h = installHarness();
  h.setRow({
    entityType: 'mystery',
    entityId: 'some-id',
    field: 'some-field',
    value: 'ТЕКСТ',
    baseVersion: null,
  });
  const before = noticeCount();

  await retryPendingDrafts(NET);

  assert.equal(h.rows[0]!.status, 'failed', 'неизвестный тип терминален');
  assert.equal(noticeCount() - before, 1, 'одно сообщение');
  const text = noticeTexts().at(-1) ?? '';
  assert.ok(text.includes('поврежд'), `русская формулировка: ${text}`);

  await retryPendingDrafts(NET);
  assert.equal(noticeCount() - before, 1, 'повторно не сообщается');
});

// ---------------------------------------------------------------------------
// 11. Стартовое сообщение о чистке черновиков прошлой сессии (fb9d6058, п.5)
//
// Пурж делает main до создания окна; renderer получает счётчик через
// client_meta, показывает ОДНО сообщение и очищает ключ.
// ---------------------------------------------------------------------------

test('стартовое сообщение о чистке черновиков: один раз, со счётчиком, ключ очищен', async () => {
  const h = installHarness();
  h.meta[CLIENT_META_KEY.DRAFTS_PURGED_COUNT] = '2';
  const before = noticeCount();

  await reportStartupPurge();

  assert.equal(noticeCount() - before, 1, 'одно стартовое сообщение');
  const text = noticeTexts().at(-1) ?? '';
  assert.ok(text.includes('2 черновика'), `счётчик и форма слова: ${text}`);
  assert.equal(
    h.meta[CLIENT_META_KEY.DRAFTS_PURGED_COUNT],
    '',
    'ключ очищен — при следующем старте сообщения нет',
  );

  await reportStartupPurge();
  assert.equal(noticeCount() - before, 1, 'повторно не показывается');
});

test('нулевой/пустой счётчик чистки — сообщения нет', async () => {
  const h = installHarness();
  const before = noticeCount();
  await reportStartupPurge();
  assert.equal(noticeCount() - before, 0, 'без счётчика — тишина');

  h.meta[CLIENT_META_KEY.DRAFTS_PURGED_COUNT] = '0';
  await reportStartupPurge();
  assert.equal(noticeCount() - before, 0, 'ноль — тишина');
});


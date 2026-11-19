/**
 * MCP-фасад задач (0.16.1, задача f34066e1, операция 22f1ea95).
 *
 * Два предмета проверки:
 *   * действия `tasks.*` исполнителя `etn.ops` повторяют REST GET/PATCH
 *     `/tasks` без роста ростера инструментов (ADR 43abd7dd): выборка
 *     материализованной проекции, toggle/move/cancel с `expected_revision` →
 *     `VERSION_CONFLICT`, массовые `cancelAll`/`moveAll` только с `confirm`,
 *     штатное `comment.updated` и эхо слоя;
 *   * блоки `meta.open_tasks` / `meta.reminders` карточки мысли — ТОЛЬКО по
 *     флагу `include_task_meta` (по умолчанию выкл), с бюджетами 10+10 и
 *     персональностью напоминаний.
 *
 * Требует нативного better-sqlite3; иначе пропускается.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import type { AnyRealtimeEvent } from '@etn/shared';

import { generateApiKey, hashApiKey } from '../src/auth/api-key.js';
import { OPS_ACTIONS_BY_NAME } from '../src/mcp/tools/ops-catalog.js';
import {
  buildMcpContext,
  callOp,
  closeMcpContext,
  connectMcpClient,
  createThoughtViaWrite,
  nativeAvailable,
  toolJson,
  toolText,
  upsertPermanentViaWrite,
  type McpClientHandle,
  type McpTestContext,
} from './mcp-helpers.js';

/** Строка задачи в выдаче `tasks.list` (паритет с REST `GET /tasks`). */
interface TaskRowJson {
  comment_id: string;
  line_no: number;
  text: string;
  due: string | null;
  period_from: string | null;
  period_to: string | null;
  done: boolean;
  subject_thoughts: string[];
  subject_state: string;
  revision: number;
  parsed_revision: number;
  owner_type: string;
  owner_id: string;
  kind: string;
}

/** Страница `tasks.list`. */
interface TaskPageJson {
  items: TaskRowJson[];
  cursor: string | null;
  total?: number;
  max_revision: number;
}

/** Ответ одиночного или массового действия `tasks.*`. */
interface TaskCommandJson {
  results: Array<{ comment_id: string; line_no: number; ok: boolean; error?: string }>;
  revisions: Array<{ id: string; version: number }>;
  request_id?: string;
  layer?: { id: string; title: string };
}

/** Блоки карточки, которые добавляет `include_task_meta`. */
interface DealsMetaJson {
  open_tasks?: {
    total: number;
    shown: number;
    truncated: boolean;
    items: Array<{
      comment_id: string;
      line_no: number;
      text: string;
      due: string | null;
      period_from: string | null;
      period_to: string | null;
      owner_type: string;
      owner_id: string;
      subject_state: string;
    }>;
  };
  reminders?: {
    total: number;
    shown: number;
    truncated: boolean;
    items: Array<{ id: string; kind: string; next_at: string | null; subject_state: string }>;
  };
}

/** Карточка мысли в объёме, который читают проверки meta. */
interface CardJson {
  id: string;
  meta: DealsMetaJson;
}

/**
 * Постоянный комментарий-источник задач: своя мысль-владелец (чтобы `meta`
 * другая карточка не видела) плюс `upsertPermanentViaWrite` — он возвращает
 * ревизию, которую действия обязаны передавать как `expected_revision`.
 */
async function seedTaskComment(
  handle: McpClientHandle,
  networkId: string,
  bodyMd: string,
): Promise<{ thoughtId: string; commentId: string; version: number }> {
  const owner = await createThoughtViaWrite(handle.client, networkId, {
    title: `Список задач ${randomUUID().slice(0, 8)}`,
  });
  const comment = await upsertPermanentViaWrite(handle.client, networkId, owner.id, bodyMd);
  return { thoughtId: owner.id, commentId: comment.id, version: comment.version };
}

/** Второй участник сети со своим ключом — напоминания персональны. */
async function addMember(ctx: McpTestContext): Promise<{ userId: string; key: string }> {
  const userId = randomUUID();
  ctx.sys.createUser({ id: userId, username: `member-${userId.slice(0, 8)}`, displayName: null });
  const gen = generateApiKey();
  ctx.sys.createApiKey({
    id: randomUUID(),
    userId,
    label: 'member',
    keyHash: hashApiKey(gen.key),
    keyPrefix: gen.keyPrefix,
  });
  ctx.sys.addNetworkMember(ctx.networkId, userId, 'member', ctx.adminId);
  return { userId, key: gen.key };
}

/** Вызвать `tasks.list` и вернуть страницу. */
async function listTasks(
  handle: McpClientHandle,
  networkId: string,
  params: Record<string, unknown> = {},
): Promise<TaskPageJson> {
  const result = await callOp(handle.client, 'tasks.list', { network_id: networkId, ...params });
  assert.equal(result.isError, undefined, toolText(result));
  return toolJson<TaskPageJson>(result);
}

/** Вызвать действие записи задач и вернуть результат (ошибку проверяет вызывающий). */
async function taskCommand(
  handle: McpClientHandle,
  action: string,
  params: Record<string, unknown>,
  confirm = false,
): Promise<TaskCommandJson> {
  const result = await callOp(handle.client, action, params, confirm);
  assert.equal(result.isError, undefined, `${action}: ${toolText(result)}`);
  return toolJson<TaskCommandJson>(result);
}

/** Прочитать `meta` карточки мысли. */
async function cardMeta(
  handle: McpClientHandle,
  networkId: string,
  thoughtId: string,
  includeTaskMeta = false,
): Promise<DealsMetaJson> {
  const result = await handle.client.callTool({
    name: 'etn.thoughts.get',
    arguments: {
      network_id: networkId,
      thought_id: thoughtId,
      ...(includeTaskMeta ? { include_task_meta: true } : {}),
    },
  });
  assert.equal(result.isError, undefined, toolText(result));
  return toolJson<CardJson>(result).meta;
}

describe('MCP etn.tasks.* и meta карточки (22f1ea95)', { skip: !nativeAvailable() }, () => {
  it('tasks.list: проекция, scope/count, thought_id, keyset и «сегодня» от клиента', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const subject = await createThoughtViaWrite(handle.client, ctx.networkId, {
          title: 'Предмет задач',
        });
        const seeded = await seedTaskComment(
          handle,
          ctx.networkId,
          `- [ ] A [[2026-11-20]] [[#${subject.id}]]\n- [ ] B [[2026-11-21]]\n- [x] C [[2026-11-22]]`,
        );

        const open = await listTasks(handle, ctx.networkId, { scope: 'open' });
        assert.deepEqual(
          open.items.map((row) => row.line_no),
          [0, 1],
        );
        assert.equal(open.items[0]!.text, `A [[2026-11-20]] [[#${subject.id}]]`);
        assert.equal(open.items[0]!.comment_id, seeded.commentId);
        assert.equal(open.total, undefined, 'COUNT без флага не отдаётся');

        const counted = await listTasks(handle, ctx.networkId, { scope: 'open', count: true });
        assert.equal(counted.total, 2);

        const bySubject = await listTasks(handle, ctx.networkId, {
          thought_id: subject.id,
          scope: 'open',
        });
        assert.equal(bySubject.items.length, 1, 'субъект отбирает только свою строку');
        // Автосубъекты (уточнение 2026-11-16): строка постоянного комментария
        // адресована и владельцу-мысли, и ID-ссылке строки (владелец — первый).
        assert.deepEqual(bySubject.items[0]!.subject_thoughts, [seeded.thoughtId, subject.id]);
        assert.equal(bySubject.items[0]!.due, '2026-11-20');

        const done = await listTasks(handle, ctx.networkId, { scope: 'done' });
        assert.deepEqual(
          done.items.map((row) => row.line_no),
          [2],
        );

        const first = await listTasks(handle, ctx.networkId, { scope: 'open', limit: 1 });
        assert.equal(first.items.length, 1);
        assert.ok(first.cursor !== null, 'у страницы есть курсор продолжения');
        const second = await listTasks(handle, ctx.networkId, {
          scope: 'open',
          limit: 1,
          cursor: first.cursor!,
        });
        assert.deepEqual(
          second.items.map((row) => row.line_no),
          [1],
          'keyset продолжает страницу без дублей',
        );

        // Просрочка считается по часам клиента: без `today` — отказ.
        const noToday = await callOp(handle.client, 'tasks.list', {
          network_id: ctx.networkId,
          scope: 'overdue',
        });
        assert.equal(noToday.isError, true);
        assert.match(toolText(noToday), /BAD_REQUEST/);
        // Некалендарная дата (форма верна, месяца/дня нет) — VALIDATION_ERROR,
        // а не молчаливая пустая выборка (ошибка 47600057).
        const badFrom = await callOp(handle.client, 'tasks.list', {
          network_id: ctx.networkId,
          from: '2026-13-45',
        });
        assert.equal(badFrom.isError, true);
        assert.match(toolText(badFrom), /VALIDATION_ERROR/);
        const overdue = await listTasks(handle, ctx.networkId, {
          scope: 'overdue',
          today: '2026-11-21',
        });
        assert.deepEqual(
          overdue.items.map((row) => row.line_no),
          [0],
        );

        // `max_revision` — маркер сети; чтение его не двигает.
        const again = await listTasks(handle, ctx.networkId);
        assert.equal(again.max_revision, counted.max_revision);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('tasks.toggle: новая ревизия и comment.updated; устаревшая ревизия — VERSION_CONFLICT без записи', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const seeded = await seedTaskComment(
          handle,
          ctx.networkId,
          '- [ ] Позвонить [[2026-12-01]]',
        );
        const events: AnyRealtimeEvent[] = [];
        ctx.pubsub.subscribe(ctx.networkId, (event) => {
          events.push(event as unknown as AnyRealtimeEvent);
        });

        const toggled = await taskCommand(handle, 'tasks.toggle', {
          network_id: ctx.networkId,
          comment_id: seeded.commentId,
          line_no: 0,
          expected_revision: seeded.version,
        });
        assert.deepEqual(toggled.results, [{ comment_id: seeded.commentId, line_no: 0, ok: true }]);
        assert.equal(toggled.revisions.length, 1);
        assert.equal(toggled.revisions[0]!.id, seeded.commentId);
        assert.equal(toggled.revisions[0]!.version, seeded.version + 1);
        assert.ok(toggled.request_id !== undefined, 'ответ помечен request_id');
        assert.ok(toggled.layer !== undefined, 'запись возвращает эхо слоя');

        const updated = events.filter((event) => event.type === 'comment.updated');
        assert.equal(updated.length, 1, 'одно событие на правку источника');
        assert.match(
          (updated[0]!.data as { changes: { body_md: string } }).changes.body_md,
          /- \[x\] Позвонить/,
        );

        const stale = await callOp(handle.client, 'tasks.toggle', {
          network_id: ctx.networkId,
          comment_id: seeded.commentId,
          line_no: 0,
          expected_revision: seeded.version,
        });
        assert.equal(stale.isError, true);
        assert.match(toolText(stale), /VERSION_CONFLICT/);

        // Ничего не записано: ревизия и состояние — от успешного действия.
        const page = await listTasks(handle, ctx.networkId, { comment_id: seeded.commentId });
        assert.equal(page.items[0]!.revision, seeded.version + 1);
        assert.equal(page.items[0]!.done, true);
      } finally {
        await handle.close();
      }

      // Классификация реестра: список читающий, правка — нет.
      const readOnly = await connectMcpClient(ctx, ctx.readOnlyKey);
      try {
        const denied = await callOp(readOnly.client, 'tasks.toggle', {
          network_id: ctx.networkId,
          comment_id: 'нет-такого',
          line_no: 0,
          expected_revision: 1,
        });
        assert.equal(denied.isError, true);
        assert.match(toolText(denied), /FORBIDDEN/);
        const read = await callOp(readOnly.client, 'tasks.list', { network_id: ctx.networkId });
        assert.equal(read.isError, undefined, toolText(read));
      } finally {
        await readOnly.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('tasks.move и tasks.cancel: сдвиг всех дат строки, снятие маркера, отказы строк в results', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const seeded = await seedTaskComment(
          handle,
          ctx.networkId,
          '- [ ] Отчёт [[2026-01-31]]\n- [ ] Без дат',
        );

        const moved = await taskCommand(handle, 'tasks.move', {
          network_id: ctx.networkId,
          comment_id: seeded.commentId,
          line_no: 0,
          expected_revision: seeded.version,
          months: 1,
        });
        assert.deepEqual(moved.results, [{ comment_id: seeded.commentId, line_no: 0, ok: true }]);
        const movedVersion = moved.revisions[0]!.version;

        // Строка без date-ссылок: отказ строки, ревизии нет.
        const undated = await taskCommand(handle, 'tasks.move', {
          network_id: ctx.networkId,
          comment_id: seeded.commentId,
          line_no: 1,
          expected_revision: movedVersion,
          days: 1,
        });
        assert.deepEqual(undated.results, [
          { comment_id: seeded.commentId, line_no: 1, ok: false, error: 'undated' },
        ]);
        assert.deepEqual(undated.revisions, []);

        const cancelled = await taskCommand(handle, 'tasks.cancel', {
          network_id: ctx.networkId,
          comment_id: seeded.commentId,
          line_no: 0,
          expected_revision: movedVersion,
        });
        assert.equal(cancelled.results[0]!.ok, true);

        // Текст источника — истина: 31-е + месяц → 28-е, маркер снят.
        const comment = await handle.client.callTool({
          name: 'etn.comments.get',
          arguments: { network_id: ctx.networkId, comment_id: seeded.commentId },
        });
        assert.equal(comment.isError, undefined, toolText(comment));
        assert.equal(
          toolJson<{ body_md: string }>(comment).body_md,
          '- Отчёт [[2026-02-28]]\n- [ ] Без дат',
        );

        // Отменённая строка ушла из проекции задач, вторая осталась «без дат».
        const page = await listTasks(handle, ctx.networkId, { comment_id: seeded.commentId });
        assert.deepEqual(
          page.items.map((row) => row.line_no),
          [1],
        );

        const outOfRange = await taskCommand(handle, 'tasks.toggle', {
          network_id: ctx.networkId,
          comment_id: seeded.commentId,
          line_no: 9,
          expected_revision: cancelled.revisions[0]!.version,
        });
        assert.deepEqual(outOfRange.results, [
          { comment_id: seeded.commentId, line_no: 9, ok: false, error: 'line_not_found' },
        ]);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('tasks.cancelAll / tasks.moveAll: без confirm отказ, с confirm — массовая правка по фильтру', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const a = await seedTaskComment(
          handle,
          ctx.networkId,
          '- [ ] Первая [[2026-03-01]]\n- [ ] Вторая [[2026-03-02]]',
        );
        const b = await seedTaskComment(handle, ctx.networkId, '- [ ] Третья [[2026-03-03]]');

        const refused = await callOp(handle.client, 'tasks.cancelAll', {
          network_id: ctx.networkId,
          filter: {},
        });
        assert.equal(refused.isError, true);
        assert.match(toolText(refused), /confirm/);

        const moved = await taskCommand(
          handle,
          'tasks.moveAll',
          { network_id: ctx.networkId, filter: { comment_id: a.commentId }, days: 2 },
          true,
        );
        assert.equal(moved.results.length, 2);
        assert.ok(moved.results.every((row) => row.ok));
        assert.equal(moved.revisions.length, 1, 'одна ревизия на источник');
        const movedPage = await listTasks(handle, ctx.networkId, { comment_id: a.commentId });
        assert.deepEqual(
          movedPage.items.map((row) => row.due),
          ['2026-03-03', '2026-03-04'],
        );

        const cancelled = await taskCommand(
          handle,
          'tasks.cancelAll',
          { network_id: ctx.networkId, filter: { comment_id: a.commentId } },
          true,
        );
        assert.equal(cancelled.results.length, 2, 'фильтр ограничил команду своим источником');
        assert.equal(cancelled.revisions.length, 1);
        assert.deepEqual(
          toolJson<{ items: TaskRowJson[] }>(
            await callOp(handle.client, 'tasks.list', {
              network_id: ctx.networkId,
              comment_id: a.commentId,
            }),
          ).items,
          [],
        );
        const untouched = await listTasks(handle, ctx.networkId, {
          comment_id: b.commentId,
          scope: 'open',
        });
        assert.equal(untouched.items.length, 1, 'второй источник команда не тронула');

        // Сдвиг обязателен и ровно один (схема контракта).
        const noShift = await callOp(
          handle.client,
          'tasks.moveAll',
          { network_id: ctx.networkId, filter: {} },
          true,
        );
        assert.equal(noShift.isError, true);
        assert.match(toolText(noShift), /exactly one of days or months/);

        // Просрочка в фильтре без `today` — та же ошибка входа, что у списка.
        const noToday = await callOp(
          handle.client,
          'tasks.cancelAll',
          { network_id: ctx.networkId, filter: { scope: 'overdue' } },
          true,
        );
        assert.equal(noToday.isError, true);
        assert.match(toolText(noToday), /BAD_REQUEST/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('meta карточки: по умолчанию блоков нет, include_task_meta добавляет open_tasks и свои напоминания', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const subject = await createThoughtViaWrite(handle.client, ctx.networkId, {
          title: 'Предмет карточки',
        });
        const other = await createThoughtViaWrite(handle.client, ctx.networkId, {
          title: 'Другой предмет',
        });
        const seeded = await seedTaskComment(
          handle,
          ctx.networkId,
          `- [ ] Открытая [[2027-01-10]] [[#${subject.id}]]\n- [x] Закрытая [[2027-01-11]] [[#${subject.id}]]`,
        );

        const plain = await cardMeta(handle, ctx.networkId, subject.id);
        assert.equal(plain.open_tasks, undefined, 'по умолчанию блоков дел нет');
        assert.equal(plain.reminders, undefined);

        const withMeta = await cardMeta(handle, ctx.networkId, subject.id, true);
        const open = withMeta.open_tasks!;
        assert.equal(open.total, 1, 'закрытая задача в «Открытые дела» не попадает');
        assert.equal(open.shown, 1);
        assert.equal(open.truncated, false);
        assert.deepEqual(
          open.items.map((item) => item.line_no),
          [0],
        );
        assert.equal(open.items[0]!.comment_id, seeded.commentId);
        assert.equal(open.items[0]!.due, '2027-01-10');
        assert.equal(open.items[0]!.owner_id, seeded.thoughtId);
        assert.equal(withMeta.reminders!.total, 0);

        // Напоминание запросившего попадает в карточку.
        const created = await callOp(handle.client, 'reminders.create', {
          network_id: ctx.networkId,
          subject_type: 'thought',
          subject_id: subject.id,
          kind: 'one',
          schedule: { type: 'once' },
          anchor_at: '2030-01-15T09:00:00.000Z',
        });
        assert.equal(created.isError, undefined, toolText(created));
        const reminderId = toolJson<{ id: string }>(created).id;

        const withReminder = await cardMeta(handle, ctx.networkId, subject.id, true);
        assert.equal(withReminder.reminders!.total, 1);
        assert.equal(withReminder.reminders!.items[0]!.id, reminderId);
        assert.equal(withReminder.reminders!.items[0]!.next_at, '2030-01-15T09:00:00.000Z');
        assert.equal(withReminder.reminders!.items[0]!.kind, 'one');

        // resolve: тот же флаг — блоки на каждой карточке; без флага — ни на одной.
        const batchPlain = toolJson<{ items: CardJson[] }>(
          await handle.client.callTool({
            name: 'etn.thoughts.resolve',
            arguments: { network_id: ctx.networkId, thought_ids: [subject.id, other.id] },
          }),
        );
        assert.ok(
          batchPlain.items.every(
            (card) => card.meta.open_tasks === undefined && card.meta.reminders === undefined,
          ),
          'resolve без флага не несёт блоков дел',
        );

        const batchMeta = toolJson<{ items: CardJson[] }>(
          await handle.client.callTool({
            name: 'etn.thoughts.resolve',
            arguments: {
              network_id: ctx.networkId,
              thought_ids: [subject.id, other.id],
              include_task_meta: true,
            },
          }),
        );
        assert.equal(batchMeta.items[0]!.meta.open_tasks!.total, 1);
        assert.equal(batchMeta.items[0]!.meta.reminders!.total, 1);
        assert.equal(batchMeta.items[1]!.meta.open_tasks!.total, 0);
        assert.equal(batchMeta.items[1]!.meta.reminders!.total, 0);

        // Персональность: чужое напоминание в моей карточке не видно, и наоборот.
        const member = await addMember(ctx);
        const memberHandle = await connectMcpClient(ctx, member.key);
        try {
          const memberReminder = await callOp(memberHandle.client, 'reminders.create', {
            network_id: ctx.networkId,
            subject_type: 'thought',
            subject_id: subject.id,
            kind: 'one',
            schedule: { type: 'once' },
            anchor_at: '2030-02-01T09:00:00.000Z',
          });
          assert.equal(memberReminder.isError, undefined, toolText(memberReminder));
          const memberCard = await cardMeta(memberHandle, ctx.networkId, subject.id, true);
          assert.equal(memberCard.reminders!.total, 1);
          assert.notEqual(
            memberCard.reminders!.items[0]!.id,
            reminderId,
            'участник видит только своё напоминание',
          );
        } finally {
          await memberHandle.close();
        }
        const adminAgain = await cardMeta(handle, ctx.networkId, subject.id, true);
        assert.equal(adminAgain.reminders!.total, 1, 'у владельца ключа по-прежнему своё');
        assert.equal(adminAgain.reminders!.items[0]!.id, reminderId);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('meta.open_tasks: бюджет 10 строк и признак truncated', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const subject = await createThoughtViaWrite(handle.client, ctx.networkId, {
          title: 'Много задач',
        });
        const lines = Array.from(
          { length: 12 },
          (_, index) =>
            `- [ ] Задача ${index + 1} [[2027-02-${String(index + 1).padStart(2, '0')}]] [[#${subject.id}]]`,
        );
        await seedTaskComment(handle, ctx.networkId, lines.join('\n'));

        const withMeta = await cardMeta(handle, ctx.networkId, subject.id, true);
        const open = withMeta.open_tasks!;
        assert.equal(open.total, 12, 'total считает все подходящие строки');
        assert.equal(open.shown, 10);
        assert.equal(open.truncated, true);
        assert.equal(open.items.length, 10);
        assert.equal(open.items[9]!.line_no, 9);

        // Остальное добирается списком, а не карточкой.
        const full = await listTasks(handle, ctx.networkId, {
          thought_id: subject.id,
          scope: 'open',
          count: true,
        });
        assert.equal(full.total, 12);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('meta.reminders: бюджет 10 строк и признак truncated (12 напоминаний)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const subject = await createThoughtViaWrite(handle.client, ctx.networkId, {
          title: 'Много напоминаний',
        });
        // 12 независимых разовых напоминаний одной мысли (решение: несколько на
        // мысль — каждое живёт само).
        for (let index = 0; index < 12; index += 1) {
          const created = await callOp(handle.client, 'reminders.create', {
            network_id: ctx.networkId,
            subject_type: 'thought',
            subject_id: subject.id,
            kind: 'one',
            schedule: { type: 'once' },
            anchor_at: `2027-04-${String(index + 1).padStart(2, '0')}T09:00:00.000Z`,
          });
          assert.equal(created.isError, undefined, toolText(created));
        }

        const withMeta = await cardMeta(handle, ctx.networkId, subject.id, true);
        const reminders = withMeta.reminders!;
        assert.equal(reminders.total, 12, 'total считает все напоминания мысли');
        assert.equal(reminders.shown, 10, 'shown — бюджет карточки');
        assert.equal(reminders.items.length, 10, 'items не больше предела');
        assert.equal(reminders.truncated, true, 'признак «остальное — списком»');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('справочник: темы tasks/tasks.<action> и классификация обслуживания', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const overview = await handle.client.callTool({
          name: 'etn.guide',
          arguments: { topic: 'tasks' },
        });
        assert.equal(overview.isError, undefined, toolText(overview));
        const text = toolText(overview);
        assert.match(text, /# tasks — tasks and checklists/);
        assert.match(text, /expected_revision/);
        assert.match(text, /include_task_meta/);

        for (const action of [
          'tasks.list',
          'tasks.toggle',
          'tasks.move',
          'tasks.cancel',
          'tasks.cancelAll',
          'tasks.moveAll',
        ]) {
          const topic = await handle.client.callTool({
            name: 'etn.guide',
            arguments: { topic: action },
          });
          assert.equal(topic.isError, undefined, `${action}: ${toolText(topic)}`);
          assert.match(toolText(topic), /## params/);
        }

        // Классификация обслуживания: список читающий, массовые — разрушающие.
        assert.equal(OPS_ACTIONS_BY_NAME.get('tasks.list')?.readOnly, true);
        assert.equal(OPS_ACTIONS_BY_NAME.get('tasks.toggle')?.readOnly, false);
        assert.equal(OPS_ACTIONS_BY_NAME.get('tasks.cancelAll')?.destructive, true);
        assert.equal(OPS_ACTIONS_BY_NAME.get('tasks.moveAll')?.destructive, true);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});

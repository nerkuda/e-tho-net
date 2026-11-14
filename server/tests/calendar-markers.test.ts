/**
 * Маркеры дней календаря месяца «Дневника» (0.16.1, задача d793fd69;
 * требование ab9d627b, элемент интерфейса 55b07702).
 *
 * Проверяется агрегатный запрос месяца: задача отмечает ВСЕ даты своего
 * периода; просрочка — день срока незакрытой задачи (due < today клиента);
 * датовые факты и date-ссылки не-задачных строк; интервалы записей приходят
 * UTC-инстансами (поисковое окно ±1 сутки — запись у локальной полуночи не
 * теряется); напоминания раскрываются движком повторов за месяц, per-user, с
 * учётом dismiss/snooze; пустой месяц — пустые списки; невалидный день — 400.
 *
 * Требует нативного better-sqlite3; иначе пропускается.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BASE_LAYER_ID, EtnError, type CalendarMarkersResult } from '@etn/shared';

import { createInMemoryNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import { listCalendarMarkers } from '../src/domain/calendar-markers-service.js';
import { createCommentWithTargets } from '../src/domain/comment-service.js';
import { createReminder, dismissReminder, snoozeReminder } from '../src/domain/reminder-service.js';
import { runWriteCore } from '../src/domain/write-wrapper.js';

import {
  apiCreateThought,
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';

const USER = 'calendar-markers-user';
const OTHER_USER = 'calendar-markers-other';
/** Часы раскрытия серий: ноябрь 2026, пятница 6-го — опорное вхождение. */
const NOW_MS = Date.parse('2026-11-01T00:00:00.000Z');
const MONTH = { from: '2026-11-01', to: '2026-11-30' } as const;

/** Запись через обёртку домена: хук пере-парса проекции срабатывает после коммита. */
function write<T>(ndb: NetworkDb, fn: () => T): T {
  return runWriteCore(
    ndb,
    { networkId: ndb.networkId, userId: USER, layerId: ndb.layerId },
    () => ({ result: fn() }),
  ).result;
}

/** Завести мысль напрямую (`marked` — помечена на удаление). */
function seedThought(
  ndb: NetworkDb,
  id: string,
  title: string,
  opts: { marked?: boolean } = {},
): void {
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO thoughts
         (id, layer_id, title, title_norm, type_id, active, is_root, marked_for_deletion,
          version, created_at, created_by, updated_at, updated_by, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, NULL, 1, 0, ?, 1, ?, ?, ?, ?, 0, 0)`,
    )
    .run(
      id,
      BASE_LAYER_ID,
      title,
      title.toLowerCase(),
      opts.marked === true ? 1 : 0,
      now,
      USER,
      now,
      USER,
    );
}

/** Завести свойство-дату в справочнике сети. */
function seedDateProperty(ndb: NetworkDb, id: string, name: string): void {
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO properties (id, layer_id, name, name_key, value_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'date', ?, ?)`,
    )
    .run(id, BASE_LAYER_ID, name, name.toLowerCase(), now, now);
}

/** Записать значение свойства мысли. */
function seedValue(ndb: NetworkDb, ownerId: string, propertyId: string, value: string): void {
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO property_values
         (id, layer_id, owner_type, owner_id, property_id, value_date, updated_at)
       VALUES (?, ?, 'thought', ?, ?, ?, ?)`,
    )
    .run(`pv-${ownerId}-${propertyId}`, BASE_LAYER_ID, ownerId, propertyId, value, now);
}

/** Создать комментарий-источник строк (хроно-запись или постоянный). */
function createComment(
  ndb: NetworkDb,
  ownerId: string,
  bodyMd: string,
  opts: {
    kind?: 'chronological' | 'permanent';
    validFrom?: string;
    validTo?: string;
  } = {},
): string {
  const kind = opts.kind ?? 'chronological';
  return write(
    ndb,
    () =>
      createCommentWithTargets(
        ndb,
        [{ owner_type: 'thought', owner_id: ownerId }],
        {
          kind,
          body_md: bodyMd,
          ...(kind === 'chronological'
            ? {
                valid_from: opts.validFrom ?? '2026-10-26T09:00:00.000Z',
                ...(opts.validTo !== undefined ? { valid_to: opts.validTo } : {}),
              }
            : {}),
        },
        USER,
      ).id,
  );
}

/** Маркеры месяца с часовым поясом теста по умолчанию. */
function markers(
  ndb: NetworkDb,
  extra: { today?: string; userId?: string } = {},
): CalendarMarkersResult {
  return listCalendarMarkers(ndb, {
    ...MONTH,
    today: extra.today ?? '2026-11-05',
    userId: extra.userId ?? USER,
    nowMs: NOW_MS,
  });
}

describe(
  'маркеры календаря: домен (ab9d627b)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('задача отмечает ВСЕ даты своего периода, период обрезается месяцем', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-1', 'Спринт');
        // Период 03…05 ноября — середина месяца.
        createComment(ndb, 't-1', '- [ ] Спринт [[2026-11-03]] … [[2026-11-05]]');
        // Период с выходом за границы месяца: в ответе только ноябрьские дни.
        createComment(ndb, 't-1', '- [ ] Переход [[2026-10-30]] … [[2026-11-02]]');
        // Задача другого месяца в ответ не попадает.
        createComment(ndb, 't-1', '- [ ] Декабрь [[2026-12-10]] … [[2026-12-12]]');

        const result = markers(ndb);

        assert.deepEqual(
          result.task_days,
          ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'],
          'все даты периода внутри месяца, без дублей и чужих месяцев',
        );
      } finally {
        ndb.close();
      }
    });

    it('просрочка — день срока незакрытой задачи строго раньше «сегодня»', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-1', 'Дела');
        createComment(ndb, 't-1', '- [ ] Просроченная [[2026-11-02]]');
        createComment(ndb, 't-1', '- [x] Закрытая [[2026-11-01]]');
        createComment(ndb, 't-1', '- [ ] Сегодняшняя [[2026-11-05]]');
        createComment(ndb, 't-1', '- [ ] Без даты');

        const result = markers(ndb, { today: '2026-11-05' });

        assert.deepEqual(
          result.overdue_days,
          ['2026-11-02'],
          'только незакрытая со сроком < today',
        );
        assert.deepEqual(
          result.task_days,
          ['2026-11-01', '2026-11-02', '2026-11-05'],
          'выполненная задача тоже даёт день периода, undated — нет',
        );

        // Граница «сегодня» — от клиента: со сдвигом дня просроченной становится и 05-е.
        const shifted = markers(ndb, { today: '2026-11-06' });
        assert.deepEqual(shifted.overdue_days, ['2026-11-02', '2026-11-05']);
      } finally {
        ndb.close();
      }
    });

    it('факты: значения-даты живых мыслей и date-ссылки не-задачных строк', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-live', 'Стол кухонный');
        seedThought(ndb, 't-dead', 'Удалённая мысль', { marked: true });
        seedDateProperty(ndb, 'p-bought', 'дата приобретения');
        seedValue(ndb, 't-live', 'p-bought', '2026-11-10');
        seedValue(ndb, 't-dead', 'p-bought', '2026-11-11');
        // Постоянный комментарий с date-ссылкой — зелёный маркер.
        createComment(ndb, 't-live', 'Встреча [[2026-11-11]]', { kind: 'permanent' });
        // Строка-задача — её дата даёт ОРАНЖЕВЫЙ маркер, а не зелёный.
        createComment(ndb, 't-live', '- [ ] Позвонить [[2026-11-12]]');

        const result = markers(ndb);

        assert.deepEqual(
          result.fact_days,
          ['2026-11-10', '2026-11-11'],
          'дата свойства + date-ссылка; помеченная мысль и строка-задача не в фактах',
        );
        assert.deepEqual(result.task_days, ['2026-11-12']);
      } finally {
        ndb.close();
      }
    });

    it('интервалы записей: запись у локальной полуночи не теряется (окно ±1 сутки)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-1', 'Записи');
        // 21:00Z 31 октября = локальная полночь 1 ноября в UTC+3.
        createComment(ndb, 't-1', 'Запись у полуночи', {
          validFrom: '2026-10-31T21:00:00.000Z',
          validTo: '2026-10-31T22:00:00.000Z',
        });
        // Запись, полностью прошедшая до месяца, в окно не попадает.
        createComment(ndb, 't-1', 'Сентябрь', {
          validFrom: '2026-09-15T09:00:00.000Z',
          validTo: '2026-09-16T09:00:00.000Z',
        });

        const result = markers(ndb);

        assert.deepEqual(result.record_spans, [
          { from: '2026-10-31T21:00:00.000Z', to: '2026-10-31T22:00:00.000Z' },
        ]);
      } finally {
        ndb.close();
      }
    });

    it('напоминания: повторы на всех датах раскрытия за месяц, per-user, dismiss/snooze', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-net', 'Домашний интернет');
        const reminder = createReminder(
          ndb,
          USER,
          {
            subject_type: 'thought',
            subject_id: 't-net',
            kind: 'rule',
            schedule: { type: 'weekdays', days: [5] },
            anchor_at: '2026-11-06T09:00:00.000Z',
          },
          NOW_MS,
        );
        // Чужое напоминание того же субъекта в маркеры не попадает (per-user).
        createReminder(
          ndb,
          OTHER_USER,
          {
            subject_type: 'thought',
            subject_id: 't-net',
            kind: 'rule',
            schedule: { type: 'weekdays', days: [1] },
            anchor_at: '2026-11-02T09:00:00.000Z',
          },
          NOW_MS,
        );

        assert.deepEqual(markers(ndb).reminder_instants, [
          '2026-11-06T09:00:00.000Z',
          '2026-11-13T09:00:00.000Z',
          '2026-11-20T09:00:00.000Z',
          '2026-11-27T09:00:00.000Z',
        ]);

        // Убранное вхождение 13-го исчезает, отложенное 20-го показывается 22-го.
        write(ndb, () =>
          dismissReminder(ndb, USER, reminder.id, NOW_MS, '2026-11-13T09:00:00.000Z'),
        );
        write(ndb, () =>
          snoozeReminder(
            ndb,
            USER,
            reminder.id,
            '2026-11-22T10:00:00.000Z',
            NOW_MS,
            '2026-11-20T09:00:00.000Z',
          ),
        );

        assert.deepEqual(markers(ndb).reminder_instants, [
          '2026-11-06T09:00:00.000Z',
          '2026-11-22T10:00:00.000Z',
          '2026-11-27T09:00:00.000Z',
        ]);
      } finally {
        ndb.close();
      }
    });

    it('задачи помеченной на удаление мысли исключены (видимость как у GET /tasks)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-dead', 'Удалённая мысль', { marked: true });
        createComment(ndb, 't-dead', '- [ ] Скрытая [[2026-11-03]]', { kind: 'permanent' });

        assert.deepEqual(markers(ndb).task_days, []);
      } finally {
        ndb.close();
      }
    });

    it('пустой месяц — пустые списки; невалидные дни — VALIDATION_ERROR', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        assert.deepEqual(markers(ndb), {
          record_spans: [],
          task_days: [],
          overdue_days: [],
          fact_days: [],
          reminder_instants: [],
        });
        const invalid = (options: Record<string, string>): boolean =>
          (() => {
            try {
              listCalendarMarkers(ndb, { ...MONTH, today: '2026-11-05', ...options });
              return false;
            } catch (err) {
              return err instanceof EtnError && err.code === 'VALIDATION_ERROR';
            }
          })();
        assert.equal(invalid({ from: '01.11.2026' }), true, 'невалидный `from`');
        assert.equal(invalid({ today: '' }), true, 'пустой `today` — ошибка входа');
      } finally {
        ndb.close();
      }
    });
  },
);

/** GET /networks/:id/chronicle/calendar-markers с произвольными query-параметрами. */
async function getMarkers(
  ctx: RestTestContext,
  query: Record<string, string> = {},
): Promise<{ statusCode: number; data: CalendarMarkersResult; code?: string }> {
  const search = new URLSearchParams(query).toString();
  const res = await ctx.app.inject({
    method: 'GET',
    url:
      `/api/v1/networks/${ctx.networkId}/chronicle/calendar-markers` +
      `${search === '' ? '' : `?${search}`}`,
    headers: authHeaders(ctx),
  });
  const json = res.json() as { data?: CalendarMarkersResult; error?: { code: string } };
  return {
    statusCode: res.statusCode,
    data: json.data as CalendarMarkersResult,
    ...(json.error === undefined ? {} : { code: json.error.code }),
  };
}

describe(
  'GET /networks/:id/chronicle/calendar-markers',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('отдаёт маркеры месяца: задача, просрочка, напоминание владельца', async () => {
      const ctx = await buildRestContext();
      try {
        const thought = await apiCreateThought(ctx, { title: 'Задачи' });
        const thoughtId = thought.data['id'] as string;
        const comment = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/comments`,
          headers: authHeaders(ctx),
          payload: {
            kind: 'permanent',
            body_md: '- [ ] Позвонить [[2026-11-14]]',
          },
        });
        assert.equal(comment.statusCode, 201);
        const reminder = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/reminders`,
          headers: authHeaders(ctx),
          payload: {
            subject_type: 'thought',
            subject_id: thoughtId,
            kind: 'rule',
            schedule: { type: 'weekdays', days: [6] },
            anchor_at: '2026-11-07T09:00:00.000Z',
          },
        });
        assert.equal(reminder.statusCode, 201);

        const result = await getMarkers(ctx, {
          from: '2026-11-01',
          to: '2026-11-30',
          today: '2026-11-20',
        });

        assert.equal(result.statusCode, 200);
        assert.deepEqual(result.data.task_days, ['2026-11-14'], 'день периода задачи');
        assert.deepEqual(result.data.overdue_days, ['2026-11-14'], 'срок раньше today');
        assert.deepEqual(
          result.data.reminder_instants,
          [
            '2026-11-07T09:00:00.000Z',
            '2026-11-14T09:00:00.000Z',
            '2026-11-21T09:00:00.000Z',
            '2026-11-28T09:00:00.000Z',
          ],
          'раскрытие повтора владельца за месяц',
        );
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('без `today` или с невалидным днём — ошибка контракта', async () => {
      const ctx = await buildRestContext();
      try {
        const missing = await getMarkers(ctx, { from: '2026-11-01', to: '2026-11-30' });
        assert.ok(missing.statusCode === 400 || missing.statusCode === 422);
        const invalid = await getMarkers(ctx, {
          from: '2026-11-01',
          to: '2026-11-30',
          today: '20.11.2026',
        });
        assert.ok(invalid.statusCode === 400 || invalid.statusCode === 422);
        assert.equal(invalid.code, 'VALIDATION_ERROR');
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);

/**
 * «Связи дня» (0.16.1, требование `1fb1047d`, элемент интерфейса `8ecc30cd`) —
 * домен и REST.
 *
 * Проверяется состав блока: датовые факты мыслей (только свойства-даты,
 * помеченные на удаление мысли исключены), date-ссылки из хроно-записей И
 * постоянных комментариев, строки-задачи исключены (их даты показывает панель
 * «Задачи»), дедупликация строки по дню, подпись владельца источника и адрес
 * владельца; пустой день — пустой ответ; невалидный день — 400/422 контракта.
 *
 * Требует нативного better-sqlite3; иначе пропускается.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BASE_LAYER_ID, EtnError, type DayLinksResult } from '@etn/shared';

import { createInMemoryNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import { createCommentWithTargets } from '../src/domain/comment-service.js';
import { listDayLinks } from '../src/domain/day-links-service.js';
import { listTasks } from '../src/domain/task-service.js';
import { runWriteCore } from '../src/domain/write-wrapper.js';

import {
  apiCreateThought,
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';

const USER = 'day-links-test-user';

/** Запись через обёртку домена: хук пере-парса проекции срабатывает после коммита. */
function write<T>(ndb: NetworkDb, fn: () => T): T {
  return runWriteCore(
    ndb,
    { networkId: ndb.networkId, userId: USER, layerId: ndb.layerId },
    () => ({ result: fn() }),
  ).result;
}

/** Завести мысль (`marked` — помечена на удаление). */
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

/** Завести ребро связи (без типа) между мыслями. */
function seedLink(ndb: NetworkDb, id: string, sourceId: string, targetId: string): void {
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO links
         (id, layer_id, source_id, target_id, type_id, position, active, marked_for_deletion,
          version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, NULL, 0, 1, 0, 1, ?, ?, ?, ?)`,
    )
    .run(id, BASE_LAYER_ID, sourceId, targetId, now, USER, now, USER);
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

/** Создать комментарий-источник date-ссылок. */
function createComment(
  ndb: NetworkDb,
  owner: { owner_type: 'thought' | 'link'; owner_id: string },
  bodyMd: string,
  kind: 'chronological' | 'permanent' = 'chronological',
  validFrom = '2026-10-26',
): string {
  return write(
    ndb,
    () =>
      createCommentWithTargets(
        ndb,
        [owner],
        {
          kind,
          body_md: bodyMd,
          ...(kind === 'chronological' ? { valid_from: validFrom } : {}),
        },
        USER,
      ).id,
  );
}

describe(
  'связи дня: домен (1fb1047d)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('date-ссылки из записи другого дня и постоянного комментария; задачи исключены', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-stol', 'Стол кухонный');
        seedThought(ndb, 't-brat', 'Брат');
        ndb
          .prepare(
            `UPDATE thoughts SET icon = '🔥', icon_kind = 'emoji', fg_color = '#0000ff' WHERE id = ?`,
          )
          .run('t-brat');
        // Запись 26 октября ссылается на 2 ноября — классический источник S1.
        createComment(
          ndb,
          { owner_type: 'thought', owner_id: 't-stol' },
          'Купили стол [[2026-11-02]]\nЕщё строка [[2026-11-02 09:30]]',
        );
        createComment(
          ndb,
          { owner_type: 'thought', owner_id: 't-brat' },
          'Созвон с братом [[2026-11-02]]',
          'permanent',
        );
        // Строка-задача: её даты показывает панель «Задачи», в блок не входят.
        createComment(
          ndb,
          { owner_type: 'thought', owner_id: 't-brat' },
          '- [ ] Позвонить [[2026-11-02]]\n- обычный пункт [[2026-11-02]]',
        );

        const result = listDayLinks(ndb, { from: '2026-11-02' });

        const texts = result.links.map((link) => link.source.text);
        // Абзац с мягким переносом — одна строка проекции целиком; пункт списка
        // хранится без маркера. Порядок: сначала связь со временем, затем без
        // времени — по началу записи-источника (26 октября раньше постоянного
        // комментария).
        assert.deepEqual(
          texts,
          [
            'Купили стол [[2026-11-02]]\nЕщё строка [[2026-11-02 09:30]]',
            'обычный пункт [[2026-11-02]]',
            'Созвон с братом [[2026-11-02]]',
          ],
          'строки-задачи исключены, не-задачные строки остались',
        );
        // Строка с двумя date-ссылками на тот же день даёт ОДНУ связь дня
        // (дедупликация по строке источника), время — первой по времени ссылки.
        const duplicate = result.links.filter((link) => link.source.text.startsWith('Купили стол'));
        assert.equal(duplicate.length, 1);
        assert.equal(duplicate[0]!.time, '09:30');

        // Адрес источника: постоянный комментарий — карточка владельца,
        // хроно-запись — интервал записи.
        const permanent = result.links.find((link) => link.source.kind === 'permanent');
        assert.ok(permanent !== undefined);
        assert.equal(permanent.source.owner_type, 'thought');
        assert.equal(permanent.source.owner_id, 't-brat');
        assert.equal(permanent.source.owner_title, 'Брат');
        assert.equal(permanent.source.source_from, null);
        // Канон отображения владельца-мысли: облачко источника с визуалом
        // (0.16.1, задача 739eb698).
        assert.equal(permanent.source.owner_thought?.id, 't-brat');
        assert.equal(permanent.source.owner_thought?.title, 'Брат');
        assert.equal(permanent.source.owner_thought?.icon, '🔥');
        assert.equal(permanent.source.owner_thought?.fg_color, '#0000ff');

        const record = result.links.find((link) => link.source.kind === 'chronological');
        assert.ok(record !== undefined);
        assert.equal(record.source.owner_title, 'Стол кухонный');
        assert.ok(record.source.source_from !== null, 'у записи есть начало интервала');
        assert.ok(record.source.source_to !== null, 'у записи есть конец интервала');
      } finally {
        ndb.close();
      }
    });

    it('датовые факты: только свойства-даты, живые мысли, порядок по названию', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-a', 'Стол кухонный');
        seedThought(ndb, 't-b', 'Брат');
        seedThought(ndb, 't-dead', 'Удалённая мысль', { marked: true });
        ndb
          .prepare(
            `UPDATE thoughts SET icon = '⭐', icon_kind = 'emoji', fg_color = '#ff0000',
               bg_color = '#00ffee', font_bold = 1, font_manual = 1 WHERE id = ?`,
          )
          .run('t-a');
        seedDateProperty(ndb, 'p-bought', 'дата приобретения');
        seedDateProperty(ndb, 'p-born', 'день рождения');
        seedValue(ndb, 't-a', 'p-bought', '2026-11-02');
        seedValue(ndb, 't-b', 'p-born', '2026-11-02');
        seedValue(ndb, 't-dead', 'p-born', '2026-11-02');
        // Значение другого дня в блок не попадает.
        seedValue(ndb, 't-b', 'p-bought', '2026-12-02');

        const result = listDayLinks(ndb, { from: '2026-11-02', to: '2026-11-02' });

        assert.deepEqual(
          result.facts.map((fact) => `${fact.title}|${fact.property_name}`),
          ['Брат|день рождения', 'Стол кухонный|дата приобретения'],
          'факты отсортированы по названию мысли, помеченная на удаление исключена',
        );
        assert.ok(result.facts.every((fact) => fact.day === '2026-11-02'));
        // Канон отображения мысли-владельца (0.16.1, задача 739eb698): облачко
        // факта несёт иконку, цвета и стиль, а не только название.
        const factA = result.facts.find((fact) => fact.thought_id === 't-a');
        assert.ok(factA !== undefined);
        assert.equal(factA.thought?.id, 't-a');
        assert.equal(factA.thought?.title, 'Стол кухонный');
        assert.equal(factA.thought?.icon, '⭐');
        assert.equal(factA.thought?.fg_color, '#ff0000');
        assert.equal(factA.thought?.bg_color, '#00ffee');
        assert.equal(factA.thought?.font_bold, true);
        const factB = result.facts.find((fact) => fact.thought_id === 't-b');
        assert.equal(factB?.thought?.title, 'Брат');
      } finally {
        ndb.close();
      }
    });

    it('постоянный комментарий помеченной на удаление связи исключается', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-1', 'Источник');
        seedThought(ndb, 't-2', 'Назначение');
        seedLink(ndb, 'l-1', 't-1', 't-2');
        createComment(
          ndb,
          { owner_type: 'link', owner_id: 'l-1' },
          'Встреча [[2026-11-02]]',
          'permanent',
        );
        ndb.prepare('UPDATE links SET marked_for_deletion = 1 WHERE id = ?').run('l-1');

        const result = listDayLinks(ndb, { from: '2026-11-02' });
        assert.deepEqual(result.links, [], 'постоянный комментарий помеченной связи скрыт');
      } finally {
        ndb.close();
      }
    });

    it('show_trash = false скрывает date-ссылки записи помеченной мысли; возврат — показывает', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-live', 'Живая мысль');
        seedThought(ndb, 't-trash', 'Мысль в корзине', { marked: true });
        createComment(
          ndb,
          { owner_type: 'thought', owner_id: 't-live' },
          'Живая встреча [[2026-11-02]]',
        );
        createComment(
          ndb,
          { owner_type: 'thought', owner_id: 't-trash' },
          'Встреча из корзины [[2026-11-02]]',
        );

        const withTrash = listDayLinks(ndb, { from: '2026-11-02' });
        assert.equal(withTrash.links.length, 2, 'по умолчанию корзина показывается');

        const hidden = listDayLinks(ndb, { from: '2026-11-02', showTrash: false });
        assert.deepEqual(
          hidden.links.map((link) => link.source.text),
          ['Живая встреча [[2026-11-02]]'],
          'запись помеченной мысли — содержимое корзины',
        );

        // Возврат из корзины возвращает строку: фильтр читается на лету.
        ndb.prepare('UPDATE thoughts SET marked_for_deletion = 0 WHERE id = ?').run('t-trash');
        const restored = listDayLinks(ndb, { from: '2026-11-02', showTrash: false });
        assert.equal(restored.links.length, 2);
      } finally {
        ndb.close();
      }
    });

    it('пустой день — пустые списки; невалидный день — VALIDATION_ERROR', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const result = listDayLinks(ndb, { from: '2026-11-02' });
        assert.deepEqual(result, { facts: [], links: [] });
        assert.throws(
          () => listDayLinks(ndb, { from: '02.11.2026' }),
          (err: unknown) => err instanceof EtnError && err.code === 'VALIDATION_ERROR',
        );
      } finally {
        ndb.close();
      }
    });

    it('GET /tasks отдаёт владельца источника строки (адрес «Открыть источник»)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-1', 'Мысль');
        const commentId = createComment(
          ndb,
          { owner_type: 'thought', owner_id: 't-1' },
          '- [ ] Открытая [[2026-11-20]]',
        );
        const page = listTasks(ndb);
        assert.equal(page.items.length, 1);
        assert.equal(page.items[0]!.comment_id, commentId);
        assert.equal(page.items[0]!.owner_type, 'thought');
        assert.equal(page.items[0]!.owner_id, 't-1');
        assert.equal(page.items[0]!.kind, 'chronological');
      } finally {
        ndb.close();
      }
    });
  },
);

/** GET /networks/:id/chronicle/day-links с произвольными query-параметрами. */
async function getDayLinks(
  ctx: RestTestContext,
  query: Record<string, string> = {},
): Promise<{ statusCode: number; data: DayLinksResult; code?: string }> {
  const search = new URLSearchParams(query).toString();
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/networks/${ctx.networkId}/chronicle/day-links${search === '' ? '' : `?${search}`}`,
    headers: authHeaders(ctx),
  });
  const json = res.json() as { data?: DayLinksResult; error?: { code: string } };
  return {
    statusCode: res.statusCode,
    data: json.data as DayLinksResult,
    ...(json.error === undefined ? {} : { code: json.error.code }),
  };
}

describe(
  'GET /networks/:id/chronicle/day-links',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('отдаёт связи дня из записи и постоянного комментария, `to` расширяет диапазон', async () => {
      const ctx = await buildRestContext();
      try {
        const brat = await apiCreateThought(ctx, { title: 'Брат' });
        const bratId = brat.data['id'] as string;
        const comment = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${bratId}/comments`,
          headers: authHeaders(ctx),
          payload: { kind: 'permanent', body_md: 'Созвон [[2026-11-02]]' },
        });
        assert.equal(comment.statusCode, 201);
        const record = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${bratId}/comments`,
          headers: authHeaders(ctx),
          payload: {
            kind: 'chronological',
            body_md: 'Запись [[2026-11-03]]',
            valid_from: '2026-10-26',
          },
        });
        assert.equal(record.statusCode, 201);

        const oneDay = await getDayLinks(ctx, { from: '2026-11-02' });
        assert.equal(oneDay.statusCode, 200);
        assert.equal(oneDay.data.links.length, 1);
        assert.equal(oneDay.data.links[0]!.source.owner_id, bratId);
        assert.equal(oneDay.data.links[0]!.source.owner_type, 'thought');

        const range = await getDayLinks(ctx, { from: '2026-11-02', to: '2026-11-03' });
        assert.equal(range.statusCode, 200);
        assert.deepEqual(
          range.data.links.map((link) => link.day),
          ['2026-11-02', '2026-11-03'],
        );
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('без `from` или с невалидным днём — ошибка контракта', async () => {
      const ctx = await buildRestContext();
      try {
        const missing = await getDayLinks(ctx, {});
        assert.ok(missing.statusCode === 400 || missing.statusCode === 422);
        const invalid = await getDayLinks(ctx, { from: '02.11.2026' });
        assert.ok(invalid.statusCode === 400 || invalid.statusCode === 422);
        assert.equal(invalid.code, 'VALIDATION_ERROR');
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);

/**
 * REST `POST /thoughts` в write-пуле (задача c744e05c, тех.проект 0df7ccd6,
 * ADR ca3a9218).
 *
 * До этой задачи write-пул был подключён только к MCP-пути (`etn.thoughts.write`,
 * `server/src/mcp/tools/bundles.ts`), а REST-создание мысли — единственный путь
 * записей GUI-клиента (`etn.thoughts.create`, в т.ч. массовая вставка текста) —
 * оставалось синхронным в главном потоке: серия созданий из клиента держала event
 * loop и «морозила» сервер для всех сетей.
 *
 * Проверяется НАБЛЮДАЕМОЕ поведение:
 *
 *   * создание через REST идёт через пул (счётчик пула растёт, задача исполнена
 *     воркером), но ответ, постоянный комментарий, связь `create_link` и журнал
 *     активности — те же, что на синхронном пути (паритет до/после);
 *   * событие уходит ПОСЛЕ коммита (в момент фан-аута запись уже видна главному
 *     соединению);
 *   * `ETN_WRITE_POOL_SIZE=0` (пул не настроен) — синхронный путь как раньше;
 *   * нагрузочная проба: серия REST-созданий через пул не блокирует главный поток
 *     (p99 лага пинга < 50 мс) — по образцу `write-pool-load.test.ts`.
 *
 * Профиль сети и «тяжёлое» тело воспроизводят форму массовой записи клиента:
 * сеть с тысячами мыслей, каждая создаваемая мысль несёт постоянный комментарий
 * с markdown, который сервер рендерит в `body_html` (это и есть работа, ради
 * которой создание перестаёт быть мгновенным).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';

import { BASE_LAYER_ID, type Thought, type ThoughtCreateInput } from '@etn/shared';

import {
  closeAll,
  openNetworkDb,
  type NetworkDb,
} from '../src/db/network-db.js';
import {
  closeWritePool,
  configureWritePool,
  getWritePool,
} from '../src/db/write-pool.js';
import { runThoughtCreate } from '../src/domain/heavy-write.js';
import type { WriteEmit, WriteFx } from '../src/domain/write-wrapper.js';
import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';

/** Потолок p99 лага пинга главного потока под нагрузкой (критерий ТП). */
const PING_P99_CEIL_MS = 50;
/** Сколько создаём в нагрузочной пробе (серия, как у массовой вставки клиента). */
const BURST = 40;
/**
 * Размер markdown-комментария в нагрузочной пробе (в блоках ≈1,4 КБ). Тело
 * подобрано так, чтобы ОДНО создание в главном потоке было заметно тяжёлым
 * (рендер `body_html`), — иначе одиночный REST-запрос слишком дёшев и блокировку
 * не видно (в отличие от батча на 50 мыслей из `write-pool-load`).
 */
const LOAD_SECTIONS = 120;
/** Форма большой сети (как в write-pool-load): мысли + wildcard-синонимы. */
const PROFILE_THOUGHTS = 600;
const PROFILE_WILDCARDS = 300;

/** p99 выборки (ближайший ранг, без интерполяции). */
function p99(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(0.99 * sorted.length) - 1);
  return sorted[index] as number;
}

/** Markdown-тело постоянного комментария: размер задаётся числом разделов. */
function bigComment(sections: number): string {
  const block =
    '## Раздел\n\n**жирный** текст со *курсивом* и `кодом`, ссылка [x](https://example.org).\n\n' +
    '- пункт один\n- пункт два\n- пункт три\n\n';
  return block.repeat(sections);
}

/** Тело создания мысли для REST/фасада: комментарий + связь с HOME. */
function createBody(
  targetId: string,
  title: string,
  commentSections = 4,
): Record<string, unknown> {
  return {
    title,
    synonyms: [`syn-${title}`],
    comment: { body_md: bigComment(commentSections) },
    create_link: { direction: 'parent', target_thought_id: targetId, type_id: null },
  };
}

/** Устойчивая проекция ответа создания (id/времена отбрасываем — они уникальны). */
function project(data: Record<string, unknown>): Record<string, unknown> {
  return {
    title: data.title,
    synonyms: data.synonyms,
    type_id: data.type_id,
    icon_kind: data.icon_kind,
    active: data.active,
    version: data.version,
  };
}

/** Фасад записи для фасадных проб: события копятся, транспорт подменён. */
function captureFx(
  networkId: string,
  layerId: string | null,
  sink: Array<{ type: string; data: unknown }>,
  onEmit?: () => void,
): WriteFx {
  const emit: WriteEmit = (type, data) => {
    sink.push({ type, data });
    onEmit?.();
  };
  return { networkId, userId: 'rest-create-user', layerId, emit };
}

/** Создать REST-запрос создания мысли (без ожидания). */
function injectCreate(
  ctx: RestTestContext,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; json: () => { data: Record<string, unknown> } }> {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thoughts`,
    headers: authHeaders(ctx),
    payload,
  });
}

/** Строка журнала активности: актор, слой, действие и тип сущности. */
interface ActivityRow {
  user_id: string;
  layer_id: string | null;
  action: string;
  entity_type: string;
}

describe(
  'REST POST /thoughts в write-пуле (c744e05c)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    afterEach(async () => {
      await closeWritePool();
    });

    it('фасад: события после коммита, порядок thought → comment → link, журнал пишет воркер', async () => {
      closeAll();
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-rest-create-'));
      const ndb: NetworkDb = openNetworkDb(tmp, randomUUID());
      try {
        configureWritePool({ size: 1, taskTimeoutMs: 60_000 });
        // У свежей сети из `openNetworkDb` нет HOME (он появляется при создании
        // сети через сервис) — заводим родителя тем же фасадом.
        const parent = await runThoughtCreate(
          ndb,
          captureFx(ndb.networkId, ndb.layerId, []),
          { title: 'Родитель' },
        );
        const events: Array<{ type: string; data: unknown }> = [];
        const invisible: string[] = [];
        const fx = captureFx(ndb.networkId, ndb.layerId, events, () => {
          // Проверка «не раньше коммита»: читаем тем же соединением главного
          // потока — созданной строки ещё/уже нет.
          for (const ev of events) {
            if (ev.type !== 'thought.created') continue;
            const title = (ev.data as { thought: Thought }).thought.title;
            const row = ndb.prepare('SELECT COUNT(*) AS c FROM thoughts WHERE title = ?').get(title) as {
              c: number;
            };
            if (row.c === 0) invisible.push(title);
          }
        });

        const input = createBody(parent.id, 'через-пул', 4) as unknown as ThoughtCreateInput;
        const created = await runThoughtCreate(ndb, fx, input);

        assert.equal(created.title, 'через-пул');
        assert.deepEqual(
          events.map((e) => e.type),
          ['thought.created', 'comment.created', 'link.created'],
          'порядок событий создания мысли',
        );
        assert.deepEqual(invisible, [], 'событие уходит после коммита');

        // Журнал писал ВОРКЕР: строки на месте, актор и слой — из фасада.
        const activity = ndb
          .prepare(
            'SELECT user_id, layer_id, action, entity_type FROM activity_log ORDER BY occurred_at_ms, id',
          )
          .all() as ActivityRow[];
        // Одна запись — от созданного родителя; три — от измеряемой мысли
        // (мысль + постоянный комментарий + связь `create_link`), в порядке записи.
        assert.equal(activity.length, 4, 'журнал: родитель + мысль + комментарий + связь');
        assert.deepEqual(
          activity.slice(1).map((r) => `${r.action}:${r.entity_type}`),
          ['created:thought', 'created:comment', 'created:link'],
          'журнал измеряемой записи: мысль, комментарий, связь',
        );
        assert.ok(activity.every((r) => r.user_id === 'rest-create-user'), 'актор журнала');
        assert.ok(activity.every((r) => r.layer_id === ndb.layerId), 'слой журнала');
        assert.ok(getWritePool()!.stats().completed >= 2, 'задачи исполнены пулом');
      } finally {
        await closeWritePool();
        closeAll();
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('REST: создание с комментарием и связью идёт через пул, результат и эффекты сохранены', async () => {
      const ctx = await buildRestContext();
      try {
        configureWritePool({ size: 1, taskTimeoutMs: 60_000 });
        const res = await injectCreate(ctx, createBody(ctx.homeId, 'REST-через-пул', 4));
        assert.equal(res.statusCode, 201, JSON.stringify(res.json()));
        const data = res.json().data as Record<string, unknown>;
        const id = data.id as string;

        // Постоянный комментарий на месте и предрендерен.
        const comments = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${id}/comments`,
          headers: authHeaders(ctx),
        });
        const list = comments.json().data as Array<{ kind: string; body_md: string; body_html: string }>;
        const permanent = list.filter((c) => c.kind === 'permanent');
        assert.equal(permanent.length, 1);
        assert.match(permanent[0]!.body_html, /<h2[^>]*>Раздел<\/h2>/);

        // Связь create_link материализована (ребёнок → HOME).
        const links = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${id}/neighbors?dir=parents`,
          headers: authHeaders(ctx),
        });
        const neighbors = links.json().data as Array<{ id: string }>;
        assert.ok(
          neighbors.some((n) => n.id === ctx.homeId),
          'новый узел связан с HOME',
        );

        assert.ok(getWritePool()!.stats().completed >= 1, 'REST-задача исполнена пулом');
        assert.equal(getWritePool()!.stats().spawns >= 1, true, 'воркер сети поднят');
      } finally {
        await closeWritePool();
        await closeRestContext(ctx);
      }
    });

    it('паритет REST до/после: одинаковое тело — одинаковый результат (пул выключен / включён)', async () => {
      // 1. Пул не настроен — синхронный путь «как раньше».
      const plain = await buildRestContext();
      let plainData: Record<string, unknown>;
      try {
        assert.equal(getWritePool(), null, 'перед синхронным прогоном пула нет');
        const res = await injectCreate(plain, createBody(plain.homeId, 'Паритет', 6));
        assert.equal(res.statusCode, 201);
        plainData = res.json().data as Record<string, unknown>;
      } finally {
        await closeRestContext(plain);
      }

      // 2. Тот же вход через пул.
      const pooled = await buildRestContext();
      try {
        configureWritePool({ size: 1, taskTimeoutMs: 60_000 });
        const res = await injectCreate(pooled, createBody(pooled.homeId, 'Паритет', 6));
        assert.equal(res.statusCode, 201);
        const pooledData = res.json().data as Record<string, unknown>;
        assert.deepEqual(project(pooledData), project(plainData), 'ответ REST не изменился');
        assert.ok(getWritePool()!.stats().completed >= 1, 'вторая запись — через пул');
      } finally {
        await closeWritePool();
        await closeRestContext(pooled);
      }
    });

    it('нагрузка: серия REST-созданий через пул не блокирует главный поток (p99 пинга < 50 мс)', async () => {
      const ctx = await buildRestContext();
      try {
        seedLargeProfile(ctx.ndb, PROFILE_THOUGHTS, PROFILE_WILDCARDS);

        // Лаг главного потока («event loop lag»): тик ставится с расчётом
        // «предыдущий + период», разница с фактом — сколько поток был занят.
        const measure = async (
          tag: string,
        ): Promise<{ ms: number; pings: number; p99: number; busy: number }> => {
          const period = 5;
          const lags: number[] = [];
          let busy = 0;
          let expected = Date.now() + period;
          let stopped = false;
          let handle: NodeJS.Timeout | null = null;
          const tick = (): void => {
            if (stopped) return;
            const now = Date.now();
            lags.push(now - expected);
            if ((getWritePool()?.stats().busyWorkers ?? 0) > 0) busy += 1;
            expected = now + period;
            handle = setTimeout(tick, period);
            handle.unref?.();
          };
          handle = setTimeout(tick, period);
          handle.unref?.();

          const started = Date.now();
          const bodies = Array.from({ length: BURST }, (_, i) =>
            createBody(ctx.homeId, `${tag}-${i}`, LOAD_SECTIONS),
          );
          const results = await Promise.all(bodies.map((body) => injectCreate(ctx, body)));
          const ms = Date.now() - started;
          await new Promise((resolve) => setTimeout(resolve, 40));
          stopped = true;
          if (handle !== null) clearTimeout(handle);

          for (const [i, res] of results.entries()) {
            assert.equal(res.statusCode, 201, `создание ${tag}-${i} прошло`);
          }
          return { ms, pings: lags.length, p99: p99(lags), busy };
        };

        // Синхронный ориентир: пула нет — серия идёт в главном потоке. Разогрев
        // снимает разовую плату инициализации рендерера markdown и первого
        // соединения: замер обязан отражать установившуюся цену записи.
        assert.equal(getWritePool(), null, 'перед синхронным замером пула нет');
        await injectCreate(ctx, createBody(ctx.homeId, 'разогрев-синхронно', 2));
        const sync = await measure('синхронно');

        const pool = configureWritePool({ size: 2, taskTimeoutMs: 60_000 });
        assert.ok(pool !== null);
        // Разогрев привязки: подъём воркера — разовая плата, вне замера.
        await injectCreate(ctx, createBody(ctx.homeId, 'разогрев', 2));
        const pooled = await measure('через-пул');

        console.log(
          `[rest-create-pool] серия ${BURST}: синхронно=${sync.ms} мс (p99 пинга=${sync.p99.toFixed(1)} мс, ` +
            `пингов=${sync.pings}); через пул=${pooled.ms} мс (p99 пинга=${pooled.p99.toFixed(1)} мс, ` +
            `пингов=${pooled.pings}, при занятом воркере=${pooled.busy})`,
        );

        assert.ok(pooled.pings >= 5, `пинги успели накопиться (${pooled.pings})`);
        assert.ok(
          pooled.busy > 0,
          'пинги через пул приходятся на время, когда воркер занят — окно перекрытия есть',
        );
        assert.ok(
          sync.p99 >= PING_P99_CEIL_MS,
          `синхронный путь обязан блокировать главный поток (p99 пинга ${sync.p99.toFixed(1)} мс)`,
        );
        assert.ok(
          pooled.p99 < PING_P99_CEIL_MS,
          `p99 лага пинга через пул ${pooled.p99.toFixed(1)} мс ≥ ${PING_P99_CEIL_MS} мс — главный поток блокируется`,
        );
        assert.equal(
          pool.stats().completed >= BURST + 1,
          true,
          'все создания исполнены пулом',
        );
      } finally {
        await closeWritePool();
        await closeRestContext(ctx);
      }
    });
  },
);

/** Заполнить сеть «формой большой сети»: мысли + wildcard-синонимы. */
function seedLargeProfile(ndb: NetworkDb, thoughts: number, wildcards: number): void {
  const insThought = ndb.prepare(
    `INSERT INTO thoughts (id, layer_id, title, title_norm, active, is_protected, is_root,
                           version, created_at, created_by, updated_at, updated_by, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, 1, 0, 0, 1, '2024-01-01T00:00:00Z', 'u', '2024-01-01T00:00:00Z', 'u', 0, 0)`,
  );
  const insSynonym = ndb.prepare(
    'INSERT OR IGNORE INTO thought_synonyms (thought_id, synonym, synonym_norm) VALUES (?, ?, ?)',
  );
  ndb.transaction(() => {
    const ids: string[] = [];
    for (let i = 0; i < thoughts; i += 1) {
      const id = randomUUID();
      const title = `Мысль номер ${i}`;
      insThought.run(id, BASE_LAYER_ID, title, title.toLowerCase());
      ids.push(id);
    }
    for (let i = 0; i < wildcards; i += 1) {
      const synonym = `терм${i}*`;
      insSynonym.run(ids[i % ids.length] as string, synonym, synonym.toLowerCase());
    }
  });
}

/** Пустая ссылка на тип, чтобы импорт `ThoughtCreateInput` не считался неиспользуемым. */
export type { ThoughtCreateInput };

/**
 * Импорт `.etnx`: корневые мысли архива прикрепляются к `parent_thought_id`
 * (ошибка e1082889).
 *
 * Дефект: в шаге 10 `importFromEtnx` условие `resolvedId !== t.id` было
 * инвертировано относительно комментария — привязка пропускалась ровно для
 * только что созданных мыслей (у них финальный id новый, remap даёт
 * `resolvedId !== t.id`), а «существующие по id» мысли, наоборот, двигались.
 * Наблюдаемое следствие: после импорта архива в сеть корень архива висел в
 * воздухе (недостижим от HOME), хотя `summary.thoughts_created`/`links_created`
 * рапортовали успех.
 *
 * Тест закрепляет три границы правки:
 *   1. корень архива, созданный импортом, получает связь
 *      `parent_thought_id → корень`, а созданный потомок — нет;
 *   2. повторный импорт того же архива идемпотентен: второй корневой связи
 *      не появляется (совпадение по названию → мысль не «создана»);
 *   3. существующая по названию мысль целевой сети не переприкрепляется
 *      (иначе правка «прикреплять все корни» ломала бы чужие подграфы).
 *
 * Кейс «`parent_thought_id` не указан» на доменном уровне недостижим:
 * `ImportOptions.parentThoughtId` — обязательное поле, REST-контракт
 * `import/commit` требует непустой UUID, MCP-инструмент `import.subgraph`
 * подставляет HOME. «Корни без привязки» кода не имеют — прежнее поведение
 * (до ошибки) здесь не воспроизводится и не может быть сломано.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { logger } from '../src/logger.js';
import { exportToEtnx } from '../src/domain/export-service.js';
import { importFromEtnx, readManifestFromBuffer } from '../src/domain/import-service.js';
import { createLink } from '../src/domain/link-service.js';
import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';

/** Создать мысль через REST и вернуть её id. */
async function createThought(ctx: RestTestContext, title: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thoughts`,
    headers: authHeaders(ctx),
    payload: { title },
  });
  assert.equal(res.statusCode, 201, res.body);
  return (res.json().data as { id: string }).id;
}

/** Сколько живых рёбер `source → target` в сети (по прямой SQL-проверке). */
function linkCount(ctx: RestTestContext, sourceId: string, targetId: string): number {
  const row = ctx.ndb
    .prepare(
      `SELECT COUNT(*) AS n FROM links
        WHERE source_id = ? AND target_id = ? AND deleted = 0`,
    )
    .get(sourceId, targetId) as { n: number };
  return row.n;
}

/**
 * Экспорт подграфа `[rootId]` в `.etnx` с потомками первого уровня и импорт
 * в `dst` под `parentThoughtId`. Возвращает путь и буфер архива.
 */
async function exportAndRead(
  src: RestTestContext,
  rootId: string,
  outPath: string,
): Promise<Buffer> {
  await exportToEtnx(
    src.ndb,
    [rootId],
    { include_attachments: true, include_chronology: true, include_types: true, include_subtree: true },
    { network_id: src.networkId, network_name: src.networkId, user_id: src.adminId },
    outPath,
  );
  return readFileSync(outPath);
}

describe(
  '.etnx прикрепляет корни архива к parent_thought_id (e1082889)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('корень получает связь с parent_thought_id, потомок — нет', async () => {
      const src = await buildRestContext();
      const dst = await buildRestContext();
      const outPath = path.join(tmpdir(), `etnx-root-attach-${randomUUID()}.zip`);
      try {
        const rootId = await createThought(src, 'Корень архива e1082889');
        const childId = await createThought(src, 'Потомок архива e1082889');
        createLink(src.ndb, { source_id: rootId, target_id: childId, type_id: null }, 'system');

        const buffer = await exportAndRead(src, rootId, outPath);
        const manifest = await readManifestFromBuffer(buffer, logger);
        assert.equal(manifest.thoughts.length, 2, 'в архиве корень и потомок');
        assert.equal(manifest.links.length, 1, 'внутренняя связь корень → потомок');

        const result = await importFromEtnx(
          dst.ndb,
          buffer,
          { actorUserId: dst.adminId, parentThoughtId: dst.homeId },
          logger,
        );
        const importedRoot = result.thoughtIdRemap.get(rootId);
        const importedChild = result.thoughtIdRemap.get(childId);
        assert.ok(importedRoot !== undefined, 'корень импортирован (remap есть)');
        assert.ok(importedChild !== undefined, 'потомок импортирован (remap есть)');
        assert.notEqual(importedRoot, rootId, 'корень создан с новым id');

        // Главное утверждение ошибки: связь родитель → корень архива есть.
        assert.equal(
          linkCount(dst, dst.homeId, importedRoot),
          1,
          'parent_thought_id → корень архива: ровно одна живая связь',
        );
        // Потомок остаётся под корнем и не прикрепляется к родителю напрямую.
        assert.equal(linkCount(dst, dst.homeId, importedChild), 0, 'потомок к родителю не прикреплён');
        assert.equal(linkCount(dst, importedRoot, importedChild), 1, 'внутренняя связь сохранена');

        // Обе связи (корневая и внутренняя) посчитаны как созданные.
        assert.equal(result.thoughts_created, 2);
        assert.equal(result.links_created, 2);
      } finally {
        rmSync(outPath, { force: true });
        await closeRestContext(src);
        await closeRestContext(dst);
      }
    });

    it('повторный импорт того же архива не создаёт вторую корневую связь', async () => {
      const src = await buildRestContext();
      const dst = await buildRestContext();
      const outPath = path.join(tmpdir(), `etnx-root-repeat-${randomUUID()}.zip`);
      try {
        const rootId = await createThought(src, 'Корень повторного импорта e1082889');
        const childId = await createThought(src, 'Потомок повторного импорта e1082889');
        createLink(src.ndb, { source_id: rootId, target_id: childId, type_id: null }, 'system');
        const buffer = await exportAndRead(src, rootId, outPath);

        const first = await importFromEtnx(
          dst.ndb,
          buffer,
          { actorUserId: dst.adminId, parentThoughtId: dst.homeId },
          logger,
        );
        const firstRoot = first.thoughtIdRemap.get(rootId);
        assert.ok(firstRoot !== undefined);
        assert.equal(linkCount(dst, dst.homeId, firstRoot), 1);

        // Второй импорт: обе мысли совпали по названию → созданных нет.
        const second = await importFromEtnx(
          dst.ndb,
          buffer,
          { actorUserId: dst.adminId, parentThoughtId: dst.homeId },
          logger,
        );
        assert.equal(second.thoughts_created, 0, 'повторно мысли не создаются');
        assert.equal(second.links_created, 0, 'повторно связи не создаются');
        assert.equal(
          linkCount(dst, dst.homeId, firstRoot),
          1,
          'корневая связь не задвоилась',
        );
        assert.equal(
          second.thoughtIdRemap.get(rootId),
          firstRoot,
          'повторный импорт разрешился в ту же мысль',
        );
      } finally {
        rmSync(outPath, { force: true });
        await closeRestContext(src);
        await closeRestContext(dst);
      }
    });

    it('существующая по названию мысль не переприкрепляется (защита от мутации)', async () => {
      const src = await buildRestContext();
      const dst = await buildRestContext();
      const outPath = path.join(tmpdir(), `etnx-root-title-match-${randomUUID()}.zip`);
      try {
        const rootTitle = 'Уже есть в целевой сети e1082889';
        const rootId = await createThought(src, rootTitle);
        const childId = await createThought(src, 'Новый потомок e1082889');
        createLink(src.ndb, { source_id: rootId, target_id: childId, type_id: null }, 'system');
        const buffer = await exportAndRead(src, rootId, outPath);

        // Целевая мысль с тем же названием: REST-создание не прикрепляет её
        // к HOME, значит до импорта связи HOME → мысль нет.
        const existingRoot = await createThought(dst, rootTitle);
        assert.equal(linkCount(dst, dst.homeId, existingRoot), 0);

        const result = await importFromEtnx(
          dst.ndb,
          buffer,
          { actorUserId: dst.adminId, parentThoughtId: dst.homeId },
          logger,
        );
        assert.equal(result.thoughtIdRemap.get(rootId), existingRoot, 'совпадение по названию');
        assert.ok(
          !result.createdThoughtIds.includes(existingRoot),
          'существующая мысль не считается созданной этим импортом',
        );

        // Мутация «прикреплять все корни» добавила бы связь HOME → уже
        // существующая мысль (NULL в UNIQUE-индексе её не ловит).
        assert.equal(
          linkCount(dst, dst.homeId, existingRoot),
          0,
          'существующая мысль не переприкреплена',
        );
        const importedChild = result.thoughtIdRemap.get(childId);
        assert.ok(importedChild !== undefined);
        assert.equal(linkCount(dst, dst.homeId, importedChild), 0, 'новый потомок к HOME не прикреплён');
        assert.equal(linkCount(dst, existingRoot, importedChild), 1, 'внутренняя связь проведена');
        assert.equal(result.links_created, 1, 'создана только внутренняя связь');
      } finally {
        rmSync(outPath, { force: true });
        await closeRestContext(src);
        await closeRestContext(dst);
      }
    });
  },
);

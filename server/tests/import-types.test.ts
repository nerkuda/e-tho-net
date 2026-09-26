/**
 * Импорт `.etnx` создавал только первый тип мысли/связи (ошибка e7d1b27a,
 * версия 0.9.1).
 *
 * `insertThoughtType`/`insertLinkType` не писали `name_key` /
 * `name_forward_key` / `name_reverse_key`; колонки `NOT NULL DEFAULT ''` с
 * UNIQUE-индексом — первая строка занимала `''`, все последующие `INSERT OR
 * IGNORE` молча отбрасывались. Счётчики отчёта при этом инкрементировались
 * безусловно.
 *
 * Тест собирает манифест с иерархией типов (родитель → потомок) и проверяет,
 * что после импорта присутствуют ВСЕ типы, ключи имён нормализованы,
 * `parent_id` сохранён, а счётчики соответствуют фактическим строкам.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createWriteStream, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { ETNX_VERSION, type ThoughtType, type LinkType } from '@etn/shared';
import archiver from 'archiver';

import { logger } from '../src/logger.js';
import { importFromEtnx } from '../src/domain/import-service.js';
import { getThought } from '../src/domain/thought-service.js';
import { buildRestContext, closeRestContext, nativeAvailable } from './rest-helpers.js';

/** Минимальная валидная запись типа мысли (parseManifest проверяет лишь shape). */
function thoughtType(
  id: string,
  name: string,
  parentId: string | null,
  isRoot = false,
): ThoughtType {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id,
    name,
    parent_id: parentId,
    is_root: isRoot,
    icon: null,
    icon_kind: 'emoji',
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    description: null,
    comment_template_md: null,
    version: 1,
    created_at: now,
    updated_at: now,
    created_by: 'seed',
  };
}

function linkType(
  id: string,
  forward: string,
  reverse: string,
  parentId: string | null,
  isRoot = false,
): LinkType {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id,
    name_forward: forward,
    name_reverse: reverse,
    parent_id: parentId,
    is_root: isRoot,
    color: null,
    style: null,
    width: null,
    description: null,
    version: 1,
    created_at: now,
    updated_at: now,
    created_by: 'seed',
  };
}

interface ManifestIds {
  typeA: string;
  typeB: string;
  linkA: string;
  linkB: string;
  thought1: string;
  thought2: string;
}

/** Манифест: 2 пользовательских типа мыслей (родитель+потомок) и 2 типа
 *  связей (родитель+потомок), одна мысль потомка и одна типизированная связь. */
function buildManifest(): { manifest: unknown; ids: ManifestIds } {
  const now = new Date().toISOString();
  const rootThought = '00000000-0000-4000-8000-000000000001';
  const rootLink = '00000000-0000-4000-8000-000000000002';
  const typeA = randomUUID();
  const typeB = randomUUID();
  const linkA = randomUUID();
  const linkB = randomUUID();
  const thought1 = randomUUID();
  const thought2 = randomUUID();

  const manifest = {
    format: 'etnx',
    version: ETNX_VERSION,
    exported_at: now,
    source: { network_id: 'src', network_name: 'src', user_id: 'seed' },
    thought_types: [
      thoughtType(rootThought, 'основной тип', null, true),
      thoughtType(typeA, 'Полигон-тип', rootThought),
      thoughtType(typeB, 'Полигон-подтип', typeA),
    ],
    link_types: [
      linkType(rootLink, 'основной тип', 'основной тип', null, true),
      linkType(linkA, 'Включает', 'Включён в', rootLink),
      linkType(linkB, 'Связан-с', 'Связан-с', linkA),
    ],
    properties: [],
    type_properties: [],
    thoughts: [
      {
        id: thought1,
        title: 'Типизированная мысль',
        type_id: typeB,
        icon: null,
        icon_kind: 'emoji',
        active: true,
        created_at: now,
        created_by: 'seed',
      },
      {
        id: thought2,
        title: 'Безымянная цель',
        type_id: null,
        icon: null,
        icon_kind: 'emoji',
        active: true,
        created_at: now,
        created_by: 'seed',
      },
    ],
    thought_synonyms: [],
    links: [
      {
        id: randomUUID(),
        source_id: thought1,
        target_id: thought2,
        type_id: linkB,
        active: true,
        version: 1,
        created_at: now,
        created_by: 'seed',
        updated_at: now,
        updated_by: 'seed',
      },
    ],
    comments: [],
    comment_targets: [],
    property_values: [],
    attachments: [],
  };
  return {
    manifest,
    ids: { typeA, typeB, linkA, linkB, thought1, thought2 },
  };
}

async function writeArchive(manifest: unknown, outPath: string): Promise<void> {
  const archive = archiver('zip', { zlib: { level: 9 } });
  const out = createWriteStream(outPath);
  const done = new Promise<void>((resolve, reject) => {
    out.on('close', () => resolve());
    out.on('error', reject);
    archive.on('error', reject);
  });
  archive.pipe(out);
  archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
  await archive.finalize();
  await done;
}

describe(
  'import .etnx types (e7d1b27a)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('creates every type with normalized keys and preserved hierarchy', async () => {
      const ctx = await buildRestContext();
      const outPath = path.join(tmpdir(), `etnx-types-${randomUUID()}.zip`);
      try {
        const { manifest, ids } = buildManifest();
        await writeArchive(manifest, outPath);

        const result = await importFromEtnx(
          ctx.ndb,
          readFileSync(outPath),
          { actorUserId: ctx.adminId, parentThoughtId: ctx.homeId },
          logger,
        );

        // Счётчики честные: корневые типы уже есть (reused), пользовательские
        // (по 2 каждого вида) созданы.
        assert.equal(result.thought_types_created, 2, 'оба пользовательских типа мысли созданы');
        assert.equal(result.thought_types_reused, 1, 'корневой тип мысли переиспользован');
        assert.equal(result.link_types_created, 2, 'оба пользовательских типа связи созданы');
        assert.equal(result.link_types_reused, 1, 'корневой тип связи переиспользован');

        // Оба типа мысли реально присутствуют, ключи нормализованы.
        const tA = ctx.ndb
          .prepare('SELECT id, name, name_key, parent_id FROM thought_types WHERE id = ?')
          .get(ids.typeA) as
          | { id: string; name: string; name_key: string; parent_id: string | null }
          | undefined;
        const tB = ctx.ndb
          .prepare('SELECT id, name, name_key, parent_id FROM thought_types WHERE id = ?')
          .get(ids.typeB) as
          | { id: string; name: string; name_key: string; parent_id: string | null }
          | undefined;
        assert.ok(tA !== undefined, 'первый пользовательский тип мысли импортирован');
        assert.ok(tB !== undefined, 'второй пользовательский тип мысли импортирован (не потерян)');
        assert.equal(tA.name_key, 'полигон-тип', 'name_key нормализован (trim+lowercase)');
        assert.equal(tB.name_key, 'полигон-подтип');
        assert.equal(tA.parent_id, '00000000-0000-4000-8000-000000000001', 'родитель A — корень');
        assert.equal(tB.parent_id, ids.typeA, 'иерархия типов мыслей сохранена');

        // Оба типа связи присутствуют с нормализованными ключами и иерархией.
        const lA = ctx.ndb
          .prepare(
            'SELECT id, name_forward_key, name_reverse_key, parent_id FROM link_types WHERE id = ?',
          )
          .get(ids.linkA) as
          | { id: string; name_forward_key: string; name_reverse_key: string; parent_id: string | null }
          | undefined;
        const lB = ctx.ndb
          .prepare('SELECT id, name_forward_key, parent_id FROM link_types WHERE id = ?')
          .get(ids.linkB) as
          | { id: string; name_forward_key: string; parent_id: string | null }
          | undefined;
        assert.ok(lA !== undefined, 'первый пользовательский тип связи импортирован');
        assert.ok(lB !== undefined, 'второй пользовательский тип связи импортирован (не потерян)');
        assert.equal(lA.name_forward_key, 'включает');
        assert.equal(lA.name_reverse_key, 'включён в');
        assert.equal(lB.name_forward_key, 'связан-с');
        assert.equal(lB.parent_id, ids.linkA, 'иерархия типов связей сохранена');

        // Мысль ссылается на созданный тип, а не на висячий id. Мысль без
        // коллизии по id получает новый id — берём его из remap импорта.
        const targetThoughtId = result.thoughtIdRemap.get(ids.thought1);
        assert.ok(targetThoughtId !== undefined, 'импортированная мысль есть в remap');
        const thought = getThought(ctx.ndb, targetThoughtId);
        assert.ok(thought !== null);
        assert.equal(thought.type_id, ids.typeB, 'type_id мысли резолвится в импортированный тип');
      } finally {
        rmSync(outPath, { force: true });
        await closeRestContext(ctx);
      }
    });
  },
);

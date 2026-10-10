/**
 * Задача f37b468d (0.11.1, техпроект «Публикации»): вид значения свойства
 * `publication`, владелец-вложение `publication` (строка-копия с общим файлом,
 * сборка мусора) и ссылки `[[#pub:<id>]]` (резолв имён, скан упоминаний).
 *
 * Пропускается, когда нативная сборка `better-sqlite3` недоступна.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { EtnError } from '@etn/shared';
import { renderPublicationFragment } from '@etn/markdown';

import { createInMemoryNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import { createThoughtType } from '../src/domain/thought-type-service.js';
import {
  createTypeProperty,
  getPropertyValues,
  setPropertyValue,
} from '../src/domain/property-service.js';
import {
  checkPublicationDeletion,
  createPublication,
  purgePublication,
  resolvePublicationRefs,
} from '../src/domain/publication-service.js';
import {
  copyAttachment,
  createAttachment,
  getAttachment,
  listAttachments,
  removeOwner,
  storedFileInUse,
} from '../src/domain/attachment-service.js';

/** True when the `better-sqlite3` native binding loads. */
function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

const skip = !nativeAvailable();
const USER = 'u';

function codeOf(err: unknown): string | undefined {
  return err instanceof EtnError ? err.code : undefined;
}

/** Seed a thought directly (no type) and return its id. */
function seedThought(ndb: NetworkDb, title = 'T'): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, 1, 0, 0, 1, '2024-01-01T00:00:00Z', 'u', '2024-01-01T00:00:00Z', 'u')`,
    )
    .run(id, title, title.toLowerCase());
  return id;
}

/** Create a thought type with one `publication` property; return both ids. */
function seedPublicationProperty(
  ndb: NetworkDb,
  opts: { multiple?: boolean } = {},
): { typeId: string; propKey: string; propId: string } {
  const type = createThoughtType(ndb, { name: `T-${randomUUID().slice(0, 8)}` }, USER);
  const prop = createTypeProperty(
    ndb,
    'thought_type',
    type.id,
    { key: 'pub', value_type: 'publication', config: { multiple: opts.multiple === true } },
    USER,
  );
  return { typeId: type.id, propKey: 'pub', propId: prop.property_id };
}

/** Seed a thought of the given type. */
function seedTypedThought(ndb: NetworkDb, typeId: string): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, type_id, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, 1, 0, 0, 1, '2024-01-01T00:00:00Z', 'u', '2024-01-01T00:00:00Z', 'u')`,
    )
    .run(id, 'T', 't', typeId);
  return id;
}

describe('value_type publication (f37b468d)', { skip }, () => {
  it('записывает и читает одиночную ссылку в value_text', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const { typeId, propKey, propId } = seedPublicationProperty(ndb);
      const thought = seedTypedThought(ndb, typeId);
      const pub = createPublication(ndb, { title: 'Док' }, USER);

      const stored = setPropertyValue(ndb, 'thought', thought, propKey, pub.id, USER);
      assert.equal(stored.value_type, 'publication');
      assert.equal(stored.value, pub.id);

      const row = ndb
        .prepare(
          'SELECT value_text, value_number FROM property_values_v WHERE owner_id = ? AND property_id = ?',
        )
        .get(thought, propId) as { value_text: string | null; value_number: number | null };
      assert.equal(row.value_text, pub.id);

      const values = getPropertyValues(ndb, 'thought', thought);
      assert.equal(values.length, 1);
      assert.equal(values[0]!.value, pub.id);
    } finally {
      ndb.close();
    }
  });

  it('несуществующая публикация отвергается (VALIDATION_ERROR)', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const { typeId, propKey } = seedPublicationProperty(ndb);
      const thought = seedTypedThought(ndb, typeId);
      assert.throws(
        () => setPropertyValue(ndb, 'thought', thought, propKey, randomUUID(), USER),
        (e) => codeOf(e) === 'VALIDATION_ERROR',
      );
    } finally {
      ndb.close();
    }
  });

  it('multiple: набор id хранится JSON-массивом и читается как массив', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const { typeId, propKey } = seedPublicationProperty(ndb, { multiple: true });
      const thought = seedTypedThought(ndb, typeId);
      const a = createPublication(ndb, { title: 'A' }, USER);
      const b = createPublication(ndb, { title: 'B' }, USER);

      const stored = setPropertyValue(ndb, 'thought', thought, propKey, [a.id, b.id], USER);
      assert.deepEqual(stored.value, [a.id, b.id]);

      // Живое значение (любая форма) блокирует физическое удаление публикации.
      assert.equal(checkPublicationDeletion(ndb, a.id).blocked, true);
      assert.equal(checkPublicationDeletion(ndb, a.id).blocking.properties, 1);
      assert.throws(() => purgePublication(ndb, a.id), (e) => codeOf(e) === 'VALIDATION_ERROR');
    } finally {
      ndb.close();
    }
  });

  it('одиночное значение тоже блокирует удаление публикации', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const { typeId, propKey } = seedPublicationProperty(ndb);
      const thought = seedTypedThought(ndb, typeId);
      const pub = createPublication(ndb, { title: 'A' }, USER);
      setPropertyValue(ndb, 'thought', thought, propKey, pub.id, USER);
      assert.equal(checkPublicationDeletion(ndb, pub.id).blocking.properties, 1);
    } finally {
      ndb.close();
    }
  });
});

describe('resolvePublicationRefs (f37b468d)', { skip }, () => {
  it('разрешает существующие, пропускает отсутствующие, хранит порядок', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const a = createPublication(ndb, { title: 'A' }, USER);
      const b = createPublication(ndb, { title: 'B' }, USER);
      const missing = randomUUID();
      const refs = resolvePublicationRefs(ndb, [b.id, missing, a.id, b.id]);
      assert.deepEqual(
        refs.map((r) => r.id),
        [b.id, a.id],
        'порядок входа без дублей; отсутствующие опущены',
      );
      assert.equal(refs[0]!.title, 'B');
      assert.equal(refs[0]!.active, true);
    } finally {
      ndb.close();
    }
  });

  it('подставляет имя через экспортный резолвер markdown-рендерера', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const pub = createPublication(ndb, { title: 'Живой документ' }, USER);
      const missing = randomUUID();
      const byId = new Map(resolvePublicationRefs(ndb, [pub.id, missing]).map((r) => [r.id, r.title]));
      const { html } = renderPublicationFragment(
        `См. [[#pub:${pub.id}]] и [[#pub:${missing}]]`,
        {
          resolveLink: (ref) => {
            if (ref.kind !== 'pub' || ref.id === null) return undefined;
            const title = byId.get(ref.id);
            return title === undefined ? { kind: 'missing' } : { kind: 'text', text: title };
          },
        },
      );
      assert.ok(html.includes('Живой документ'), 'имя публикации подставлено');
      assert.ok(html.includes('удалена'), 'отсутствующая — пометка «удалена»');
    } finally {
      ndb.close();
    }
  });
});

describe('владелец-вложение publication (f37b468d)', { skip }, () => {
  it('создаёт и перечисляет вложения публикации', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const pub = createPublication(ndb, { title: 'P' }, USER);
      const a = createAttachment(ndb, 'publication', pub.id, { kind: 'url', url: 'https://e/x.png' }, USER);
      assert.equal(a.owner_type, 'publication');
      assert.equal(a.owner_id, pub.id);
      assert.equal(listAttachments(ndb, 'publication', pub.id).length, 1);
    } finally {
      ndb.close();
    }
  });

  it('несуществующая публикация-владелец → NOT_FOUND', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      assert.throws(
        () => createAttachment(ndb, 'publication', randomUUID(), { kind: 'url', url: 'https://e/x.png' }, USER),
        (e) => codeOf(e) === 'NOT_FOUND',
      );
    } finally {
      ndb.close();
    }
  });

  it('копия строки в публикацию делит физический файл и переживает удаление источника', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const filePath = path.resolve('C:/tmp/cover.png');
      const sourceThought = seedThought(ndb, 'Источник');
      const source = createAttachment(
        ndb,
        'thought',
        sourceThought,
        { kind: 'file', file_path: filePath, file_size: 10, mime_type: 'image/png' },
        USER,
      );
      const pub = createPublication(ndb, { title: 'P' }, USER);

      const result = copyAttachment(
        ndb,
        source.id,
        { target_owner_type: 'publication', target_owner_ids: [pub.id] },
        USER,
      );
      assert.equal(result.added.length, 1);
      // Муль-владение: та же строка-вложение теперь держится и публикацией.
      const shared = getAttachment(ndb, source.id)!;
      assert.equal(shared.file_path, source.file_path, 'тот же физический файл');
      assert.ok(storedFileInUse(ndb, filePath), 'файл используется');

      // Снятие владения мысли не трогает файл: он нужен публикации.
      removeOwner(ndb, source.id, 'thought', sourceThought);
      assert.notEqual(getAttachment(ndb, source.id), null);
      assert.equal(getAttachment(ndb, source.id)?.file_path, source.file_path);
      assert.ok(storedFileInUse(ndb, filePath), 'файл удержан владением публикации');
    } finally {
      ndb.close();
    }
  });

  it('purge публикации удаляет её строки и освобождает файл без других ссылок', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const filePath = path.resolve('C:/tmp/purge-me.png');
      const pub = createPublication(ndb, { title: 'P' }, USER);
      const a = createAttachment(
        ndb,
        'publication',
        pub.id,
        { kind: 'file', file_path: filePath, file_size: 1, mime_type: 'image/png' },
        USER,
      );
      assert.ok(storedFileInUse(ndb, filePath));

      purgePublication(ndb, pub.id);
      assert.equal(getAttachment(ndb, a.id), null, 'строка-вложение удалена каскадом');
      assert.equal(storedFileInUse(ndb, filePath), false, 'файл больше никем не удержан');
    } finally {
      ndb.close();
    }
  });
});

/**
 * Unit tests for {@link copyThoughtsBatch} (task L26, bb8277f6).
 *
 * Two scenarios are pinned down:
 *
 *  - A subgraph copy preserves internal hierarchy: only the **roots** of
 *    the copied subgraph (the thoughts with no incoming copied link) get a
 *    new parent-link to the paste target. Internal thoughts keep their
 *    existing parent-links and do NOT receive an extra link to the paste
 *    target — otherwise the children zone would double-list them.
 *  - The whole batch is atomic: a malformed thought snapshot rolls back
 *    every other create in the same call.
 *
 * Skipped entirely when the `better-sqlite3` native binding is unavailable
 * (the rest of the suite stays green).
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import type { ThoughtCopyInput, ThoughtCopyItem, ThoughtCopyLink } from '@etn/shared';

import { getAttachmentRawByPath, createAttachmentFile } from '../src/domain/attachment-service.js';
import {
  createInMemoryNetworkDb,
  NetworkDb,
  registerMigrationHelpers,
} from '../src/db/network-db.js';
import { runMigrations } from '../src/db/migrator.js';
import { networkMigrationsDir } from '../src/paths.js';
import { copyThoughtsBatch, makeCopyFileCopier } from '../src/domain/thought-copy-service.js';

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

const ACTOR = '11111111-2222-3333-4444-555555555555';
const PASTE_TARGET = 'paste-target-thought';

function setup(): NetworkDb {
  const ndb = createInMemoryNetworkDb();
  // Insert the paste target up-front — the service validates its existence
  // and would 404 on a missing parent.
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, type_id, icon, icon_kind, active,
                             is_protected, is_root, fg_color, bg_color,
                             font_bold, font_italic, font_underline, font_strike, font_manual,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, NULL, NULL, 'emoji', 1, 0, 0, NULL, NULL, 0, 0, 0, 0, 0,
               1, '2026-01-01T00:00:00.000Z', ?, '2026-01-01T00:00:00.000Z', ?)`,
    )
    .run(PASTE_TARGET, 'Paste target', 'paste target', ACTOR, ACTOR);
  return ndb;
}

function snapshot(title: string): ThoughtCopyItem {
  return {
    thought: {
      title,
      synonyms: [],
      type: { id: null, name: null },
      icon: null,
      icon_kind: 'emoji',
      active: true,
      fg_color: null,
      bg_color: null,
      font_bold: null,
      font_italic: null,
      font_underline: null,
      font_strike: null,
    },
  } as unknown as ThoughtCopyItem;
}

/** Inject the client-side `source_id` extension (the service reads it off
 *  the wire to fill in the result's `thought_id_map`). */
function withSourceId(item: ThoughtCopyItem, sourceId: string): ThoughtCopyItem {
  return { ...item, source_id: sourceId } as unknown as ThoughtCopyItem;
}

function untypedLink(sourceId: string, targetId: string): ThoughtCopyLink {
  return {
    source_id: sourceId,
    target_id: targetId,
    type: { id: null, name_forward: null, name_reverse: null },
    color: null,
    style: null,
    width: null,
    active: true,
  };
}

describe(
  'copyThoughtsBatch',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('attaches only roots of the copied subgraph to the paste target', () => {
      const ndb = setup();
      // Source subgraph: A → B, A → C (B and C are children of A).
      const input: ThoughtCopyInput = {
        source_network_id: 'source-net',
        parent_thought_id: PASTE_TARGET,
        thoughts: [
          withSourceId(snapshot('Project A'), 'source-a'),
          withSourceId(snapshot('Subtask B'), 'source-b'),
          withSourceId(snapshot('Subtask C'), 'source-c'),
        ],
        links: [
          untypedLink('source-a', 'source-b'),
          untypedLink('source-a', 'source-c'),
        ],
      };

      const result = copyThoughtsBatch(ndb, input, ACTOR);

      // Three thoughts created.
      assert.equal(result.created_thoughts.length, 3);
      const newA = result.thought_id_map['source-a']!;
      const newB = result.thought_id_map['source-b']!;
      const newC = result.thought_id_map['source-c']!;
      assert.ok(newA && newB && newC);

      // New thoughts that are TARGETS of copied links (B, C) must NOT have a
      // parent-link from the paste target — they keep the original link
      // from A as their parent.
      const linkToA = ndb
        .prepare('SELECT id FROM links WHERE source_id = ? AND target_id = ?')
        .get(PASTE_TARGET, newA) as { id: string } | undefined;
      const linkToB = ndb
        .prepare('SELECT id FROM links WHERE source_id = ? AND target_id = ?')
        .get(PASTE_TARGET, newB) as { id: string } | undefined;
      const linkToC = ndb
        .prepare('SELECT id FROM links WHERE source_id = ? AND target_id = ?')
        .get(PASTE_TARGET, newC) as { id: string } | undefined;
      assert.ok(linkToA, 'paste-target → A (root) must get a parent-link');
      assert.equal(linkToB, undefined, 'paste-target → B (internal) must NOT get a parent-link');
      assert.equal(linkToC, undefined, 'paste-target → C (internal) must NOT get a parent-link');

      // B and C keep the original A → B / A → C parent-links.
      const aToB = ndb
        .prepare('SELECT id FROM links WHERE source_id = ? AND target_id = ?')
        .get(newA, newB) as { id: string } | undefined;
      const aToC = ndb
        .prepare('SELECT id FROM links WHERE source_id = ? AND target_id = ?')
        .get(newA, newC) as { id: string } | undefined;
      assert.ok(aToB, 'A → B parent-link must survive the copy');
      assert.ok(aToC, 'A → C parent-link must survive the copy');
    });

    it('attaches every thought when none of them has a copied parent', () => {
      const ndb = setup();
      // Two independent thoughts copied together — no links between them.
      const input: ThoughtCopyInput = {
        source_network_id: 'source-net',
        parent_thought_id: PASTE_TARGET,
        thoughts: [
          withSourceId(snapshot('Independent A'), 'src-1'),
          withSourceId(snapshot('Independent B'), 'src-2'),
        ],
        links: [],
      };

      const result = copyThoughtsBatch(ndb, input, ACTOR);

      const newA = result.thought_id_map['src-1']!;
      const newB = result.thought_id_map['src-2']!;
      const linkToA = ndb
        .prepare('SELECT id FROM links WHERE source_id = ? AND target_id = ?')
        .get(PASTE_TARGET, newA) as { id: string } | undefined;
      const linkToB = ndb
        .prepare('SELECT id FROM links WHERE source_id = ? AND target_id = ?')
        .get(PASTE_TARGET, newB) as { id: string } | undefined;
      assert.ok(linkToA, 'Independent thought A must be attached to paste target');
      assert.ok(linkToB, 'Independent thought B must be attached to paste target');
    });

    it('attaches only the source of an inter-thought link as a root', () => {
      // Edge case: a copy of two siblings with a single inter-thought link.
      // A is the source of the inter-link (so it has no incoming copied
      // link → root → gets a parent-link to the paste target). B is the
      // target of that same link → internal → keeps the inter-link as its
      // only incoming edge and is NOT attached to the paste target again.
      const ndb = setup();
      const input: ThoughtCopyInput = {
        source_network_id: 'source-net',
        parent_thought_id: PASTE_TARGET,
        thoughts: [
          withSourceId(snapshot('Sibling A'), 's-a'),
          withSourceId(snapshot('Sibling B'), 's-b'),
        ],
        links: [untypedLink('s-a', 's-b')],
      };

      const result = copyThoughtsBatch(ndb, input, ACTOR);
      const newA = result.thought_id_map['s-a']!;
      const newB = result.thought_id_map['s-b']!;

      assert.ok(
        ndb
          .prepare('SELECT 1 FROM links WHERE source_id = ? AND target_id = ?')
          .get(PASTE_TARGET, newA),
        'Sibling A (link source) must attach to paste target',
      );
      assert.equal(
        ndb
          .prepare('SELECT 1 FROM links WHERE source_id = ? AND target_id = ?')
          .get(PASTE_TARGET, newB),
        undefined,
        'Sibling B (link target) must NOT be re-attached to paste target',
      );
      // The copied inter-link is preserved.
      assert.ok(
        ndb.prepare('SELECT 1 FROM links WHERE source_id = ? AND target_id = ?').get(newA, newB),
        'Sibling A → Sibling B inter-link preserved',
      );
    });
  },
);

// ---------------------------------------------------------------------------
// Межсетевое копирование вложений (ошибка b83a7d89)
// ---------------------------------------------------------------------------

/** Создать сетевую БД с файловым расположением (каталог `attachments/` рядом). */
function makeFileDb(dataDir: string, networkId: string): NetworkDb {
  const db = new DatabaseConstructor(':memory:');
  db.pragma('foreign_keys = ON');
  registerMigrationHelpers(db);
  runMigrations(db, networkMigrationsDir());
  return new NetworkDb(db, networkId, path.join(dataDir, 'data.db'));
}

/** Вставить мысль напрямую (чтобы владелец вложения существовал). */
function seedThought(ndb: NetworkDb, title: string): string {
  const id = `t-${Math.random().toString(36).slice(2)}-${title}`;
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, type_id, icon, icon_kind, active,
                             is_protected, is_root, fg_color, bg_color,
                             font_bold, font_italic, font_underline, font_strike, font_manual,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, NULL, NULL, 'emoji', 1, 0, 0, NULL, NULL, 0, 0, 0, 0, 0,
               1, '2026-01-01T00:00:00.000Z', ?, '2026-01-01T00:00:00.000Z', ?)`,
    )
    .run(id, title, title.toLowerCase(), ACTOR, ACTOR);
  return id;
}

/** Снимок мысли с вложениями (файл + url). */
function snapshotWithAttachments(
  title: string,
  sourceId: string,
  attachments: ThoughtCopyItem['attachments'],
): ThoughtCopyItem {
  return { ...snapshot(title), source_id: sourceId, attachments } as unknown as ThoughtCopyItem;
}

describe(
  'copyThoughtsBatch — вложения (межсетевое копирование)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('межсетевое: файл мысли физически копируется в целевую сеть и читается', () => {
      const srcDir = mkdtempSync(path.join(os.tmpdir(), 'etn-src-'));
      const tgtDir = mkdtempSync(path.join(os.tmpdir(), 'etn-tgt-'));
      const source = makeFileDb(srcDir, 'source-net');
      const target = makeFileDb(tgtDir, 'target-net');
      try {
        const seed = seedThought(source, 'Источник');
        const pasteTarget = seedThought(target, 'Paste target');
        const stored = createAttachmentFile(
          source,
          'thought',
          seed,
          {
            title: 'План',
            mime_type: 'text/plain',
            data_base64: Buffer.from('hello attachment').toString('base64'),
          },
          ACTOR,
        );
        const sourcePath = stored.file_path!;
        assert.ok(existsSync(sourcePath));

        const input: ThoughtCopyInput = {
          source_network_id: 'source-net',
          parent_thought_id: pasteTarget,
          thoughts: [
            snapshotWithAttachments('Копия', 'src-1', [
              { kind: 'file', file_path: sourcePath, file_size: stored.file_size, mime_type: 'text/plain', title: 'План' },
              { kind: 'url', url: 'https://e.com/x', title: 'Ссылка' },
            ]),
          ],
          links: [],
        };
        const copier = makeCopyFileCopier(target, input, path.join(srcDir, 'attachments'));
        assert.ok(copier, 'межсетевое копирование должно создать планировщик');

        const result = copyThoughtsBatch(target, input, ACTOR, { fileCopier: copier });
        copier.commit();

        const fileAtt = result.created_attachments.find((a) => a.kind === 'file')!;
        assert.ok(fileAtt.file_path !== null);
        assert.notEqual(fileAtt.file_path, sourcePath, 'file_path копии не должен указывать на источник');
        assert.equal(path.dirname(fileAtt.file_path!), path.join(tgtDir, 'attachments'));
        assert.match(path.basename(fileAtt.file_path!), /-2\.txt$/, 'копия получает суффикс -2');
        assert.ok(existsSync(fileAtt.file_path!), 'файл копии должен существовать');
        assert.equal(readFileSync(fileAtt.file_path!).toString(), 'hello attachment');

        // Копия читается сервером как вложение целевой сети (не 404).
        const raw = getAttachmentRawByPath(target, fileAtt.file_path!);
        assert.equal(raw.body.toString(), 'hello attachment');
        assert.equal(raw.mime_type, 'text/plain');

        // URL-вложение переносится без файла.
        const urlAtt = result.created_attachments.find((a) => a.kind === 'url')!;
        assert.equal(urlAtt.url, 'https://e.com/x');
      } finally {
        source.close();
        target.close();
        rmSync(srcDir, { recursive: true, force: true });
        rmSync(tgtDir, { recursive: true, force: true });
      }
    });

    it('межсетевое: вложение связи тоже переносит файл', () => {
      const srcDir = mkdtempSync(path.join(os.tmpdir(), 'etn-src-'));
      const tgtDir = mkdtempSync(path.join(os.tmpdir(), 'etn-tgt-'));
      const source = makeFileDb(srcDir, 'src-net');
      const target = makeFileDb(tgtDir, 'tgt-net');
      try {
        const seed = seedThought(source, 'Источник');
        const pasteTarget = seedThought(target, 'Paste target');
        const stored = createAttachmentFile(
          source,
          'thought',
          seed,
          { title: 'Вложение связи', mime_type: 'text/plain', data_base64: Buffer.from('link bytes').toString('base64') },
          ACTOR,
        );

        const link: ThoughtCopyLink = {
          source_id: 'src-a',
          target_id: 'src-b',
          type: { id: null, name_forward: null, name_reverse: null },
          color: null,
          style: null,
          width: null,
          active: true,
          attachments: [
            { kind: 'file', file_path: stored.file_path, file_size: stored.file_size, mime_type: 'text/plain', title: 'Вложение связи' },
          ],
        };
        const input: ThoughtCopyInput = {
          source_network_id: 'src-net',
          parent_thought_id: pasteTarget,
          thoughts: [
            snapshotWithAttachments('A', 'src-a', []),
            snapshotWithAttachments('B', 'src-b', []),
          ],
          links: [link],
        };
        const copier = makeCopyFileCopier(target, input, path.join(srcDir, 'attachments'))!;
        const result = copyThoughtsBatch(target, input, ACTOR, { fileCopier: copier });
        copier.commit();

        const linkAtt = result.created_attachments.find((a) => a.owner_type === 'link')!;
        assert.ok(linkAtt, 'вложение связи должно быть создано');
        assert.equal(linkAtt.kind, 'file');
        assert.notEqual(linkAtt.file_path, stored.file_path);
        assert.equal(path.dirname(linkAtt.file_path!), path.join(tgtDir, 'attachments'));
        assert.ok(existsSync(linkAtt.file_path!));
        assert.equal(readFileSync(linkAtt.file_path!).toString(), 'link bytes');
      } finally {
        source.close();
        target.close();
        rmSync(srcDir, { recursive: true, force: true });
        rmSync(tgtDir, { recursive: true, force: true });
      }
    });

    it('внутрисетевое: файл не дублируется, file_path сохраняется', () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'etn-intra-'));
      const ndb = makeFileDb(dir, 'same-net');
      try {
        const seed = seedThought(ndb, 'Источник');
        const pasteTarget = seedThought(ndb, 'Paste target');
        const stored = createAttachmentFile(
          ndb,
          'thought',
          seed,
          { title: 'Файл', mime_type: 'text/plain', data_base64: Buffer.from('shared').toString('base64') },
          ACTOR,
        );
        const attDir = path.join(dir, 'attachments');
        const before = readdirSync(attDir).length;

        const input: ThoughtCopyInput = {
          source_network_id: 'same-net',
          parent_thought_id: pasteTarget,
          thoughts: [
            snapshotWithAttachments('Копия', 'src-1', [
              { kind: 'file', file_path: stored.file_path, mime_type: 'text/plain', title: 'Файл' },
            ]),
          ],
          links: [],
        };
        // Внутри сети планировщик не создаётся — файл шарится.
        const copier = makeCopyFileCopier(ndb, input, attDir);
        assert.equal(copier, null, 'внутрисетевое копирование не копирует файлы');

        const result = copyThoughtsBatch(ndb, input, ACTOR, { fileCopier: copier });

        const fileAtt = result.created_attachments.find((a) => a.kind === 'file')!;
        assert.equal(fileAtt.file_path, stored.file_path, 'file_path должен переноситься как есть');
        assert.equal(readdirSync(attDir).length, before, 'новых файлов появиться не должно');
      } finally {
        ndb.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('межсетевое: имя копии не сталкивается с уже существующим файлом', () => {
      const srcDir = mkdtempSync(path.join(os.tmpdir(), 'etn-src-'));
      const tgtDir = mkdtempSync(path.join(os.tmpdir(), 'etn-tgt-'));
      const source = makeFileDb(srcDir, 'source-net');
      const target = makeFileDb(tgtDir, 'target-net');
      try {
        const seed = seedThought(source, 'Источник');
        const pasteTarget = seedThought(target, 'Paste target');
        const stored = createAttachmentFile(
          source,
          'thought',
          seed,
          { title: 'Doc', mime_type: 'text/plain', data_base64: Buffer.from('v').toString('base64') },
          ACTOR,
        );
        // Занимаем имя будущей первой копии (`<stem>-2.txt`).
        const stem = path.basename(stored.file_path!, '.txt');
        const tgtAttDir = path.join(tgtDir, 'attachments');
        mkdirSync(tgtAttDir, { recursive: true });
        writeFileSync(path.join(tgtAttDir, `${stem}-2.txt`), 'occupied');

        const input: ThoughtCopyInput = {
          source_network_id: 'source-net',
          parent_thought_id: pasteTarget,
          thoughts: [
            snapshotWithAttachments('Doc copy', 'src-1', [
              { kind: 'file', file_path: stored.file_path, mime_type: 'text/plain', title: 'Doc' },
            ]),
          ],
          links: [],
        };
        const copier = makeCopyFileCopier(target, input, path.join(srcDir, 'attachments'))!;
        const result = copyThoughtsBatch(target, input, ACTOR, { fileCopier: copier });
        copier.commit();
        const fileAtt = result.created_attachments.find((a) => a.kind === 'file')!;
        assert.match(path.basename(fileAtt.file_path!), /-3\.txt$/, 'занятое -2 сдвигает копию на -3');
      } finally {
        source.close();
        target.close();
        rmSync(srcDir, { recursive: true, force: true });
        rmSync(tgtDir, { recursive: true, force: true });
      }
    });

    it('межсетевое: отсутствующий исходный файл не роняет копию (метаданные как есть)', () => {
      const srcDir = mkdtempSync(path.join(os.tmpdir(), 'etn-src-'));
      const tgtDir = mkdtempSync(path.join(os.tmpdir(), 'etn-tgt-'));
      const source = makeFileDb(srcDir, 'source-net');
      const target = makeFileDb(tgtDir, 'target-net');
      try {
        const seed = seedThought(source, 'Источник');
        const pasteTarget = seedThought(target, 'Paste target');
        const stored = createAttachmentFile(
          source,
          'thought',
          seed,
          { title: 'Gone', mime_type: 'text/plain', data_base64: Buffer.from('x').toString('base64') },
          ACTOR,
        );
        const sourcePath = stored.file_path!;
        rmSync(sourcePath); // файл пропал, метаданные остались

        const warnings: string[] = [];
        const input: ThoughtCopyInput = {
          source_network_id: 'source-net',
          parent_thought_id: pasteTarget,
          thoughts: [
            snapshotWithAttachments('Gone copy', 'src-1', [
              { kind: 'file', file_path: sourcePath, mime_type: 'text/plain', title: 'Gone' },
            ]),
          ],
          links: [],
        };
        const copier = makeCopyFileCopier(target, input, path.join(srcDir, 'attachments'), (msg) =>
          warnings.push(msg),
        )!;
        const result = copyThoughtsBatch(target, input, ACTOR, { fileCopier: copier });
        copier.commit();

        const fileAtt = result.created_attachments.find((a) => a.kind === 'file')!;
        assert.equal(fileAtt.file_path, sourcePath, 'метаданные сохраняются как есть');
        assert.ok(warnings.length >= 1, 'отсутствие файла должно быть залогировано');
      } finally {
        source.close();
        target.close();
        rmSync(srcDir, { recursive: true, force: true });
        rmSync(tgtDir, { recursive: true, force: true });
      }
    });
  },
);

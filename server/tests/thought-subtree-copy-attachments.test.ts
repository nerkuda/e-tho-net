/**
 * Регресс ошибки b83a7d89 для MCP-пути `etn.thoughts.copy_subtree`.
 *
 * При межсетевом копировании файлы вложений должен коммитить ВЫЗЫВАЮЩИЙ —
 * ПОСЛЕ фиксации внешней транзакции. Иначе, если фасад (`runWrite`) откатит
 * транзакцию после `copySubtree`, в каталоге целевой сети останется
 * файл-сирота, хотя строки БД откатились.
 *
 * Тест и есть модель фасада: он оборачивает `copySubtree` во внешнюю
 * `target.transaction(...)`, при откате НЕ вызывает `fileCopier.commit()` и
 * проверяет, что целевой каталог вложений пуст. Возврат старого порядка
 * (commit внутри `copySubtree`) делает тест красным.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { AttachmentFileCopier, createAttachmentFile, listAttachments } from '../src/domain/attachment-service.js';
import { NetworkDb, registerMigrationHelpers } from '../src/db/network-db.js';
import { runMigrations } from '../src/db/migrator.js';
import { networkMigrationsDir } from '../src/paths.js';
import { copySubtree, type CopySubtreeParams } from '../src/domain/thought-subtree-copy-service.js';
import { createThought } from '../src/domain/thought-service.js';

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

/** Сетевая БД с файловым расположением (`attachments/` рядом с `data.db`). */
function makeFileDb(dataDir: string, networkId: string): NetworkDb {
  const db = new DatabaseConstructor(':memory:');
  db.pragma('foreign_keys = ON');
  registerMigrationHelpers(db);
  runMigrations(db, networkMigrationsDir());
  return new NetworkDb(db, networkId, path.join(dataDir, 'data.db'));
}

/** Мир: сеть-источник с мыслью-корнем и файловым вложением + целевая сеть. */
function makeWorld(): {
  src: NetworkDb;
  dst: NetworkDb;
  srcDir: string;
  tgtDir: string;
  rootId: string;
  sourceFilePath: string;
  cleanup(): void;
} {
  const srcDir = mkdtempSync(path.join(os.tmpdir(), 'etn-sub-src-'));
  const tgtDir = mkdtempSync(path.join(os.tmpdir(), 'etn-sub-tgt-'));
  const src = makeFileDb(srcDir, 'src-net');
  const dst = makeFileDb(tgtDir, 'tgt-net');
  const rootId = createThought(src, { title: 'Корень с файлом' }, ACTOR).id;
  const stored = createAttachmentFile(
    src,
    'thought',
    rootId,
    { title: 'Файл', mime_type: 'text/plain', data_base64: Buffer.from('subtree bytes').toString('base64') },
    ACTOR,
  );
  return {
    src,
    dst,
    srcDir,
    tgtDir,
    rootId,
    sourceFilePath: stored.file_path!,
    cleanup() {
      src.close();
      dst.close();
      rmSync(srcDir, { recursive: true, force: true });
      rmSync(tgtDir, { recursive: true, force: true });
    },
  };
}

function params(
  src: NetworkDb,
  dst: NetworkDb,
  rootId: string,
  fileCopier: AttachmentFileCopier | null,
): CopySubtreeParams {
  return {
    source_ndb: src,
    target_ndb: dst,
    root_thought_ids: [rootId],
    max_depth: 1,
    include: ['thought', 'attachments'],
    duplicate_policy: 'create_always',
    target_parent_thought_id: '',
    actor_user_id: ACTOR,
    fileCopier,
  };
}

/** Файлов в каталоге вложений цели (0, если каталога ещё нет). */
function targetFileCount(tgtDir: string): number {
  const dir = path.join(tgtDir, 'attachments');
  return existsSync(dir) ? readdirSync(dir).length : 0;
}

describe(
  'copySubtree — файлы вложений коммитит вызывающий (b83a7d89)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('успешная внешняя транзакция: вызывающий коммитит — файл в целевой сети есть', () => {
      const w = makeWorld();
      try {
        const copier = new AttachmentFileCopier(w.dst, path.join(w.srcDir, 'attachments'));
        const summary = w.dst.transaction(() =>
          copySubtree(params(w.src, w.dst, w.rootId, copier)),
        );
        copier.commit();

        const dstRoot = summary.thought_id_map[w.rootId]!;
        const atts = listAttachments(w.dst, 'thought', dstRoot);
        assert.equal(atts.length, 1);
        assert.ok(existsSync(atts[0]!.file_path!), 'файл копии должен существовать');
        assert.equal(targetFileCount(w.tgtDir), 1);
      } finally {
        w.cleanup();
      }
    });

    it('откат внешней транзакции: осиротевшего файла в целевой сети НЕ остаётся', () => {
      const w = makeWorld();
      try {
        const copier = new AttachmentFileCopier(w.dst, path.join(w.srcDir, 'attachments'));
        // Модель фасада `runWrite`, которая откатывается после copySubtree.
        assert.throws(() => {
          w.dst.transaction(() => {
            copySubtree(params(w.src, w.dst, w.rootId, copier));
            throw new Error('boom');
          });
        }, /boom/);
        // Вызывающий не коммитит (исключение ушло наружу) — файлов быть не должно.
        assert.equal(targetFileCount(w.tgtDir), 0, 'на откате не должно остаться файлов-сирот');
        // И строк БД тоже нет.
        const rows = w.dst
          .prepare("SELECT COUNT(*) AS c FROM attachments_v WHERE kind = 'file'")
          .get() as { c: number };
        assert.equal(rows.c, 0);
      } finally {
        w.cleanup();
      }
    });
  },
);

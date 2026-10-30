/**
 * Регрессия ошибки b4ab6e94: sweep кэша markdown перезаписывал `body_html`
 * всех слоёв.
 *
 * `comments.id` — ЛОГИЧЕСКИЙ идентификатор: теневая копия слоя несёт id
 * предка, а у постоянных комментариев id ещё и детерминирован от владельца
 * (миграция 048). Поэтому `UPDATE comments SET body_html = ? WHERE id = ?`
 * попадал во все одноимённые строки всех слоёв: последняя обработанная строка
 * (тень) оставляла свой HTML и в основе. Физически адресует строку только
 * суррогатный `pk`.
 *
 * Сценарий (фикстуры — тексты реальной базы полигона «Тест 1», ошибка
 * b4ab6e94): постоянный комментарий мысли в основе и его тень в слое с другим
 * `body_md`; версия рендера сброшена на предыдущую, старт сервера запускает
 * sweep. Ожидание: у каждой строки HTML собственного `body_md`, повторный
 * старт после записи версии ничего не трогает (sentinel).
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { MD_RENDER_VERSION, renderMarkdown } from '@etn/markdown';
import { BASE_LAYER_ID } from '@etn/shared';

import { closeAll, openNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import { SystemDb } from '../src/db/system-db.js';
import { MARKDOWN_RENDER_SETTING, sweepCommentHtml } from '../src/domain/markdown-sweep.js';
import { createLogger } from '../src/logger.js';

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

/** Тень постоянного комментария — слой «Проверка 1» реальной базы полигона. */
const SHADOW_LAYER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/**
 * Тексты реальной базы (ошибка b4ab6e94): основа хранит «нет тут комментария»,
 * тень слоя — «Тут совсем другой комментарий…». В повреждённой базе HTML
 * основы уже был HTML-ом тени.
 */
const BASE_BODY_MD = 'нет тут комментария';
const SHADOW_BODY_MD = 'Тут совсем другой комментарий, созданный в слое "Проверка 1".';

describe(
  'markdown sweep — адресация строки слоя по pk (b4ab6e94)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    let dataDir: string;
    let systemDb: SystemDb;
    let networkId: string;
    let ndb: NetworkDb;
    let commentId: string;
    let ownerThoughtId: string;

    /** Физическая строка комментария (сырой INSERT — слои создаются намеренно). */
    function insertCommentRow(layerId: string, bodyMd: string): void {
      const now = new Date().toISOString();
      ndb
        .prepare(
          `INSERT INTO comments (id, layer_id, owner_type, owner_id, kind, title, body_md, body_html,
                                 valid_from, valid_to, version, created_at, updated_at, created_by, updated_by)
           VALUES (?, ?, 'thought', ?, 'permanent', NULL, ?, ?, ?, NULL, 1, ?, ?, 'tester', 'tester')`,
        )
        .run(
          commentId,
          layerId,
          ownerThoughtId,
          bodyMd,
          // Исходное состояние повреждённой базы: основа уже несёт HTML тени.
          layerId === BASE_LAYER_ID ? renderMarkdown(SHADOW_BODY_MD) : renderMarkdown(bodyMd),
          now,
          now,
          now,
        );
    }

    /** `body_html` физической строки указанного слоя. */
    function rowHtml(layerId: string): string {
      const row = ndb
        .prepare('SELECT body_html FROM comments WHERE id = ? AND layer_id = ?')
        .get(commentId, layerId) as { body_html: string } | undefined;
      assert.ok(row !== undefined, `строка комментария в слое ${layerId} не найдена`);
      return row.body_html;
    }

    before(() => {
      const log = createLogger('silent');
      dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-md-sweep-'));
      systemDb = SystemDb.open(dataDir, log);

      const ownerId = randomUUID();
      systemDb.createUser({ id: ownerId, username: `u-${ownerId}`, displayName: 'U' });
      networkId = randomUUID();
      systemDb.createNetworkRow(networkId, ownerId, 'Сеть sweep', null);

      ndb = openNetworkDb(dataDir, networkId, log);
      const now = new Date().toISOString();
      ndb
        .prepare(
          `INSERT INTO layers (id, parent_id, title, is_base, depth, created_by, created_at, last_activity_at)
           VALUES (?, ?, 'Проверка 1', 0, 1, 'tester', ?, ?)`,
        )
        .run(SHADOW_LAYER_ID, BASE_LAYER_ID, now, now);

      commentId = randomUUID();
      ownerThoughtId = randomUUID();
      insertCommentRow(BASE_LAYER_ID, BASE_BODY_MD);
      insertCommentRow(SHADOW_LAYER_ID, SHADOW_BODY_MD);
    });

    after(() => {
      closeAll();
      systemDb.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    });

    it('перерисовывает каждую строку слоя из её собственного body_md', () => {
      // Предыдущая версия конвейера — как на старте после подъёма MD_RENDER_VERSION.
      systemDb.setSetting(MARKDOWN_RENDER_SETTING, 'markdown-it/11');

      sweepCommentHtml(dataDir, systemDb, createLogger('silent'));

      assert.equal(rowHtml(BASE_LAYER_ID), renderMarkdown(BASE_BODY_MD), 'основа получила HTML тени');
      assert.equal(rowHtml(SHADOW_LAYER_ID), renderMarkdown(SHADOW_BODY_MD));
      assert.equal(systemDb.getSetting(MARKDOWN_RENDER_SETTING), MD_RENDER_VERSION);
    });

    it('повторный старт идемпотентен: версия отмечена, строки не тронуты', () => {
      const sentinel = '<p>SENTINEL: не трогать</p>';
      ndb
        .prepare('UPDATE comments SET body_html = ? WHERE id = ? AND layer_id = ?')
        .run(sentinel, commentId, BASE_LAYER_ID);

      sweepCommentHtml(dataDir, systemDb, createLogger('silent'));

      assert.equal(rowHtml(BASE_LAYER_ID), sentinel, 'повторный sweep переписал строку при совпавшей версии');
      assert.equal(rowHtml(SHADOW_LAYER_ID), renderMarkdown(SHADOW_BODY_MD));
    });
  },
);

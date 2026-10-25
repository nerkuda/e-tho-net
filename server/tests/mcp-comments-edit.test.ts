/**
 * 0.7.2 — `etn.comments.edit` (задача d28abe04, спека 154df95d).
 *
 * Секционная правка комментария ops-ами одной транзакцией:
 * `append` / `prepend` / `replace_section` / `delete_section`.
 * Адресация — по тексту markdown-заголовка (виртуальная первая строка
 * для текстов без `#`). Ops применяются последовательно; ошибка любой
 * откатывает весь вызов.
 *
 * Тесты гоняются против реального MCP-фасада через in-memory transport:
 * видят ту же валидацию, что агент, и тот же контракт записи в БД
 * (включая журнал активности и audit_log).
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  nativeAvailable,
  toolJson,
  toolText,
  upsertPermanentViaWrite,
} from './mcp-helpers.js';
import { openNetworkDb } from '../src/db/network-db.js';

interface EditResult {
  id: string;
  version: number;
  sections: string[];
  chars_total: number;
  request_id?: string;
}

interface CommentBody {
  body_md: string;
  version: number;
}

/** Создать мысль и вернуть её id — нужно для адресации `thought_id`. */
function makeThought(
  ndb: ReturnType<typeof openNetworkDb>,
  title: string,
  adminId: string,
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, layer_id, title, title_norm, type_id, icon, icon_kind,
                             icon_attachment_id, active, is_protected, is_root,
                             marked_for_deletion, version, created_at, updated_at,
                             created_by, updated_by, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, NULL, NULL, 'emoji', NULL, 1, 0, 0,
               0, 1, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, ndb.layerId, title, title.toLowerCase(), now, now, adminId, adminId,
         Date.now(), Date.now());
  return id;
}

/** Прочитать текущее тело и версию комментария напрямую из БД (минуя preview). */
function readBody(
  ndb: ReturnType<typeof openNetworkDb>,
  commentId: string,
): CommentBody {
  const row = ndb
    .prepare('SELECT body_md, version FROM comments_v WHERE id = ?')
    .get(commentId) as { body_md: string; version: number } | undefined;
  assert.ok(row, `comment ${commentId} must exist`);
  return row;
}

describe('etn.comments.edit (0.7.2)', { skip: !nativeAvailable() }, () => {
  it('append к одной секции: добавляет в конец с одним разделителем', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtId = makeThought(ndb, 'edit-append', ctx.adminId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const upserted = await upsertPermanentViaWrite(handle.client, ctx.networkId, thoughtId, '## Раздел\nИзначальный текст');
        const result = toolJson<EditResult>(
          await handle.client.callTool({
            name: 'etn.comments.edit',
            arguments: {
              network_id: ctx.networkId,
              comment_id: upserted.id,
              ops: [{ op: 'append', text: 'Добавка' }],
            },
          }),
        );
        assert.equal(result.version, 2);
        assert.deepEqual(result.sections, ['Раздел']);
        assert.equal(typeof result.chars_total, 'number');
        assert.ok(result.chars_total > 0);
        const body = readBody(ndb, upserted.id);
        assert.equal(body.body_md, '## Раздел\nИзначальный текст\n\nДобавка');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('повторный append не плодит тройные переводы строки', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtId = makeThought(ndb, 'edit-append-2', ctx.adminId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const upserted = await upsertPermanentViaWrite(handle.client, ctx.networkId, thoughtId, '## Раздел\nA');
        // Делаем три append подряд; между блоками не должно быть `\n\n\n`.
        for (let i = 0; i < 3; i++) {
          await handle.client.callTool({
            name: 'etn.comments.edit',
            arguments: {
              network_id: ctx.networkId,
              comment_id: upserted.id,
              ops: [{ op: 'append', text: `Добавка ${i}` }],
            },
          });
        }
        const body = readBody(ndb, upserted.id);
        assert.ok(
          !body.body_md.includes('\n\n\n'),
          `тройной перевод строки не должен появляться, body=${JSON.stringify(body.body_md)}`,
        );
        // Каждый append даёт ровно одну пустую строку-разделитель.
        assert.equal(body.body_md, '## Раздел\nA\n\nДобавка 0\n\nДобавка 1\n\nДобавка 2');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('prepend к началу: добавляет с одним разделителем', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtId = makeThought(ndb, 'edit-prepend', ctx.adminId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const upserted = await upsertPermanentViaWrite(handle.client, ctx.networkId, thoughtId, '## Раздел\nТело');
        const result = toolJson<EditResult>(
          await handle.client.callTool({
            name: 'etn.comments.edit',
            arguments: {
              network_id: ctx.networkId,
              comment_id: upserted.id,
              ops: [{ op: 'prepend', text: 'Преамбула' }],
            },
          }),
        );
        assert.equal(result.version, 2);
        const body = readBody(ndb, upserted.id);
        assert.equal(body.body_md, 'Преамбула\n\n## Раздел\nТело');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('replace_section с тем же уровнем заголовка', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtId = makeThought(ndb, 'edit-replace', ctx.adminId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const upserted = await upsertPermanentViaWrite(handle.client, ctx.networkId, thoughtId, [
                '## Запрет',
                'Нельзя делать X.',
                '',
                '## Прочее',
                'Оставить как есть.',
              ].join('\n'));
        const result = toolJson<EditResult>(
          await handle.client.callTool({
            name: 'etn.comments.edit',
            arguments: {
              network_id: ctx.networkId,
              comment_id: upserted.id,
              ops: [
                {
                  op: 'replace_section',
                  section: 'Запрет',
                  text: '## Запрет\nНельзя делать Y.',
                },
              ],
            },
          }),
        );
        assert.equal(result.version, 2);
        assert.deepEqual(result.sections, ['Запрет', 'Прочее']);
        const body = readBody(ndb, upserted.id);
        assert.equal(
          body.body_md,
          ['## Запрет', 'Нельзя делать Y.', '', '## Прочее', 'Оставить как есть.'].join('\n'),
        );
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('replace_section с текстом без заголовка — заголовок добавляется автоматически', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtId = makeThought(ndb, 'edit-replace-nohead', ctx.adminId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const upserted = await upsertPermanentViaWrite(handle.client, ctx.networkId, thoughtId, '## Запрет\nСтарое содержимое');
        const result = toolJson<EditResult>(
          await handle.client.callTool({
            name: 'etn.comments.edit',
            arguments: {
              network_id: ctx.networkId,
              comment_id: upserted.id,
              ops: [
                {
                  op: 'replace_section',
                  section: 'Запрет',
                  text: 'Новое содержимое без заголовка',
                },
              ],
            },
          }),
        );
        assert.equal(result.version, 2);
        const body = readBody(ndb, upserted.id);
        assert.equal(body.body_md, '## Запрет\nНовое содержимое без заголовка');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('delete_section удаляет одну секцию, остальные остаются', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtId = makeThought(ndb, 'edit-delete', ctx.adminId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const upserted = await upsertPermanentViaWrite(handle.client, ctx.networkId, thoughtId, [
                '## A',
                'один',
                '',
                '## B',
                'два',
                '',
                '## C',
                'три',
              ].join('\n'));
        const result = toolJson<EditResult>(
          await handle.client.callTool({
            name: 'etn.comments.edit',
            arguments: {
              network_id: ctx.networkId,
              comment_id: upserted.id,
              ops: [{ op: 'delete_section', section: 'B' }],
            },
          }),
        );
        assert.deepEqual(result.sections, ['A', 'C']);
        const body = readBody(ndb, upserted.id);
        assert.equal(
          body.body_md,
          ['## A', 'один', '', '## C', 'три'].join('\n'),
        );
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('delete_section единственной секции оставляет пустое тело, но запись сохраняется', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtId = makeThought(ndb, 'edit-delete-only', ctx.adminId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const upserted = await upsertPermanentViaWrite(handle.client, ctx.networkId, thoughtId, '## Только');
        const result = toolJson<EditResult>(
          await handle.client.callTool({
            name: 'etn.comments.edit',
            arguments: {
              network_id: ctx.networkId,
              comment_id: upserted.id,
              ops: [{ op: 'delete_section', section: 'Только' }],
            },
          }),
        );
        assert.equal(result.version, 2);
        assert.deepEqual(result.sections, []);
        assert.equal(result.chars_total, 0);
        // Запись в БД жива.
        const still = readBody(ndb, upserted.id);
        assert.equal(still.body_md, '');
        assert.equal(still.version, 2);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('неизвестный заголовок → NOT_FOUND со списком доступных', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtId = makeThought(ndb, 'edit-not-found', ctx.adminId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const upserted = await upsertPermanentViaWrite(handle.client, ctx.networkId, thoughtId, ['## Альфа', 'A', '', '## Бета', 'B'].join('\n'));
        const err = await handle.client.callTool({
          name: 'etn.comments.edit',
          arguments: {
            network_id: ctx.networkId,
            comment_id: upserted.id,
            ops: [{ op: 'replace_section', section: 'Гамма', text: '?' }],
          },
        });
        assert.equal(err.isError, true);
        const text = toolText(err);
        assert.match(text, /NOT_FOUND/);
        assert.match(text, /sections/);
        assert.match(text, /Альфа/);
        assert.match(text, /Бета/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('повторяющиеся заголовки одного уровня → VALIDATION_ERROR', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtId = makeThought(ndb, 'edit-dupes', ctx.adminId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const upserted = await upsertPermanentViaWrite(handle.client, ctx.networkId, thoughtId, ['## Дубль', 'A', '', '## Дубль', 'B'].join('\n'));
        const err = await handle.client.callTool({
          name: 'etn.comments.edit',
          arguments: {
            network_id: ctx.networkId,
            comment_id: upserted.id,
            ops: [{ op: 'append', text: 'хвост' }],
          },
        });
        assert.equal(err.isError, true);
        assert.match(toolText(err), /VALIDATION_ERROR/);
        assert.match(toolText(err), /Дубль/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('текст без `#`: ops адресуются по виртуальной первой строке', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtId = makeThought(ndb, 'edit-virtual', ctx.adminId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const upserted = await upsertPermanentViaWrite(handle.client, ctx.networkId, thoughtId, 'Просто текст без заголовков.\nВторая строка.');
        const result = toolJson<EditResult>(
          await handle.client.callTool({
            name: 'etn.comments.edit',
            arguments: {
              network_id: ctx.networkId,
              comment_id: upserted.id,
              ops: [{ op: 'append', text: 'Добавка' }],
            },
          }),
        );
        // Виртуальный заголовок — первая непустая строка, обрезанная до 255.
        assert.deepEqual(result.sections, ['Просто текст без заголовков.']);
        const body = readBody(ndb, upserted.id);
        // Сам текст не меняется (нет `#`), добавка идёт через разделитель.
        assert.equal(
          body.body_md,
          'Просто текст без заголовков.\nВторая строка.\n\nДобавка',
        );

        // Replace_section по виртуальному заголовку — заменяет «единственную»
        // секцию целиком; сам виртуальный заголовок не сохраняется, тело
        // становится равным переданному `text` (спека 154df95d: «Заголовок
        // НЕ сохраняется, текст замены целиком замещает секцию»).
        const replace = toolJson<EditResult>(
          await handle.client.callTool({
            name: 'etn.comments.edit',
            arguments: {
              network_id: ctx.networkId,
              comment_id: upserted.id,
              ops: [
                {
                  op: 'replace_section',
                  section: 'Просто текст без заголовков.',
                  text: 'Совершенно новый текст\nСо второй строкой',
                },
              ],
            },
          }),
        );
        // Новая первая строка становится новым виртуальным заголовком.
        assert.deepEqual(replace.sections, ['Совершенно новый текст']);
        const after = readBody(ndb, upserted.id);
        assert.equal(
          after.body_md,
          'Совершенно новый текст\nСо второй строкой',
        );
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('вводный абзац перед `##`-секциями адресуем как виртуальная секция (ошибка a39046d9)', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtId = makeThought(ndb, 'edit-preamble', ctx.adminId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const upserted = await upsertPermanentViaWrite(
          handle.client,
          ctx.networkId,
          thoughtId,
          'Вводный абзац до первого заголовка.\n\n## Раздел\nТекст раздела',
        );
        // Вводный абзац виден в `sections[]` — по первой непустой строке.
        const append = toolJson<EditResult>(
          await handle.client.callTool({
            name: 'etn.comments.edit',
            arguments: {
              network_id: ctx.networkId,
              comment_id: upserted.id,
              ops: [{ op: 'append', text: 'Хвост' }],
            },
          }),
        );
        assert.deepEqual(append.sections, ['Вводный абзац до первого заголовка.', 'Раздел']);

        // replace_section по вводному абзацу НЕ трогает реальные секции.
        const replaced = toolJson<EditResult>(
          await handle.client.callTool({
            name: 'etn.comments.edit',
            arguments: {
              network_id: ctx.networkId,
              comment_id: upserted.id,
              ops: [
                {
                  op: 'replace_section',
                  section: 'Вводный абзац до первого заголовка.',
                  text: 'Новый вводный абзац.',
                },
              ],
            },
          }),
        );
        assert.deepEqual(replaced.sections, ['Новый вводный абзац.', 'Раздел']);
        assert.equal(
          readBody(ndb, upserted.id).body_md,
          'Новый вводный абзац.\n\n## Раздел\nТекст раздела\n\nХвост',
        );

        // delete_section по вводному абзацу оставляет заголовки нетронутыми.
        const deleted = toolJson<EditResult>(
          await handle.client.callTool({
            name: 'etn.comments.edit',
            arguments: {
              network_id: ctx.networkId,
              comment_id: upserted.id,
              ops: [{ op: 'delete_section', section: 'Новый вводный абзац.' }],
            },
          }),
        );
        assert.deepEqual(deleted.sections, ['Раздел']);
        assert.equal(readBody(ndb, upserted.id).body_md, '## Раздел\nТекст раздела\n\nХвост');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('транзакционность: [append_ok, replace_section_fail] → откат всего вызова', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtId = makeThought(ndb, 'edit-rollback', ctx.adminId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const initial = ['## X', 'раз', '', '## Y', 'два'].join('\n');
        const upserted = await upsertPermanentViaWrite(handle.client, ctx.networkId, thoughtId, initial);
        // Первая op прошла бы (append), но вторая — NOT_FOUND.
        const err = await handle.client.callTool({
          name: 'etn.comments.edit',
          arguments: {
            network_id: ctx.networkId,
            comment_id: upserted.id,
            ops: [
              { op: 'append', text: 'хвост' },
              { op: 'replace_section', section: 'Несуществующая', text: '!' },
            ],
          },
        });
        assert.equal(err.isError, true);
        assert.match(toolText(err), /NOT_FOUND/);
        // Тело и версия не изменились.
        const after = readBody(ndb, upserted.id);
        assert.equal(after.body_md, initial);
        assert.equal(after.version, 1);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('правильный expected_version — успех; неправильный — VERSION_CONFLICT без правки', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtId = makeThought(ndb, 'edit-version', ctx.adminId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const upserted = await upsertPermanentViaWrite(handle.client, ctx.networkId, thoughtId, '## X\nраз');

        // Корректный expected_version=1 → успех.
        const ok = toolJson<EditResult>(
          await handle.client.callTool({
            name: 'etn.comments.edit',
            arguments: {
              network_id: ctx.networkId,
              comment_id: upserted.id,
              expected_version: 1,
              ops: [{ op: 'append', text: 'хвост' }],
            },
          }),
        );
        assert.equal(ok.version, 2);

        // Теперь версия 2; передаём устаревший 1 → VERSION_CONFLICT, тело без изменений.
        const conflict = await handle.client.callTool({
          name: 'etn.comments.edit',
          arguments: {
            network_id: ctx.networkId,
            comment_id: upserted.id,
            expected_version: 1,
            ops: [{ op: 'append', text: 'ещё хвост' }],
          },
        });
        assert.equal(conflict.isError, true);
        assert.match(toolText(conflict), /VERSION_CONFLICT/);
        const after = readBody(ndb, upserted.id);
        assert.equal(after.version, 2);
        assert.ok(!after.body_md.endsWith('ещё хвост'), 'тело не изменилось');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('адресация по thought_id (постоянный комментарий мысли)', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtId = makeThought(ndb, 'edit-by-thought', ctx.adminId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        await upsertPermanentViaWrite(handle.client, ctx.networkId, thoughtId, '## X\nраз');
        const result = toolJson<EditResult>(
          await handle.client.callTool({
            name: 'etn.comments.edit',
            arguments: {
              network_id: ctx.networkId,
              thought_id: thoughtId,
              ops: [{ op: 'append', text: 'хвост' }],
            },
          }),
        );
        assert.equal(result.version, 2);
        // Достаём постоянный комментарий мысли и убеждаемся, что запись обновилась.
        const row = ndb
          .prepare(
            `SELECT body_md, version FROM comments_v
             WHERE owner_type = 'thought' AND owner_id = ? AND kind = 'permanent'`,
          )
          .get(thoughtId) as { body_md: string; version: number };
        assert.equal(row.version, 2);
        assert.equal(row.body_md, '## X\nраз\n\nхвост');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('без одновременно comment_id и thought_id → VALIDATION_ERROR', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const err = await handle.client.callTool({
          name: 'etn.comments.edit',
          arguments: {
            network_id: ctx.networkId,
            ops: [{ op: 'append', text: 'хвост' }],
          },
        });
        assert.equal(err.isError, true);
        assert.match(toolText(err), /Invalid arguments|comment_id or thought_id/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('отсутствующий комментарий → NOT_FOUND', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const err = await handle.client.callTool({
          name: 'etn.comments.edit',
          arguments: {
            network_id: ctx.networkId,
            comment_id: '00000000-0000-4000-8000-0000000000aa',
            ops: [{ op: 'append', text: 'хвост' }],
          },
        });
        assert.equal(err.isError, true);
        assert.match(toolText(err), /NOT_FOUND/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('после успешного edit — событие в журнале активности', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtId = makeThought(ndb, 'edit-activity', ctx.adminId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const upserted = await upsertPermanentViaWrite(handle.client, ctx.networkId, thoughtId, '## X\nраз');
        await handle.client.callTool({
          name: 'etn.comments.edit',
          arguments: {
            network_id: ctx.networkId,
            comment_id: upserted.id,
            ops: [{ op: 'append', text: 'хвост' }],
          },
        });
        // Через `etn.activity.list` напрямую проверяем, что запись с типом
        // «comment» и действием «updated» появилась (тот же фасад, что
        // видит REST-клиент).
        const activity = toolJson<{ data: Array<{ entity_type: string; action: string; entity_id: string }> }>(
          await handle.client.callTool({
            name: 'etn.activity.list',
            arguments: { network_id: ctx.networkId, entity_type: 'comment' },
          }),
        );
        const entry = activity.data.find(
          (row) => row.entity_id === upserted.id && row.action === 'updated',
        );
        assert.ok(entry, 'в журнале должна появиться запись updated по комментарию');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});

/**
 * Ошибка f15f389e: `replace_section` по секции документа с вводным текстом
 * до первого заголовка задваивал заголовок (исходный `##` + заголовок из
 * replacement другого уровня) и дублировал имя секции в `sections[]`.
 * Вводный блок при этом терялся (вторая часть уже закрыта ошибкой a39046d9 —
 * вводный абзац адресуется как виртуальная секция).
 *
 * Принятое поведение: `replace_section` заменяет ТОЛЬКО тело адресованной
 * секции. Заголовок в `text` — необязательная эхо-строка: если её текст
 * совпадает с адресованным заголовком (уровень игнорируется), строка
 * отбрасывается и сохраняется исходный заголовок. Заголовок того же или
 * более высокого уровня с ДРУГИМ текстом (попытка переименования или
 * подмены секции) — `VALIDATION_ERROR`: молча оставлять пустой старый
 * заголовок (грабля 0.8.3) нельзя. Заголовок более низкого уровня — это
 * подраздел внутри тела, он допустим.
 */
describe('etn.comments.edit replace_section — заголовок и вводный блок (f15f389e)', { skip: !nativeAvailable() }, () => {
  /** Документ карточки: вводный абзац + две реальные секции. */
  const CARD_BODY = [
    'Вводный абзац до первого заголовка.',
    'Вторая строка вводного абзаца.',
    '',
    '## Заголовок A',
    'Старый контент A.',
    '',
    '## Заголовок B',
    'Контент B.',
  ].join('\n');

  it('кейс карточки: заголовок из replacement не задваивается, вводный блок цел', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtId = makeThought(ndb, 'edit-card-case', ctx.adminId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const upserted = await upsertPermanentViaWrite(handle.client, ctx.networkId, thoughtId, CARD_BODY);
        const result = toolJson<EditResult>(
          await handle.client.callTool({
            name: 'etn.comments.edit',
            arguments: {
              network_id: ctx.networkId,
              comment_id: upserted.id,
              // Реальный вызов из карточки: заголовок того же текста, но `###`.
              ops: [
                {
                  op: 'replace_section',
                  section: 'Заголовок A',
                  text: '### Заголовок A\n\nНовый контент A.',
                },
              ],
            },
          }),
        );
        assert.equal(result.version, 2);
        // Имя секции не дублируется в ответе.
        assert.deepEqual(result.sections, [
          'Вводный абзац до первого заголовка.',
          'Заголовок A',
          'Заголовок B',
        ]);
        assert.equal(new Set(result.sections).size, result.sections.length);
        const body = readBody(ndb, upserted.id).body_md;
        assert.equal(
          body,
          [
            'Вводный абзац до первого заголовка.',
            'Вторая строка вводного абзаца.',
            '',
            '## Заголовок A',
            'Новый контент A.',
            '',
            '## Заголовок B',
            'Контент B.',
          ].join('\n'),
        );
        // Исходный заголовок ровно один, заголовка из replacement нет.
        assert.equal(body.match(/Заголовок A/g)?.length, 1, body);
        assert.ok(!body.includes('### Заголовок A'), body);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('replace_section не первой секции: вводный блок и соседи не тронуты', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtId = makeThought(ndb, 'edit-middle-section', ctx.adminId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const upserted = await upsertPermanentViaWrite(handle.client, ctx.networkId, thoughtId, CARD_BODY);
        const result = toolJson<EditResult>(
          await handle.client.callTool({
            name: 'etn.comments.edit',
            arguments: {
              network_id: ctx.networkId,
              comment_id: upserted.id,
              ops: [
                {
                  op: 'replace_section',
                  section: 'Заголовок B',
                  text: '### Заголовок B\n\nНовый контент B.',
                },
              ],
            },
          }),
        );
        assert.deepEqual(result.sections, [
          'Вводный абзац до первого заголовка.',
          'Заголовок A',
          'Заголовок B',
        ]);
        assert.equal(
          readBody(ndb, upserted.id).body_md,
          [
            'Вводный абзац до первого заголовка.',
            'Вторая строка вводного абзаца.',
            '',
            '## Заголовок A',
            'Старый контент A.',
            '',
            '## Заголовок B',
            'Новый контент B.',
          ].join('\n'),
        );
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('документ без вводного текста: заголовок первой секции не задваивается', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtId = makeThought(ndb, 'edit-no-preamble', ctx.adminId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const upserted = await upsertPermanentViaWrite(
          handle.client,
          ctx.networkId,
          thoughtId,
          ['## Секция', 'Старое.', '', '## Хвост', 'Хвост.'].join('\n'),
        );
        const result = toolJson<EditResult>(
          await handle.client.callTool({
            name: 'etn.comments.edit',
            arguments: {
              network_id: ctx.networkId,
              comment_id: upserted.id,
              ops: [
                { op: 'replace_section', section: 'Секция', text: '### Секция\n\nНовое.' },
              ],
            },
          }),
        );
        assert.deepEqual(result.sections, ['Секция', 'Хвост']);
        assert.equal(
          readBody(ndb, upserted.id).body_md,
          ['## Секция', 'Новое.', '', '## Хвост', 'Хвост.'].join('\n'),
        );
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('документ только из вводного текста: замена виртуальной секции', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtId = makeThought(ndb, 'edit-only-preamble', ctx.adminId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const upserted = await upsertPermanentViaWrite(
          handle.client,
          ctx.networkId,
          thoughtId,
          'Только вводный текст без заголовков.',
        );
        const result = toolJson<EditResult>(
          await handle.client.callTool({
            name: 'etn.comments.edit',
            arguments: {
              network_id: ctx.networkId,
              comment_id: upserted.id,
              ops: [
                {
                  op: 'replace_section',
                  section: 'Только вводный текст без заголовков.',
                  text: 'Совершенно новый текст.',
                },
              ],
            },
          }),
        );
        assert.deepEqual(result.sections, ['Совершенно новый текст.']);
        assert.equal(readBody(ndb, upserted.id).body_md, 'Совершенно новый текст.');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('заголовок другого текста того же уровня → VALIDATION_ERROR, тело не меняется', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtId = makeThought(ndb, 'edit-rename-rejected', ctx.adminId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const initial = ['## Старое имя', 'Старое тело.', '', '## Хвост', 'Хвост.'].join('\n');
        const upserted = await upsertPermanentViaWrite(handle.client, ctx.networkId, thoughtId, initial);
        const err = await handle.client.callTool({
          name: 'etn.comments.edit',
          arguments: {
            network_id: ctx.networkId,
            comment_id: upserted.id,
            ops: [
              { op: 'replace_section', section: 'Старое имя', text: '## Новое имя\nНовое тело.' },
            ],
          },
        });
        assert.equal(err.isError, true);
        const text = toolText(err);
        assert.match(text, /VALIDATION_ERROR/);
        // Сообщение объясняет правило, а не просто «нельзя».
        assert.match(text, /heading/i);
        assert.match(text, /body/i);
        const after = readBody(ndb, upserted.id);
        assert.equal(after.body_md, initial);
        assert.equal(after.version, 1);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('заголовок более низкого уровня в начале text — допустимый подраздел', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtId = makeThought(ndb, 'edit-subsection', ctx.adminId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const upserted = await upsertPermanentViaWrite(handle.client, ctx.networkId, thoughtId, '## Секция\nСтарое.');
        const result = toolJson<EditResult>(
          await handle.client.callTool({
            name: 'etn.comments.edit',
            arguments: {
              network_id: ctx.networkId,
              comment_id: upserted.id,
              ops: [
                { op: 'replace_section', section: 'Секция', text: '### Подраздел\nТекст подраздела.' },
              ],
            },
          }),
        );
        assert.deepEqual(result.sections, ['Секция', 'Подраздел']);
        assert.equal(
          readBody(ndb, upserted.id).body_md,
          ['## Секция', '', '### Подраздел', 'Текст подраздела.'].join('\n'),
        );
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('эхо заголовка с 1–3 ведущими пробелами снимается (круг 1)', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtId = makeThought(ndb, 'edit-indented-echo', ctx.adminId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const upserted = await upsertPermanentViaWrite(
          handle.client,
          ctx.networkId,
          thoughtId,
          ['## Заголовок A', 'Старое.', '', '## Заголовок B', 'Хвост.'].join('\n'),
        );
        // markdown-it считает заголовком строку с 1–3 ведущими пробелами —
        // эхо обязано сниматься так же, как без отступа.
        for (const spaces of [1, 2, 3]) {
          const result = toolJson<EditResult>(
            await handle.client.callTool({
              name: 'etn.comments.edit',
              arguments: {
                network_id: ctx.networkId,
                comment_id: upserted.id,
                ops: [
                  {
                    op: 'replace_section',
                    section: 'Заголовок A',
                    text: `${' '.repeat(spaces)}## Заголовок A\nНовое ${spaces}.`,
                  },
                ],
              },
            }),
          );
          assert.deepEqual(result.sections, ['Заголовок A', 'Заголовок B']);
          const body = readBody(ndb, upserted.id).body_md;
          assert.equal(
            body,
            ['## Заголовок A', `Новое ${spaces}.`, '', '## Заголовок B', 'Хвост.'].join('\n'),
          );
          assert.equal(body.match(/^## Заголовок A$/gm)?.length, 1, body);
        }
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('4+ ведущих пробела — блок кода, а не заголовок: тело остаётся как есть', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtId = makeThought(ndb, 'edit-indented-code', ctx.adminId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const upserted = await upsertPermanentViaWrite(handle.client, ctx.networkId, thoughtId, '## Заголовок A\nСтарое.');
        const result = toolJson<EditResult>(
          await handle.client.callTool({
            name: 'etn.comments.edit',
            arguments: {
              network_id: ctx.networkId,
              comment_id: upserted.id,
              ops: [
                {
                  op: 'replace_section',
                  section: 'Заголовок A',
                  text: '    ## Заголовок A\nНовое.',
                },
              ],
            },
          }),
        );
        // Строка с четырьмя пробелами рендерится как код, а не как второй h2:
        // это тело секции, отступ не снимается.
        assert.deepEqual(result.sections, ['Заголовок A']);
        assert.equal(
          readBody(ndb, upserted.id).body_md,
          ['## Заголовок A', '    ## Заголовок A', 'Новое.'].join('\n'),
        );
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('fenced-блок не даёт секций и не рвётся при правке (круг 1)', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtId = makeThought(ndb, 'edit-fence', ctx.adminId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        // Внутри fence — заголовки (в том числе повторяющий адресованный и с
        // отступами): секциями они не считаются, validateSections молчит.
        const initial = [
          '## Секция',
          'Текст.',
          '',
          '```',
          '## Секция',
          '  ## поддельный',
          '   # тоже',
          '```',
          '',
          '## Хвост',
          'Хвост.',
        ].join('\n');
        const upserted = await upsertPermanentViaWrite(handle.client, ctx.networkId, thoughtId, initial);
        const result = toolJson<EditResult>(
          await handle.client.callTool({
            name: 'etn.comments.edit',
            arguments: {
              network_id: ctx.networkId,
              comment_id: upserted.id,
              ops: [{ op: 'append', text: 'Добавка' }],
            },
          }),
        );
        assert.deepEqual(result.sections, ['Секция', 'Хвост']);
        // Fence целиком сохранён — ни заголовков, ни пустых строк не добавилось.
        assert.equal(readBody(ndb, upserted.id).body_md, `${initial}\n\nДобавка`);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});

/**
 * Ошибка f15f389e, круг 2: fence и заголовки внутри контейнеров (список,
 * цитата). Круг 1 распознавал заголовки строчной регуляркой и не учитывал
 * префиксы контейнеров: fence, открытый в элементе списка, не считался кодом,
 * `## поддельный` внутри него становился секцией, и правка рвала документ
 * (`delete_section` терял закрывающий fence, реальный `## Хвост` и хвост).
 *
 * Решение: заголовки даёт `extractHeadings` из `@etn/markdown` по block-токенам
 * markdown-it — тот же разбор, что у рендерера (ADR 01ec1467). Секции —
 * только заголовки верхнего уровня (`tokenLevel === 0`); закрывающие решётки
 * `## X ##` нормализуются в `X`, как в рендере.
 */
describe('etn.comments.edit — контейнеры и fence (f15f389e, круг 2)', { skip: !nativeAvailable() }, () => {
  /** Документ блокера: fence открыт в элементе списка. */
  const LIST_FENCE = ['- ```', '  ## поддельный', '  ```', '## Хвост', 'хвост'].join('\n');

  it('fence в `- ` и `1. `: секции только реальные, тело не рвётся', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const orderedFence = ['1. ```', '   ## поддельный', '   ```', '## Хвост', 'хвост'].join('\n');
        const cases = [
          ['edit-list-fence', LIST_FENCE, '- ```'],
          ['edit-ordered-fence', orderedFence, '1. ```'],
        ] as const;
        for (const [title, initial, firstSection] of cases) {
          const thoughtId = makeThought(ndb, title, ctx.adminId);
          const upserted = await upsertPermanentViaWrite(handle.client, ctx.networkId, thoughtId, initial);
          const result = toolJson<EditResult>(
            await handle.client.callTool({
              name: 'etn.comments.edit',
              arguments: {
                network_id: ctx.networkId,
                comment_id: upserted.id,
                ops: [{ op: 'append', text: 'Добавка' }],
              },
            }),
          );
          assert.deepEqual(result.sections, [firstSection, 'Хвост'], title);
          assert.equal(readBody(ndb, upserted.id).body_md, `${initial}\n\nДобавка`, title);
        }
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('закрывающий fence с отступом 4 пробела внутри списка закрывает блок', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtId = makeThought(ndb, 'edit-list-close-indent', ctx.adminId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const initial = ['- пример:', '  ```', '    ## поддельный', '    ```', '## Хвост', 'хвост'].join('\n');
        const upserted = await upsertPermanentViaWrite(handle.client, ctx.networkId, thoughtId, initial);
        const result = toolJson<EditResult>(
          await handle.client.callTool({
            name: 'etn.comments.edit',
            arguments: {
              network_id: ctx.networkId,
              comment_id: upserted.id,
              ops: [{ op: 'append', text: 'Добавка' }],
            },
          }),
        );
        assert.deepEqual(result.sections, ['- пример:', 'Хвост']);
        assert.equal(readBody(ndb, upserted.id).body_md, `${initial}\n\nДобавка`);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('delete_section не находит «поддельный» и не теряет «Хвост» (документ блокера)', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtId = makeThought(ndb, 'edit-list-fence-delete', ctx.adminId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const upserted = await upsertPermanentViaWrite(handle.client, ctx.networkId, thoughtId, LIST_FENCE);
        const err = await handle.client.callTool({
          name: 'etn.comments.edit',
          arguments: {
            network_id: ctx.networkId,
            comment_id: upserted.id,
            ops: [{ op: 'delete_section', section: 'поддельный' }],
          },
        });
        assert.equal(err.isError, true);
        const text = toolText(err);
        assert.match(text, /NOT_FOUND/);
        assert.match(text, /Хвост/);
        // Тело и версия не изменились: удалять было нечего.
        const after = readBody(ndb, upserted.id);
        assert.equal(after.body_md, LIST_FENCE);
        assert.equal(after.version, 1);
        // Реальная секция «Хвост» адресуема, документ цел.
        const replaced = toolJson<EditResult>(
          await handle.client.callTool({
            name: 'etn.comments.edit',
            arguments: {
              network_id: ctx.networkId,
              comment_id: upserted.id,
              ops: [{ op: 'replace_section', section: 'Хвост', text: 'новый хвост' }],
            },
          }),
        );
        assert.deepEqual(replaced.sections, ['- ```', 'Хвост']);
        // Пересборка тела разделяет блоки пустой строкой (нормализация
        // joinSections); fence и реальный заголовок целы.
        assert.equal(
          readBody(ndb, upserted.id).body_md,
          ['- ```', '  ## поддельный', '  ```', '', '## Хвост', 'новый хвост'].join('\n'),
        );
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('`~~~`-fence не даёт секций', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtId = makeThought(ndb, 'edit-tilde-fence', ctx.adminId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const initial = ['~~~', '## поддельный', '~~~', '## Хвост', 'хвост'].join('\n');
        const upserted = await upsertPermanentViaWrite(handle.client, ctx.networkId, thoughtId, initial);
        const result = toolJson<EditResult>(
          await handle.client.callTool({
            name: 'etn.comments.edit',
            arguments: {
              network_id: ctx.networkId,
              comment_id: upserted.id,
              ops: [{ op: 'append', text: 'Добавка' }],
            },
          }),
        );
        assert.deepEqual(result.sections, ['~~~', 'Хвост']);
        assert.equal(readBody(ndb, upserted.id).body_md, `${initial}\n\nДобавка`);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('закрывающие решётки `## X ##` нормализуются в `X` (как у рендерера)', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtId = makeThought(ndb, 'edit-closing-hashes', ctx.adminId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const initial = ['## Заголовок A ##', 'Старое.', '', '## B', 'Хвост.'].join('\n');
        const upserted = await upsertPermanentViaWrite(handle.client, ctx.networkId, thoughtId, initial);
        const appended = toolJson<EditResult>(
          await handle.client.callTool({
            name: 'etn.comments.edit',
            arguments: {
              network_id: ctx.networkId,
              comment_id: upserted.id,
              ops: [{ op: 'append', text: 'Добавка' }],
            },
          }),
        );
        // Имя секции — без закрывающей последовательности, как в `<h2>`.
        assert.deepEqual(appended.sections, ['Заголовок A', 'B']);
        // append текст не пересобирает: исходная строка заголовка как есть.
        assert.equal(readBody(ndb, upserted.id).body_md, `${initial}\n\nДобавка`);
        // Адресация по нормализованному имени работает; пересборка тела
        // выдаёт заголовок в ATX-форме без закрывающих решёток.
        const replaced = toolJson<EditResult>(
          await handle.client.callTool({
            name: 'etn.comments.edit',
            arguments: {
              network_id: ctx.networkId,
              comment_id: upserted.id,
              ops: [{ op: 'replace_section', section: 'Заголовок A', text: 'Новое.' }],
            },
          }),
        );
        assert.deepEqual(replaced.sections, ['Заголовок A', 'B']);
        assert.equal(
          readBody(ndb, upserted.id).body_md,
          ['## Заголовок A', 'Новое.', '', '## B', 'Хвост.', '', 'Добавка'].join('\n'),
        );
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('вложенный список и цитата с fence: «поддельный» не секция', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const cases = [
          ['edit-quote-fence', ['> ```', '> ## поддельный', '> ```', '## Хвост', 'хвост'].join('\n'), '> ```'],
          [
            'edit-nested-list-fence',
            ['- пункт', '  - ```', '    ## поддельный', '    ```', '## Хвост', 'хвост'].join('\n'),
            '- пункт',
          ],
        ] as const;
        for (const [title, initial, firstSection] of cases) {
          const thoughtId = makeThought(ndb, title, ctx.adminId);
          const upserted = await upsertPermanentViaWrite(handle.client, ctx.networkId, thoughtId, initial);
          const result = toolJson<EditResult>(
            await handle.client.callTool({
              name: 'etn.comments.edit',
              arguments: {
                network_id: ctx.networkId,
                comment_id: upserted.id,
                ops: [{ op: 'append', text: 'Добавка' }],
              },
            }),
          );
          assert.deepEqual(result.sections, [firstSection, 'Хвост'], title);
          assert.equal(readBody(ndb, upserted.id).body_md, `${initial}\n\nДобавка`, title);
        }
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});


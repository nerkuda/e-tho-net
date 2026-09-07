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
        const upserted = toolJson<{ id: string }>(
          await handle.client.callTool({
            name: 'etn.comments.upsert',
            arguments: {
              network_id: ctx.networkId,
              owner_type: 'thought',
              owner_id: thoughtId,
              kind: 'permanent',
              body_md: '## Раздел\nИзначальный текст',
            },
          }),
        );
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
        const upserted = toolJson<{ id: string }>(
          await handle.client.callTool({
            name: 'etn.comments.upsert',
            arguments: {
              network_id: ctx.networkId,
              owner_type: 'thought',
              owner_id: thoughtId,
              kind: 'permanent',
              body_md: '## Раздел\nA',
            },
          }),
        );
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
        const upserted = toolJson<{ id: string }>(
          await handle.client.callTool({
            name: 'etn.comments.upsert',
            arguments: {
              network_id: ctx.networkId,
              owner_type: 'thought',
              owner_id: thoughtId,
              kind: 'permanent',
              body_md: '## Раздел\nТело',
            },
          }),
        );
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
        const upserted = toolJson<{ id: string }>(
          await handle.client.callTool({
            name: 'etn.comments.upsert',
            arguments: {
              network_id: ctx.networkId,
              owner_type: 'thought',
              owner_id: thoughtId,
              kind: 'permanent',
              body_md: [
                '## Запрет',
                'Нельзя делать X.',
                '',
                '## Прочее',
                'Оставить как есть.',
              ].join('\n'),
            },
          }),
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
        const upserted = toolJson<{ id: string }>(
          await handle.client.callTool({
            name: 'etn.comments.upsert',
            arguments: {
              network_id: ctx.networkId,
              owner_type: 'thought',
              owner_id: thoughtId,
              kind: 'permanent',
              body_md: '## Запрет\nСтарое содержимое',
            },
          }),
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
        const upserted = toolJson<{ id: string }>(
          await handle.client.callTool({
            name: 'etn.comments.upsert',
            arguments: {
              network_id: ctx.networkId,
              owner_type: 'thought',
              owner_id: thoughtId,
              kind: 'permanent',
              body_md: [
                '## A',
                'один',
                '',
                '## B',
                'два',
                '',
                '## C',
                'три',
              ].join('\n'),
            },
          }),
        );
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
        const upserted = toolJson<{ id: string }>(
          await handle.client.callTool({
            name: 'etn.comments.upsert',
            arguments: {
              network_id: ctx.networkId,
              owner_type: 'thought',
              owner_id: thoughtId,
              kind: 'permanent',
              body_md: '## Только',
            },
          }),
        );
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
        const upserted = toolJson<{ id: string }>(
          await handle.client.callTool({
            name: 'etn.comments.upsert',
            arguments: {
              network_id: ctx.networkId,
              owner_type: 'thought',
              owner_id: thoughtId,
              kind: 'permanent',
              body_md: ['## Альфа', 'A', '', '## Бета', 'B'].join('\n'),
            },
          }),
        );
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
        const upserted = toolJson<{ id: string }>(
          await handle.client.callTool({
            name: 'etn.comments.upsert',
            arguments: {
              network_id: ctx.networkId,
              owner_type: 'thought',
              owner_id: thoughtId,
              kind: 'permanent',
              body_md: ['## Дубль', 'A', '', '## Дубль', 'B'].join('\n'),
            },
          }),
        );
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
        const upserted = toolJson<{ id: string }>(
          await handle.client.callTool({
            name: 'etn.comments.upsert',
            arguments: {
              network_id: ctx.networkId,
              owner_type: 'thought',
              owner_id: thoughtId,
              kind: 'permanent',
              body_md: 'Просто текст без заголовков.\nВторая строка.',
            },
          }),
        );
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

  it('транзакционность: [append_ok, replace_section_fail] → откат всего вызова', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtId = makeThought(ndb, 'edit-rollback', ctx.adminId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const initial = ['## X', 'раз', '', '## Y', 'два'].join('\n');
        const upserted = toolJson<{ id: string }>(
          await handle.client.callTool({
            name: 'etn.comments.upsert',
            arguments: {
              network_id: ctx.networkId,
              owner_type: 'thought',
              owner_id: thoughtId,
              kind: 'permanent',
              body_md: initial,
            },
          }),
        );
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
        const upserted = toolJson<{ id: string }>(
          await handle.client.callTool({
            name: 'etn.comments.upsert',
            arguments: {
              network_id: ctx.networkId,
              owner_type: 'thought',
              owner_id: thoughtId,
              kind: 'permanent',
              body_md: '## X\nраз',
            },
          }),
        );

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
        await handle.client.callTool({
          name: 'etn.comments.upsert',
          arguments: {
            network_id: ctx.networkId,
            owner_type: 'thought',
            owner_id: thoughtId,
            kind: 'permanent',
            body_md: '## X\nраз',
          },
        });
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
        const upserted = toolJson<{ id: string }>(
          await handle.client.callTool({
            name: 'etn.comments.upsert',
            arguments: {
              network_id: ctx.networkId,
              owner_type: 'thought',
              owner_id: thoughtId,
              kind: 'permanent',
              body_md: '## X\nраз',
            },
          }),
        );
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

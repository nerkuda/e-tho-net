/**
 * Загрузка файла через MCP-инструменты вложений (задача 75c75a2f, паритет с
 * REST `POST …/attachments/file`, стандарт 9e5cff3f).
 *
 * Проверяем сквозной путь без REST-обхода: агент передаёт данные файла
 * (`mime_type` + `data_base64`) в `etn.ops { action: "attachments.add" }` и в
 * `attachments[]` инструмента `etn.thoughts.write`; сервер сохраняет копию в
 * каталоге вложений сети, `file_path` строки указывает на неё, файл читается
 * с диска. Отдельно — лимит 10 МиБ и валидация невалидного base64/`mime_type`.
 *
 * Сквозной in-process прогон через production-фабрику `createMcpServer`
 * (`buildMcpContext`), а не полигон `etn-dev` (он на старой сборке).
 *
 * Bootstrap — `mcp-helpers.ts`. Пропускается без нативного `better-sqlite3`.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  ATTACHMENT_FILE_MAX_BYTES,
  getAttachment,
} from '../src/domain/attachment-service.js';
import { openNetworkDb } from '../src/db/network-db.js';
import { networkDbPath } from '../src/paths.js';
import {
  buildMcpContext,
  callOp,
  callWrite,
  closeMcpContext,
  connectMcpClient,
  nativeAvailable,
  toolJson,
  toolText,
} from './mcp-helpers.js';

/** Каталог серверных копий вложений сети — рядом с её `data.db`. */
function attachmentsDir(dataDir: string, networkId: string): string {
  return path.join(path.dirname(networkDbPath(dataDir, networkId)), 'attachments');
}

/** Небольшая валидная PNG-подпись + маркер: важно лишь, что байты сохранены. */
function samplePng(marker: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(marker, 'utf8'),
  ]);
}

describe('MCP: загрузка файла в вложение (75c75a2f)', { skip: !nativeAvailable() }, () => {
  it('etn.ops attachments.add: data_base64 создаёт kind=file и читается с сервера', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const png = samplePng('ops-upload');
        const created = toolJson<{ id: string }>(
          await callOp(handle.client, 'attachments.add', {
            network_id: ctx.networkId,
            owner_type: 'thought',
            owner_id: ctx.homeId,
            kind: 'file',
            mime_type: 'image/png',
            data_base64: png.toString('base64'),
            title: 'Скриншот из ops',
          }),
        );
        assert.equal(typeof created.id, 'string');

        // Строка вложения: kind=file, file_path внутри серверного каталога.
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const stored = getAttachment(ndb, created.id);
        assert.ok(stored !== null, 'вложение должно существовать');
        assert.equal(stored.kind, 'file');
        assert.equal(stored.mime_type, 'image/png');
        assert.equal(stored.file_size, png.length);
        assert.ok(stored.file_path !== null);

        const dir = attachmentsDir(ctx.dataDir, ctx.networkId);
        assert.ok(
          path.resolve(stored.file_path!).startsWith(path.resolve(dir) + path.sep),
          `file_path должен указывать в каталог вложений сети, получено ${stored.file_path}`,
        );

        // Файл реально записан и совпадает побайтово.
        const onDisk = fs.readFileSync(stored.file_path!);
        assert.equal(onDisk.length, png.length);
        assert.ok(onDisk.equals(png), 'содержимое серверной копии совпадает с загруженным');

        // Аудит-строка содержит описательные поля (`title`), но НЕ саму
        // base64-нагрузку — только её длину (иначе строка аудита в десятки МБ).
        const auditRow = ctx.rawDb
          .prepare(
            `SELECT details FROM audit_log WHERE action = ? AND network_id = ? ORDER BY ts DESC LIMIT 1`,
          )
          .get('etn.attachments.add', ctx.networkId) as { details: string } | undefined;
        assert.ok(auditRow !== undefined, 'должна быть аудит-строка etn.attachments.add');
        const details = JSON.parse(auditRow!.details) as Record<string, unknown>;
        assert.equal(details.title, 'Скриншот из ops');
        assert.equal(details.mime_type, 'image/png');
        assert.equal(details.data_base64_chars, png.toString('base64').length);
        assert.equal('data_base64' in details, false, 'base64-полезная нагрузка в аудит не пишется');

        // Вложение-ссылка: `description` не теряется в аудите (регрессия — поле
        // выпало при добавлении ветки данных файла).
        await callOp(handle.client, 'attachments.add', {
          network_id: ctx.networkId,
          owner_type: 'thought',
          owner_id: ctx.homeId,
          kind: 'url',
          url: 'https://example.test/doc',
          title: 'Ссылка',
          description: 'Описание ссылки',
        });
        const urlAudit = ctx.rawDb
          .prepare(
            `SELECT details FROM audit_log WHERE action = ? AND network_id = ? ORDER BY ts DESC LIMIT 1`,
          )
          .get('etn.attachments.add', ctx.networkId) as { details: string } | undefined;
        const urlDetails = JSON.parse(urlAudit!.details) as Record<string, unknown>;
        assert.equal(urlDetails.description, 'Описание ссылки');
        assert.equal(urlDetails.url, 'https://example.test/doc');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.thoughts.write attachments[]: данные файла пишутся в той же транзакции', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const txt = Buffer.from('лог прогона\nстрока 2\n', 'utf8');
        const result = await callWrite(handle.client, ctx.networkId, [
          {
            ref: 'log',
            thought: { title: 'Карточка с логом' },
            attachments: [
              {
                kind: 'file',
                mime_type: 'text/plain',
                data_base64: txt.toString('base64'),
                title: 'Лог прогона',
              },
            ],
          },
        ]);
        const attachmentId = result.items[0]?.attachments?.[0]?.id;
        assert.ok(attachmentId !== undefined, 'вложение должно вернуться в items[].attachments[]');

        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const stored = getAttachment(ndb, attachmentId!);
        assert.ok(stored !== null);
        assert.equal(stored.kind, 'file');
        assert.equal(stored.file_size, txt.length);
        assert.ok(stored.file_path !== null);
        assert.ok(fs.readFileSync(stored.file_path!).equals(txt));
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('лимит 10 МиБ: декодированный файл сверх лимита отвергается', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const overLimit = Buffer.alloc(ATTACHMENT_FILE_MAX_BYTES + 1, 0x41);
        const res = await callOp(handle.client, 'attachments.add', {
          network_id: ctx.networkId,
          owner_type: 'thought',
          owner_id: ctx.homeId,
          kind: 'file',
          mime_type: 'application/octet-stream',
          data_base64: overLimit.toString('base64'),
        });
        assert.equal(res.isError, true, 'сверх лимита должен быть отказ');
        const text = toolText(res);
        assert.match(text, /VALIDATION_ERROR/);
        assert.match(text, new RegExp(String(ATTACHMENT_FILE_MAX_BYTES)));
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('валидация: невалидный base64, отсутствие mime_type, data_base64 вне kind=file', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const base = {
          network_id: ctx.networkId,
          owner_type: 'thought',
          owner_id: ctx.homeId,
        };

        const badB64 = await callOp(handle.client, 'attachments.add', {
          ...base,
          kind: 'file',
          mime_type: 'text/plain',
          data_base64: '!!!not-base64!!!',
        });
        assert.equal(badB64.isError, true);
        assert.match(toolText(badB64), /data_base64/);

        const noMime = await callOp(handle.client, 'attachments.add', {
          ...base,
          kind: 'file',
          data_base64: Buffer.from('x', 'utf8').toString('base64'),
        });
        assert.equal(noMime.isError, true);
        assert.match(toolText(noMime), /mime_type/);

        const wrongKind = await callOp(handle.client, 'attachments.add', {
          ...base,
          kind: 'url',
          data_base64: Buffer.from('x', 'utf8').toString('base64'),
          mime_type: 'text/plain',
        });
        assert.equal(wrongKind.isError, true);
        assert.match(toolText(wrongKind), /kind/);

        // Через write путь — та же доменная валидация.
        const wres = await handle.client.callTool({
          name: 'etn.thoughts.write',
          arguments: {
            network_id: ctx.networkId,
            thoughts: [
              {
                ref: 'x',
                thought: { title: 'Плохое вложение' },
                attachments: [
                  { kind: 'file', mime_type: 'text/plain', data_base64: '!!!bad!!!' },
                ],
              },
            ],
          },
        });
        assert.equal(wres.isError, true);
        assert.match(toolText(wres), /data_base64/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  // Ошибка 5fcb8307: `file_path` — путь в ОС СЕРВЕРА. Нерезолвящийся на
  // сервере путь раньше молча создавал битое вложение (mime_type/file_size
  // пусты, файл недоступен). Теперь это явная VALIDATION_ERROR с путём в
  // деталях; клиентский файл передаётся содержимым через data_base64.
  it('etn.ops attachments.add: нерезолвящийся file_path отвергается (5fcb8307)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const missing = path.join(os.tmpdir(), `etn-missing-${randomUUID()}.png`);
        const res = await callOp(handle.client, 'attachments.add', {
          network_id: ctx.networkId,
          owner_type: 'thought',
          owner_id: ctx.homeId,
          kind: 'file',
          file_path: missing,
          mime_type: 'image/png',
        });
        assert.equal(res.isError, true, 'нерезолвящийся путь должен быть отказом');
        const text = toolText(res);
        assert.match(text, /VALIDATION_ERROR/);
        // Путь присутствует в деталях/сообщении — агент видит, что именно не найдено.
        assert.ok(text.includes(missing), `в деталях должен быть путь: ${text}`);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.ops attachments.add: резолвящийся file_path работает как раньше (5fcb8307)', async () => {
    const ctx = await buildMcpContext();
    const existing = path.join(os.tmpdir(), `etn-file-${randomUUID()}.png`);
    fs.writeFileSync(existing, 'png-bytes');
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const created = toolJson<{ id: string }>(
          await callOp(handle.client, 'attachments.add', {
            network_id: ctx.networkId,
            owner_type: 'thought',
            owner_id: ctx.homeId,
            kind: 'file',
            file_path: existing,
            mime_type: 'image/png',
          }),
        );
        assert.ok(created.id.length > 0, 'вложение создано');
        const row = openNetworkDb(ctx.dataDir, ctx.networkId)
          .prepare('SELECT kind, file_path FROM attachments WHERE id = ?')
          .get(created.id) as { kind: string; file_path: string | null };
        assert.equal(row.kind, 'file');
        assert.equal(row.file_path, existing, 'путь сохранён как передан');
      } finally {
        await handle.close();
      }
    } finally {
      fs.rmSync(existing, { force: true });
      await closeMcpContext(ctx);
    }
  });

  it('etn.thoughts.write attachments[]: нерезолвящийся file_path отвергается (5fcb8307)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const missing = path.join(os.tmpdir(), `etn-missing-write-${randomUUID()}.txt`);
        const res = await handle.client.callTool({
          name: 'etn.thoughts.write',
          arguments: {
            network_id: ctx.networkId,
            thoughts: [
              {
                ref: 'bad-path',
                thought: { title: 'Битый путь' },
                attachments: [{ kind: 'file', file_path: missing, mime_type: 'text/plain' }],
              },
            ],
          },
        });
        assert.equal(res.isError, true, 'нерезолвящийся путь должен быть отказом');
        const text = toolText(res);
        assert.match(text, /VALIDATION_ERROR/);
        assert.ok(text.includes(missing), `в деталях должен быть путь: ${text}`);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});

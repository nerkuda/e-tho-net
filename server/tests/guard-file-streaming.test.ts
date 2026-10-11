/**
 * Сторож класса «файл отдаётся без стриминга» (ошибка 24d75c96; тот же класс,
 * что закрыт в 99c16033 для `jobs/:id/download`).
 *
 * Правило: маршруты выдачи файлов обязаны отдавать их потоком
 * (`createReadStream`), а доменные описания файловой выдачи — не нести готовый
 * `Buffer` тела. Сторож краснеет, если кто-то вернёт чтение файла целиком
 * в память на отдаче. Пример-образец — `guard-db-layer.test.ts`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * Маршруты, отдающие файлы клиенту: обязаны использовать `createReadStream`.
 * Пополнять при добавлении новой файловой выдачи (как в `guard-*-реестрах`).
 */
const FILE_DELIVERY_ROUTES = [
  'routes/attachments.ts', // GET /networks/:nid/attachments/raw
  'routes/system-logging.ts', // GET /system/logs/:filename
  'routes/search.ts', // GET /jobs/:jobId/download (файловые результаты)
];

describe('guard: файлы отдаются потоком, а не читаются целиком в память', () => {
  it('каждый маршрут выдачи файлов использует createReadStream', () => {
    const missing: string[] = [];
    for (const rel of FILE_DELIVERY_ROUTES) {
      const src = fs.readFileSync(path.join(SERVER_SRC, rel), 'utf8');
      if (!src.includes('createReadStream')) {
        missing.push(rel);
      }
    }
    assert.deepEqual(
      missing,
      [],
      `маршруты выдачи файлов без потоковой отдачи: ${missing.join(', ')}`,
    );
  });

  it('доменный контракт raw-выдачи вложения не несёт буфер целиком', () => {
    const src = fs.readFileSync(path.join(SERVER_SRC, 'domain', 'attachment-service.ts'), 'utf8');
    const start = src.indexOf('export interface AttachmentRawFile');
    assert.notEqual(start, -1, 'AttachmentRawFile не найден');
    const block = src.slice(start, src.indexOf('}', start));
    assert.match(block, /filePath\s*:\s*string/, 'AttachmentRawFile должен нести filePath');
    assert.doesNotMatch(
      block,
      /body\s*:\s*Buffer/,
      'AttachmentRawFile.body: Buffer вернулся — файл снова буферизуется',
    );
  });
});

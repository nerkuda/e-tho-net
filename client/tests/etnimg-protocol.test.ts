/**
 * Транспорт `etnimg` (ошибка 280a322b): разбор адреса и порядок отдачи.
 *
 * Дефект: `screens/publications/cover.ts` строил `etnimg://attachment/<id>`,
 * а протокол знал только адрес по пути — картинка обложки падала в заглушку.
 * Тест фиксирует контракт обеих форм и то, что при недоступности локального
 * файла запрашивается серверная копия (случай УДАЛЁННОГО сервера).
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  etnimgContentType,
  parseEtnimgTarget,
  serveEtnimgRequest,
  type EtnimgServeDeps,
} from '../src/main/etnimg.js';

const ATT_ID = '22222222-2222-4222-8222-222222222222';

describe('etnimg: разбор адреса (parseEtnimgTarget)', () => {
  it('Windows-диск латинской буквой → путь по диску', () => {
    assert.deepEqual(parseEtnimgTarget('etnimg://c/pics/img.png'), {
      kind: 'file',
      filePath: path.join('c:', 'pics', 'img.png'),
    });
  });

  it('POSIX-путь → абсолютный путь от первого сегмента', () => {
    assert.deepEqual(parseEtnimgTarget('etnimg://srv/etn/att/a.txt'), {
      kind: 'file',
      filePath: '/srv/etn/att/a.txt',
    });
  });

  it('проценты и кириллица раскодируются в пути', () => {
    const target = parseEtnimgTarget(
      'etnimg://c/data/%D0%9E%D1%82%D1%87%D0%B5%D1%82%20%D0%B7%D0%B0%20%D0%B8%D1%8E%D0%BD%D1%8C.png',
    );
    assert.equal(target?.kind, 'file');
    assert.ok(target?.kind === 'file' && target.filePath.includes('Отчет за июнь.png'));
  });

  it('форма attachment/<id> распознаётся как адрес вложения', () => {
    assert.deepEqual(parseEtnimgTarget(`etnimg://attachment/${ATT_ID}`), {
      kind: 'attachment',
      attachmentId: ATT_ID,
    });
  });

  it('мусор и чужие схемы → null', () => {
    assert.equal(parseEtnimgTarget('https://example.com/x.png'), null);
    assert.equal(parseEtnimgTarget('не-url'), null);
    assert.equal(parseEtnimgTarget('etnimg://c'), null); // нет сегментов пути
    assert.equal(parseEtnimgTarget('etnimg://attachment'), null); // нет id
    assert.equal(parseEtnimgTarget('etnimg://attachment/a/b'), null); // лишний сегмент
    assert.equal(parseEtnimgTarget('etnimg://attachment/'), null);
  });

  it('сегменты `.`/`..` нормализуются, attachment с traversal не проходит', () => {
    // WHATWG URL сам нормализует точечные сегменты, поэтому `pics/..` исчезает.
    assert.deepEqual(parseEtnimgTarget('etnimg://c/pics/../a.png'), {
      kind: 'file',
      filePath: path.join('c:', 'a.png'),
    });
    assert.equal(parseEtnimgTarget('etnimg://attachment/..%2F..'), null);
  });
});

describe('etnimg: content type по расширению', () => {
  it('знает картинки и текст, прочее — octet-stream', () => {
    assert.equal(etnimgContentType('C:\\a\\IMG.PNG'), 'image/png');
    assert.equal(etnimgContentType('C:\\a\\b.webp'), 'image/webp');
    assert.equal(etnimgContentType('C:\\a\\notes.md'), 'text/plain; charset=utf-8');
    assert.equal(etnimgContentType('C:\\a\\archive.zip'), 'application/octet-stream');
    assert.equal(etnimgContentType('C:\\a\\noext'), 'application/octet-stream');
  });
});

/** Депы с записью вызовов: локальное чтение и серверная копия задаются тестом. */
function deps(overrides: Partial<EtnimgServeDeps> = {}): {
  deps: EtnimgServeDeps;
  resolved: string[];
  fetched: string[];
} {
  const resolved: string[] = [];
  const fetched: string[] = [];
  const base: EtnimgServeDeps = {
    async resolveAttachmentFilePath(id) {
      resolved.push(id);
      return null;
    },
    async fetchServerFile(filePath) {
      fetched.push(filePath);
      return null;
    },
    readLocalFile() {
      return null;
    },
    ...overrides,
  };
  return { deps: base, resolved, fetched };
}

describe('etnimg: отдача (serveEtnimgRequest)', () => {
  it('адрес по пути: локальный файл читается с content type по расширению', async () => {
    const body = Buffer.from('img-bytes');
    const { deps: d } = deps({ readLocalFile: (p) => (p.endsWith('a.png') ? body : null) });
    const res = await serveEtnimgRequest('etnimg://c/pics/a.png', d);
    assert.deepEqual(res, { ok: true, body, contentType: 'image/png' });
  });

  it('локального файла нет → берётся серверная копия (удалённый сервер)', async () => {
    const serverBody = Buffer.from('from-server');
    const { deps: d, fetched } = deps({
      readLocalFile: () => null,
      async fetchServerFile(p) {
        fetched.push(p);
        return { contentType: 'image/png', body: serverBody };
      },
    });
    const res = await serveEtnimgRequest('etnimg://c/pics/remote.png', d);
    assert.deepEqual(res, { ok: true, body: serverBody, contentType: 'image/png' });
    assert.deepEqual(fetched, [path.join('c:', 'pics', 'remote.png')]);
  });

  it('ни локально, ни на сервере → 404', async () => {
    const { deps: d } = deps();
    const res = await serveEtnimgRequest('etnimg://c/pics/gone.png', d);
    assert.deepEqual(res, { ok: false, status: 404, message: 'not found' });
  });

  it('attachment/<id>: id резолвится в file_path, затем читается файл', async () => {
    const body = Buffer.from('cover');
    const { deps: d, resolved, fetched } = deps({
      async resolveAttachmentFilePath(id) {
        resolved.push(id);
        return path.join('c:', 'etn', 'cover.jpg');
      },
      readLocalFile: () => body,
    });
    const res = await serveEtnimgRequest(`etnimg://attachment/${ATT_ID}`, d);
    assert.deepEqual(res, { ok: true, body, contentType: 'image/jpeg' });
    assert.deepEqual(resolved, [ATT_ID]);
    assert.deepEqual(fetched, []); // локально нашли — сервер не нужен
  });

  it('attachment/<id> на удалённом сервере: локально нет → скачиваем серверную копию', async () => {
    const serverBody = Buffer.from('remote-cover');
    const ref = path.join('c:', 'etn', 'cover.png');
    const { deps: d, fetched } = deps({
      async resolveAttachmentFilePath() {
        return ref;
      },
      readLocalFile: () => null,
      async fetchServerFile(p) {
        fetched.push(p);
        return { contentType: 'image/png', body: serverBody };
      },
    });
    const res = await serveEtnimgRequest(`etnimg://attachment/${ATT_ID}`, d);
    assert.deepEqual(res, { ok: true, body: serverBody, contentType: 'image/png' });
    assert.deepEqual(fetched, [ref]);
  });

  it('неизвестное вложение (нет file_path) → 404, вложение не запрашивается', async () => {
    const { deps: d, fetched } = deps({ async resolveAttachmentFilePath() { return null; } });
    const res = await serveEtnimgRequest(`etnimg://attachment/${ATT_ID}`, d);
    assert.deepEqual(res, { ok: false, status: 404, message: 'attachment not found' });
    assert.deepEqual(fetched, []);
  });

  it('битый адрес → 400 и ни одного внешнего вызова', async () => {
    const { deps: d, resolved, fetched } = deps();
    const res = await serveEtnimgRequest('etnimg://attachment/a/b', d);
    assert.deepEqual(res, { ok: false, status: 400, message: 'bad etnimg url' });
    assert.deepEqual(resolved, []);
    assert.deepEqual(fetched, []);
  });
});

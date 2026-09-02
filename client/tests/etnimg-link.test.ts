/**
 * Unit tests for the pure helpers of `lib/etnimg-link.ts` (карточка ETN
 * 33379769: клик по `[имя](etnimg://…)` открывает файл-вложение):
 * `decodeEtnimgUrl` (the inverse of `editor/markdown-field.ts`'s `etnimgUrl`),
 * `sameFilePath` (drive-letter case-blind comparison) and
 * `findAttachmentByPath`. Pure — no DOM (importing the module must stay
 * side-effect-free; it only touches `document` inside
 * `initEtnimgLinkNavigation()`, never called here).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Attachment } from '@etn/shared';
import { etnimgLinkInternals } from '../src/renderer/lib/etnimg-link.js';

const { decodeEtnimgUrl, sameFilePath, findAttachmentByPath } = etnimgLinkInternals;

/** Encodes a file path the same way `etnimgUrl` does (drive → single-letter host). */
function etnimgUrl(filePath: string): string {
  const segments = filePath.replace(/\\/g, '/').split('/').filter((s) => s !== '');
  const encoded = segments.map((seg, i) => {
    if (i === 0 && /^[a-zA-Z]:$/.test(seg)) return seg[0]!.toLowerCase();
    return encodeURIComponent(seg);
  });
  return `etnimg://${encoded.join('/')}`;
}

/** Minimal `kind: 'file'` attachment row. */
function fileAttachment(id: string, filePath: string): Attachment {
  return {
    id,
    owner_type: 'thought',
    owner_id: 't1',
    kind: 'file',
    url: null,
    file_path: filePath,
    file_size: 1,
    mime_type: null,
    title: null,
    icon: null,
    description: null,
    position: 0,
    created_at: '2026-09-02T00:00:00.000Z',
    created_by: 'u1',
  };
}

test('decodeEtnimgUrl: виндовый диск → путь с обратными слешами', () => {
  assert.equal(decodeEtnimgUrl('etnimg://c/pics/a.png'), 'c:\\pics\\a.png');
});

test('decodeEtnimgUrl: раундтрип etnimgUrl — проценты и кириллица декодируются', () => {
  const path = 'C:\\data\\Отчет за июнь.docx';
  assert.equal(decodeEtnimgUrl(etnimgUrl(path)), 'c:\\data\\Отчет за июнь.docx');
});

test('decodeEtnimgUrl: POSIX-путь восстанавливается с ведущим /', () => {
  assert.equal(decodeEtnimgUrl('etnimg://srv/etn/attachments/a.txt'), '/srv/etn/attachments/a.txt');
});

test('decodeEtnimgUrl: не-etnimg URL и мусор → null', () => {
  assert.equal(decodeEtnimgUrl('https://example.com/a.png'), null);
  assert.equal(decodeEtnimgUrl('not a url'), null);
  assert.equal(decodeEtnimgUrl('etnimg://c'), null); // нет сегментов пути
});

test('sameFilePath: регистр диска и вид слешей не важны (Windows), POSIX — точное сравнение', () => {
  assert.ok(sameFilePath('c:\\Data\\a.png', 'C:/Data/a.png'));
  assert.ok(!sameFilePath('c:\\Data\\a.png', 'D:/Data/a.png'));
  assert.ok(sameFilePath('/srv/a.txt', '/srv/a.txt'));
  assert.ok(!sameFilePath('/srv/A.txt', '/srv/a.txt')); // POSIX регистрочувствителен
});

test('findAttachmentByPath: находит file-вложение по декодированному пути', () => {
  const rows = [
    fileAttachment('a1', 'C:\\ETN\\networks\\n1\\attachments\\x.pdf'),
    fileAttachment('a2', 'C:\\ETN\\networks\\n1\\attachments\\отчет.docx'),
  ];
  const found = findAttachmentByPath(rows, 'c:/ETN/networks/n1/attachments/x.pdf');
  assert.equal(found?.id, 'a1');
  assert.equal(findAttachmentByPath(rows, 'c:\\ETN\\networks\\n1\\attachments\\отчет.docx')?.id, 'a2');
});

test('findAttachmentByPath: URL-вложения и чужие пути игнорируются', () => {
  const urlRow = { ...fileAttachment('u1', 'C:\\x\\y.txt'), kind: 'url' as const, file_path: null, url: 'https://e.com' };
  assert.equal(findAttachmentByPath([urlRow], 'c:/x/y.txt'), null);
  assert.equal(findAttachmentByPath([fileAttachment('a1', 'C:\\x\\y.txt')], 'c:/x/z.txt'), null);
});

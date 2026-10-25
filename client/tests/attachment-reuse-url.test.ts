/**
 * Регресс-тест ошибки 1b4cc172 «"Найти существующее": переиспользование
 * URL-вложения падает с 422 (file_size: null)».
 *
 * Симптом: в диалоге «Добавить вложение» → «Найти существующее» выбор
 * найденного URL-вложения не добавлял его — под полем поиска появлялось
 * «значение должно быть числом.» (POST …/attachments → 422).
 *
 * Причина: тело запроса собиралось из DTO вложения напрямую и несло
 * `file_size: attachment.file_size`; у URL-вложения размера нет (`null`), а
 * контракт `RestAttachmentCreate` принимает `file_size` только целым числом.
 *
 * Здесь проверяется ЧИСТОЕ тело запроса, которое клиент отправляет при
 * переиспользовании (`reuseAttachmentInput`): необязательные поля со значением
 * `null` в тело не попадают, значимые поля вложения сохраняются. DOM для этого
 * не нужен — та же точка, что была дефектной в `reuseAttachment`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Attachment } from '@etn/shared';

import { reuseAttachmentInput } from '../src/renderer/editor/attachments.js';

function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'a1',
    owner_type: 'thought',
    owner_id: 't1',
    kind: 'url',
    url: 'https://example.com/doc',
    file_path: null,
    file_size: null,
    mime_type: null,
    title: 'Документ',
    icon: null,
    description: null,
    position: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    created_by: 'u1',
    ...overrides,
  };
}

describe('reuseAttachmentInput — тело POST …/attachments при переиспользовании', () => {
  it('URL-вложение: file_size=null НЕ попадает в тело (иначе REST 422, 1b4cc172)', () => {
    const input = reuseAttachmentInput(makeAttachment());
    assert.equal(
      Object.hasOwn(input, 'file_size'),
      false,
      'поле file_size не должно присутствовать в теле запроса, даже как undefined',
    );
    assert.equal(input.kind, 'url');
    assert.equal(input.url, 'https://example.com/doc');
    assert.equal(input.file_path, null);
    assert.equal(input.title, 'Документ');
  });

  it('URL-вложение: title/description/mime_type сохраняются как есть', () => {
    const input = reuseAttachmentInput(
      makeAttachment({ title: 'Ссылка', description: 'Комментарий', mime_type: 'text/html' }),
    );
    assert.equal(input.title, 'Ссылка');
    assert.equal(input.description, 'Комментарий');
    assert.equal(input.mime_type, 'text/html');
  });

  it('файловое вложение с размером: file_size сохраняется (метаданные не теряются)', () => {
    const input = reuseAttachmentInput(
      makeAttachment({
        kind: 'file',
        url: null,
        file_path: 'C:\\docs\\plan.md',
        file_size: 2048,
        mime_type: 'text/markdown',
        title: 'План',
      }),
    );
    assert.equal(input.file_size, 2048);
    assert.equal(input.url, null);
    assert.equal(input.file_path, 'C:\\docs\\plan.md');
    assert.equal(input.mime_type, 'text/markdown');
  });

  it('файловое вложение без размера: file_size тоже не отправляется', () => {
    const input = reuseAttachmentInput(
      makeAttachment({ kind: 'file', url: null, file_path: 'C:\\x.bin', file_size: null }),
    );
    assert.equal(Object.hasOwn(input, 'file_size'), false);
    assert.equal(input.file_path, 'C:\\x.bin');
  });
});

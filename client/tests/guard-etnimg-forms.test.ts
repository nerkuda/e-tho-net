/**
 * Сторож схемы `etnimg` (ошибка 280a322b; ADR «Формы адреса схемы etnimg:
 * файл по пути и вложение по id»; стандарт «Правило без теста-сторожа не
 * считается введённым»).
 *
 * Правила:
 * 1. **Ровно две формы адреса.** `parseEtnimgTarget` знает только «файл по
 *    пути» (`<диск>/<путь…>`) и «вложение по id» (`attachment/<id>`). Попытка
 *    провести третью форму или поменять контракт делает сторож красным:
 *    поведенческие случаи перечисляют, что обязано возвращать `null`, а
 *    источник пинится на точный набор вариантов `kind`.
 * 2. **Запрет из ADR.** Рендерер не ходит в REST за вложениями и не резолвит
 *    id вложения сам (ни `rest-client`, ни `attachments/raw` в `src/renderer`),
 *    а `cover.ts` адресует картинку только формой `etnimg://attachment/<id>` —
 *    не путём (`etnimgUrl`) и не вызовом `attachments.*`.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseEtnimgTarget } from '../src/main/etnimg.js';
import { assertGuardClean } from './guard-helpers.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN_ETNIMG = path.join(CLIENT_ROOT, 'src', 'main', 'etnimg.ts');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');
const COVER_TS = path.join(RENDERER_ROOT, 'screens', 'publications', 'cover.ts');

const ATT_ID = '22222222-2222-4222-8222-222222222222';

describe('guard: схема etnimg — ровно две формы адреса (ADR, 280a322b)', () => {
  it('обе разрешённые формы разбираются', () => {
    assert.equal(parseEtnimgTarget('etnimg://c/pics/a.png')?.kind, 'file');
    assert.equal(parseEtnimgTarget('etnimg://srv/etn/attachments/a.txt')?.kind, 'file');
    assert.deepEqual(parseEtnimgTarget(`etnimg://attachment/${ATT_ID}`), {
      kind: 'attachment',
      attachmentId: ATT_ID,
    });
  });

  it('неизвестный хост — POSIX-путь, а не третья форма', () => {
    // Хост, кроме `attachment` и односимвольного диска, — первый сегмент
    // POSIX-пути. Новый вид адреса так не заводится: он попадёт в ветку файла.
    for (const url of [
      'etnimg://thought/11111111-1111-4111-8111-111111111111',
      'etnimg://publication/11111111-1111-4111-8111-111111111111',
      'etnimg://link/11111111-1111-4111-8111-111111111111',
      'etnimg://data/image.png',
    ]) {
      assert.equal(parseEtnimgTarget(url)?.kind, 'file', `должен быть путь: ${url}`);
    }
  });

  it('неразбираемый адрес и злоупотребление attachment-формой → null', () => {
    const rejected = [
      // Attachment-форма с лишним/пустым сегментом.
      `etnimg://attachment/${ATT_ID}/extra`,
      'etnimg://attachment',
      'etnimg://attachment/',
      // Пустой хост / без сегментов пути.
      'etnimg://',
      'etnimg://thought/',
      // Чужие схемы и не-URL.
      'https://example.com/a.png',
      'file:///c/pics/a.png',
      'не-url',
    ];
    for (const url of rejected) {
      assert.equal(parseEtnimgTarget(url), null, `обязан быть null: ${url}`);
    }
  });

  it('контракт зафиксирован в типе: вариантов `kind` ровно два', () => {
    const source = fs.readFileSync(MAIN_ETNIMG, 'utf8');
    const kinds = new Set(
      [...source.matchAll(/\bkind:\s*'([a-z-]+)'/g)].map((m) => m[1] as string),
    );
    assert.deepEqual(
      [...kinds].sort(),
      ['attachment', 'file'],
      'в EtnimgTarget допустимы только attachment и file — новая форма требует правки ADR и сторожа',
    );
  });
});

describe('guard: рендерер не резолвит вложения сам (ADR по 280a322b)', () => {
  it('в src/renderer нет rest-client и обращений к raw-вложениям', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'renderer-rest-client',
        description: 'рендерер не тянет REST-клиент main-процесса: вложения отдаёт схема etnimg',
        pattern: /rest-client|from\s+['"].*\/main\/net\//,
      },
      {
        name: 'renderer-attachment-raw',
        description: 'рендерер не скачивает сырые вложения — это дело main (etnimg)',
        pattern: /getAttachmentRaw|attachments\/raw/,
      },
    ]);
  });

  it('cover.ts адресует картинку формой attachment/<id>, а не путём', () => {
    const source = fs.readFileSync(COVER_TS, 'utf8');
    assert.ok(
      source.includes('etnimg://attachment/'),
      'cover.ts обязан строить etnimg://attachment/<id> (ADR: форма по id)',
    );
    const isComment = (line: string): boolean => /^\s*(\*|\/\/)/.test(line);
    const banned = /etnimgUrl|attachments\.(get|list|search|add)\(|\.file_path\b/;
    const offenders = source
      .split('\n')
      .map((line, i) => ({ line, no: i + 1 }))
      .filter((l) => banned.test(l.line) && !isComment(l.line));
    assert.deepEqual(
      offenders.map((o) => `${o.no}: ${o.line.trim()}`),
      [],
      'cover.ts не резолвит id вложения в путь и не ходит в attachments.*',
    );
  });
});

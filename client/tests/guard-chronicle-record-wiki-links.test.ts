/**
 * Сторож резолва ID-форм wiki-ссылок в теле записи «Дневника» (ошибка ab8b6da8,
 * симптом 1: «в режиме редактора ссылки на мысли отображаются, а в режиме
 * просмотра — нет»).
 *
 * Причина: серверный `body_html` отдаёт ID-форму пустым спаном
 * `<span class="wiki-link" data-wiki-id>` — имя мысли подставляет клиент.
 * Поле markdown резолвит такие спаны в своём `paintView`
 * (`resolveWikiLinksInDom`), а статичный просмотр тела записи рисовался общим
 * `renderHtml` без этой декорации, поэтому ссылка на мысль в ПРОСМОТРЕ была
 * невидима (в правке имя подтягивает `wikiIdPlugin`). Требование d574d116:
 * резолвер «подключается в полях просмотра комментария, дневника и в сниппетах».
 *
 * Сторож зелёный на исправленном коде и краснеет, если декорацию уберут.
 * Поведенческий сквозной сценарий (реальный клик/рендер) — GUI-стенд; здесь
 * фиксируется проводка декорации в экране, который под Node не импортируется
 * (тянет Electron-каркас).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');

function read(...parts: string[]): string {
  return readFileSync(resolve(RENDERER, ...parts), 'utf8');
}

const CHRONICLE = read('screens', 'chronicle', 'chronicle.ts');
const RECORD_BODY = read('screens', 'chronicle', 'record-body.ts');

describe('сторож: резолв ID-ссылок в просмотре записи «Дневника» (ab8b6da8)', () => {
  it('fillRecordCard резолвит ID-формы wiki-ссылок в просмотре записи', () => {
    const fill =
      /function fillRecordCard\(card: HTMLElement, row: ChronicleRow, day: string\): void \{([\s\S]*?)\n\}/.exec(
        CHRONICLE,
      )?.[1] ?? '';
    assert.ok(fill !== '', 'тело fillRecordCard найдено');
    // Комментарии не код: пояснение рядом может упоминать имя — ищем вызов.
    const code = fill.replace(/\/\/[^\n]*/g, '');
    assert.match(
      code,
      /resolveWikiLinksInDom\(recordView,/,
      'просмотр записи резолвит ID-ссылки — иначе ссылка на мысль невидима (симптом 1)',
    );
  });

  it('chronicle.ts импортирует резолвер wiki-ссылок', () => {
    assert.match(
      CHRONICLE,
      /import\s*\{[^}]*resolveWikiLinksInDom[^}]*\}\s*from\s*'\.\.\/\.\.\/editor\/wiki-link-resolver\.js'/,
      'резолвер подключён из общего модуля, а не переписан локально',
    );
  });

  it('record-body остаётся чистым: сеть и декорации — забота вызывающего', () => {
    assert.ok(
      !/^\s*import[^\n]*wiki-link-resolver/m.test(RECORD_BODY),
      'record-body.ts не импортирует резолвер wiki-ссылок',
    );
    assert.ok(
      !/requireNetworkId\s*\(/.test(RECORD_BODY),
      'record-body.ts не обращается к сети',
    );
  });
});

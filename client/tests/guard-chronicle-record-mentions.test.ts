/**
 * Сторож авто-подсветки упоминаний в теле записи «Дневника» (ошибка 616207a9).
 *
 * Симптом: в записях ленты не подчёркивались слова, совпадающие с именами и
 * синонимами мыслей; при сохранении (Ctrl+Enter) подчёркивания на долю секунды
 * появлялись (поле markdown подсвечивает СВОЙ просмотр) и пропадали, потому что
 * лента перерисовывала тело статичным `body_html` без декораций. Правило:
 * просмотр комментария несёт одни и те же декорации в любом месте, поэтому
 * статичный `body_html` записи проходит тот же `annotateMentions`, что и поле
 * markdown, а «Вставить ссылку» из меню делегирует единственной реализации
 * замены/сохранения поля (`insertMentionLinkIntoField`).
 *
 * Сторож зелёный на исправленном коде и краснеет, если декорацию уберут.
 *
 * DOM-часть `annotateMentions` (обёртка узлов) проверяется вручную — в клиентских
 * тестах нет jsdom; здесь фиксируется поведенческий контракт возврата тела и
 * проводка декорации.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');

function read(...parts: string[]): string {
  return readFileSync(resolve(RENDERER, ...parts), 'utf8');
}

const CHRONICLE = read('screens', 'chronicle', 'chronicle.ts');
const RECORD_BODY = read('screens', 'chronicle', 'record-body.ts');
const MD_FIELD = read('editor', 'markdown-field.ts');

/** Минимальный DOM-шим: хватает для сборки оболочки комментария. */
function installShim(): void {
  const body = new ShimElement('body');
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (text: string) => new ShimElement('#text', undefined, text),
    body,
    activeElement: body,
  };
}

describe('сторож: подсветка упоминаний в теле записи «Дневника» (616207a9)', () => {
  it('renderRecordView возвращает контейнер тела — его можно декорировать', async () => {
    installShim();
    const { commentShell } = await import('../src/renderer/lib/ui/comment.js');
    const { renderRecordView, RECORD_VIEW_CLASS } = await import(
      '../src/renderer/screens/chronicle/record-body.js'
    );

    const shell = commentShell({ variant: 'plain' });
    const view = renderRecordView(shell as never, { body_html: '<p>Текст записи</p>' });
    assert.ok(view, 'renderRecordView вернул контейнер тела');
    assert.ok(
      view.classList.contains(RECORD_VIEW_CLASS),
      'возвращён именно контейнер тела `.diary-body`',
    );
  });

  it('fillRecordCard декорирует статичный просмотр авто-подсветкой упоминаний', () => {
    const fill =
      /function fillRecordCard\(card: HTMLElement, row: ChronicleRow, day: string\): void \{([\s\S]*?)\n\}/.exec(
        CHRONICLE,
      )?.[1] ?? '';
    assert.ok(fill !== '', 'тело fillRecordCard найдено');
    // Комментарии не код: пояснение рядом может упоминать имена — ищем вызовы.
    const code = fill.replace(/\/\/[^\n]*/g, '');

    assert.match(
      code,
      /const recordView = renderRecordView\(shell, row\)/,
      'тело просмотра удерживается для декорирования',
    );
    assert.match(
      code,
      /annotateMentions\(recordView,/,
      'просмотр декорируется annotateMentions — единый путь подсветки',
    );
    assert.match(
      code,
      /recordView\.isConnected/,
      'декорация ждёт монтирования карточки (аннотация пропускает оторванный узел)',
    );
    assert.match(
      code,
      /insertMentionLinkIntoField\(w, thought, matchedText\)/,
      '«Вставить ссылку» делегирует единственной реализации поля markdown',
    );
  });

  it('поле markdown отдаёт вставку ссылки-упоминания наружу (единственная реализация)', () => {
    assert.match(
      MD_FIELD,
      /export function insertMentionLinkIntoField\(/,
      'обёртка вставки ссылки доступна вне поля',
    );
    assert.match(
      MD_FIELD,
      /handles\.get\(root\)\?\.insertMentionLink\(thought, matchedText\)/,
      'обёртка делегирует handle поля',
    );
    assert.match(
      MD_FIELD,
      /handles\.set\(root, \{\s*\n\s*showEdit,\s*\n\s*insertMentionLink,/,
      'handle поля несёт insertMentionLink',
    );
  });

  it('record-body остаётся чистым: сеть и декорации — забота вызывающего', () => {
    // Статичный просмотр не тянет скан упоминаний сам: декорацию навешивает
    // экран. Проверяем импорты/вызовы, а не пояснения в шапке модуля.
    assert.ok(
      !/^\s*import[^\n]*mentions-annotate/m.test(RECORD_BODY),
      'record-body.ts не импортирует модуль аннотации упоминаний',
    );
    assert.ok(
      !/requireNetworkId\s*\(/.test(RECORD_BODY),
      'record-body.ts не обращается к сети',
    );
  });
});

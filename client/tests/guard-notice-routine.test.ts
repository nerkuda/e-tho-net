/**
 * Сторож каналов рутинных сообщений (задача 28d22b8a, сквозной аудит).
 *
 * Рутина — копирование в буфер, подсказки и клиентские валидации — живёт
 * в зоне сообщений статус-бара (`notice` без вида). Реальный сбой и отказ
 * сервера — тостом (`'error'`). Сторож фиксирует границу, которую проверка
 * задачи нашла нарушенной трижды: «не удалось скопировать» уезжало тостом,
 * а отказ 409 по обложке — наоборот, в статусбар.
 *
 * Дублирование записи дневника (`copyRecord`) — не буфер, а серверная
 * операция `comments.get` + `createMulti`: её сбой идёт error-тостом, хотя
 * по тексту похож на рутинное копирование.
 *
 * Мутации, которые краснят: вернуть `'error'` любому из семи рутинных
 * вызовов; убрать `'error'` у отказа `ATTACHMENT_OWNER_IS_ICON` в карточке
 * публикации; вернуть `'warning'` отклонению несовместимого drop фильтра;
 * убрать `'error'` у сбоя дублирования записи в хронике.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const RENDERER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'renderer',
);

function read(rel: string): string {
  return readFileSync(path.join(RENDERER_ROOT, rel), 'utf8');
}

describe('сторож: рутина — в статусбар, сбой и отказ сервера — тостом', () => {
  it('копирование в буфер в карточке публикации — без вида (два места)', () => {
    const source = read('editor/publication-card.ts');
    const routine = source.match(/notice\(t\('publication\.copy\.failed'\)\);/g) ?? [];
    assert.equal(routine.length, 2, 'оба отказа копирования — в статусбар');
    assert.doesNotMatch(
      source,
      /notice\(t\('publication\.copy\.failed'\), 'error'\)/,
      'рутинное копирование не должно идти error-тостом',
    );
  });

  it('отказ сервера 409 по обложке публикации — error-тост', () => {
    assert.match(
      read('editor/publication-card.ts'),
      /notice\(t\('publication\.cover\.removeOwnerBlocked'\), 'error'\);/,
      'операция не выполнена — важное сообщение',
    );
  });

  it('дублирование записи в хронике — error-тост (серверная операция)', () => {
    assert.match(
      read('screens/chronicle/chronicle.ts'),
      /notice\(t\('diary\.duplicateFailed', \[errText\(err\)\]\), 'error'\);/,
      'сбой создания дубля записи (comments.get + createMulti) — важное сообщение',
    );
  });

  it('копирование блока в буфер трансклюзии — без вида', () => {
    const transclusion = read('editor/transclusion.ts');
    assert.match(
      transclusion,
      /notice\(t\('comment\.transclusion\.menu\.copyError'\)\);/,
      'отказ копирования трансклюзии — в статусбар',
    );
    assert.doesNotMatch(
      transclusion,
      /notice\(t\('comment\.transclusion\.menu\.copyError'\), 'error'\)/,
      'рутинное копирование не должно идти error-тостом',
    );
  });

  it('подсказки etnimg-ссылки — в статусбар, сбой открытия — error-тостом', () => {
    const source = read('lib/etnimg-link.ts');
    assert.doesNotMatch(
      source,
      /владелец вложения неизвестен[\s\S]{0,40}?'error'/,
      'нет контекста — подсказка, не сбой',
    );
    assert.doesNotMatch(
      source,
      /Не удалось разобрать путь во вложении[\s\S]{0,40}?'error'/,
      'битый путь — подсказка, не сбой',
    );
    assert.match(
      source,
      /Не удалось открыть файл вложения[\s\S]{0,60}?'error'/,
      'сбой чтения списка вложений остаётся error-тостом',
    );
  });

  it('отклонение несовместимого drop фильтра — в статусбар (два места)', () => {
    const source = read('lib/filter-value.ts');
    const routine = source.match(/notice\(filterValueDropRejectionText\(payload\)\);/g) ?? [];
    assert.equal(routine.length, 2, 'оба отклонения drop — в статусбар');
    assert.doesNotMatch(
      source,
      /notice\(filterValueDropRejectionText\(payload\), 'warning'\)/,
      'рутинная валидация не должна идти предупреждающим тостом',
    );
  });
});

/**
 * Сторож сворачиваемой записи «Дневника» (0.10.2, задача 41ed99ab).
 *
 * Фиксирует правила, на которых держится п.7 критериев приёмки:
 *  • переключение тела записи меняет карточку НА МЕСТЕ (`findRecordCard` +
 *    `applyRecordCollapsed`), а не пересборкой ленты — иначе теряются фокус
 *    навигации и позиция прокрутки (грабли ab78e7b5, 407b1827);
 *  • свёрнутость переприменяется при keyed-обновлении карточки
 *    (`fillRecordCard` → `dayOfCard` + `recordCollapseKey`);
 *  • единица свёрнутости — вхождение «день + id» (`recordCollapseKey`);
 *  • поле «комментарий» доступно только у развёрнутой записи (`feed-nav`);
 *  • календарь использует точки (`calendarDotCount`), а не число `.cal-count`;
 *  • заголовок выходного дня красится токеном `--cal-weekend` (обе темы).
 *
 * Сторож зелёный на исправленном коде и краснеет, если эти пути откатят.
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
const FEED_NAV = read('screens', 'chronicle', 'feed-nav.ts');
const CALENDAR = read('lib', 'month-calendar.ts');
const CHRONICLE_CSS = read('styles', 'screens', 'chronicle.css');
const TOKENS = read('styles', 'tokens.css');

describe('сторож: сворачиваемая запись «Дневника» (41ed99ab)', () => {
  it('переключение записи меняет карточку на месте, без пересборки ленты', () => {
    assert.match(
      CHRONICLE,
      /findRecordCard\(feedList,\s*day,\s*id\)/,
      'переключение ищет карточку вхождения в текущем DOM',
    );
    assert.match(
      CHRONICLE,
      /applyRecordCollapsed\(card,\s*collapsed,\s*recordGroupLabels\(\)\)/,
      'состояние применяется к существующей карточке (in-place)',
    );
    assert.match(
      CHRONICLE,
      /function setRecordCollapsed\(/,
      'единая точка переключения записи на экране',
    );
  });

  it('свёрнутость переприменяется при keyed-обновлении карточки', () => {
    assert.match(
      CHRONICLE,
      /applyRecordCollapsed\([\s\S]*?collapsedRecords\.has\(recordCollapseKey\(day, row\.id\)\)/,
      'fillRecordCard переприменяет свёрнутость после пересборки содержимого',
    );
    assert.match(
      CHRONICLE,
      /recordCollapseKey\(day,\s*row\.id\)/,
      'ключ свёрнутости записи — вхождение «день + id»',
    );
  });

  it('поле «комментарий» доступно только у развёрнутой записи', () => {
    assert.match(
      FEED_NAV,
      /!card\.classList\.contains\('is-collapsed'\)/,
      'скрытое тело записи не входит в обход полей',
    );
    assert.match(
      FEED_NAV,
      /opts\.onSetRecordCollapsed\?\./,
      'навигация сообщает экрану о сворачивании тела',
    );
  });

  it('CSS: свёрнутая запись прячет тело, тело не участвует в display', () => {
    assert.match(
      CHRONICLE_CSS,
      /\.diary-record\.is-collapsed\s+\.diary-record-body\s*\{[^}]*display:\s*none/,
      'тело скрывается классом карточки',
    );
  });

  it('календарь: точки индикатора вместо числа-счётчика', () => {
    assert.match(CALENDAR, /calendarDotCount\(count\)/, 'пороги точек 50/100');
    assert.match(CALENDAR, /'cal-dots'/, 'столбик точек');
    assert.ok(!/cal-count/.test(CALENDAR), 'число-счётчик `.cal-count` упразднено');
    assert.ok(
      !/\.cal-day\.has-records/.test(CHRONICLE_CSS),
      'фоновая подсветка `.has-records` убрана',
    );
  });

  it('одиночный клик заголовка отложен — двойной клик не сворачивает тело', () => {
    assert.match(
      CHRONICLE,
      /deferSingleClick\(/,
      'заголовок различает одиночный и двойной клик (эталон жестов облачка)',
    );
    assert.match(
      CHRONICLE,
      /view\.addEventListener\('dblclick'/,
      'двойной клик входит в правку заголовка',
    );
  });

  it('токен выходного дня определён в светлой и тёмной темах', () => {
    assert.match(TOKENS, /--cal-weekend:/, 'токен объявлен');
    const dark = TOKENS.slice(TOKENS.indexOf("[data-theme='dark']"));
    assert.match(dark, /--cal-weekend:/, 'токен переопределён в тёмной теме');
    assert.match(CHRONICLE, /isWeekend\(day\)/, 'заголовок выходного дня помечается классом');
    assert.match(CHRONICLE_CSS, /\.diary-day-head\.is-weekend/, 'вид выходного дня');
  });

  it('свёрнутость восстанавливается без опоры на DOM-предка карточки', () => {
    // Блокер проверки, круг 1: `reconcileKeyed` зовёт `build`/`update` ДО
    // вставки узла, поэтому день нельзя выводить из DOM (`dayOfCard`). Проверяем,
    // что день передаётся явным параметром в сборку и обновление, а `fillRecordCard`
    // не ищет день по предку.
    assert.match(
      CHRONICLE,
      /buildRecordCard\(row,\s*day\.day\)/,
      'в keyed-сборке день передаётся явно',
    );
    assert.match(
      CHRONICLE,
      /function fillRecordCard\(card: HTMLElement, row: ChronicleRow, day: string\)/,
      'fillRecordCard принимает день параметром',
    );
    assert.ok(
      !/collapsedRecords\.has\(recordCollapseKey\(dayOfCard\(/.test(CHRONICLE),
      'fillRecordCard не выводит день из DOM-предка',
    );
  });

  it('«Свернуть все» собирает ключи и с фактических карточек DOM', () => {
    // Замечание проверки, круг 1: дозагруженные «+50» карточки могут не попасть
    // в `rows` на момент нажатия — ключ берётся с самой карточки.
    assert.match(
      CHRONICLE,
      /if \(collapsed\) collapsedRecords\.add\(recordCollapseKey\(day, id\)\)/,
      'ключ дозагруженной карточки попадает в набор при сворачивании',
    );
  });

  it('будний заголовок дня использует реальный серый токен', () => {
    // Блокер проверки, круг 1: `--muted` в проекте не существует — заголовок
    // наследовал `--text`. Реальный серый — `--text-dim`.
    const head = /\.diary-day-head\s*\{[^}]*\}/.exec(CHRONICLE_CSS)?.[0] ?? '';
    assert.match(head, /color:\s*var\(--text-dim\)/, 'будни серые через `--text-dim`');
    assert.ok(!/var\(--muted\)/.test(head), 'несуществующий `--muted` в заголовке дня убран');
  });
});

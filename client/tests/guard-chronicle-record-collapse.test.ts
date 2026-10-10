/**
 * Сторож сворачиваемой записи «Дневника» (0.10.2, задача 41ed99ab).
 *
 * Фиксирует правила, на которых держится п.7 критериев приёмки:
 *  • переключение тела записи меняет карточку НА МЕСТЕ (`findRecordCard` +
 *    `applyRecordCollapsed`), а не пересборкой ленты — иначе теряются фокус
 *    навигации и позиция прокрутки (грабли ab78e7b5, 407b1827);
 *  • свёрнутость переприменяется при keyed-обновлении карточки
 *    (`fillRecordCard` → `applyRecordCollapsedForDay` с явным днём, без вывода
 *    дня из DOM-предка `dayOfCard`);
 *  • единица свёрнутости — вхождение «день + id» (`recordCollapseKey`);
 *  • поле «комментарий» доступно только у развёрнутой записи (`feed-nav`);
 *  • календарь использует точки (`calendarDotCount`), а не число `.cal-count`;
 *  • заголовок выходного дня красится токеном `--cal-weekend` (обе темы);
 *  • смена надписи заголовка (`setRecordTitleLabel`) сохраняет иконку-шеврон —
 *    первый узел кнопки не затирается (задача d586f340).
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
const RECORD_HEAD = read('screens', 'chronicle', 'record-head.ts');
const RECORD_GROUPS = read('screens', 'chronicle', 'record-groups.ts');
const RECORD_TITLE = read('screens', 'chronicle', 'record-title.ts');
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
    // Задача 8f9c9b12: применение свёрнутости по явному дню — единая функция в
    // `record-groups.ts`; `fillRecordCard` зовёт именно её, а не собирает ключ у
    // себя. Сторож ловит возврат доменного вывода дня (`dayOfCard`) в сборку.
    assert.match(
      RECORD_GROUPS,
      /export function applyRecordCollapsedForDay\(\s*card: HTMLElement,\s*day: string,\s*id: string,/,
      'единая функция «день + id → состояние» в record-groups.ts',
    );
    assert.match(
      RECORD_GROUPS,
      /applyRecordCollapsed\(card,\s*collapsedKeys\.has\(recordCollapseKey\(day, id\)\), labels\)/,
      'функция замыкает in-place применение через ключ вхождения',
    );
    assert.match(
      CHRONICLE,
      /applyRecordCollapsedForDay\(card, day, row\.id, collapsedRecords, recordGroupLabels\(\)\)/,
      'fillRecordCard переприменяет свёрнутость по дню-параметру',
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
    // Компонент заголовка вынесен в один модуль (ошибка 36c330a3): различение
    // кликов живёт там, а не в сборке карточки.
    assert.match(
      RECORD_TITLE,
      /deferSingleClick\(/,
      'заголовок различает одиночный и двойной клик (эталон жестов облачка)',
    );
    assert.match(
      RECORD_TITLE,
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
    // Блокер проверки, круг 1 (усилено задачей 8f9c9b12): `reconcileKeyed` зовёт
    // `build`/`update` ДО вставки узла, поэтому день нельзя выводить из DOM
    // (`dayOfCard`). Проверяем, что день передаётся явным параметром в сборку и
    // обновление, а `fillRecordCard` не ищет день по предку.
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
    const fill =
      /function fillRecordCard\(card: HTMLElement, row: ChronicleRow, day: string\): void \{([\s\S]*?)\n\}/.exec(
        CHRONICLE,
      )?.[1] ?? '';
    assert.ok(fill !== '', 'тело fillRecordCard найдено');
    // Комментарии не код: пояснение рядом может упоминать `dayOfCard` — ищем
    // сам вызов в коде.
    const fillCode = fill.replace(/\/\/[^\n]*/g, '');
    assert.match(
      fillCode,
      /applyRecordCollapsedForDay\(card, day, row\.id, collapsedRecords, recordGroupLabels\(\)\)/,
      'fillRecordCard применяет свёрнутость по дню-параметру',
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

  it('у заголовка записи есть индикатор сворачивания (стрелка, как у группы дня)', () => {
    // Задача 472457bf: тот же приём, что у групп дня, — стрелка внутри
    // кнопки-заголовка, поворот единым путём через класс `is-collapsed` заголовка.
    // Компонент заголовка — единый модуль `record-title.ts` (ошибка 36c330a3).
    const buildView =
      /function buildView\(\): HTMLButtonElement \{([\s\S]*?)\n {2}\}/.exec(RECORD_TITLE)?.[1] ?? '';
    assert.ok(buildView !== '', 'тело buildView найдено');
    assert.match(
      buildView,
      /view\.prepend\(svgIcon\('chevron-down',\s*\d+\)\)/,
      'стрелка-индикатор внутри кнопки-заголовка (общий `svgIcon`)',
    );
    // Карточка собирает заголовок через ЕДИНЫЙ конструктор шапки, а сам узел
    // компонента создаётся в его модуле (ошибка 47c2bf05; ранее — buildTitle).
    assert.match(
      CHRONICLE,
      /buildRecordHead\(/,
      'карточка берёт заголовок из единого конструктора шапки',
    );
    assert.match(
      RECORD_HEAD,
      /createRecordTitle\(/,
      'узел заголовка создаётся общим компонентом',
    );
    assert.match(
      RECORD_GROUPS,
      /title\.classList\?\.toggle\('is-collapsed', collapsed\)/,
      'класс заголовка — единый путь поворота индикатора',
    );
    assert.match(
      CHRONICLE_CSS,
      /\.diary-record-title\.is-collapsed svg\s*\{[^}]*transform:\s*rotate\(-90deg\)/,
      'свёрнутая запись поворачивает стрелку вправо (−90°)',
    );
    assert.match(
      CHRONICLE_CSS,
      /\.diary-record-title svg\s*\{[^}]*transition:\s*transform/,
      'поворот индикатора плавный',
    );
    assert.match(
      RECORD_TITLE,
      /setRecordTitleLabel\(view,/,
      'смена надписи сохраняет стрелку (иначе `textContent` её затирает)',
    );
  });

  it('смена надписи заголовка сохраняет иконку-шеврон (не стирает узлы)', () => {
    // Задача d586f340: проверки одного вызова `setRecordTitleLabel(view, …)` мало —
    // возврат тела помощника к `view.textContent = label` стирал бы svg-иконку
    // (первый узел кнопки), оставаясь зелёным. Разбираем тело помощника.
    const body =
      /function setRecordTitleLabel\(view: HTMLElement, label: string\): void \{([\s\S]*?)\n\}/.exec(
        RECORD_TITLE,
      )?.[1] ?? '';
    assert.ok(body !== '', 'тело setRecordTitleLabel найдено');
    const code = body.replace(/\/\/[^\n]*/g, '');
    // Иконка — первый узел: помощник берёт её и собирает содержимое заново.
    assert.match(code, /view\.firstChild/, 'берёт иконку-шеврон первым узлом');
    assert.match(
      code,
      /view\.replaceChildren\(\s*icon\s*,\s*label\s*\)/,
      'надпись ставится без затирания узлов (replaceChildren, а не textContent)',
    );
    // `textContent = label` допустим ТОЛЬКО как запасной путь для кнопки без иконки.
    const outsideFallback = code.replace(
      /if\s*\(\s*icon\s*===\s*null\s*\)\s*\{[\s\S]*?\n\s*\}/,
      '',
    );
    assert.ok(
      !/view\.textContent\s*=\s*label/.test(outsideFallback),
      'вне ветки без иконки надпись не ставится через textContent (потеря шеврона)',
    );
  });
});

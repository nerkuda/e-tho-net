/**
 * Юнит-тесты библиотечного контрола «редактор периода»
 * (client/src/renderer/lib/period-editor.ts).
 *
 * Задача T5 740b8045 (0.10.1), элемент интерфейса «Поле периода» 2f14de06,
 * ADR d4d53fe6, требование 91f8d8dd. Проверяется: три режима и их переключение,
 * значение `{ from?, to?, hasTime?, token? }`, динамические токены (только
 * глобальные), сохранение времени суток/секунд по ADR времени 994d076a,
 * клиентская валидация и `onChange`.
 *
 * Модуль гоняется под Node с минимальным DOM-шимом (`tests/dom-shim.ts`) — тот
 * же подход, что у suggest-dropdown.test.ts.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildPeriodEditor,
  composeInstant,
  composeLocalBound,
  formatPeriodLocalDisplay,
  GLOBAL_DATE_TOKEN_RE,
  hasExplicitTime,
  instantToLocalDate,
  instantToLocalTime,
  isGlobalDateToken,
  parseBound,
  parseLocalBound,
  PERIOD_TOKEN_PRESETS,
  setInstantDate,
  setInstantTime,
  validatePeriodToken,
} from '../src/renderer/lib/period-editor.js';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// DOM-шим
// ---------------------------------------------------------------------------

interface ShimWindow {
  innerWidth: number;
  innerHeight: number;
  addEventListener(type: string, listener: (event: any) => void, capture?: boolean): void;
  removeEventListener(type: string, listener: (event: any) => void, capture?: boolean): void;
}

/** Ставит свежие document/window для сборки контрола. */
function installShim(): ShimElement {
  const body = new ShimElement('body');
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (text: string) => new ShimElement('#text', undefined, text),
    body,
    activeElement: body,
  };
  const win: ShimWindow = {
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener() {
      /* capture-слушатели выпадашки в тестах не требуются */
    },
    removeEventListener() {
      /* см. выше */
    },
  };
  (globalThis as any).window = win;
  return body;
}

/** Корень контрола как узел DOM-шима (типы продукта — реальный DOM). */
function rootShim(root: HTMLElement): ShimElement {
  return root as unknown as ShimElement;
}

/** Поле по классу; отсутствие — ошибка теста. */
function field(root: HTMLElement, cls: string): ShimElement {
  const node = rootShim(root).querySelector(`.${cls}`);
  assert.ok(node, `в контроле обязано быть поле .${cls}`);
  return node;
}

/** Все поля по классу. */
function allFields(root: HTMLElement, cls: string): ShimElement[] {
  return rootShim(root).querySelectorAll(`.${cls}`);
}

/** Эмуляция ручного ввода: значение + событие. */
function type(node: ShimElement, value: string, event = 'change'): void {
  node.value = value;
  node.emit(event);
}

// ---------------------------------------------------------------------------
// Чистые помощники
// ---------------------------------------------------------------------------

describe('period-editor: разбор и валидация токенов', () => {
  it('глобальными считаются $today/$now и арифметика ±Nd', () => {
    for (const ok of ['$today', '$now', '$today+7d', '$today-3d', '$now+1d']) {
      assert.equal(isGlobalDateToken(ok), true, `${ok} — глобальный токен`);
    }
    for (const bad of ['$thought.title', '$thought.[версия]', '$user', '$foo', 'today', '$today + 1d', '$']) {
      assert.equal(isGlobalDateToken(bad), false, `${bad} — не токен периода`);
    }
  });

  it('все пресеты подсказок — допустимые глобальные токены', () => {
    for (const preset of PERIOD_TOKEN_PRESETS) {
      assert.match(preset.text, GLOBAL_DATE_TOKEN_RE);
    }
  });

  it('validatePeriodToken пропускает даты и глобальные токены, отвергает прочее', () => {
    for (const ok of ['', '2026-01-01', '$today', '$today-3d']) {
      assert.equal(validatePeriodToken(ok), null, `${ok} — корректно`);
    }
    for (const bad of ['$thought.title', '$foo', '2026-01-01$today']) {
      assert.notEqual(validatePeriodToken(bad), null, `${bad} — ошибка токена`);
    }
  });

  it('parseBound различает пусто/дату/инстанс/токен/ошибку', () => {
    assert.equal(parseBound('').kind, 'empty');
    assert.equal(parseBound('2026-09-26').kind, 'date');
    assert.equal(parseBound('$today-3d').kind, 'token');
    assert.equal(parseBound('2026-09-26T10:30:00.000Z').kind, 'instant');
    assert.equal(parseBound('2026-02-30').kind, 'invalid', 'несуществующая дата — ошибка');
    assert.equal(parseBound('2026-09-26T10:30:00').kind, 'invalid', 'инстанс без пояса — ошибка');
    assert.equal(parseBound('не дата').kind, 'invalid');
  });
});

describe('period-editor: время по ADR (локальный пояс)', () => {
  it('composeInstant собирает локальные дату и время в UTC-инстанс', () => {
    const instant = composeInstant('2026-09-26', '10:30');
    assert.notEqual(instant, '');
    assert.match(instant, /Z$/);
    assert.equal(instantToLocalDate(instant), '2026-09-26');
    assert.equal(instantToLocalTime(instant), '10:30');
  });

  it('правка часов:минут сохраняет секунды и миллисекунды', () => {
    const source = '2026-09-26T10:30:45.123Z';
    const next = setInstantTime(source, '11:45');
    assert.match(next, /:45\.123Z$/, 'секунды и мс сохранены');
    assert.equal(instantToLocalTime(next), '11:45');
  });

  it('смена только даты сохраняет время суток', () => {
    const source = '2026-09-26T10:30:45.123Z';
    const next = setInstantDate(source, '2026-10-01');
    assert.equal(instantToLocalDate(next), '2026-10-01');
    assert.equal(instantToLocalTime(next), instantToLocalTime(source));
    assert.match(next, /:45\.123Z$/, 'секунды и мс сохранены');
  });

  it('пустой состав — пустая строка', () => {
    assert.equal(composeInstant('', '10:00'), '');
    assert.equal(composeInstant('2026-09-26', ''), '');
  });
});

// ---------------------------------------------------------------------------
// Контрол
// ---------------------------------------------------------------------------

describe('period-editor: режимы и значение', () => {
  it('умолчание — режим «одна дата», пустое значение', () => {
    installShim();
    const editor = buildPeriodEditor({});
    assert.equal(editor.getMode(), 'date');
    assert.deepEqual(editor.getValue(), { hasTime: false });
    assert.equal(rootShim(editor.root).querySelector('.pe-time-input'), null, 'в режиме даты времени нет');
  });

  it('одна дата заполняет обе границы и не несёт времени', () => {
    installShim();
    const editor = buildPeriodEditor({ value: { from: '2026-09-26' } });
    assert.deepEqual(editor.getValue(), {
      from: '2026-09-26',
      to: '2026-09-26',
      hasTime: false,
    });
  });

  it('токен задаёт период целиком и попадает в поле token', () => {
    installShim();
    const editor = buildPeriodEditor({ value: { token: '$today-3d' } });
    assert.deepEqual(editor.getValue(), {
      from: '$today-3d',
      to: '$today-3d',
      hasTime: false,
      token: '$today-3d',
    });
  });

  it('режим «дата и время» отдаёт полный UTC-инстанс и hasTime', () => {
    installShim();
    const source = '2026-09-26T10:30:00.000Z';
    const editor = buildPeriodEditor({ mode: 'datetime', value: { from: source } });
    const value = editor.getValue();
    assert.equal(value.hasTime, true);
    assert.equal(value.from, value.to);
    assert.match(value.from ?? '', /Z$/);
    // Время показывается в локальном поясе наблюдателя (ADR времени).
    assert.equal(instantToLocalDate(value.from ?? ''), instantToLocalDate(source));
    assert.equal(instantToLocalTime(value.from ?? ''), instantToLocalTime(source));
  });

  it('режим «диапазон»: начало и конец независимы, время опционально', () => {
    installShim();
    const editor = buildPeriodEditor({
      mode: 'range',
      value: { from: '2026-09-26', to: '2026-09-28' },
    });
    assert.deepEqual(editor.getValue(), {
      from: '2026-09-26',
      to: '2026-09-28',
      hasTime: false,
    });
  });

  it('setMode сохраняет время суток при переходе в «дата и время»', () => {
    installShim();
    const source = '2026-09-26T10:30:45.123Z';
    const editor = buildPeriodEditor({
      mode: 'range',
      value: { from: source, to: '2026-09-28T08:00:00.000Z' },
    });
    editor.setMode('datetime');
    assert.equal(editor.getMode(), 'datetime');
    const value = editor.getValue();
    assert.equal(value.hasTime, true);
    assert.equal(instantToLocalTime(value.from ?? ''), instantToLocalTime(source));
    assert.match(value.from ?? '', /:45\.123Z$/, 'секунды и мс сохранены при смене режима');
  });

  it('setMode на «дата» убирает время (hasTime false)', () => {
    installShim();
    const source = '2026-09-26T10:30:00.000Z';
    const editor = buildPeriodEditor({ mode: 'datetime', value: { from: source } });
    editor.setMode('date');
    assert.equal(editor.getValue().hasTime, false);
    assert.equal(instantToLocalDate(editor.getValue().from ?? ''), instantToLocalDate(source));
  });

  it('setValue (range) кладёт конец во вторую границу', () => {
    installShim();
    const editor = buildPeriodEditor({ mode: 'range' });
    editor.setValue({ from: '2026-01-01', to: '2026-02-01' });
    assert.deepEqual(editor.getValue(), {
      from: '2026-01-01',
      to: '2026-02-01',
      hasTime: false,
    });
  });
});

describe('period-editor: ввод, валидация и onChange', () => {
  it('ручной ввод даты в поле обновляет значение и зовёт onChange', () => {
    installShim();
    const seen: unknown[] = [];
    const editor = buildPeriodEditor({ onChange: (v) => seen.push(v) });
    type(field(editor.root, 'pe-date-input'), '2026-09-26');
    assert.deepEqual(editor.getValue(), {
      from: '2026-09-26',
      to: '2026-09-26',
      hasTime: false,
    });
    assert.equal(seen.length, 1, 'onChange вызван ровно один раз');
  });

  it('ввод времени в диапазоне даёт полный инстанс и hasTime', () => {
    installShim();
    const editor = buildPeriodEditor({ mode: 'range' });
    const dateFields = allFields(editor.root, 'pe-date-input');
    type(dateFields[0]!, '2026-09-26');
    const timeFields = allFields(editor.root, 'pe-time-input');
    type(timeFields[0]!, '09:15');
    const value = editor.getValue();
    assert.equal(value.hasTime, true);
    assert.equal(instantToLocalDate(value.from ?? ''), '2026-09-26');
    assert.equal(instantToLocalTime(value.from ?? ''), '09:15');
    assert.equal(value.to, undefined, 'конец не задан');
  });

  it('некорректный токен даёт ошибку; глобальный — нет', () => {
    installShim();
    const editor = buildPeriodEditor({});
    type(field(editor.root, 'pe-date-input'), '$thought.title');
    assert.equal(editor.errors().length, 1);
    type(field(editor.root, 'pe-date-input'), '$today-3d');
    assert.deepEqual(editor.errors(), []);
    assert.equal(editor.getValue().token, '$today-3d');
  });

  it('некорректная дата даёт ошибку', () => {
    installShim();
    const editor = buildPeriodEditor({});
    type(field(editor.root, 'pe-date-input'), '2026-02-30');
    assert.equal(editor.errors().length, 1);
  });

  it('ввод полного инстанса разбирается в дату и время', () => {
    installShim();
    const source = '2026-09-26T10:30:45.123Z';
    const editor = buildPeriodEditor({ mode: 'datetime' });
    type(field(editor.root, 'pe-date-input'), source);
    const value = editor.getValue();
    assert.equal(instantToLocalDate(value.from ?? ''), instantToLocalDate(source));
    assert.equal(instantToLocalTime(value.from ?? ''), instantToLocalTime(source));
    assert.match(value.from ?? '', /:45\.123Z$/, 'секунды и мс исходного инстанса сохранены');
  });

  it('allowTokens:false отвергает токен', () => {
    installShim();
    const editor = buildPeriodEditor({ allowTokens: false });
    type(field(editor.root, 'pe-date-input'), '$today');
    assert.equal(editor.errors().length, 1, 'токен без поддержки отвергается валидацией');
  });
});

// ---------------------------------------------------------------------------
// Панельный вариант: «Пресеты»/«Даты» (0.10.1, приёмка №2)
// ---------------------------------------------------------------------------

describe('period-editor: панельный вариант «Пресеты»/«Даты» (приёмка №2)', () => {
  /** Конвертеры, как их задаёт панель «Дневника» (единый клиентский вычислитель). */
  const resolveToken = (token: string): string =>
    token === '$week.start' ? '2026-09-21' : token === '$week.end' ? '2026-09-27' : '';
  const tokensForRange = (from: string, to: string): { from: string; to: string } => ({
    from: from === '2026-09-21' ? '$week.start' : from,
    to: to === '2026-09-27' ? '$week.end' : to,
  });

  it('умолчание — режим «Пресеты», границы-комбобоксы со сдвигом', () => {
    installShim();
    const editor = buildPeriodEditor({
      variant: 'panel',
      value: { from: '$week.start', to: '$week.end' },
      resolveToken,
      tokensForRange,
    });
    assert.equal(editor.getPanelMode(), 'presets');
    assert.ok(rootShim(editor.root).querySelector('.pe-mode'), 'переключатель режима панели');
    assert.equal(allFields(editor.root, 'pe-preset-bound').length, 2, 'две пресет-границы');
    assert.equal(allFields(editor.root, 'pe-preset-anchor').length, 2, 'два комбобокса пресетов');
    assert.equal(allFields(editor.root, '.pe-time-input').length, 0, 'без часов/минут');
    assert.deepEqual(editor.getValue(), {
      from: '$week.start',
      to: '$week.end',
      hasTime: false,
      mode: 'presets',
    });
  });

  it('смена на «Даты» конвертирует токены в даты и помечает значение mode', () => {
    installShim();
    const seen: Array<{ from?: string; mode?: string }> = [];
    const editor = buildPeriodEditor({
      variant: 'panel',
      value: { from: '$week.start', to: '$week.end' },
      resolveToken,
      tokensForRange,
      onChange: (v) => seen.push({ from: v.from, mode: v.mode }),
    });
    editor.setPanelMode('dates');
    assert.equal(editor.getPanelMode(), 'dates');
    const dates = allFields(editor.root, 'date-field-input');
    assert.equal(dates.length, 2, 'в режиме «Даты» — два поля дат');
    assert.equal(dates[0]!.value, '2026-09-21', 'токен раскрыт в дату');
    assert.deepEqual(editor.getValue(), {
      from: '2026-09-21',
      to: '2026-09-27',
      hasTime: false,
      mode: 'dates',
    });
  });

  it('смена на «Пресеты» конвертирует даты в токены по правилу', () => {
    installShim();
    const editor = buildPeriodEditor({
      variant: 'panel',
      panelMode: 'dates',
      value: { from: '2026-09-21', to: '2026-09-27' },
      resolveToken,
      tokensForRange,
    });
    editor.setPanelMode('presets');
    assert.deepEqual(editor.getValue(), {
      from: '$week.start',
      to: '$week.end',
      hasTime: false,
      mode: 'presets',
    });
  });

  it('в режиме «Пресеты» поле показывает композицию, а наружу уходит канонический токен', () => {
    installShim();
    const seen: Array<string | undefined> = [];
    const editor = buildPeriodEditor({
      variant: 'panel',
      value: { from: '$month.end-1mo', to: '$today' },
      resolveToken,
      tokensForRange,
      onChange: (v) => seen.push(v.from),
    });
    // Поле-комбобокс — только чтение и человекочитаемая композиция, без токена.
    const anchor = allFields(editor.root, 'pe-preset-anchor')[0]!;
    assert.equal(anchor.readOnly, true, 'ввод токена в поле запрещён');
    assert.equal(anchor.value, 'конец месяца − 1 мес');
    assert.ok(!anchor.value.includes('$'), 'токен-строки в поле нет');
    const num = allFields(editor.root, 'pe-preset-num')[0]!;
    const unit = allFields(editor.root, 'pe-preset-unit')[0]!;
    assert.equal(num.value, '-1');
    assert.equal(unit.value, 'mo');
    assert.equal(editor.getValue().from, '$month.end-1mo');
    // Смена единицы сдвига пересобирает токен и обновляет композицию поля.
    type(unit, 'w');
    assert.equal(editor.getValue().from, '$month.end-1w');
    assert.equal(anchor.value, 'конец месяца − 1 нед');
    assert.deepEqual(seen, ['$month.end-1w']);
  });

  it('диапазон «Даты» редактируется датами и отдаёт точные даты', () => {
    installShim();
    const editor = buildPeriodEditor({
      variant: 'panel',
      panelMode: 'dates',
      resolveToken,
      tokensForRange,
    });
    // Компонентные поля даты (итерация приёмки №8, п.4): правка «С»/«По»
    // пересобирает строки (автоподгон «С» ≤ «По») — поле берём заново.
    const dates = allFields(editor.root, 'date-field-input');
    type(dates[0]!, '2026-09-10');
    const afterFrom = allFields(editor.root, 'date-field-input');
    type(afterFrom[1]!, '2026-09-12');
    assert.deepEqual(editor.getValue(), {
      from: '2026-09-10',
      to: '2026-09-12',
      hasTime: false,
      mode: 'dates',
    });
  });
});

// ---------------------------------------------------------------------------
// Вариант «dialog»: поле-значение периода (0.10.1, задача 12a5e719)
// ---------------------------------------------------------------------------

describe('period-editor: вариант «dialog» — поле-значение периода (12a5e719)', () => {
  it('чистые помощники: локальное представление, сборка и признак времени', () => {
    assert.deepEqual(parseLocalBound('2026-09-26T10:30:00'), { date: '2026-09-26', time: '10:30' });
    assert.deepEqual(parseLocalBound('2026-09-26'), { date: '2026-09-26', time: '' });
    assert.deepEqual(parseLocalBound(''), { date: '', time: '' });
    assert.equal(hasExplicitTime('00:00'), false, 'полночь — времени нет');
    assert.equal(hasExplicitTime('10:00'), true);
    assert.equal(hasExplicitTime(''), false);
    assert.equal(composeLocalBound('2026-09-26', ''), '2026-09-26');
    assert.match(composeLocalBound('2026-09-26', '10:30'), /Z$/);
    assert.equal(composeLocalBound('', '10:30'), '');
    assert.equal(formatPeriodLocalDisplay('2026-09-26', '2026-09-28'), '2026-09-26 - 2026-09-28');
    assert.equal(formatPeriodLocalDisplay('2026-09-26T10:30:00', '2026-09-26T00:00:00'), '2026-09-26 10:30 - 2026-09-26');
    assert.equal(formatPeriodLocalDisplay('', ''), '');
  });

  it('пустое значение: заглушка, крестик скрыт, индикатора нет, переключателей нет', () => {
    installShim();
    const editor = buildPeriodEditor({ variant: 'dialog' });
    assert.ok(rootShim(editor.root).querySelector('.pe-dialog-value'), 'кнопка-значение периода');
    assert.equal(field(editor.root, 'pe-dialog-clear').hidden, true, 'крестик у пустого скрыт');
    assert.equal(field(editor.root, 'pe-dialog-time').hidden, true, 'индикатора времени нет');
    assert.equal(allFields(editor.root, 'pe-mode').length, 0, 'переключателя режимов нет');
    assert.deepEqual(editor.getValue(), { hasTime: false });
  });

  it('историческая «наивная» дата-время читается и показывает время', () => {
    installShim();
    const editor = buildPeriodEditor({
      variant: 'dialog',
      value: { from: '2024-02-01T10:30:00', to: '2024-02-28T00:00:00' },
    });
    assert.equal(
      field(editor.root, 'pe-dialog-value').textContent,
      '2024-02-01 10:30 - 2024-02-28',
    );
    assert.equal(field(editor.root, 'pe-dialog-time').hidden, false, 'время не полночь — индикатор виден');
    assert.equal(editor.getValue().from, '2024-02-01T10:30:00', 'историческое значение не искажено');
    assert.equal(editor.getValue().hasTime, true);
  });

  it('обе границы — полночь: индикатор скрыт', () => {
    installShim();
    const editor = buildPeriodEditor({
      variant: 'dialog',
      value: { from: '2024-02-01T00:00:00', to: '2024-02-28T00:00:00' },
    });
    assert.equal(field(editor.root, 'pe-dialog-time').hidden, true);
    assert.equal(editor.getValue().hasTime, false);
  });

  it('крестик очищает период и сообщает onChange', () => {
    installShim();
    const seen: Array<{ from?: string; to?: string }> = [];
    const editor = buildPeriodEditor({
      variant: 'dialog',
      value: { from: '2026-09-26', to: '2026-09-28' },
      onChange: (v) => seen.push({ from: v.from, to: v.to }),
    });
    field(editor.root, 'pe-dialog-clear').click();
    assert.deepEqual(editor.getValue(), { hasTime: false });
    assert.equal(seen.length, 1, 'onChange вызван один раз');
    assert.equal(seen[0]!.from, undefined);
    assert.equal(seen[0]!.to, undefined);
  });

  it('клик по значению открывает диалог и применяет новые границы', async () => {
    installShim();
    const seen: unknown[] = [];
    const source = '2026-10-01T08:00:00.000Z';
    const editor = buildPeriodEditor({
      variant: 'dialog',
      value: { from: '2026-09-26' },
      onChange: (v) => seen.push(v),
      openPeriodDialog: async () => ({
        from: source,
        to: '2026-10-05T20:00:00.000Z',
      }),
    });
    field(editor.root, 'pe-dialog-value').click();
    await Promise.resolve();
    await Promise.resolve();
    const value = editor.getValue();
    assert.equal(instantToLocalDate(value.from ?? ''), instantToLocalDate(source));
    assert.equal(instantToLocalTime(value.from ?? ''), instantToLocalTime(source));
    assert.equal(value.hasTime, true);
    assert.equal(seen.length, 1, 'onChange вызван после применения');
    assert.equal(field(editor.root, 'pe-dialog-time').hidden, false);
  });
});

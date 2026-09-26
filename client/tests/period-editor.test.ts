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
  GLOBAL_DATE_TOKEN_RE,
  instantToLocalDate,
  instantToLocalTime,
  isGlobalDateToken,
  parseBound,
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

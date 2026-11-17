/**
 * Дни недели в редакторе напоминания (0.16.1, ошибка cbac920b).
 *
 * Симптом: в команде «каждую неделю» блок «День недели» показывал слитную
 * строку «пн вт ср чт пт сб вс» без отметок. Причина — у контрола не было
 * видимой кожи: базовый `.ui-toggle` вида не задаёт (вид даёт владелец или
 * режим), а глобальный сброс `button` в `tokens.css` снимает фон, границы и
 * отступы. Поэтому каждый день обязан быть тумблером режима `glyph` (кожа и
 * заливка нажатого — токенами темы), а выбор дня — попадать в
 * `schedule.weekdays.days` и фильтровать превью.
 *
 * DOM — общий шим `./dom-shim.js`; локали — словарь (`weekdayLabel`).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, it } from 'node:test';

import { expandOccurrences, normalizeAnchor } from '@etn/shared';

import {
  reminderEditorInternals,
  scheduleOf,
  toggleWeekdayDays,
  weekdayToggleRow,
  type ReminderDraft,
} from '../src/renderer/lib/reminder-editor.js';
import { weekdayLabel } from '../src/renderer/lib/reminder-label.js';
import { TOGGLE_CLASS } from '../src/renderer/lib/ui/toggle.js';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const body = new ShimElement('body');

/** Поднять минимальный `document`/`window` для `lib/dom.ts` и фасадов `lib/ui`. */
function installDom(): void {
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    body,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
    querySelectorAll: (selector: string) => body.querySelectorAll(selector),
    querySelector: (selector: string) => body.querySelector(selector),
    activeElement: null,
  };
  (globalThis as any).HTMLElement = ShimElement;
  const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
  win.innerWidth = 1200;
  win.innerHeight = 800;
  win.addEventListener = (): void => undefined;
  win.removeEventListener = (): void => undefined;
}

/** Кнопки ряда в порядке разметки (слева направо). */
function dayButtons(row: HTMLElement): HTMLElement[] {
  return Array.from(row.querySelectorAll('button')) as unknown as HTMLElement[];
}

/** Состояния кнопок: `true` — день отмечен. */
function pressedStates(row: HTMLElement): boolean[] {
  return dayButtons(row).map((button) => button.getAttribute('aria-pressed') === 'true');
}

beforeEach(() => {
  installDom();
});

describe('дни недели: видимые тумблеры-чекбоксы (ошибка cbac920b)', () => {
  it('каждый день — кнопка-тумблер с кожей режима glyph и состоянием aria-pressed', () => {
    const row = weekdayToggleRow({
      days: [],
      startDay: 1,
      onToggle: () => undefined,
    }) as unknown as HTMLElement;
    assert.equal(row.className, 'reminder-weekdays');
    const buttons = dayButtons(row);
    assert.equal(buttons.length, 7, 'ровно семь дней');
    for (const button of buttons) {
      assert.equal(button.tagName.toLowerCase(), 'button');
      const classes = button.className.split(/\s+/);
      assert.ok(classes.includes(TOGGLE_CLASS), `нет класса фасада: ${button.className}`);
      assert.ok(
        classes.includes(`${TOGGLE_CLASS}--glyph`),
        'без режима glyph у тумблера нет кожи: базовый .ui-toggle пуст, а сброс button снимает фон и границы',
      );
      assert.ok(classes.includes('reminder-weekday'), 'класс владельца для проб и раскладки');
      assert.equal(button.getAttribute('aria-pressed'), 'false');
    }
    assert.deepEqual(
      buttons.map((button) => button.textContent),
      [1, 2, 3, 4, 5, 6, 7].map((day) => weekdayLabel(day)),
      'подписи — короткие названия дней',
    );
    assert.deepEqual(
      buttons.map((button) => button.title),
      [1, 2, 3, 4, 5, 6, 7].map((day) => weekdayLabel(day, 'long')),
      'подсказка — полное название дня',
    );
  });

  it('порядок флажков — с первого дня недели сети (требование 1b77decd)', () => {
    const row = weekdayToggleRow({
      days: [],
      startDay: 3,
      onToggle: () => undefined,
    }) as unknown as HTMLElement;
    const expected = [3, 4, 5, 6, 7, 1, 2].map((day) => weekdayLabel(day));
    assert.deepEqual(
      dayButtons(row).map((button) => button.textContent),
      expected,
      'неделя начинается со среды',
    );
  });

  it('отмечены ровно выбранные дни', () => {
    const row = weekdayToggleRow({
      days: [1, 4],
      startDay: 1,
      onToggle: () => undefined,
    }) as unknown as HTMLElement;
    assert.deepEqual(pressedStates(row), [true, false, false, true, false, false, false]);
  });

  it('клик переключает состояние и отдаёт день с новым значением', () => {
    const calls: Array<[number, boolean]> = [];
    const row = weekdayToggleRow({
      days: [2],
      startDay: 1,
      onToggle: (day, pressed) => calls.push([day, pressed]),
    }) as unknown as HTMLElement;
    const [monday, tuesday] = dayButtons(row);
    assert.ok(monday !== undefined && tuesday !== undefined);

    monday.click();
    assert.deepEqual(calls, [[1, true]], 'включение понедельника');
    assert.equal(monday.getAttribute('aria-pressed'), 'true');

    tuesday.click();
    assert.deepEqual(
      calls,
      [
        [1, true],
        [2, false],
      ],
      'выключение вторника',
    );
    assert.equal(tuesday.getAttribute('aria-pressed'), 'false');
  });

  it('выбор дней попадает в расписание и фильтрует превью', () => {
    let draft: ReminderDraft = {
      ...reminderEditorInternals.emptyDraft(),
      command: 'weekdays',
      days: [],
    };
    const row = weekdayToggleRow({
      days: draft.days,
      startDay: 1,
      onToggle: (day, pressed) => {
        draft = { ...draft, days: toggleWeekdayDays(draft.days, day, pressed) };
      },
    }) as unknown as HTMLElement;
    const friday = dayButtons(row)[4];
    assert.ok(friday !== undefined);
    friday.click();
    assert.ok(draft.days.includes(5), 'пятница попала в черновик');

    const schedule = scheduleOf(draft);
    assert.deepEqual(schedule, { type: 'weekdays', days: [5], every_weeks: 1 });

    const now = Date.parse('2026-11-17T06:00:00.000Z'); // вторник
    const normalized = normalizeAnchor(
      schedule,
      reminderEditorInternals.localInstant(draft.date, draft.time),
    );
    const occurrences = expandOccurrences(
      schedule,
      normalized,
      now,
      now + 40 * 86_400_000,
      new Map(),
    );
    assert.ok(occurrences.length > 0, 'серия даёт вхождения');
    for (const occurrence of occurrences) {
      assert.equal(
        new Date(occurrence.occurrence_at).getDay(),
        5,
        'вхождения — только по пятницам',
      );
    }
  });
});

describe('кожа тумблера дней недели — токены темы и видимое нажатие', () => {
  const css = readFileSync(new URL('../src/renderer/lib/ui/toggle.css', import.meta.url), 'utf8');
  const glyph = css.slice(css.indexOf('.ui-toggle--glyph {'));

  it('режим glyph задаёт рамку, фон и отступы токенами (иначе — слитная строка текста)', () => {
    assert.match(glyph, /border:\s*1px solid var\(--border-strong\)/);
    assert.match(glyph, /background:\s*var\(--surface\)/);
    assert.match(glyph, /width:\s*var\(--control-w-m\)/);
    assert.match(glyph, /height:\s*var\(--control-h\)/);
  });

  it('нажатый день виден заливкой и рамкой акцента', () => {
    const pressed = /\.ui-toggle--glyph\[aria-pressed='true'\]\s*\{([^}]*)\}/.exec(css);
    assert.ok(pressed !== null, 'нет правила нажатого состояния — включённый день не отличить');
    const rule = pressed[1] ?? '';
    assert.match(rule, /background:\s*var\(--accent-soft\)/);
    assert.match(rule, /border-color:\s*var\(--accent\)/);
    assert.match(rule, /color:\s*var\(--accent\)/);
  });

  it('в коже нет hex: цвета берутся из темы', () => {
    assert.equal(/#[0-9a-f]{3,8}\b/i.test(glyph), false, 'hex-цвет сломал бы тёмные темы');
  });
});

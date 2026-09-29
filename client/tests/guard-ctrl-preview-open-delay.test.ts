/**
 * Сторож и поведенческая проба единой задержки Ctrl+предпросмотров
 * (ошибка 34e61b47: «Ctrl+наведение: предпросмотр срабатывает слишком быстро
 * и перехватывает Ctrl+click»).
 *
 * Что проверяется.
 *
 * 1. Поведение общего планировщика `lib/preview-open-delay.ts` на
 *    ИСКУССТВЕННЫХ таймерах: до истечения задержки показа нет, по её истечении
 *    — есть; отмена (отпускание Ctrl / mousedown) до истечения задержки
 *    отменяет неоткрывшийся предпросмотр; повтор для того же субъекта не
 *    перезапускает таймер, смена субъекта — заменяет ожидание.
 * 2. Единственный источник значения: константа одна и равна 500 мс; оба
 *    движка (`hover-preview.ts` и `image-zoom.ts`) импортируют её и планируют
 *    открытие через `createDelayedOpen`; прежней задержки `OPEN_DEBOUNCE_MS`
 *    (200 мс) в коде нет.
 *
 * Сторож КРАСНЕЕТ, если задержку откатить к прежнему поведению: уменьшить
 * значение (первое утверждение требует ровно 500) или показать предпросмотр
 * мгновенно мимо `createDelayedOpen` (структурная проверка wiring'а). Проба
 * на искусственных таймерах ловит и числовой откат: при 200 мс предпросмотр
 * «открылся бы» уже на отметке 499 мс, где проба требует тишины.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, it } from 'node:test';

import {
  CTRL_PREVIEW_OPEN_DELAY_MS,
  createDelayedOpen,
} from '../src/renderer/lib/preview-open-delay.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const LIB = resolve(import.meta.dirname, '..', 'src', 'renderer', 'lib');
const SRC = {
  delay: resolve(LIB, 'preview-open-delay.ts'),
  hover: resolve(LIB, 'hover-preview.ts'),
  zoom: resolve(LIB, 'image-zoom.ts'),
};

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

/** Искусственные таймеры: время двигается только явным `advance`. */
interface FakeClock {
  api: {
    setTimeout(fn: () => void, ms: number): number;
    clearTimeout(id: number): void;
  };
  advance(ms: number): void;
}

function fakeClock(): FakeClock {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    api: {
      setTimeout(fn, ms) {
        const id = nextId++;
        timers.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    },
    advance(ms) {
      now += ms;
      let progressed = true;
      while (progressed) {
        progressed = false;
        for (const [id, timer] of [...timers]) {
          if (timer.at <= now) {
            timers.delete(id);
            progressed = true;
            timer.fn();
          }
        }
      }
    },
  };
}

describe('единая задержка Ctrl+предпросмотров: поведение (ошибка 34e61b47)', () => {
  let clock: FakeClock;
  let opened: string[];

  beforeEach(() => {
    clock = fakeClock();
    opened = [];
    (globalThis as any).window = clock.api;
  });

  it('до истечения задержки показа нет, по её истечении — есть', () => {
    assert.equal(CTRL_PREVIEW_OPEN_DELAY_MS, 500, 'граница пробы — 500 мс');
    const scheduler = createDelayedOpen<string>((subject) => opened.push(subject));
    scheduler.schedule('trigger');

    // Литеральная граница 500 мс (а не CTRL_PREVIEW_OPEN_DELAY_MS): откат
    // значения к 200 мс должен ронять пробу, а не «подстраивать» её.
    clock.advance(499);
    assert.deepEqual(opened, [], 'на t < 500 мс предпросмотра быть не должно');
    assert.equal(scheduler.pending, 'trigger', 'показ ещё ожидается');

    clock.advance(1);
    assert.deepEqual(opened, ['trigger'], 'на t ≥ 500 мс предпросмотр открывается');
  });

  it('отмена до истечения задержки отменяет неоткрывшийся предпросмотр', () => {
    const scheduler = createDelayedOpen<string>((subject) => opened.push(subject));
    scheduler.schedule('trigger');
    clock.advance(CTRL_PREVIEW_OPEN_DELAY_MS - 1);

    scheduler.cancel(); // отпускание Ctrl / mousedown
    assert.equal(scheduler.pending, null);
    clock.advance(10_000);
    assert.deepEqual(opened, [], 'после отмены предпросмотр не открывается');
  });

  it('повтор для того же субъекта не перезапускает таймер', () => {
    const scheduler = createDelayedOpen<string>((subject) => opened.push(subject));
    scheduler.schedule('trigger');
    clock.advance(CTRL_PREVIEW_OPEN_DELAY_MS - 1);
    scheduler.schedule('trigger'); // тот же триггер — не сдвигает окно

    clock.advance(1);
    assert.deepEqual(opened, ['trigger']);
  });

  it('смена субъекта заменяет ожидающий показ', () => {
    const scheduler = createDelayedOpen<string>((subject) => opened.push(subject));
    scheduler.schedule('first');
    clock.advance(100);
    scheduler.schedule('second');

    clock.advance(CTRL_PREVIEW_OPEN_DELAY_MS - 1);
    assert.deepEqual(opened, [], 'старый субъект отменён, новый ещё ждёт');
    clock.advance(1);
    assert.deepEqual(opened, ['second']);
  });
});

describe('единая задержка Ctrl+предпросмотров: единственный источник (ошибка 34e61b47)', () => {
  it('константа одна и равна 500 мс', () => {
    assert.equal(CTRL_PREVIEW_OPEN_DELAY_MS, 500);
    const delay = readText(SRC.delay);
    assert.ok(
      delay.includes('export const CTRL_PREVIEW_OPEN_DELAY_MS = 500;'),
      'значение объявлено ровно один раз в нейтральном модуле',
    );
  });

  it('движок предпросмотров берёт задержку из общего модуля, старой нет', () => {
    const src = readText(SRC.hover);
    assert.ok(
      src.includes("from './preview-open-delay.js'") && src.includes('createDelayedOpen'),
      'hover-preview.ts планирует открытие через общий createDelayedOpen',
    );
    assert.ok(
      src.includes('CTRL_PREVIEW_OPEN_DELAY_MS'),
      'hover-preview.ts ссылается на общую константу',
    );
    assert.ok(!src.includes('OPEN_DEBOUNCE_MS'), 'прежний собственный дебаунс удалён');
    assert.ok(!/=\s*200\b/.test(src), 'число 200 мс как задержка открытия убрано');
    assert.ok(
      /watchOutsideTap\([\s\S]*?cancelPendingOpen\(\)/.test(src),
      'нажатие мыши (через компонентный watchOutsideTap) отменяет неоткрывшийся предпросмотр',
    );
  });

  it('«лупа» использует ту же задержку и не показывается мгновенно', () => {
    const src = readText(SRC.zoom);
    assert.ok(
      src.includes("from './preview-open-delay.js'") && src.includes('createDelayedOpen'),
      'image-zoom.ts показывает лупу через общий createDelayedOpen',
    );
    // Все пути показа (mouseover и Ctrl уже зажат) идут через scheduleShow —
    // прямого вызова `show(` из обработчиков нет.
    assert.ok(/const scheduleShow = /.test(src), 'есть единая точка отложенного показа лупы');
    assert.ok(
      (src.match(/scheduleShow\(/g) ?? []).length >= 2,
      'mouseover и keydown Control планируют показ через scheduleShow',
    );
    assert.ok(!/= 200\b/.test(src), 'мгновенного показа без задержки не осталось');
    assert.ok(
      /watchOutsideTap\([\s\S]*?zoomScheduler\.cancel\(\)/.test(src),
      'нажатие мыши (через компонентный watchOutsideTap) отменяет неоткрывшуюся лупу',
    );
  });
});

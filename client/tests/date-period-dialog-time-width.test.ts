/**
 * Регресс ошибки c4eea7aa: поле времени диалога «Дата/период» достаточно
 * широкое, чтобы `HH:MM` и нативная иконка-пикер Chromium не перекрывались.
 *
 * Симптом (сообщение пользователя, итерации приёмки №5–№7): `.dpd-value
 * .dpd-time` имело `width: 70px` при `padding: 5px 8px` (`.ui-input`) — контент
 * -бокс ≈ 54px. У `input[type=time]` Chromium держит справа иконку-«часики»
 * (`::-webkit-calendar-picker-indicator`); при такой ширине разряды минут
 * уезжали под индикатор. Подтверждено замером Chromium-рендера клиента
 * (Electron): при 70px видно `10:0…`, при 86px и шире — полное `10:00`.
 *
 * Тест СТРУКТУРНЫЙ (собранный CSS) и красный на прежнем правиле: порог 90px
 * отсекает 70px, но допускает запас 90–104px. Замер делает тест независимым
 * от точной длины текста и шрифта: он держит минимально достаточный резерв.
 *
 * Дом — собранный CSS (`tests/renderer-css.ts`), комментарии снимаются, чтобы
 * не ловить числа из пояснений.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readRendererCss } from './renderer-css.js';

/** CSS манифеста без комментариев. */
const CSS = readRendererCss().replace(/\/\*[\s\S]*?\*\//g, '');

/** Тело правила CSS, среди селекторов которого есть точный (комментарии сняты). */
function cssBlock(source: string, selector: string): string {
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1]!.split(',').map((s) => s.trim());
    if (selectors.includes(selector)) return match[2]!;
  }
  assert.fail(`нет правила ${selector}`);
}

/** Число из `свойство: <N>px`. */
function px(decl: string, property: string): number {
  const match = new RegExp(`${property}\\s*:\\s*(\\d+(?:\\.\\d+)?)px`).exec(decl);
  assert.ok(match !== null, `нет ${property}: <N>px в «${decl.trim()}»`);
  return Number(match[1]);
}

describe('ошибка c4eea7aa: поле времени не перекрывается иконкой-пикером', () => {
  it('ширина `.dpd-value .dpd-time` даёт резерв под HH:MM + иконку (≥ 90px)', () => {
    const time = cssBlock(CSS, '.dpd-value .dpd-time');
    const width = px(time, 'width');
    assert.ok(
      width >= 90,
      `ширина времени ≥ 90px, иначе иконка-пикер перекрывает минуты (получено ${width}px)`,
    );
    assert.ok(
      width <= 104,
      `ширина времени не раздута сверх нужного (получено ${width}px)`,
    );
  });

  it('поле времени фиксированной ширины и по-прежнему центрирует значение', () => {
    const time = cssBlock(CSS, '.dpd-value .dpd-time');
    assert.match(time, /flex:\s*0\s+0\s+auto/, 'поле не растягивается на ширину диалога');
    assert.match(time, /text-align:\s*center/, 'значение центрировано');
    assert.ok(!/width:\s*100%/.test(time), 'поле времени не на всю ширину');
    assert.ok(!/padding-right/.test(time), 'резерв даёт ширина, а не сдвигающий текст padding');
  });

  it('строка значения остаётся в одну линию (коммит a7b306da не откатывается)', () => {
    const line = cssBlock(CSS, '.dpd-value');
    assert.match(line, /flex-wrap:\s*nowrap/, 'контролы не переносятся на другую линию');
    assert.ok(!/flex-wrap:\s*wrap/.test(line), 'flex-wrap: wrap запрещён');
  });
});

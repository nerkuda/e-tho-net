/**
 * Сторож: кнопка с атрибутом `hidden` обязана исчезать (грабля повторялась
 * трижды — `.editor-tab`, `.tab-overflow`, `.link-value-corner-btn`, а по
 * задаче b02ef1cf — ещё и `.st-f-clear-inline`).
 *
 * Причина. Скрытие делается кодом (`el.hidden = true`), а браузерное
 * `[hidden] { display: none }` — правило user-agent'а normal-приоритета. В
 * бандл клиента входит таблица Web Awesome, где авторское слоёное правило
 * `@layer wa-native button, input[type=button], … { display: inline-flex }`
 * его перебивает (author > UA независимо от специфичности). Поэтому у
 * произвольной `<button hidden>` без явного авторского `[hidden]`-правила
 * остаётся видимый пустой квадрат (у `.st-f-clear-inline` — 22×22).
 *
 * Инвариант: в `styles/tokens.css` есть неслоёное правило `button[hidden]`
 * с `display: none` — оно бьёт и слоёные правила Web Awesome, и однотипные
 * классовые (`0-1-1` > `0-1-0`). Плюс сохраняются точечные правила для
 * исторически починенных классов (документируют грабли и страхуют от
 * перестановки импортов).
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');

/** Тело CSS-правила по селектору или `null`, если правила нет. */
function ruleBody(css: string, selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  return match?.[1] ?? null;
}

describe('guard: `<button hidden>` реально скрывается (b02ef1cf)', () => {
  const tokens = fs.readFileSync(path.join(RENDERER_ROOT, 'styles', 'tokens.css'), 'utf8');

  it('tokens.css задаёт общий паттерн `button[hidden] { display: none }`', () => {
    const body = ruleBody(tokens, 'button[hidden]');
    assert.ok(body !== null, 'правило button[hidden] присутствует в styles/tokens.css');
    assert.match(body!, /display\s*:\s*none\b/, 'button[hidden] задаёт display: none');
  });

  it('точечные `[hidden]`-правила починенных ранее классов на месте', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['styles/editor.css', '.editor-tab[hidden]'],
      ['styles/layout.css', '.tab-overflow[hidden]'],
      ['styles/legacy.css', '.link-value-corner-btn[hidden]'],
    ];
    for (const [rel, selector] of cases) {
      const css = fs.readFileSync(path.join(RENDERER_ROOT, rel), 'utf8');
      const body = ruleBody(css, selector);
      assert.ok(body !== null, `${rel}: правило ${selector} найдено`);
      assert.match(body!, /display\s*:\s*none\b/, `${rel}: ${selector} задаёт display: none`);
    }
  });
});

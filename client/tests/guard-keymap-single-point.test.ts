/**
 * Сторож единственной точки перехвата `keydown` (ADR `b420b08c`, задача
 * e7bf87e3, ТП1).
 *
 * Правило: глобальный перехват клавиш приложения живёт в общеклиентском
 * диспетчере контекстов `lib/keymap.ts` (`installKeymap`), а `app.ts` только
 * регистрирует свои команды в диспетчере. Свой `window.addEventListener(
 * 'keydown')` в `app.ts` — нарушение: он завёл бы вторую точку перехвата и
 * обошёл приоритет контекстов (диалог поверх поля и т. п.).
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const RENDERER_ROOT = path.resolve(import.meta.dirname, '..', 'src', 'renderer');

const APP = fs.readFileSync(path.join(RENDERER_ROOT, 'app.ts'), 'utf8');
const KEYMAP = fs.readFileSync(path.join(RENDERER_ROOT, 'lib', 'keymap.ts'), 'utf8');
const MAIN = fs.readFileSync(path.join(RENDERER_ROOT, 'main.ts'), 'utf8');

describe('сторож: единственная точка перехвата keydown в keymap', () => {
  it('app.ts не заводит собственный слушатель keydown', () => {
    assert.equal(
      APP.includes("addEventListener('keydown'"),
      false,
      'app.ts должен регистрировать команды в диспетчере, а не слушать keydown сам',
    );
  });

  it('app.ts устанавливает диспетчер и регистрирует глобальный контекст', () => {
    assert.ok(APP.includes('installKeymap()'), 'initKeyboard ставит lib/keymap-диспетчер');
    assert.ok(APP.includes('GLOBAL_CONTEXT_ID'), 'app.ts регистрирует глобальный контекст');
  });

  it('диспетчер владеет слушателем keydown', () => {
    const occurrences = KEYMAP.split("addEventListener('keydown'").length - 1;
    assert.equal(occurrences, 1, 'lib/keymap.ts — единственное место установки keydown-слушателя');
  });

  it('main.ts поднимает клавиатуру через initKeyboard', () => {
    assert.ok(MAIN.includes('initKeyboard()'), 'main.ts вызывает initKeyboard');
  });
});

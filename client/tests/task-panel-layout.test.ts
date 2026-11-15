/**
 * Вид панели «Задачи и напоминания» — CSS-якоря исправлений 0.16.1
 * (ошибки 58c470a3 / d0801eea / d318a647).
 *
 * Домен компоненты (секции, строки, действия) проверяют тесты на DOM-шиме; здесь
 * держится то, что живёт ТОЛЬКО в CSS:
 *  • шапка панели приклеена к верху и не уезжает при прокрутке списка
 *    (ошибка 58c470a3) — сама прокрутка у панели, поэтому отступы ушли в шапку
 *    и тело, иначе содержимое шло бы под шапкой в полосе отступа;
 *  • каретка сворачиваемых блоков поворачивается в свёрнутом виде
 *    (ошибка d0801eea) — без этого сворачивание не видно;
 *  • чекбокс серой строки НЕ гасится: он остаётся командой (ошибка d318a647).
 *
 * Файл читается напрямую: `lib/ui/task-panel.css` подключается из
 * `lib/ui/register.ts`, а не из манифеста `styles.css`, поэтому
 * `readRendererCss()` его не видит.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { RENDERER_ROOT } from './renderer-css.js';

/** CSS панели без комментариев. */
const CSS = fs
  .readFileSync(path.join(RENDERER_ROOT, 'lib', 'ui', 'task-panel.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** Тело правила по точному селектору (последнее вхождение). */
function ruleBody(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[},])\\s*${esc}\\s*\\{([^}]*)\\}`, 'g');
  let body: string | null = null;
  for (const match of CSS.matchAll(re)) {
    if (match[1] !== undefined) body = match[1];
  }
  assert.ok(body !== null, `правило «${selector}» есть в task-panel.css`);
  return body;
}

describe('панель задач: шапка, свёрнутость и серая строка в CSS', () => {
  it('шапка панели приклеена к верху прокручиваемой панели (58c470a3)', () => {
    const head = ruleBody('.ui-task-panel-head');
    assert.match(head, /position:\s*sticky/, 'шапка не прокручивается со списком');
    assert.match(head, /top:\s*0/, 'шапка держится у верхней границы панели');
    assert.match(head, /background:\s*var\(--surface\)/, 'строки не просвечивают сквозь шапку');
    assert.match(head, /padding:\s*var\(--space-/, 'отступ панели перенесён в шапку');
    // Панель — сама прокручиваемый контейнер: без `overflow` sticky не работает.
    assert.match(ruleBody('.ui-task-panel'), /overflow:\s*auto/);
    assert.doesNotMatch(
      ruleBody('.ui-task-panel'),
      /\n\s*padding:/,
      'у корня панели нет собственного отступа: содержимое не идёт под шапкой',
    );
  });

  it('каретка сворачиваемых блоков поворачивается в свёрнутом виде (d0801eea)', () => {
    assert.match(
      CSS,
      /\.ui-task-caret\.collapsed[^{]*\{[^}]*transform:\s*rotate\(-90deg\)/,
      'каретка группы/секции показывает свёрнутость',
    );
    assert.match(
      CSS,
      /\.ui-task-caret,[\s\S]*?\{[^}]*display:\s*inline-flex/,
      'каретка — inline-flex (поворот вокруг своего центра)',
    );
    assert.match(
      ruleBody('.ui-task-section-head'),
      /cursor:\s*pointer/,
      'заголовок секции — кликабельная шапка сворачиваемой группы',
    );
  });

  it('чекбокс серой строки не гасится: он остаётся командой (d318a647)', () => {
    assert.doesNotMatch(
      CSS,
      /\.ui-task-row\.is-stale\s+\.ui-task-row-check/,
      'у чекбокса серой строки нет «выключенного» вида — он работает',
    );
    assert.match(ruleBody('.ui-task-row.is-stale'), /color:\s*var\(--text-dim\)/, 'гасится текст');
  });
});

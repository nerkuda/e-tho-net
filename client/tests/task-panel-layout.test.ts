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

/** Тела всех правил с точным селектором (селекторы через запятую учитываются). */
function ruleBodies(selector: string): string[] {
  const code = CSS;
  const bodies: string[] = [];
  for (const match of code.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1]!.split(',').map((part) => part.trim().replace(/\s+/g, ' '));
    if (selectors.includes(selector)) bodies.push(match[2]!);
  }
  return bodies;
}

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

  // Пункт E ТЗ 2026-11-17: заголовок группы крупнее на полшага шкалы, фон
  // полосы панели — «элемент UI» (светлее в тёмной теме, темнее в светлой).
  it('заголовок группы — плюс полшага шкалы токенов (пункт E)', () => {
    assert.match(
      ruleBody('.ui-task-group-title'),
      /font-size:\s*calc\(\s*var\(--font-size-s\)\s*\+\s*var\(--font-size-step-half\)\s*\)/,
      'полшага — токен шкалы, а не литерал px',
    );
    assert.match(
      ruleBody('.ui-task-group-title'),
      /font-weight:\s*var\(--font-weight-semibold\)/,
      'насыщенность заголовка не потеряна',
    );
  });

  it('фон полосы панели смешан от темы и текста, а не взят поверхностью (пункт E)', () => {
    const panel = ruleBody('.ui-task-panel');
    assert.match(
      panel,
      /background:\s*color-mix\(\s*in srgb,\s*var\(--text\)\s+4%,\s*var\(--surface\)\s*\)/,
      'светлее в тёмной / темнее в светлой теме без правки файлов тем',
    );
    assert.match(panel, /height:\s*var\(--task-panel-height, auto\)/, 'высота панели из настроек');
    assert.match(panel, /max-height:\s*var\(--task-panel-height, 40vh\)/, 'умолчание высоты');
  });

  it('просроченные строки и даты — красным токеном темы (пункт D)', () => {
    assert.match(
      ruleBody(
        '.ui-task-row.is-overdue .ui-task-row-text,\n.ui-task-row.is-overdue .ui-task-row-date',
      ),
      /color:\s*var\(--danger\)/,
      'просрочка красная в обеих темах (токен, не литерал)',
    );
  });

  it('подчинённый блок: каретка у верхнего края, блок — просмотр комментария (пачка 7)', () => {
    assert.match(
      ruleBody('.ui-task-row.has-children'),
      /flex-wrap:\s*wrap/,
      'блок уходит под строку, адрес `data-row-key` остаётся у строки',
    );
    assert.match(ruleBody('.ui-task-row-children'), /padding-left:\s*var\(--tree-indent\)/);
    assert.match(
      ruleBody('.ui-task-row-caret'),
      /align-self:\s*flex-start/,
      'каретка выравнивается по ВЕРХНЕМУ краю многострочной строки (пункт 4 ТЗ)',
    );
    // Плоских строк панели больше нет: блок рисует просмотр комментария.
    assert.equal(
      ruleBodies('.ui-task-child-row').length,
      0,
      'правила плоских `.ui-task-child-row` удалены — блок рендерит единый рендерер',
    );
  });
});

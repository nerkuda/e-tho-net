/**
 * Раскладка опорных полей редактора напоминания (ошибка 3ff85ede).
 *
 * Симптом: в диалоге напоминания дата и время опоры наезжали друг на друга, а
 * подписи перекрывались — поля сжимались до нескольких пикселей.
 *
 * Корень: поля стоят строками `fieldRow` из `lib/ui/field.ts`, а сам `.ui-field`
 * объявлен контейнерным запросом (`container-type: inline-size`). В строковом
 * flex контейнерный элемент не имеет собственной ширины (её определяет запрос,
 * который считается от ширины контейнера-родителя), поэтому оба поля получали
 * ширину 0 и «схлопывались».
 *
 * Правило раскладки — только токены дизайн-системы; сторож держит именно
 * направление колонки (мутация «снова строка» краснеет), а не пиксели.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { RENDERER_ROOT } from './renderer-css.js';

/** CSS модулей без комментариев: правила адресуются по селектору. */
const EDITOR_CSS = stripComments(
  fs.readFileSync(path.join(RENDERER_ROOT, 'styles', 'editor.css'), 'utf8'),
);
const FIELD_CSS = stripComments(
  fs.readFileSync(path.join(RENDERER_ROOT, 'lib', 'ui', 'field.css'), 'utf8'),
);

/** Убрать CSS-комментарии: селектор в комментарии не должен считаться правилом. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Тело правила по точному селектору (последнее вхождение в файле). */
function ruleBody(css: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[},])\\s*${esc}\\s*\\{([^}]*)\\}`, 'g');
  let body: string | null = null;
  for (const match of css.matchAll(re)) {
    if (match[1] !== undefined) body = match[1];
  }
  assert.ok(body !== null, `правило «${selector}» есть в CSS`);
  return body;
}

describe('редактор напоминания: опорные дата и время в колонку (ошибка 3ff85ede)', () => {
  it('поля опоры не стоят строкой: колонка вместо строкового flex', () => {
    const body = ruleBody(EDITOR_CSS, '.reminder-anchor-row');
    assert.match(body, /display:\s*flex/, 'раскладка — flex-контейнер');
    assert.match(
      body,
      /flex-direction:\s*column/,
      'поля идут в колонку: в строке контейнерные .ui-field сжимаются до нуля',
    );
    assert.doesNotMatch(
      body,
      /flex-wrap:\s*wrap/,
      'строковый перенос вернул бы сжатие полей (корень ошибки)',
    );
  });

  it('корень подтверждён: .ui-field — контейнерный запрос', () => {
    assert.match(
      ruleBody(FIELD_CSS, '.ui-field'),
      /container-type:\s*inline-size/,
      'ширина .ui-field считается контейнерным запросом, а не содержимым',
    );
  });

  it('вертикальный зазор даёт колонка, а не отступ поля', () => {
    assert.match(
      ruleBody(EDITOR_CSS, '.reminder-anchor-row'),
      /gap:\s*var\(--space-/,
      'зазор — токен шкалы отступов',
    );
    assert.match(
      ruleBody(EDITOR_CSS, '.reminder-anchor-row .ui-field'),
      /margin-bottom:\s*0/,
      'собственный отступ поля снят, иначе зазор удвоился бы',
    );
  });
});

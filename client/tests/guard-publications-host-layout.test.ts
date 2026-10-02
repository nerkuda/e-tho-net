/**
 * Сторож раскладки хоста экрана «Публикации» (0.11.1, ошибка fea20bd1).
 *
 * Хост вида — флекс-элемент в `.workspace-body` наравне с `.canvas`,
 * `.structures`, `.chronicle`, `.activity`, поэтому обязан РАСТИ (`flex: 1`) и
 * быть flex-контейнером для внутреннего `.publications` (`flex: 1`). Без этого
 * между хостом и панелью редактора остаётся пустота: панель встаёт не у правого
 * края, а её абсолютный сплиттер (привязан к правому краю `.workspace-body`)
 * отрывается от панели.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readRendererCss } from './renderer-css.js';

const CSS = readRendererCss();

/** Тело первого правила с селектором `selector`. */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `в собранном CSS нет правила ${selector}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

describe('layout: хост экрана «Публикации» (fea20bd1, f24fbef0)', () => {
  it('.publications-host растягивается, как прочие виды', () => {
    const body = ruleBody(CSS, '.publications-host');
    assert.match(
      body,
      /flex:\s*1\s*;/,
      'хост обязан расти (flex: 1) — иначе панель редактора встаёт не у правого края',
    );
    assert.match(
      body,
      /display:\s*flex\s*;/,
      'хост обязан быть flex-контейнером, чтобы внутренний .publications заполнял его',
    );
  });

  it('фон полотна следует активному слою (--layer-bg)', () => {
    const body = ruleBody(CSS, '.publications');
    assert.match(
      body,
      /background:\s*var\(--layer-bg,\s*var\(--bg\)\)\s*;/,
      'полотно «Публикаций» обязано следовать фону слоя: без правила смена слоя не видна (ошибка f24fbef0)',
    );
  });
});

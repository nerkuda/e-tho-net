/**
 * Высота диалога сохранённых отборов (ошибка d8eac984, версия 0.13.1).
 *
 * Симптом: диалог кнопки «…» в строке сохранённых отборов показывал ≈4 строки
 * списка — роль `s` даёт `--dialog-h: 320px`. Решение — оговорка «Высота вне
 * ролей» требования 13464c39: диалог-список вправе взять именованную высоту
 * классом-модификатором на боксе + токеном `--dialog-h-<имя>`:
 * `min(max(450px, 50vh), calc(100vh - 60px))` — 50 % высоты клиентского окна,
 * но не меньше 450px, с прежним пределом по экрану. Высота остаётся
 * ФИКСИРОВАННОЙ (тело прокручивается), роль `s` не трогается: её делят
 * модальные пикеры сущностей (`lib/entity-picker.ts`).
 *
 * Тест — регресс на два независимых дефекта:
 *  1. отсутствие именованной высоты у диалога (роль `s` = 320px);
 *  2. литерал `.sfd-list { max-height: 320px }` — потолок области списка,
 *     который снова схлопнет список в 4 строки (регресс f68bb43c).
 *
 * Геометрию подтверждает GUI-стенд (`ui-probe.filter-footer.scenario.json`);
 * здесь — структура и токены, которые иначе не поймать.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { readRendererCss } from './renderer-css.js';

const RENDERER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'renderer',
);

function read(rel: string): string {
  return readFileSync(path.join(RENDERER_ROOT, ...rel.split('/')), 'utf8');
}

describe('высота диалога сохранённых отборов (d8eac984)', () => {
  it('диалог берёт именованную высоту модификатором dialog-saved-filter', () => {
    // Селектор с `[data-dialog-size]` перебивает правило роли по специфичности
    // независимо от порядка в бандле (грабли 36889dd6), как у `dialog-stats`.
    assert.match(
      readRendererCss(),
      /\.dialog-box\[data-dialog-size\]\.dialog-saved-filter\s*\{[^}]*--dialog-h:\s*var\(--dialog-h-saved-filter\)/s,
      'диалог сохранённых отборов не берёт высоту модификатором dialog-saved-filter',
    );
    assert.match(
      read('styles/tokens.css'),
      /--dialog-h-saved-filter:\s*min\(max\(450px,\s*50vh\),\s*calc\(100vh - 60px\)\)\s*;/,
      'высота обязана быть токеном --dialog-h-saved-filter = min(max(450px, 50vh), calc(100vh - 60px)), а не литералом',
    );
  });

  it('модификатор вешается на бокс диалога, роль s не тронута', () => {
    assert.match(
      read('lib/saved-filter-bar.ts'),
      /box\.classList\.add\('dialog-saved-filter'\)/,
      'диалог не помечает бокс модификатором — высота не применится',
    );
    // Роль `s` делят модальные пикеры сущностей (lib/entity-picker.ts): её
    // высота обязана остаться 320px.
    assert.match(
      readRendererCss(),
      /\.dialog-box\[data-dialog-size='s'\]\s*\{[^}]*--dialog-h:\s*320px/s,
      'высота роли s изменена: роль делят модальные пикеры сущностей',
    );
  });

  it('литерал .sfd-list не ограничивает список (регресс f68bb43c)', () => {
    const css = readRendererCss();
    // Своё правило бокса `.sfd-list` больше не задаёт потолок высоты: его
    // задаёт роль/модификатор диалога.
    const own = /^\.sfd-list\s*\{([^}]*)\}/m.exec(css);
    assert.ok(own !== null, 'правило .sfd-list обязано существовать (раскладка списка)');
    assert.ok(
      !/max-height/.test(own[1] ?? ''),
      'литерал .sfd-list { max-height: 320px } схлопнет область списка в 4 строки (регресс f68bb43c)',
    );
    // Область списка в диалоге тянется на свободную высоту и не имеет потолка.
    assert.match(
      css,
      /\.list-dialog-body\s+\.sfd-list[^{]*\{[^}]*max-height:\s*none/s,
      'область списка диалога обязана тянуться на свободную высоту (правило 9 требования 11ddd910)',
    );
  });
});

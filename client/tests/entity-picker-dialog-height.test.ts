/**
 * Высота модальных пикеров сущностей (ошибка ffa55338, версия 0.13.1).
 *
 * Симптом: оба режима пикера (`lib/entity-picker.ts:840/1014` — режим типов и
 * единый список сущностей) открываются ролью `s` + `fixedHeight`; роль `s` даёт
 * `--dialog-h: 320px`, поэтому область дерева выбора получает ≈150px (≈7 строк
 * из 21 на стенде) — тот же класс дефекта, что у диалога «Сохранённые отборы»
 * (`d8eac984`). Решение — та же оговорка «Высота вне ролей» требования
 * 13464c39: диалог-список вправе взять именованную высоту классом-модификатором
 * на боксе + токеном `--dialog-h-<имя>`:
 * `min(max(450px, 50vh), calc(100vh - 60px))` — 50 % высоты клиентского окна,
 * но не меньше 450px, с прежним пределом по экрану. Высота остаётся
 * ФИКСИРОВАННОЙ (тело прокручивается), роль `s` не трогается: её делят прочие
 * диалоги-списки.
 *
 * Геометрию подтверждает GUI-стенд (`ui-probe.entity-picker-height.scenario.json`);
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

describe('высота модальных пикеров сущностей (ffa55338)', () => {
  it('пикер берёт именованную высоту модификатором dialog-entity-picker', () => {
    // Селектор с `[data-dialog-size]` перебивает правило роли по специфичности
    // независимо от порядка в бандле (грабли 36889dd6), как у `dialog-stats`.
    assert.match(
      readRendererCss(),
      /\.dialog-box\[data-dialog-size\]\.dialog-entity-picker\s*\{[^}]*--dialog-h:\s*var\(--dialog-h-entity-picker\)/s,
      'пикер сущностей не берёт высоту модификатором dialog-entity-picker',
    );
    assert.match(
      read('styles/tokens.css'),
      /--dialog-h-entity-picker:\s*min\(max\(450px,\s*50vh\),\s*calc\(100vh - 60px\)\)\s*;/,
      'высота обязана быть токеном --dialog-h-entity-picker = min(max(450px, 50vh), calc(100vh - 60px)), а не литералом',
    );
  });

  it('модификатор вешается на бокс в ОБОИХ режимах пикера, роль s не тронута', () => {
    const src = read('lib/entity-picker.ts');
    const hits = src.match(/box\.classList\.add\('dialog-entity-picker'\)/g) ?? [];
    assert.equal(
      hits.length,
      2,
      `модификатор обязан вешаться на бокс в обоих showDialog пикера (режим типов и единый список сущностей), найдено ${hits.length}`,
    );
    // Оба `onMount` берут бокс вторым аргументом — иначе модификатор некуда вешать.
    const onMount = src.match(/onMount:\s*\(_close,\s*box\)/g) ?? [];
    assert.equal(
      onMount.length,
      2,
      `оба showDialog пикера обязаны получать бокс в onMount (_close, box), найдено ${onMount.length}`,
    );
    // Роль `s` делят прочие диалоги-списки: её высота обязана остаться 320px.
    assert.match(
      readRendererCss(),
      /\.dialog-box\[data-dialog-size='s'\]\s*\{[^}]*--dialog-h:\s*320px/s,
      'высота роли s изменена: роль делят прочие диалоги-списки',
    );
  });

  it('область списка пикера в диалоге тянется на свободную высоту', () => {
    // Список дерева выбора занимает свободное место тела диалога (правило 9
    // требования 11ddd910) — фикс повышает и сам бокс, и область списка.
    assert.match(
      read('styles/condition-combo.css'),
      /\.list-dialog-body\s+\.st-f-picker-list\s*\{[^}]*flex:\s*1 1 auto/s,
      'область списка пикера обязана тянуться на свободную высоту (правило 9 требования 11ddd910)',
    );
  });
});

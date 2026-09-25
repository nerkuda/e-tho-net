/**
 * Сторож глобального положения панели редактора (ошибка 477fd133).
 *
 * Правило: положение панели редактора (слева/справа/сверху/снизу) — одна
 * глобальная настройка пользователя, и она обязана двигать контент ОДИНАКОВО
 * на всех экранах (карта, структуры, хроника, события). В CSS дока редактор и
 * контент упорядочиваются через `order`; чтобы новый экран не выпал из этого
 * порядка, вся семья хостов контента помечена единым маркером `view-host`, а
 * правила порядка в `styles/layout.css` адресуют именно маркер, а не
 * перечисление конкретных хостов.
 *
 * Почему это ломалось: `.structures`/`.chronicle`/`.activity` не перечислялись
 * в правилах `order` (там был только `.canvas`), получали `order: 0` и при
 * доке «слева» вставали ЛЕВЕЕ редактора (`order: 1`) — панель оставалась
 * справа, а её сплиттер уезжал на левую границу `--editor-w`.
 *
 * Правила сторожа:
 *  1. `screens/workspace.ts` помечает маркером все хосты контента тела;
 *  2. `styles/layout.css` задаёт порядок контента для дока слева/сверху/снизу
 *     через `.view-host`;
 *  3. порядок контента НЕ адресуется перечислением конкретных хостов
 *     (`.canvas`/`.structures`/`.chronicle`/`.activity`) — иначе новый экран
 *     снова выпадет молча.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const RENDERER_ROOT = path.resolve(import.meta.dirname, '..', 'src', 'renderer');
const WORKSPACE = path.join(RENDERER_ROOT, 'screens', 'workspace.ts');
const LAYOUT_CSS = path.join(RENDERER_ROOT, 'styles', 'layout.css');

/** Хосты контента тела: класс-перечисление, из которого выпали структуры. */
const VIEW_HOST_CLASSES = ['canvas', 'structures', 'chronicle', 'activity'];

describe('guard: глобальное положение панели редактора (477fd133)', () => {
  const workspace = fs.readFileSync(WORKSPACE, 'utf8');
  const layout = fs.readFileSync(LAYOUT_CSS, 'utf8');

  it('каждый хост контента тела несёт маркер view-host', () => {
    for (const cls of VIEW_HOST_CLASSES) {
      assert.match(
        workspace,
        new RegExp(`div\\(['"][^'"]*\\b${cls}\\b[^'"]*\\bview-host\\b`),
        `хост .${cls} обязан нести маркер view-host — без него правило порядка ` +
          'дока редактора перестаёт на него действовать (ошибка 477fd133)',
      );
    }
  });

  it('порядок контента для дока слева/сверху/снизу задан через .view-host', () => {
    for (const pos of ['left', 'top', 'bottom'] as const) {
      assert.match(
        layout,
        new RegExp(`\\[data-editor-pos='${pos}'\\][^{]*>\\s*\\.view-host`),
        `правило order для дока '${pos}' обязано адресовать .view-host`,
      );
    }
  });

  it('порядок контента не перечисляет конкретные хосты', () => {
    for (const cls of VIEW_HOST_CLASSES) {
      const re = new RegExp(`\\[data-editor-pos='(left|right|top|bottom)'\\][^{]*>\\s*\\.${cls}\\b`);
      assert.doesNotMatch(
        layout,
        re,
        `.${cls} не должен упоминаться в правилах дока через data-editor-pos — ` +
          'порядок контента держит единый маркер .view-host',
      );
    }
  });
});

/**
 * Тесты выбора фона главного окна до первого кадра
 * (`client/src/main/window-background.ts`; задача 0e4a52cd, замечание проверки).
 *
 * Покрывается: точный кэш `ui_window_bg`, игнор битого кэша, fallback на
 * исторический `client_meta.theme` (это РЕЖИМ) при первом запуске после
 * обновления и нейтральный светлый фон при пустых метаданных — вместо
 * `undefined` (белая вспышка у тёмного пользователя).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CLIENT_META_KEY } from '@etn/shared';

import {
  CURRENT_DARK_BG,
  CURRENT_LIGHT_BG,
  resolveWindowBackground,
} from '../src/main/window-background.js';

/** Заглушка `client_meta`: отсутствующий ключ — `null`, как у `LocalDb.getMeta`. */
function meta(values: Record<string, string>): (key: string) => string | null {
  return (key) => values[key] ?? null;
}

describe('resolveWindowBackground (0e4a52cd)', () => {
  it('берёт точный --bg применённой темы из кэша', () => {
    assert.equal(
      resolveWindowBackground(meta({ [CLIENT_META_KEY.UI_WINDOW_BG]: '#0c0c0c' })),
      '#0c0c0c',
      'фон — цвет темы retronotes (тёмный режим)',
    );
  });

  it('битый кэш игнорируется: значение не формата #rrggbb не применяется', () => {
    for (const broken of ['rgb(0, 0, 0)', '#0c0', 'red', '']) {
      assert.equal(
        resolveWindowBackground(meta({ [CLIENT_META_KEY.UI_WINDOW_BG]: broken })),
        CURRENT_LIGHT_BG,
        `«${broken}» — не цвет фона`,
      );
    }
  });

  it('первый запуск после обновления: исторический режим dark → тёмный фон', () => {
    assert.equal(
      resolveWindowBackground(meta({ [CLIENT_META_KEY.THEME]: 'dark' })),
      CURRENT_DARK_BG,
      'у тёмного пользователя нет белой вспышки',
    );
  });

  it('исторический режим light → светлый фон', () => {
    assert.equal(
      resolveWindowBackground(meta({ [CLIENT_META_KEY.THEME]: 'light' })),
      CURRENT_LIGHT_BG,
    );
  });

  it('совсем пустая установка — нейтральный светлый фон, не undefined', () => {
    assert.equal(resolveWindowBackground(meta({})), CURRENT_LIGHT_BG);
  });

  it('кэш приоритетнее исторического режима', () => {
    assert.equal(
      resolveWindowBackground(
        meta({ [CLIENT_META_KEY.UI_WINDOW_BG]: '#faf6f0', [CLIENT_META_KEY.THEME]: 'dark' }),
      ),
      '#faf6f0',
      'выбор темы из профиля важнее старого режима',
    );
  });
});

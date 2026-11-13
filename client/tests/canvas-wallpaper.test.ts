/**
 * Подложка холста карты: применение состояния картинки к корню документа
 * (0.16.1, задача 80324150; элемент ef8112b0, требование e6d586d3, сценарий
 * 3fe62610).
 *
 * CSS-правило `.canvas` при `[data-canvas-wallpaper='on']` не содержит
 * radial-gradient — сетка при картинке исчезает (это проверяется живым стендом,
 * здесь — переменные и атрибут, которыми правило включается).
 *
 * jsdom в проекте нет: корень подменяется минимальной заглушкой с картой
 * CSS-переменных и атрибутов.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  WALLPAPER_ATTR,
  WALLPAPER_IMAGE_VAR,
  WALLPAPER_TINT_VAR,
  applyWallpaperState,
  readWallpaperBase,
  type WallpaperRootTarget,
} from '../src/renderer/canvas/wallpaper.js';

/** Состояние «картинка есть»: светлота 0.95 (очень светлая картинка). */
const OK_STATE = {
  status: 'ok' as const,
  network_id: 'n-1',
  data_url: 'data:image/jpeg;base64,AQID',
  mime_type: 'image/jpeg',
  file_size: 3,
  content_hash: 'h',
  meta: { width: 2, height: 2, avg_luminance: 0.95 },
  source: 'server' as const,
};

/** Заглушка корня: переменные и атрибуты в памяти. */
function fakeRoot(): WallpaperRootTarget & {
  vars: Map<string, string>;
  attrs: Map<string, string>;
} {
  const vars = new Map<string, string>();
  const attrs = new Map<string, string>();
  return {
    vars,
    attrs,
    style: {
      setProperty: (name, value) => vars.set(name, value),
      removeProperty: (name) => {
        vars.delete(name);
      },
    },
    setAttribute: (name, value) => attrs.set(name, value),
    removeAttribute: (name) => {
      attrs.delete(name);
    },
  };
}

describe('applyWallpaperState: картинка включает подложку', () => {
  it('ставит url картинки, тинт цвета темы и атрибут сетки', () => {
    const root = fakeRoot();
    applyWallpaperState(root, OK_STATE, { color: '#0e1116', in_layer: false });
    assert.equal(root.vars.get(WALLPAPER_IMAGE_VAR), 'url("data:image/jpeg;base64,AQID")');
    // Светлая картинка (0.95) на тёмном фоне: расхождение максимальное → плотный тинт.
    assert.equal(root.vars.get(WALLPAPER_TINT_VAR), 'rgba(14, 17, 22, 0.8)');
    assert.equal(root.attrs.get(WALLPAPER_ATTR), 'on');
  });

  it('в слое тинт — цвет слоя с повышенной прозрачностью', () => {
    const root = fakeRoot();
    applyWallpaperState(root, OK_STATE, { color: '#191327', in_layer: true });
    assert.equal(root.vars.get(WALLPAPER_TINT_VAR), 'rgba(25, 19, 39, 0.68)');
  });

  it('картинка той же светлоты, что фон, — минимальная вуаль', () => {
    const root = fakeRoot();
    applyWallpaperState(
      root,
      { ...OK_STATE, meta: { ...OK_STATE.meta, avg_luminance: 0.95 } },
      { color: '#f2f2f2', in_layer: false },
    );
    const tint = root.vars.get(WALLPAPER_TINT_VAR) ?? '';
    const alpha = Number(/,\s([\d.]+)\)$/.exec(tint)?.[1] ?? 'NaN');
    assert.ok(Number.isFinite(alpha));
    assert.ok(alpha >= 0.45 && alpha <= 0.55, `лёгкая вуаль, получено ${alpha}`);
  });

  it('нечитаемый токен цвета — картинка без вуали, сетка всё равно скрыта', () => {
    const root = fakeRoot();
    applyWallpaperState(root, OK_STATE, { color: null, in_layer: false });
    assert.equal(root.vars.has(WALLPAPER_TINT_VAR), false);
    assert.equal(root.attrs.get(WALLPAPER_ATTR), 'on');
  });
});

describe('applyWallpaperState: картинки нет', () => {
  it('снимает переменные и атрибут — холст возвращается к цвету и сетке', () => {
    const root = fakeRoot();
    applyWallpaperState(root, OK_STATE, { color: '#0e1116', in_layer: false });
    applyWallpaperState(root, { status: 'none' }, { color: '#0e1116', in_layer: false });
    assert.equal(root.vars.has(WALLPAPER_IMAGE_VAR), false);
    assert.equal(root.vars.has(WALLPAPER_TINT_VAR), false);
    assert.equal(root.attrs.has(WALLPAPER_ATTR), false, 'базовое правило с сеткой активно');
  });
});

describe('readWallpaperBase: основа — тема, слой — слоя', () => {
  it('без --layer-bg берётся --bg темы', () => {
    const values: Record<string, string> = { '--bg': '#0e1116' };
    const base = readWallpaperBase((name) => values[name] ?? '');
    assert.deepEqual(base, { color: '#0e1116', in_layer: false });
  });

  it('--layer-bg слоя важнее темы (тинт — цвет фона слоя)', () => {
    const values: Record<string, string> = { '--bg': '#0e1116', '--layer-bg': '#191327' };
    const base = readWallpaperBase((name) => values[name] ?? '');
    assert.deepEqual(base, { color: '#191327', in_layer: true });
  });

  it('токены не прочитаны — color null (тинт не ставится, картинка показывается)', () => {
    const base = readWallpaperBase(() => '');
    assert.deepEqual(base, { color: null, in_layer: false });
  });
});

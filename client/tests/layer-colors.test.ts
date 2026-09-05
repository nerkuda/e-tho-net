/**
 * Unit tests for the layer colour indication (0.6.4, 13-layers.md §2.2a).
 *
 *   * `invertLightness` — the theme-inversion rule: HSL lightness flips
 *    (L → 1−L), hue/saturation survive, double inversion is the identity;
 *   * `invertThemeColor` — the stored pair built from the picked values of
 *     the current theme;
 *   * `defaultLayerColors` — creation defaults: violet stripe/background for
 *     the dark theme, lightness inversions for the light one, both hex;
 *   * `resolveLayerTheme` + `applyLayerThemeStyle` — picking the theme
 *     variant and writing/clearing the `--layer-*` CSS variables;
 *   * `initLayerTheme`/`refreshLayerTheme` — the live pipeline on a faked
 *     `document`: variables follow the store (layer switch, theme toggle,
 *     back to base) and are removed when the layer has no colours;
 *   * `layerLabelView`/`layerLabelFontSize`/`stripeLabelColor` — the map
 *     label: never on the base layer, horizontal text with the font fixed at
 *     30% of the zone height (never shrunk for the name — long names are
 *     clipped by the CSS `overflow: hidden`), black/white contrast;
 *   * the styles.css rules the runtime relies on: the 78% focus-cloud width
 *     cap, the non-interactive clipped label stripe and its horizontal text.
 *
 * Pure functions + a faked document — no Electron, no real DOM.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { BASE_LAYER_ID, type Layer, type LayerColors } from '@etn/shared';

import {
  DEFAULT_FOCUS_BAND_COLOR,
  LABEL_FONT_SHARE,
  LABEL_MIN_FONT_PX,
  LABEL_OPACITY,
  applyLayerThemeStyle,
  currentLayerColors,
  defaultLayerColors,
  initLayerTheme,
  invertLightness,
  invertThemeColor,
  layerLabelFontSize,
  layerLabelView,
  resolveLayerTheme,
  stripeLabelColor,
  type LayerStyleTarget,
} from '../src/renderer/lib/layer-colors.js';
import { store } from '../src/renderer/state.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Parses `#rrggbb` into an RGB triple 0..255. */
function rgb(hex: string): [number, number, number] {
  const v = hex.replace('#', '');
  return [
    Number.parseInt(v.slice(0, 2), 16),
    Number.parseInt(v.slice(2, 4), 16),
    Number.parseInt(v.slice(4, 6), 16),
  ];
}

/** RGB → HSL (h degrees, s/l 0..1) for assertions. */
function hsl(hex: string): [number, number, number] {
  const [r0, g0, b0] = rgb(hex).map((c) => c / 255) as [number, number, number];
  const max = Math.max(r0, g0, b0);
  const min = Math.min(r0, g0, b0);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r0) h = 60 * (((g0 - b0) / d) % 6);
  else if (max === g0) h = 60 * ((b0 - r0) / d + 2);
  else h = 60 * ((r0 - g0) / d + 4);
  return [h < 0 ? h + 360 : h, s, l];
}

function layerColors(focus: string, bg: string): LayerColors {
  return {
    focus_stripe: { dark: focus, light: invertLightness(focus) },
    background: { dark: bg, light: invertLightness(bg) },
  };
}

function layer(overrides: Partial<Layer> & { id: string; title: string }): Layer {
  return {
    parent_id: null,
    comment: null,
    git_branch: null,
    colors: null,
    is_service: false,
    is_base: false,
    depth: 1,
    created_by: 'u',
    created_at: '2026-08-30T00:00:00Z',
    last_activity_at: '2026-08-30T00:00:00Z',
    version: 1,
    children_count: 0,
    current: false,
    ...overrides,
  };
}

/** Recording style-declaration shim for the CSS-variable application. */
function shimStyle(): LayerStyleTarget & { vars: Map<string, string> } {
  const vars = new Map<string, string>();
  return {
    vars,
    setProperty(name: string, value: string): void {
      vars.set(name, value);
    },
    removeProperty(name: string): void {
      vars.delete(name);
    },
  };
}

describe('invertLightness (0.6.4 §2.2a)', () => {
  it('flips HSL lightness, preserving hue and saturation', () => {
    const source = '#7e57c2';
    const inverted = invertLightness(source);
    const [h1, s1, l1] = hsl(source);
    const [h2, s2, l2] = hsl(inverted);
    assert.ok(Math.abs(h1 - h2) < 0.5, `hue drift: ${h1} -> ${h2}`);
    assert.ok(Math.abs(s1 - s2) < 0.01, `saturation drift: ${s1} -> ${s2}`);
    assert.ok(Math.abs(l1 + l2 - 1) < 0.01, `lightness not flipped: ${l1} + ${l2}`);
    assert.match(inverted, /^#[0-9a-f]{6}$/);
  });

  it('double inversion returns the original colour (±1 per channel)', () => {
    for (const hex of ['#7e57c2', '#191327', '#1e62be', '#eef0f4', '#5b8cff']) {
      const back = invertLightness(invertLightness(hex));
      const [r1, g1, b1] = rgb(hex);
      const [r2, g2, b2] = rgb(back);
      assert.ok(
        Math.abs(r1 - r2) <= 1 && Math.abs(g1 - g2) <= 1 && Math.abs(b1 - b2) <= 1,
        `${hex} -> ${back} is not an identity round-trip`,
      );
    }
  });

  it('handles the achromatic edges', () => {
    assert.equal(invertLightness('#000000'), '#ffffff');
    assert.equal(invertLightness('#ffffff'), '#000000');
    const gray = invertLightness('#808080');
    const [h, s] = hsl(gray);
    assert.equal(h, 0);
    assert.ok(s < 0.001);
  });
});

describe('invertThemeColor + defaultLayerColors', () => {
  it('keeps the picked side, computes the opposite by inversion', () => {
    const dark = invertThemeColor({ dark: '#7e57c2', light: '#irrelevant' }, 'dark');
    assert.equal(dark.dark, '#7e57c2');
    assert.equal(dark.light, invertLightness('#7e57c2'));

    const light = invertThemeColor({ dark: '#irrelevant', light: '#4db6ac' }, 'light');
    assert.equal(light.light, '#4db6ac');
    assert.equal(light.dark, invertLightness('#4db6ac'));
  });

  it('creation defaults: violet dark pair, inverted light pair, valid hex', () => {
    const colors = defaultLayerColors();
    assert.equal(colors.focus_stripe.dark, '#7e57c2');
    assert.equal(colors.background.dark, '#191327');
    assert.equal(colors.focus_stripe.light, invertLightness('#7e57c2'));
    assert.equal(colors.background.light, invertLightness('#191327'));
    for (const hex of [
      colors.focus_stripe.dark,
      colors.focus_stripe.light,
      colors.background.dark,
      colors.background.light,
    ]) {
      assert.match(hex, /^#[0-9a-f]{6}$/);
    }
    // Distinct from the theme defaults the base uses (the whole point).
    assert.notEqual(colors.focus_stripe.dark, '#1e62be');
    assert.notEqual(colors.background.dark, '#0e1116');
  });
});

describe('resolveLayerTheme + currentLayerColors + applyLayerThemeStyle', () => {
  it('null colors (base layer / layer without colours) resolve to theme defaults', () => {
    assert.deepEqual(resolveLayerTheme(null, 'dark'), { focusStripe: null, background: null });
    assert.deepEqual(currentLayerColors([], null), null);

    const base = layer({ id: BASE_LAYER_ID, title: 'Основа', is_base: true, current: true });
    assert.equal(currentLayerColors([base], { id: BASE_LAYER_ID, title: 'Основа' }), null);

    const plain = layer({ id: 'l1', title: 'Слой' });
    assert.equal(currentLayerColors([plain], { id: 'l1', title: 'Слой' }), null);
  });

  it('picks the current theme variant of the active layer', () => {
    const colors = layerColors('#7e57c2', '#191327');
    const l1 = layer({ id: 'l1', title: 'Слой', colors });
    assert.deepEqual(currentLayerColors([l1], { id: 'l1', title: 'Слой' }), colors);

    assert.deepEqual(resolveLayerTheme(colors, 'dark'), {
      focusStripe: '#7e57c2',
      background: '#191327',
    });
    assert.deepEqual(resolveLayerTheme(colors, 'light'), {
      focusStripe: colors.focus_stripe.light,
      background: colors.background.light,
    });
  });

  it('writes and clears the --layer-* CSS variables', () => {
    const style = shimStyle();
    applyLayerThemeStyle(style, { focusStripe: '#7e57c2', background: '#191327' });
    assert.equal(style.vars.get('--layer-focus-stripe'), '#7e57c2');
    assert.equal(style.vars.get('--layer-bg'), '#191327');

    applyLayerThemeStyle(style, { focusStripe: null, background: null });
    assert.equal(style.vars.has('--layer-focus-stripe'), false);
    assert.equal(style.vars.has('--layer-bg'), false);
  });
});

describe('layer theme pipeline (store → document root)', () => {
  it('applies, re-themes and resets the variables as the store changes', () => {
    const style = shimStyle();
    const originalDocument = (globalThis as any).document;
    (globalThis as any).document = { documentElement: { style } };
    try {
      initLayerTheme();

      // Base layer: no variables.
      store.update({
        layers: [layer({ id: BASE_LAYER_ID, title: 'Основа', is_base: true, depth: 0 })],
        currentLayer: { id: BASE_LAYER_ID, title: 'Основа' },
        theme: 'dark',
      });
      assert.equal(style.vars.has('--layer-focus-stripe'), false);
      assert.equal(style.vars.has('--layer-bg'), false);

      // Switch to a layer with colours: both variables appear (dark theme).
      const colors = layerColors('#7e57c2', '#191327');
      store.update({
        layers: [
          layer({ id: BASE_LAYER_ID, title: 'Основа', is_base: true, depth: 0 }),
          layer({ id: 'l1', title: 'Правки августа', colors }),
        ],
        currentLayer: { id: 'l1', title: 'Правки августа' },
      });
      assert.equal(style.vars.get('--layer-focus-stripe'), '#7e57c2');
      assert.equal(style.vars.get('--layer-bg'), '#191327');

      // Theme toggle while the layer stays active: the light variant applies.
      store.update({ theme: 'light' });
      assert.equal(style.vars.get('--layer-focus-stripe'), colors.focus_stripe.light);
      assert.equal(style.vars.get('--layer-bg'), colors.background.light);

      // Back to the base: variables are removed (theme defaults again).
      store.update({ currentLayer: { id: BASE_LAYER_ID, title: 'Основа' } });
      assert.equal(style.vars.has('--layer-focus-stripe'), false);
      assert.equal(style.vars.has('--layer-bg'), false);
    } finally {
      if (originalDocument === undefined) delete (globalThis as any).document;
      else (globalThis as any).document = originalDocument;
      // Leave the store on the base for the other suites.
      store.update({
        layers: [],
        currentLayer: null,
        theme: 'light',
      });
    }
  });
});

describe('map label (0.6.4 §2.2a)', () => {
  it('never appears on the base layer; appears for a layer with/without colours', () => {
    const base = layerLabelView(
      { id: BASE_LAYER_ID, title: 'Основа' },
      null,
      'dark',
      300,
      1000,
    );
    assert.equal(base.visible, false);

    const colored = layerLabelView(
      { id: 'l1', title: 'Правки августа' },
      layerColors('#7e57c2', '#191327'),
      'dark',
      300,
      1000,
    );
    assert.equal(colored.visible, true);
    assert.equal(colored.title, 'Правки августа');
    assert.equal(colored.stripe, '#7e57c2');
    // The violet stripe is dark — white text.
    assert.equal(colored.color, '#ffffff');
    // The font is fixed by the zone geometry — 30% of 300 — no matter how
    // long the name is (long names clip, they never shrink the font).
    assert.equal(colored.fontPx, Math.floor(300 * 0.3));

    // A layer without explicit colours still shows, contrasted against the
    // theme-default focus band.
    const plain = layerLabelView({ id: 'l1', title: 'Слой' }, null, 'dark', 300, 1000);
    assert.equal(plain.visible, true);
    assert.equal(plain.stripe, DEFAULT_FOCUS_BAND_COLOR);

    // Degenerate geometry: no focus row → no label.
    const flat = layerLabelView({ id: 'l1', title: 'Слой' }, null, 'dark', 0, 1000);
    assert.equal(flat.visible, false);
  });

  it('font size: 30% of the zone height, fixed by the zone geometry', () => {
    // 30% of 300 = 90 — the name length plays no role (long names clip via
    // the CSS `overflow: hidden`, they never shrink the font).
    assert.equal(layerLabelFontSize(300), 90);
    assert.equal(layerLabelFontSize(300), Math.floor(300 * LABEL_FONT_SHARE));
    // A tiny zone clamps to the readability floor.
    assert.equal(layerLabelFontSize(20), LABEL_MIN_FONT_PX);
  });

  it('LABEL_OPACITY stays a sane tuning value', () => {
    assert.ok(LABEL_OPACITY > 0 && LABEL_OPACITY <= 1, `opacity out of range: ${LABEL_OPACITY}`);
  });

  it('stripeLabelColor is black on light stripes, white on dark ones', () => {
    assert.equal(stripeLabelColor('#eef0f4'), '#000000');
    assert.equal(stripeLabelColor('#ffffff'), '#000000');
    assert.equal(stripeLabelColor('#7e57c2'), '#ffffff');
    assert.equal(stripeLabelColor('#191327'), '#ffffff');
  });
});

describe('styles.css rules the runtime relies on', () => {
  const css = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'styles.css'),
    'utf8',
  );

  it('caps the focused thought at 78% of the canvas width', () => {
    const block = css.match(/\.cloud\.focus-cloud\s*\{[^}]*\}/)?.[0] ?? '';
    assert.match(block, /max-width:\s*min\(78%,\s*calc\(100% - 28px\)\)/);
  });

  it('the layer label is a non-interactive clipped stripe capped at 10% width', () => {
    const block = css.match(/\.layer-label\s*\{[^}]*\}/)?.[0] ?? '';
    assert.match(block, /max-width:\s*10%/);
    assert.match(block, /overflow:\s*hidden/);
    assert.match(block, /pointer-events:\s*none/);
  });

  it('the label text is horizontal (no writing-mode, no rotation), kept on one line', () => {
    const block = css.match(/\.layer-label-text\s*\{[^}]*\}/)?.[0] ?? '';
    assert.match(block, /white-space:\s*nowrap/);
    assert.doesNotMatch(block, /writing-mode/);
    assert.doesNotMatch(block, /transform/);
  });

  it('the canvas, structures results and chronicle follow --layer-bg', () => {
    assert.match(css.match(/^\.canvas \{[^}]*\}/m)?.[0] ?? '', /var\(--layer-bg,\s*var\(--bg\)\)/);
    assert.match(
      css.match(/^\.st-results \{[^}]*\}/m)?.[0] ?? '',
      /var\(--layer-bg,\s*var\(--bg\)\)/,
    );
    assert.match(css.match(/^\.chronicle \{[^}]*\}/m)?.[0] ?? '', /var\(--layer-bg,\s*var\(--bg\)\)/);
  });

  it('the focus band and the editor halo follow --layer-focus-stripe', () => {
    assert.match(
      css.match(/\.canvas::before\s*\{[^}]*\}/)?.[0] ?? '',
      /var\(--layer-focus-stripe,\s*var\(--focus-band-color\)\)/,
    );
    assert.match(
      css.match(/\.cloud\.halo\s*\{[^}]*\}/)?.[0] ?? '',
      /var\(--layer-focus-stripe,\s*var\(--accent\)\)/,
    );
  });
});

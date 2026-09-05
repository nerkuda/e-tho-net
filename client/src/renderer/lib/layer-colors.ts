/**
 * Layer colour indication (0.6.4, docs/13-layers.md §2.2a «Цветовая
 * индикация слоёв»).
 *
 * A non-base layer is visually almost indistinguishable from the base, so the
 * user does not understand why others do not see the layer's edits. The fix
 * colours two things while a layer is active:
 *
 *   * `focus_stripe` — the focus band across the middle zone of the thought
 *     map (`.canvas::before`) and the halo border of the thought opened in
 *     the editor (`.cloud.halo`);
 *   * `background` — the canvas background of every view (map, structures,
 *     chronicle).
 *
 * Both live in the layer's `colors` object with a dark/light pair per key.
 * The client resolves the current theme's variant and writes it into the
 * `--layer-focus-stripe` / `--layer-bg` CSS custom properties on the document
 * root; the theme blocks in styles.css fall back to their defaults when the
 * variables are absent (the base layer never sets them).
 *
 * Editing: the «Свойства слоя» dialog picks the two colours for the CURRENT
 * theme only — the opposite theme's pair is computed by flipping the HSL
 * lightness (L → 1−L, hue/saturation preserved), so one choice themes both
 * modes. The same inversion derives the light defaults from the dark ones.
 */

import { BASE_LAYER_ID, type Layer, type LayerColors, type LayerEcho } from '@etn/shared';

import { store, type Theme } from '../state.js';

/** Theme default of the focus band (styles.css `--focus-band-color`, L12) —
 *  the label contrast fallback for a layer without explicit colours. */
export const DEFAULT_FOCUS_BAND_COLOR = '#1e62be';

/** Creation defaults of the dark theme (0.6.4): a violet stripe clearly
 *  distinct from the blue base band (#1e62be) and a violet-tinted canvas
 *  background next to the neutral #0e1116 — a fresh layer is immediately
 *  visible. The light variants are the HSL-lightness inversions. */
const DEFAULT_STRIPE_DARK = '#7e57c2';
const DEFAULT_BACKGROUND_DARK = '#191327';

/**
 * Effective colours of the active layer for CSS, `null` = theme defaults.
 * Written onto the document root by {@link applyLayerThemeStyle}.
 */
export interface LayerThemeVars {
  focusStripe: string | null;
  background: string | null;
}

/** Minimal style-declaration surface (CSSStyleDeclaration in the renderer). */
export interface LayerStyleTarget {
  setProperty(name: string, value: string): void;
  removeProperty(name: string): void;
}

// ---------------------------------------------------------------------------
// Colour math
// ---------------------------------------------------------------------------

/** `#rrggbb` → normalized [0..1] RGB triple. */
function hexToRgb(hex: string): [number, number, number] {
  const v = hex.replace('#', '');
  return [
    Number.parseInt(v.slice(0, 2), 16) / 255,
    Number.parseInt(v.slice(2, 4), 16) / 255,
    Number.parseInt(v.slice(4, 6), 16) / 255,
  ];
}

/** Normalized [0..1] RGB triple → `#rrggbb`. */
function rgbToHex(r: number, g: number, b: number): string {
  const ch = (x: number): string =>
    Math.round(Math.min(1, Math.max(0, x)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${ch(r)}${ch(g)}${ch(b)}`;
}

/** HSL → `#rrggbb` (h in degrees, s/l in [0..1]). */
function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let rgb: [number, number, number];
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const m = l - c / 2;
  return rgbToHex(rgb[0] + m, rgb[1] + m, rgb[2] + m);
}

/**
 * Inverts the lightness of a `#rrggbb` colour in HSL space (L → 1−L), keeping
 * hue and saturation — the theme-inversion rule of the layer colours. Used
 * both for the stored opposite-theme pair (dialog save, creation defaults)
 * and for tests as the definition of «инверсия темы».
 */
export function invertLightness(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) {
    // Achromatic: only lightness flips.
    return hslToHex(0, 0, 1 - l);
  }
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = 60 * (((g - b) / d) % 6);
  else if (max === g) h = 60 * ((b - r) / d + 2);
  else h = 60 * ((r - g) / d + 4);
  if (h < 0) h += 360;
  return hslToHex(h, s, 1 - l);
}

/**
 * Builds the stored colour pair from the values picked for the CURRENT theme:
 * the picked side stays as-is, the opposite theme is computed by flipping the
 * HSL lightness (0.6.4, §2.2a) — one choice themes both modes.
 */
export function invertThemeColor(
  pair: LayerColors['focus_stripe'],
  theme: Theme,
): LayerColors['focus_stripe'] {
  if (theme === 'dark') {
    return { dark: pair.dark, light: invertLightness(pair.dark) };
  }
  return { dark: invertLightness(pair.light), light: pair.light };
}

/**
 * Creation defaults (0.6.4): the client passes them in `POST /layers`, so a
 * new layer is visually distinct from the base right away. The dark values
 * are canonical; the light ones are their lightness inversions.
 */
export function defaultLayerColors(): LayerColors {
  return {
    focus_stripe: {
      dark: DEFAULT_STRIPE_DARK,
      light: invertLightness(DEFAULT_STRIPE_DARK),
    },
    background: {
      dark: DEFAULT_BACKGROUND_DARK,
      light: invertLightness(DEFAULT_BACKGROUND_DARK),
    },
  };
}

// ---------------------------------------------------------------------------
// Resolving the active layer's theme
// ---------------------------------------------------------------------------

/** Colours of the session's current layer: `null` on/for the base layer and
 *  for a layer that carries no explicit colours (theme defaults, §2.2a). */
export function currentLayerColors(layers: Layer[], current: LayerEcho | null): LayerColors | null {
  if (current === null || current.id === BASE_LAYER_ID) return null;
  return layers.find((l) => l.id === current.id)?.colors ?? null;
}

/** The current theme's variant of a layer's colours; `null` → theme defaults. */
export function resolveLayerTheme(colors: LayerColors | null, theme: Theme): LayerThemeVars {
  if (colors === null) return { focusStripe: null, background: null };
  return {
    focusStripe: colors.focus_stripe[theme],
    background: colors.background[theme],
  };
}

/**
 * Writes (or clears) the layer CSS variables on a style target:
 * `--layer-focus-stripe` / `--layer-bg`. Absent variables fall back to the
 * theme tokens in styles.css (`.canvas`, `.canvas::before`, `.cloud.halo`,
 * `.st-results`, `.chronicle`), so the base layer keeps the current look.
 */
export function applyLayerThemeStyle(style: LayerStyleTarget, vars: LayerThemeVars): void {
  if (vars.focusStripe === null) style.removeProperty('--layer-focus-stripe');
  else style.setProperty('--layer-focus-stripe', vars.focusStripe);
  if (vars.background === null) style.removeProperty('--layer-bg');
  else style.setProperty('--layer-bg', vars.background);
}

/** Signature of the last applied variables — skips no-op style writes. */
let lastAppliedKey = '';
let themeWired = false;

/** Reads the store and applies the current layer's theme variables to the
 *  document root. Cheap enough to call on every store change (layer switch,
 *  theme toggle, network close) thanks to the change-detection key. */
export function refreshLayerTheme(): void {
  if (typeof document === 'undefined') return;
  const s = store.state;
  const colors = currentLayerColors(s.layers, s.currentLayer);
  const vars = resolveLayerTheme(colors, s.theme);
  const key = `${s.theme}|${vars.focusStripe ?? ''}|${vars.background ?? ''}`;
  if (key === lastAppliedKey) return;
  lastAppliedKey = key;
  applyLayerThemeStyle(document.documentElement.style, vars);
}

/**
 * Wires the live layer-theme application: one store subscription, applied
 * once on boot (after `initTheme` — the theme attribute is on the root
 * already, this only adds the layer overrides on top).
 */
export function initLayerTheme(): void {
  if (themeWired) return;
  themeWired = true;
  store.subscribe(refreshLayerTheme);
  refreshLayerTheme();
}

// ---------------------------------------------------------------------------
// Layer-name label on the map (§2.2a: the horizontal stripe at the left edge
// of the focus zone)
// ---------------------------------------------------------------------------

/** Font size of the label: up to 30% of the focus-zone height. */
export const LABEL_FONT_SHARE = 0.3;
/** Label opacity, 0..1 — a single tuning knob; the value is picked by eye,
 *  keep it in sync with 13-layers.md §2.2a. */
export const LABEL_OPACITY = 0.6;
/** Below this size the text is unreadable — clamp and let `overflow` clip. */
export const LABEL_MIN_FONT_PX = 8;

/**
 * Font size of the layer label: 30% of the focus-zone height, fixed by the
 * zone geometry — never shrunk to fit the name: a name longer than the label
 * stripe (max 10% of the canvas width, CSS `max-width` + `overflow: hidden`)
 * is simply clipped.
 */
export function layerLabelFontSize(zoneHeight: number): number {
  return Math.max(LABEL_MIN_FONT_PX, Math.floor(zoneHeight * LABEL_FONT_SHARE));
}

/**
 * Pure view model of the map label: shown only for a non-base layer; the text
 * colour is auto-contrast (black/white by relative luminance) to the
 * effective focus-stripe colour (the layer's own or the theme default).
 */
export interface LayerLabelView {
  visible: boolean;
  title: string;
  /** Effective stripe colour behind the label (also its contrast source). */
  stripe: string;
  /** Black or white — whichever reads on {@link LayerLabelView.stripe}. */
  color: string;
  fontPx: number;
}

/** sRGB-linearised relative luminance of a `#rrggbb` colour (WCAG). */
function relativeLuminance(hex: string): number {
  const channel = (part: string): number => {
    const c = Number.parseInt(part, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const v = hex.replace('#', '');
  return (
    0.2126 * channel(v.slice(0, 2)) +
    0.7152 * channel(v.slice(2, 4)) +
    0.0722 * channel(v.slice(4, 6))
  );
}

/** Black on light stripes, white on dark ones (relative luminance). */
export function stripeLabelColor(stripe: string): string {
  return relativeLuminance(stripe) > 0.35 ? '#000000' : '#ffffff';
}

/** Computes the label view model from the store-shaped inputs (pure). */
export function layerLabelView(
  current: LayerEcho | null,
  colors: LayerColors | null,
  theme: Theme,
  zoneHeight: number,
  canvasWidth: number,
): LayerLabelView {
  const visible =
    current !== null && current.id !== BASE_LAYER_ID && zoneHeight > 0 && canvasWidth > 0;
  const stripe = colors?.focus_stripe[theme] ?? DEFAULT_FOCUS_BAND_COLOR;
  return {
    visible,
    title: current?.title ?? '',
    stripe,
    color: stripeLabelColor(stripe),
    fontPx: visible ? layerLabelFontSize(zoneHeight) : 0,
  };
}

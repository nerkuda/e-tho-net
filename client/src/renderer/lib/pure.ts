/**
 * Pure (DOM-free) renderer helpers — unit-testable in Node without a browser.
 *
 * Everything here is deterministic string/number logic used by the UI:
 * title/synonym parsing for the add dialog (08-ui-spec.md §4), cloud geometry
 * (11-settings-and-state.md §2.4), ui_state parsing and realtime-event
 * narrowing/description.
 */

import {
  CANVAS_CHILDREN_SHARE_DEFAULT,
  CANVAS_SHARE_MAX,
  CANVAS_SHARE_MIN,
  CANVAS_TOP_SPLIT_DEFAULT,
  CANVAS_ZOOM_DEFAULT,
  CANVAS_ZOOM_MAX,
  CANVAS_ZOOM_MIN,
  CANVAS_ZOOM_STEP,
  CLOUD_GAP_DEFAULT,
  CLOUD_GAP_MAX,
  CLOUD_GAP_MIN,
  CLOUD_WIDTH_DEFAULT,
  CLOUD_WIDTH_MAX,
  CLOUD_WIDTH_MIN,
  EDITOR_H_DEFAULT,
  EDITOR_H_MAX,
  EDITOR_H_MIN,
  EDITOR_W_DEFAULT,
  EDITOR_W_MAX,
  EDITOR_W_MIN,
  REALTIME_EVENT_TYPES,
  type AnyRealtimeEvent,
  type RealtimeEventType,
} from '@etn/shared';

// ---------------------------------------------------------------------------
// Cloud geometry (11-settings-and-state.md §2.4)
// ---------------------------------------------------------------------------

/** Number of title lines in a simple (non-focus) cloud. */
export const CLOUD_TITLE_LINES = 2;

/** Reference font sizes the cloud font scales between (px). */
const CLOUD_FONT_MIN = 12;
const CLOUD_FONT_MAX = 16;

/** Vertical padding of the cloud body, px (both sides). */
export const CLOUD_PAD = 6;
/** Height of a single ellipse thickening, px. */
export const ELLIPSE_HEIGHT = 8;
/** Cloud border width, px. */
export const CLOUD_BORDER = 1;
/** Title line-height factor relative to the font size. */
const TITLE_LINE_FACTOR = 1.5;
/** Indicators line-height factor relative to the font size. */
const IND_LINE_FACTOR = 1.2;

/** Clamps a number into `[min, max]`. */
export function clip(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Font size of a simple cloud, linearly interpolated between the reference
 * sizes across `CLOUD_WIDTH_MIN..CLOUD_WIDTH_MAX` (11-settings-and-state.md
 * §2.4: fixed scaling rule; the exact formula is left to the implementation)
 * and multiplied by the canvas zoom (L9).
 */
export function cloudFontSize(width: number, zoom = 1): number {
  const t = clip((width - CLOUD_WIDTH_MIN) / (CLOUD_WIDTH_MAX - CLOUD_WIDTH_MIN), 0, 1);
  return Math.round((CLOUD_FONT_MIN + t * (CLOUD_FONT_MAX - CLOUD_FONT_MIN)) * zoom * 10) / 10;
}

/**
 * Fixed height of a simple cloud in px: 2 title lines + indicators line +
 * paddings + two ellipses + borders. Not user-editable (11-settings-and-state.md
 * §2.4). The font, paddings and ellipses scale with the canvas zoom; the 1 px
 * borders stay constant (they are constant in CSS too).
 */
export function cloudHeight(width: number, zoom = 1): number {
  const font = cloudFontSize(width, zoom);
  const title = font * TITLE_LINE_FACTOR * CLOUD_TITLE_LINES;
  const ind = font * IND_LINE_FACTOR;
  const pad = CLOUD_PAD * zoom;
  const ellipse = ELLIPSE_HEIGHT * zoom;
  return Math.round(title + ind + pad * 2 + ellipse * 2 + CLOUD_BORDER * 2);
}

/** Effective cloud sizes applied by the renderer (zoom-multiplied, px-rounded). */
export interface CloudGeom {
  /** Effective cloud width, px. */
  width: number;
  /** Effective gap between clouds, px. */
  gap: number;
  /** Effective title font size, px. */
  font: number;
  /** Effective fixed cloud height, px. */
  height: number;
}

/**
 * Effective cloud geometry for the zone grids and CSS variables: L4
 * `cloud_width`/`cloud_gap` multiplied by the canvas zoom (L9). The same
 * numbers feed the CSS (`--cloud-*`) and the virtualized grid math, so the
 * grid rows never diverge from the rendered DOM heights.
 */
export function cloudGeom(width: number, gap: number, zoom = 1): CloudGeom {
  return {
    width: Math.round(width * zoom),
    gap: Math.round(gap * zoom),
    font: cloudFontSize(width, zoom),
    height: cloudHeight(width, zoom),
  };
}

/** Parses an L4 `cloud_width` value, clipped to the system constants. */
export function parseCloudWidth(raw: string | null): number {
  const num = raw === null ? Number.NaN : Number(raw);
  if (!Number.isFinite(num)) return CLOUD_WIDTH_DEFAULT;
  return clip(Math.round(num), CLOUD_WIDTH_MIN, CLOUD_WIDTH_MAX);
}

/** Parses an L4 `cloud_gap` value, clipped to the system constants. */
export function parseCloudGap(raw: string | null): number {
  const num = raw === null ? Number.NaN : Number(raw);
  if (!Number.isFinite(num)) return CLOUD_GAP_DEFAULT;
  return clip(Math.round(num), CLOUD_GAP_MIN, CLOUD_GAP_MAX);
}

/** Result of parsing the L4 `window_layout` value: editor panel sizes. */
export interface ParsedEditorSize {
  /** Editor width when docked left/right, px. */
  w: number;
  /** Editor height when docked top/bottom, px. */
  h: number;
}

/**
 * Parses the L4 `window_layout` value (JSON `{"w":<px>,"h":<px>}`), clipped to
 * the editor size constants. Missing/invalid fields fall back to the defaults,
 * so a partially-stored value or an older single-number format still loads.
 */
export function parseWindowLayout(raw: string | null): ParsedEditorSize {
  const fallback: ParsedEditorSize = { w: EDITOR_W_DEFAULT, h: EDITOR_H_DEFAULT };
  if (raw === null || raw === '') return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      const wNum = Number(obj['w']);
      const hNum = Number(obj['h']);
      return {
        w: Number.isFinite(wNum) ? clip(Math.round(wNum), EDITOR_W_MIN, EDITOR_W_MAX) : fallback.w,
        h: Number.isFinite(hNum) ? clip(Math.round(hNum), EDITOR_H_MIN, EDITOR_H_MAX) : fallback.h,
      };
    }
    // Legacy single-number form: treat as width.
    const single = Number(parsed);
    if (Number.isFinite(single)) {
      return { w: clip(Math.round(single), EDITOR_W_MIN, EDITOR_W_MAX), h: fallback.h };
    }
  } catch {
    /* fall through to fallback */
  }
  return fallback;
}

/** Result of parsing the L4 `canvas_layout` value: zone splitter shares. */
export interface ParsedCanvasLayout {
  /** Share of the top strip width given to the parents zone, 0..1. */
  topSplit: number;
  /** Share of the canvas height given to the children zone, 0..1. */
  childrenShare: number;
}

/** Clips a zone share into the stored range, rounding to 3 decimals. */
function clipShare(value: number): number {
  return Math.round(clip(value, CANVAS_SHARE_MIN, CANVAS_SHARE_MAX) * 1000) / 1000;
}

/**
 * Parses the L4 `canvas_layout` value (JSON
 * `{"topSplit":<0..1>,"childrenShare":<0..1>}`), clipped to the share range.
 * Missing/invalid fields fall back to the defaults, so a partially stored
 * value still loads (08-ui-spec.md §2.1).
 */
export function parseCanvasLayout(raw: string | null): ParsedCanvasLayout {
  const fallback: ParsedCanvasLayout = {
    topSplit: CANVAS_TOP_SPLIT_DEFAULT,
    childrenShare: CANVAS_CHILDREN_SHARE_DEFAULT,
  };
  if (raw === null || raw === '') return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return fallback;
    const obj = parsed as Record<string, unknown>;
    const top = Number(obj['topSplit']);
    const children = Number(obj['childrenShare']);
    return {
      topSplit: Number.isFinite(top) ? clipShare(top) : fallback.topSplit,
      childrenShare: Number.isFinite(children) ? clipShare(children) : fallback.childrenShare,
    };
  } catch {
    return fallback;
  }
}

/** Rounds a zoom value to 2 decimals (the step grid is 0.05). */
function roundZoom(value: number): number {
  return Math.round(value * 100) / 100;
}

/** UI themes (L10, `client_meta.theme`). */
export type ThemeName = 'light' | 'dark';

/** Parses an L5 `theme` value; anything but `'dark'` falls back to light. */
export function parseTheme(raw: string | null): ThemeName {
  return raw === 'dark' ? 'dark' : 'light';
}

/** Parses an L4 `canvas_zoom` value, clipped to the zoom constants. */
export function parseCanvasZoom(raw: string | null): number {
  const num = raw === null ? Number.NaN : Number(raw);
  if (!Number.isFinite(num)) return CANVAS_ZOOM_DEFAULT;
  return roundZoom(clip(num, CANVAS_ZOOM_MIN, CANVAS_ZOOM_MAX));
}

/**
 * One keyboard step of the canvas zoom (L9): moves along the grid of
 * `CANVAS_ZOOM_STEP` increments (100 → 105 → 110 …, not multiplicative),
 * clipped to the zoom range. `direction` is +1 (zoom in) or −1 (zoom out).
 */
export function zoomStep(zoom: number, direction: 1 | -1): number {
  const base = clip(zoom, CANVAS_ZOOM_MIN, CANVAS_ZOOM_MAX);
  const steps = Math.round((base + direction * CANVAS_ZOOM_STEP) / CANVAS_ZOOM_STEP);
  return roundZoom(clip(steps * CANVAS_ZOOM_STEP, CANVAS_ZOOM_MIN, CANVAS_ZOOM_MAX));
}

// ---------------------------------------------------------------------------
// Title / synonym parsing (08-ui-spec.md §4.3, §4.4)
// ---------------------------------------------------------------------------

/** Parsed "title | syn1, syn2" input of the add dialog. */
export interface ParsedTitle {
  /** Title before the first `|`. */
  title: string;
  /** Synonyms after the `|`, split by comma. */
  synonyms: string[];
}

/**
 * Parses the add-dialog input: text after the first `|` is treated as a
 * comma-separated synonym list (08-ui-spec.md §4.3).
 */
export function parseTitleWithSynonyms(raw: string): ParsedTitle {
  const pipe = raw.indexOf('|');
  const title = (pipe >= 0 ? raw.slice(0, pipe) : raw).trim();
  const synRaw = pipe >= 0 ? raw.slice(pipe + 1) : '';
  const synonyms = synRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  return { title, synonyms };
}

/** One parsed line of a pasted multi-line buffer (08-ui-spec.md §4.3). */
export interface AddLine extends ParsedTitle {
  /** Original trimmed line, kept for display. */
  raw: string;
}

/**
 * Parses a multi-line clipboard buffer into add-dialog lines; every line is
 * parsed for `|` synonyms, empty lines are dropped (08-ui-spec.md §4.3).
 */
export function parseAddLines(text: string): AddLine[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => ({ raw: line, ...parseTitleWithSynonyms(line) }));
}

// ---------------------------------------------------------------------------
// ui_state parsing (L4)
// ---------------------------------------------------------------------------

/** Parses `editor_collapsed_groups` ui_state JSON, tolerating garbage. */
export function parseCollapsedGroups(raw: string | null): Record<string, Record<string, boolean>> {
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, Record<string, boolean>> = {};
    for (const [entityId, groups] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof groups !== 'object' || groups === null || Array.isArray(groups)) continue;
      const flags: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(groups as Record<string, unknown>)) {
        if (typeof value === 'boolean') flags[key] = value;
      }
      out[entityId] = flags;
    }
    return out;
  } catch {
    return {};
  }
}

/** Parses `last_used_link_type_id` ui_state value (uuid or null). */
export function parseLinkTypeId(raw: string | null): string | null {
  if (raw === null || raw.trim() === '') return null;
  return raw;
}

// ---------------------------------------------------------------------------
// Realtime events
// ---------------------------------------------------------------------------

/**
 * Structural guard for realtime events coming over IPC: the renderer receives
 * `unknown` and must verify the shape before use (no `any`, no blind casts).
 */
export function isRealtimeEvent(value: unknown): value is AnyRealtimeEvent {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  const type = obj['type'];
  const seq = obj['seq'];
  const networkId = obj['network_id'];
  return (
    typeof type === 'string' &&
    (REALTIME_EVENT_TYPES as readonly string[]).includes(type) &&
    typeof seq === 'number' &&
    typeof networkId === 'string'
  );
}

/** Russian one-word descriptions of realtime event types (status bar). */
const EVENT_ACTIONS: Record<RealtimeEventType, string> = {
  'thought.created': 'создана мысль',
  'thought.updated': 'изменена мысль',
  'thought.deleted': 'удалена мысль',
  'thought.reordered': 'изменён порядок мыслей',
  'link.created': 'создана связь',
  'link.updated': 'изменена связь',
  'link.deleted': 'удалена связь',
  'thought-type.created': 'создан тип мыслей',
  'thought-type.updated': 'изменён тип мыслей',
  'thought-type.deleted': 'удалён тип мыслей',
  'link-type.created': 'создан тип связей',
  'link-type.updated': 'изменён тип связей',
  'link-type.deleted': 'удалён тип связей',
  'property-definition.created': 'добавлено свойство типа',
  'property-definition.updated': 'изменено свойство типа',
  'property-definition.deleted': 'удалено свойство типа',
  'comment.created': 'добавлен комментарий',
  'comment.updated': 'изменён комментарий',
  'comment.deleted': 'удалён комментарий',
  'attachment.created': 'добавлено вложение',
  'attachment.updated': 'изменено вложение',
  'attachment.deleted': 'удалено вложение',
  'property-value.set': 'изменено свойство',
  'property-value.deleted': 'удалено свойство',
  'network.updated': 'изменена сеть',
  'network.deleted': 'сеть удалена',
  'member.added': 'добавлен участник сети',
  'member.removed': 'участник покинул сеть',
  'member.role_changed': 'изменена роль участника',
  'presence.joined': 'участник подключился',
  'presence.left': 'участник отключился',
  'presence.focus_changed': 'участник сменил фокус',
  'user-preference.updated': 'обновлены настройки',
  'user-focus-preferences.updated': 'обновлена сортировка зон',
  'user-focus-order.updated': 'обновлён порядок зоны',
  'thought-view.updated': 'обновлён просмотр',
};

/**
 * Human-readable status-bar line for an event (08-ui-spec.md §11). Thought
 * events use the current title from the cache when available.
 */
export function describeEvent(evt: AnyRealtimeEvent, title?: string): string {
  const action = EVENT_ACTIONS[evt.type];
  if (title !== undefined && evt.type.startsWith('thought.')) {
    return `${action}: «${title}»`;
  }
  return action;
}

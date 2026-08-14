/**
 * Manual-style bitmap helpers for `thoughts.font_manual` (02-data-model.md
 * §3.1.1).
 *
 * `font_*` columns are NOT NULL 0/1; a companion bitmap `font_manual` records
 * which of them carry an explicit manual value (the rest are inherited from the
 * thought's type). The API surfaces `font_*` as `boolean | null` (`null` =
 * "inherit"); this module decodes the bitmap at the row→DTO boundary.
 */

/** Bitmap bit marking a manual `font_bold`. */
export const FONT_BOLD_BIT = 1 << 0;
/** Bitmap bit marking a manual `font_italic`. */
export const FONT_ITALIC_BIT = 1 << 1;
/** Bitmap bit marking a manual `font_underline`. */
export const FONT_UNDERLINE_BIT = 1 << 2;
/** Bitmap bit marking a manual `font_strike`. */
export const FONT_STRIKE_BIT = 1 << 3;

/**
 * Decode one font flag: `null` when the bit is off (inherit from type), or the
 * raw 0/1 as a boolean when the bit is on (manual value).
 */
export function readFont(fm: number, bit: number, raw: number): boolean | null {
  return (fm & bit) !== 0 ? raw === 1 : null;
}

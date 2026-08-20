/**
 * Settings dialogs for thought/link visual style (08-ui-spec.md §6.9; type
 * editors reuse them, L6).
 *
 * - Thought: text/background colours + four font-style toggles.
 * - Link: line colour, dash style, width.
 *
 * Both exist in a "type" mode (opts.mode = 'type'): the title says so and the
 * «Сброс» button resets to the plain defaults instead of nulling the entity's
 * manual overrides (a type's font flags are NOT NULL; a link type has no
 * per-link override semantics).
 *
 * Both expose a «Сброс» button that nulls every manual override so the entity is
 * shown with its type's defaults again (02-data-model.md §3.1.1, §3.6). Each
 * control commits its change immediately through the caller-provided `onApply`.
 */

import { LINK_STYLES, type LinkStyle } from '@etn/shared';

import { showDialog } from '../lib/dialog.js';
import { button, div, el, setTooltip } from '../lib/dom.js';

/** Resolved thought style (own value, else the type's default). */
export interface ResolvedThoughtStyle {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
}

/**
 * Style patch shared by the thought header (`ThoughtUpdateInput`) and the
 * thought-type editor (`ThoughtTypeUpdateInput`) — the common field subset.
 */
export interface ThoughtStylePatch {
  icon?: string | null;
  fg_color?: string | null;
  bg_color?: string | null;
  font_bold?: boolean | null;
  font_italic?: boolean | null;
  font_underline?: boolean | null;
  font_strike?: boolean | null;
}

/** Line-style patch shared by the link header and the link-type editor. */
export interface LinkStylePatch {
  color?: string | null;
  style?: LinkStyle | null;
  width?: number | null;
}

/** Wraps a control with a small caption. */
function colorField(caption: string, input: HTMLElement): HTMLElement {
  const wrap = div('style-color-field');
  wrap.append(el('span', 'style-color-caption', caption), input);
  return wrap;
}

/** Opens the thought settings dialog (colours + font style + reset). */
export function showThoughtStyleDialog(opts: {
  resolved: ResolvedThoughtStyle;
  onApply: (patch: ThoughtStylePatch) => Promise<boolean>;
  /** `'type'` — editing a thought type: title + plain-default reset (L6). */
  mode?: 'thought' | 'type';
}): void {
  const { resolved, onApply, mode = 'thought' } = opts;
  const body = div('form-stack');

  const fgInput = el('input', 'color-input');
  fgInput.type = 'color';
  fgInput.value = resolved.fg ?? '#20242d';
  fgInput.addEventListener('change', () => void onApply({ fg_color: fgInput.value }));

  const bgInput = el('input', 'color-input');
  bgInput.type = 'color';
  bgInput.value = resolved.bg ?? '#ffffff';
  bgInput.addEventListener('change', () => void onApply({ bg_color: bgInput.value }));

  const colorsRow = div('style-colors');
  colorsRow.append(colorField('Текст', fgInput), colorField('Фон', bgInput));
  body.append(colorsRow);

  const toggles = div('font-toggles');
  const fontToggle = (
    glyph: string,
    title: string,
    on: boolean,
    apply: (value: boolean) => Promise<boolean>,
  ): void => {
    const btn = button(
      glyph,
      () => {
        const next = !btn.classList.contains('on');
        // Press optimistically; revert when the save fails so the button
        // never shows a state that was not stored.
        btn.classList.toggle('on', next);
        void apply(next).then((ok) => {
          if (!ok) btn.classList.toggle('on', !next);
        });
      },
      `font-toggle${on ? ' on' : ''}`,
    );
    setTooltip(btn, title);
    toggles.append(btn);
  };
  fontToggle('Ж', 'Жирный', resolved.bold, (v) => onApply({ font_bold: v }));
  fontToggle('Н', 'Курсив', resolved.italic, (v) => onApply({ font_italic: v }));
  fontToggle('П', 'Подчёркнутый', resolved.underline, (v) => onApply({ font_underline: v }));
  fontToggle('З', 'Зачёркнутый', resolved.strike, (v) => onApply({ font_strike: v }));
  body.append(toggles);

  showDialog({
    title: mode === 'type' ? 'Настройки типа мысли' : 'Настройки мысли',
    body,
    buttons: [
      {
        label: 'Сброс',
        danger: true,
        keepOpen: true,
        onClick: (close) => {
          // Both modes reset to «inherit» since L21: a thought inherits its
          // type chain, a type inherits its parent (the root falls back to
          // the application defaults).
          void onApply({
            icon: null,
            fg_color: null,
            bg_color: null,
            font_bold: null,
            font_italic: null,
            font_underline: null,
            font_strike: null,
          }).then((ok) => {
            if (ok) close();
          });
        },
      },
      { label: 'Закрыть', primary: true },
    ],
  });
}

/** Opens the link settings dialog (line colour/style/width + reset). */
export function showLinkStyleDialog(opts: {
  resolved: { color: string | null; style: LinkStyle; width: number };
  onApply: (patch: LinkStylePatch) => Promise<void>;
  /** `'type'` — editing a link type: title + plain-default reset (L6). */
  mode?: 'link' | 'type';
}): void {
  const { resolved, onApply, mode = 'link' } = opts;
  const body = div('form-stack');

  const colorInput = el('input', 'color-input');
  colorInput.type = 'color';
  colorInput.value = resolved.color ?? '#5a6478';
  colorInput.addEventListener('change', () => void onApply({ color: colorInput.value }));
  body.append(colorField('Цвет линии', colorInput));

  const styleSelect = el('select', 'select-input');
  for (const s of LINK_STYLES) {
    const option = el('option', undefined, s === 'solid' ? 'сплошная' : s === 'dashed' ? 'штрихи' : 'точки');
    option.value = s;
    styleSelect.append(option);
  }
  styleSelect.value = resolved.style;
  styleSelect.addEventListener('change', () => {
    void onApply({ style: styleSelect.value as LinkStyle });
  });
  body.append(colorField('Стиль', styleSelect));

  const widthInput = el('input', 'text-input');
  widthInput.type = 'number';
  widthInput.min = '1';
  widthInput.max = '12';
  widthInput.value = String(resolved.width);
  widthInput.addEventListener('change', () => {
    const n = Number(widthInput.value);
    if (Number.isInteger(n) && n >= 1 && n <= 12) {
      void onApply({ width: n });
    } else {
      widthInput.value = String(resolved.width);
    }
  });
  body.append(colorField('Толщина', widthInput));

  showDialog({
    title: mode === 'type' ? 'Настройки типа связи' : 'Настройки связи',
    body,
    buttons: [
      {
        label: 'Сброс',
        danger: true,
        keepOpen: true,
        onClick: (close) => {
          // Since L21 both modes reset to «inherit»: a link inherits its type
          // chain, a type inherits its parent (the root falls back to the
          // application defaults solid/1).
          void onApply({ color: null, style: null, width: null }).then(() => close());
        },
      },
      { label: 'Закрыть', primary: true },
    ],
  });
}

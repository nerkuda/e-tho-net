/**
 * Inline SVG icon set for the interface chrome (L13, 08-ui-spec.md §13).
 *
 * Chrome buttons (toolbar, status bar, focus-history bar, settings gears,
 * dropdown carets, the dialog close ×) render lucide-style stroke icons from
 * this module instead of emoji/text glyphs: emoji render inconsistently
 * across platforms and ignore the theme. User CONTENT icons — thought/type
 * emoji, cloud indicators 📝/📅/📎 — intentionally stay emoji (§2.2).
 *
 * CSP-friendly: everything is inline markup from this local module; no
 * external fonts, sprites or network fetches. Colour comes from
 * `currentColor`, so icons follow the text colour of their host control and
 * switch with the theme for free.
 */

/** Icon names available for the chrome. */
export type IconName =
  | 'network'
  | 'settings'
  | 'user'
  | 'menu'
  | 'chevron-down'
  | 'arrow-left'
  | 'search'
  | 'alert'
  | 'x'
  | 'mindmap'
  | 'tree'
  | 'history'
  | 'plus';

/**
 * Trusted static inner-SVG markup per icon (lucide geometry, MIT). Assigned
 * via `innerHTML` of an element WE created — never with external input.
 */
const PATHS: Record<IconName, string> = {
  network:
    '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>' +
    '<line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/>',
  settings:
    '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08' +
    'a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74' +
    'l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1' +
    ' 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08' +
    'a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74' +
    'l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  user:
    '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  menu:
    '<line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="18" y2="18"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'arrow-left': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  alert:
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  // View switcher (L15, 08-ui-spec.md §15.1): the canvas map (central hub with
  // satellite clouds) and the structures tree (explorer-style hierarchy).
  mindmap:
    '<circle cx="12" cy="12" r="3"/><circle cx="4.5" cy="5" r="2"/><circle cx="19.5" cy="5" r="2"/>' +
    '<circle cx="4.5" cy="19" r="2"/><circle cx="19.5" cy="19" r="2"/>' +
    '<path d="M9.9 10.2 6 7.2"/><path d="m14.1 10.2 3.9-3"/><path d="M9.9 13.8 6 16.8"/>' +
    '<path d="m14.1 13.8 3.9 3"/>',
  tree:
    '<rect x="9" y="3" width="6" height="4" rx="1"/><rect x="3" y="17" width="6" height="4" rx="1"/>' +
    '<rect x="15" y="17" width="6" height="4" rx="1"/><path d="M12 7v6"/><path d="M6 13h12"/>' +
    '<path d="M6 13v4"/><path d="M18 13v4"/>',
  // View switcher (L20): the chronicle timeline (lucide «history»).
  history:
    '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>' +
    '<path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
};

/**
 * Builds one icon as an `<svg>` element sized `size`×`size` px. The element
 * carries the `icon` class; style its placement/colour via the host (colour
 * inherits through `currentColor`).
 */
export function svgIcon(name: IconName, size = 16): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = PATHS[name];
  return svg;
}

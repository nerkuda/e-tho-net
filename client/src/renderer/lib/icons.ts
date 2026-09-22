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
  | 'activity'
  | 'plus'
  | 'trash'
  // Возврат из корзины (ошибка 009784ad, 0.8.2): кнопка-иконка «Восстановить»
  // в таблице корзины — lucide «undo-2» (стрелка, уходящая назад и вверх).
  | 'undo'
  | 'layers'
  | 'loader'
  | 'filter'
  // Команды модального чек-листа пикера (ошибка bd8b78a0, 0.8.2): «Очистить»
  // (ластик), «Пометить все» (двойная галочка), «Вернуть умолчания» (сброс
  // против часовой) — иконки-кнопки верхней строки вместо текстовых надписей.
  | 'eraser'
  | 'check-check'
  | 'rotate-ccw'
  // Строка сохранённых отборов панели отбора (задача 2ebe4206, 0.8.2):
  // «записать настройки отбора» — дискета, «скопировать отбор» — копия.
  | 'save'
  | 'copy'
  // Виды значения свойства (задача 6ebde54e, 0.8.2): иконка перед именем
  // скалярного свойства в общем списке свойств (`lib/property-list.ts`).
  | 'value-text'
  | 'value-number'
  | 'value-date'
  | 'value-bool'
  | 'value-url'
  | 'value-ref'
  // Кросс-сетевая ссылка (задача 7849008a): адрес `n:<network_id>#<thought_id>`.
  | 'value-cross-network-ref';

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
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  menu: '<line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="18" y2="18"/>',
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
  // View switcher (задача f27809d0 «События»): the activity log feed — lucide
  // «activity», a heartbeat-style polyline. Distinct from the chronicle clock.
  activity:
    '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  // Mark-for-deletion badge (S13, 08-ui-spec.md §2.2): lucide «trash», drawn
  // bright red over the enlarged badge circle (colour via the host CSS).
  trash:
    '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>' +
    '<path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/>' +
    '<line x1="14" x2="14" y1="11" y2="17"/>',
  // Кнопка «Восстановить» строки корзины (ошибка 009784ad), lucide «undo-2».
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11"/>',
  // Layer menu + overridden badge (S11, 13-layers.md §10.3): lucide «layers».
  layers:
    '<polygon points="12 2 2 7 12 12 22 7 12 2"/>' +
    '<polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  // Editor preloader (0.5.6, bug 9d1d27c9): lucide «loader», used in the
  // header icon slot while a freshly-targeted thought/link is still being
  // fetched. Spinning is driven by the `editor-icon-loading` CSS class
  // (animation), the SVG itself stays static.
  loader:
    '<line x1="12" x2="12" y1="2" y2="6"/>' +
    '<line x1="12" x2="12" y1="18" y2="22"/>' +
    '<line x1="4.93" x2="7.76" y1="4.93" y2="7.76"/>' +
    '<line x1="16.24" x2="19.07" y1="16.24" y2="19.07"/>' +
    '<line x1="2" x2="6" y1="12" y2="12"/>' +
    '<line x1="18" x2="22" y1="12" y2="12"/>' +
    '<line x1="4.93" x2="7.76" y1="19.07" y2="16.24"/>' +
    '<line x1="16.24" x2="19.07" y1="7.76" y2="4.93"/>',
  // Canvas link-type filter button (задача «Фильтр типов связей на карте
  // мыслей», 0.8.1): lucide «filter» — a literal funnel, per user request.
  filter: '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
  // Команды модального чек-листа пикера (ошибка bd8b78a0, 0.8.2), lucide:
  // «eraser» — «Очистить»; «check-check» — «Пометить все»; «rotate-ccw» —
  // «Вернуть умолчания».
  eraser:
    '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/>' +
    '<path d="M22 21H7"/><path d="m5 11 9 9"/>',
  'check-check': '<path d="M18 6 7 17l-5-5"/><path d="m22 10-7.5 7.5L13 16"/>',
  'rotate-ccw':
    '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  // Строка сохранённых отборов (задача 2ebe4206), lucide: save (дискета),
  // copy (два листа).
  save:
    '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/>' +
    '<path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>',
  copy:
    '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>' +
    '<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  // Виды значения свойства (задача 6ebde54e, 0.8.2), lucide: type (строка),
  // hash (число), calendar (дата), toggle-left (да/нет), link (URL),
  // at-sign (ссылка на мысль — legacy thought_ref).
  'value-text':
    '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/>' +
    '<line x1="12" x2="12" y1="4" y2="20"/>',
  'value-number':
    '<line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/>' +
    '<line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/>',
  'value-date':
    '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/>' +
    '<path d="M3 10h18"/>',
  'value-bool':
    '<rect width="20" height="12" x="2" y="6" rx="6" ry="6"/><circle cx="8" cy="12" r="2"/>',
  'value-url':
    '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>' +
    '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  'value-ref':
    '<circle cx="12" cy="12" r="4"/>' +
    '<path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
  // Кросс-сетевая ссылка (задача 7849008a): два концентрических кольца —
  // метафора «ссылка между двумя сетями».
  'value-cross-network-ref':
    '<circle cx="12" cy="12" r="9"/>' +
    '<circle cx="12" cy="12" r="4"/>' +
    '<path d="M3 12h4M17 12h4"/>',
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

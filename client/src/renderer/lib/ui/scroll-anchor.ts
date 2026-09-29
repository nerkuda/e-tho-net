/**
 * Сохранение позиции прокрутки при пересборке списка — общий модуль
 * дизайн-системы (задача 3bfef1f7, уровень 1 тех.проекта `1d48df6d`
 * «Инкрементальное обновление списков UI»).
 *
 * Полная пересборка (`clear()`/`replaceChildren`) опустошает контейнер:
 * `scrollHeight` на мгновение становится 0, браузер клампит `scrollTop` в 0, и
 * после сборки список показывается с начала. Прецеденты точечного сохранения
 * уже есть (`property-manager.ts`, `suggest-dropdown.ts`, лента «Дневника») —
 * там запоминался один `scrollTop`. Здесь позиция привязывается к СТРОКЕ: если
 * строки выше изменили высоту (раскрытие ветви, дозагрузка), прежний `scrollTop`
 * «уезжает» по содержимому, а якорь держит у верхней кромки ту же строку.
 *
 * Механика: до сборки запоминаются `scrollTop` и ближайшая к верхней кромке
 * строка с ключом (`data-key`/`data-row-key`) вместе с её `offsetTop`; после
 * сборки — если строка с тем же ключом снова есть, `scrollTop` сдвигается на
 * изменение её `offsetTop` (строки выше могли изменить высоту); иначе
 * восстанавливается прежний `scrollTop`, урезанный по новой высоте.
 *
 * Модуль без зависимостей и без DOM-состояния: вызывающий сам решает, что и
 * когда пересобирать, и передаёт сборку колбэком. Семантика «сохранять или
 * наверх» — на стороне точки пересборки: сохранять — обернуть сборку в
 * {@link preserveScroll}, показать с начала — звать сборку напрямую.
 */

/** Ключ строки-якоря: атрибут в DOM и короткое имя в `dataset`. */
const ANCHOR_KEYS: ReadonlyArray<readonly [attr: string, datasetKey: string]> = [
  // Дерево «Структур» ставит ключ через `rowEl.dataset.key`.
  ['data-key', 'key'],
  // Таблица `lib/ui/table.ts` и лента «Дневника» — через `data-row-key`.
  ['data-row-key', 'rowKey'],
];

/** Строки-кандидаты якоря — потомки контейнера со своим ключом строки. */
function anchorRows(host: HTMLElement): HTMLElement[] {
  const rows: HTMLElement[] = [];
  for (const [attr] of ANCHOR_KEYS) {
    rows.push(...host.querySelectorAll<HTMLElement>(`[${attr}]`));
  }
  return rows;
}

/** Ключ строки-якоря или `null`, если ключ пуст/отсутствует. */
function readKey(row: HTMLElement): string | null {
  for (const [attr, datasetKey] of ANCHOR_KEYS) {
    const value = row.getAttribute(attr) ?? row.dataset[datasetKey];
    if (value !== null && value !== undefined && value !== '') return value;
  }
  return null;
}

/** Ближайшая к верхней кромке строка-якорь: её ключ и `offsetTop`. */
function topAnchor(host: HTMLElement): { key: string; offsetTop: number } | null {
  const rows = anchorRows(host);
  if (rows.length === 0) return null;
  const scroll = host.scrollTop;
  // Строки в DOM идут сверху вниз: берём последнюю, начавшуюся не ниже кромки
  // (она и «держит» верхний край); если таких нет, якорь — первая строка.
  let chosen = rows[0]!;
  let chosenTop = chosen.offsetTop;
  let hasAbove = false;
  for (const row of rows) {
    const top = row.offsetTop;
    if (top <= scroll && (!hasAbove || top > chosenTop)) {
      chosen = row;
      chosenTop = top;
      hasAbove = true;
    }
  }
  const key = readKey(chosen);
  return key === null ? null : { key, offsetTop: chosenTop };
}

/** Строка с тем же ключом после пересборки (или `null`, если её больше нет). */
function findAnchor(host: HTMLElement, key: string): HTMLElement | null {
  for (const row of anchorRows(host)) {
    if (readKey(row) === key) return row;
  }
  return null;
}

/** `scrollTop`, урезанный по текущей высоте содержимого контейнера. */
function clampScrollTop(host: HTMLElement, value: number): number {
  const max = Math.max(0, host.scrollHeight - host.clientHeight);
  return Math.max(0, Math.min(value, max));
}

/**
 * Снять позицию прокрутки, выполнить `rebuild()`, восстановить позицию.
 *
 * Якорь — ближайшая к верхней кромке строка с ключом (`data-key`/`data-row-key`).
 * Если после пересборки строка с тем же ключом есть, позиция корректируется на
 * изменение её `offsetTop`; иначе восстанавливается прежний `scrollTop`,
 * урезанный по новой высоте (`rebuild` с пустым результатом — законный случай,
 * клампинг даёт 0).
 *
 * @param host контейнер прокрутки (например, `resultsHost` «Структур»).
 * @param rebuild сборка содержимого — обычно `clear()` + наполнение.
 */
export function preserveScroll(host: HTMLElement, rebuild: () => void): void {
  const prevScrollTop = host.scrollTop;
  const anchor = topAnchor(host);
  rebuild();
  if (anchor !== null) {
    const next = findAnchor(host, anchor.key);
    if (next !== null) {
      host.scrollTop = clampScrollTop(host, prevScrollTop + (next.offsetTop - anchor.offsetTop));
      return;
    }
  }
  host.scrollTop = clampScrollTop(host, prevScrollTop);
}

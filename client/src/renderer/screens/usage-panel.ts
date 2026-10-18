/**
 * Панель использования (спека f7623077, ошибка aca92904).
 *
 * Интерактивный разбор блокировок удаления — не путать с пассивной группой
 * «Использование» вкладки «Связи» редактора. Открывается по ссылке
 * «Открыть использование…» из диалогов удаления (мысль/связь) и закрывается
 * крестиком или повторным вызовом для той же сущности (toggle).
 *
 * Источники данных:
 *  - `GET /thoughts/{id}/usage` (`etn.thoughts.usage`) — группы «кто и через
 *    какое свойство ссылается» + `holding_layers`;
 *  - `POST /thoughts/deletion-check-batch` / `POST /links/deletion-check-batch`
 *    — удерживающие слои (для связи групп свойств нет).
 *
 * Группы (id `usage_panel:properties`, `usage_panel:layers`):
 *  - «Используется в свойствах» — строка «ссылающаяся мысль + имя свойства»,
 *    контекстное меню строки = меню облачка + «Очистить свойство»
 *    (`DELETE …/properties/{key}`), кнопка «Очистить все свойства»
 *    (`POST …/usage/clear`, с подтверждением);
 *  - «Используется в слоях» — удерживающие слои, кнопка «Удалить слой»
 *    (тот же диалог каскада, что в меню слоёв). После удаления панель
 *    перечитывает данные и обновляет открытые диалоги удаления.
 *
 * Геометрия: слева, сразу правее панели выделения (при скрытой — на её
 * месте), своя ширина `--usage-w` / `window_layout.u` (см. workspace.ts и
 * screens/selection-resizer.ts).
 */

import { BASE_LAYER_ID, type HoldingLayerRef, type ThoughtUsage } from '@etn/shared';

import { etn } from '../lib/etn.js';
import { store } from '../state.js';
import { div, span } from '../lib/dom.js';
import { notice } from '../lib/notice.js';
import { confirmDialog, errorDialog } from '../lib/dialog.js';
import { MENU_SEPARATOR, menuAction, type MenuItem } from '../lib/menu.js';
import { collapsibleSection } from '../lib/ui/collapsible.js';
import { iconButton, uiButton } from '../lib/ui/button.js';
import {
  usageLayers,
  usagePropertyRows,
  type UsagePropertyRow,
} from '../lib/usage.js';
import { errorState, loadingState } from '../lib/ui/empty-state.js';
import { svgIcon } from '../lib/ui/icon.js';
import { createThoughtCloud } from '../lib/thought-cloud.js';
import { openThoughtInEditor } from '../editor/editor.js';
import { openDeleteLayerDialog } from './layers.js';
import { refreshOpenDeleteDialogs } from '../lib/delete-dialog.js';

/** Что показывает панель: мысль (свойства + слои) или связь (только слои). */
export interface UsagePanelTarget {
  kind: 'thought' | 'link';
  id: string;
  title: string;
}

/** Срез данных панели — чистые данные без DOM. */
export interface UsagePanelData {
  properties: UsagePropertyRow[];
  total: number;
  layers: HoldingLayerRef[];
}

/** Открытая панель (одна на клиент): хост и сплиттер монтирует workspace. */
let host: HTMLElement | null = null;
let resizer: HTMLElement | null = null;
let targetBox: HTMLElement | null = null;
let bodyBox: HTMLElement | null = null;
let current: UsagePanelTarget | null = null;
/** Поколение загрузки: поздний ответ прошлой цели не перерисовывает новую. */
let loadGeneration = 0;

/** Монтирует хосты панели; возвращает teardown для смены workspace. */
export function mountUsagePanel(hostEl: HTMLElement, resizerEl: HTMLElement): () => void {
  host = hostEl;
  resizer = resizerEl;
  host.replaceChildren();

  const header = div('usage-header');
  const title = span('Использование', 'usage-title');
  const close = iconButton({
    icon: svgIcon('x', 14),
    title: 'Закрыть панель использования',
    role: 'ghost',
    size: 's',
    onClick: () => closeUsagePanel(),
  });
  header.append(title, close);
  targetBox = div('usage-target');
  bodyBox = div('usage-body');
  host.append(header, targetBox, bodyBox);

  current = null;
  return () => {
    host = null;
    resizer = null;
    targetBox = null;
    bodyBox = null;
    current = null;
  };
}

/**
 * Открывает панель для сущности. Повторный вызов для той же цели закрывает
 * её (toggle по спеке). Для другой цели панель просто перерисовывается.
 */
export function openUsagePanel(target: UsagePanelTarget): void {
  if (host === null) return;
  if (current !== null && current.kind === target.kind && current.id === target.id) {
    closeUsagePanel();
    return;
  }
  current = target;
  host.classList.remove('hidden');
  resizer?.classList.remove('hidden');
  if (targetBox !== null) targetBox.textContent = target.title;
  void load(target);
}

/** Закрывает панель и очищает содержимое. */
export function closeUsagePanel(): void {
  current = null;
  loadGeneration += 1;
  if (host !== null) {
    host.classList.add('hidden');
    host.classList.remove('busy');
  }
  resizer?.classList.add('hidden');
  bodyBox?.replaceChildren();
  if (targetBox !== null) targetBox.textContent = '';
}

/** Открыта ли панель для указанной сущности (для toggle-точек входа). */
export function isUsagePanelOpenFor(kind: 'thought' | 'link', id: string): boolean {
  return current !== null && current.kind === kind && current.id === id;
}

/** Загружает данные и собирает тело панели. */
async function load(target: UsagePanelTarget): Promise<void> {
  const generation = ++loadGeneration;
  const networkId = store.state.networkId;
  if (bodyBox === null) return;
  if (networkId === null) {
    bodyBox.replaceChildren(errorState('Сеть не открыта.'));
    return;
  }
  bodyBox.replaceChildren(loadingState('Загрузка использования…'));

  let usage: ThoughtUsage | null = null;
  let layersFromCheck: HoldingLayerRef[] = [];
  try {
    if (target.kind === 'thought') {
      const [loadedUsage, checks] = await Promise.all([
        etn.thoughts.usage(networkId, target.id),
        etn.thoughts.deletionCheck(networkId, [target.id]),
      ]);
      usage = loadedUsage;
      layersFromCheck = checks[target.id]?.blocking.layers ?? [];
    } else {
      const checks = await etn.links.deletionCheck(networkId, [target.id]);
      layersFromCheck = checks[target.id]?.blocking.layers ?? [];
    }
  } catch (err) {
    if (generation === loadGeneration && bodyBox !== null) {
      bodyBox.replaceChildren(errorState(errText(err), {
        label: 'Повторить',
        onClick: () => void load(target),
      }));
    }
    return;
  }

  // Пока ждали сеть, панель закрыли или переключили на другую сущность.
  if (generation !== loadGeneration || bodyBox === null || current !== target) return;

  const data: UsagePanelData = {
    properties: usagePropertyRows(usage),
    total: usage?.total ?? 0,
    layers: usageLayers(usage?.holding_layers, layersFromCheck),
  };
  renderBody(target, data);

  // «После удаления слоя панель перечитывает deletion-check и обновляет
  // открытые диалоги удаления» (f7623077): обновляем видимую блокировку.
  bodyBox.dataset['blocked'] = data.layers.length > 0 ? 'true' : 'false';
}

/** Собирает две сворачиваемые группы панели. */
function renderBody(target: UsagePanelTarget, data: UsagePanelData): void {
  if (bodyBox === null) return;
  const parts: HTMLElement[] = [];

  if (target.kind === 'thought') {
    parts.push(buildPropertiesGroup(target, data));
  }
  parts.push(buildLayersGroup(target, data));

  bodyBox.replaceChildren(...parts);
}

/** Группа «Используется в свойствах» (только мысль). */
function buildPropertiesGroup(target: UsagePanelTarget, data: UsagePanelData): HTMLElement {
  const clearAllBtn = uiButton({
    label: 'Очистить все свойства',
    size: 's',
    onClick: () => {
      void clearAllProperties(target);
    },
  });
  clearAllBtn.disabled = data.total === 0;

  const group = collapsibleSection({
    title: 'Используется в свойствах',
    count: String(data.total),
    collapsed: false,
    actions: [clearAllBtn],
    classes: { root: 'usage-group', header: 'usage-group-header', body: 'usage-group-body' },
    buildBody: () =>
      data.properties.length === 0
        ? span('Ни одно свойство на эту мысль не ссылается.', 'usage-empty')
        : rowsBox(data.properties, target),
  });
  group.root.id = 'usage_panel:properties';
  return group.root;
}

/** Строки «ссылающаяся мысль + имя свойства» с меню «Очистить свойство». */
function rowsBox(rows: readonly UsagePropertyRow[], target: UsagePanelTarget): HTMLElement {
  const box = div('usage-group-body');
  for (const row of rows) {
    const line = div('usage-row');
    const cloud = createThoughtCloud(row.thought, {
      profile: 'chip',
      width: 'container',
      actions: {
        onClick: (id) => openThoughtInEditor(id),
        onContextMenu: (event, id) => {
          // Облачко уже гасит браузерное меню; останавливаем всплытие, чтобы
          // обработчик строки не открыл второе меню.
          event.stopPropagation();
          void openRowMenu(event, id, row, target);
        },
      },
    });
    line.append(cloud, span(row.propertyKey, 'usage-row-property'));
    line.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      void openRowMenu(event, row.thought.id, row, target);
    });
    box.append(line);
  }
  return box;
}

/** Меню строки: общее меню облачка + «Очистить свойство». */
async function openRowMenu(
  event: MouseEvent,
  id: string,
  row: UsagePropertyRow,
  target: UsagePanelTarget,
): Promise<void> {
  const { showThoughtContextMenu, resolveSiblingParentId } = await import(
    '../canvas/context-menu.js'
  );
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const extraItems: MenuItem[] = [
    MENU_SEPARATOR,
    menuAction('Очистить свойство', () => {
      void clearProperty(row, target);
    }),
  ];
  showThoughtContextMenu(
    event,
    {
      id,
      title: row.thought.title,
      dir: 'siblings',
      siblingParentId: await resolveSiblingParentId(networkId, id),
      trashed: row.thought.marked_for_deletion,
    },
    { extraItems },
  );
}

/** `DELETE …/properties/{key}` — очищает одно свойство у ссылающейся мысли. */
async function clearProperty(row: UsagePropertyRow, target: UsagePanelTarget): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  try {
    await etn.properties.remove(networkId, 'thought', row.thought.id, row.propertyKey);
    notice('Свойство очищено.');
    await reloadAfterMutation(target);
  } catch (err) {
    errorDialog('Очистить свойство', err);
  }
}

/** `POST …/usage/clear` — необратимо снимает все ссылки на мысль. */
async function clearAllProperties(target: UsagePanelTarget): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const ok = await confirmDialog(
    'Очистить все свойства',
    'Все ссылки на эту мысль через свойства будут удалены. Действие необратимо и затрагивает другие мысли.',
    true,
    'Очистить',
  );
  if (!ok) return;
  try {
    const { cleared } = await etn.thoughts.usageClear(networkId, target.id);
    notice(cleared > 0 ? `Очищено ссылок: ${cleared}.` : 'Ссылок не было.');
    await reloadAfterMutation(target);
  } catch (err) {
    errorDialog('Очистить все свойства', err);
  }
}

/** Группа «Используется в слоях» (мысль и связь). */
function buildLayersGroup(target: UsagePanelTarget, data: UsagePanelData): HTMLElement {
  const group = collapsibleSection({
    title: 'Используется в слоях',
    count: String(data.layers.length),
    collapsed: false,
    classes: { root: 'usage-group', header: 'usage-group-header', body: 'usage-group-body' },
    buildBody: () =>
      data.layers.length === 0
        ? span('Ни один слой не удерживает сущность.', 'usage-empty')
        : buildLayerRows(target, data.layers),
  });
  group.root.id = 'usage_panel:layers';
  return group.root;
}

/** Строки слоёв с кнопкой «Удалить слой» (диалог каскада — как в меню слоёв). */
function buildLayerRows(target: UsagePanelTarget, layers: readonly HoldingLayerRef[]): HTMLElement {
  const box = div('usage-group-body');
  for (const layer of layers) {
    const row = div('usage-layer-row');
    row.append(span(layer.title, 'usage-layer-title'));
    // «Основу» удалить нельзя — она не слой правок; показываем строку без кнопки.
    if (layer.id !== BASE_LAYER_ID) {
      const del = uiButton({
        label: 'Удалить слой',
        size: 's',
        role: 'danger',
        onClick: () => {
          const networkId = store.state.networkId;
          if (networkId === null) return;
          openDeleteLayerDialog(networkId, layer.id, () => {
            void reloadAfterMutation(target);
          });
        },
      });
      row.append(del);
    }
    box.append(row);
  }
  return box;
}

/** После мутации: перечитать данные и обновить открытые диалоги удаления. */
async function reloadAfterMutation(target: UsagePanelTarget): Promise<void> {
  await load(target);
  refreshOpenDeleteDialogs();
}

/** Текст ошибки для состояния «не загрузилось». */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

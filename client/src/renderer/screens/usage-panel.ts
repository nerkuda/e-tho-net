/**
 * Панель использования (спека f7623077, ошибка aca92904; выход из корзины —
 * задача d23279f6).
 *
 * Интерактивный разбор блокировок удаления — не путать с пассивной группой
 * «Использование» вкладки «Связи» редактора. Точки входа: ссылка
 * «Открыть использование…» из диалогов удаления (toggle — повторный вызов для
 * той же сущности закрывает панель) и команда «Открыть использование…» в
 * корзине (режим `forceOpen`: корзина закрывается, панель открывается всегда,
 * даже если была открыта для этой же цели).
 *
 * У помеченной на удаление цели в шапке есть действие «Вернуть из корзины»:
 * пометка читается свежим запросом при каждом открытии/перечитывании, restore —
 * обычный PATCH со свежим If-Match, без захвата. После успеха действие
 * скрывается, панель перечитывается; 404/412/409 оставляют панель открытой с
 * сообщением.
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

import { BASE_LAYER_ID, EtnError, type HoldingLayerRef, type ThoughtUsage } from '@etn/shared';

import { etn } from '../lib/etn.js';
import { store } from '../state.js';
import { div, span } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { notice } from '../lib/notice.js';
import { confirmDialog, errorDialog } from '../lib/dialog.js';
import { MENU_SEPARATOR, menuAction, type MenuItem } from '../lib/menu.js';
import { collapsibleSection } from '../lib/ui/collapsible.js';
import { iconButton, uiButton } from '../lib/ui/button.js';
import {
  isRestorePanelError,
  usageLayers,
  usagePanelRepeatAction,
  usagePropertyRows,
  type UsagePropertyRow,
} from '../lib/usage.js';
import { errorState, loadingState } from '../lib/ui/empty-state.js';
import { svgIcon } from '../lib/ui/icon.js';
import { createThoughtCloud } from '../lib/thought-cloud.js';
import { openThoughtInEditor, reflectThoughtUpdate } from '../editor/editor.js';
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
  /** Цель помечена на удаление — в шапке видно «Вернуть из корзины». */
  marked: boolean;
}

/** Параметры открытия панели. */
export interface OpenUsagePanelOptions {
  /**
   * Открыть панель, даже если она уже открыта для этой же цели (вход из
   * корзины). Без опции повторный вызов для той же цели закрывает панель
   * (toggle — вход из диалога удаления).
   */
  forceOpen?: boolean;
}

/** Открытая панель (одна на клиент): хост и сплиттер монтирует workspace. */
let host: HTMLElement | null = null;
let resizer: HTMLElement | null = null;
let targetBox: HTMLElement | null = null;
let statusBox: HTMLElement | null = null;
let bodyBox: HTMLElement | null = null;
let closeBtn: HTMLButtonElement | null = null;
let restoreBtn: HTMLButtonElement | null = null;
let current: UsagePanelTarget | null = null;
/** Поколение загрузки: поздний ответ прошлой цели не перерисовывает новую. */
let loadGeneration = 0;

/** Монтирует хосты панели; возвращает teardown для смены workspace. */
export function mountUsagePanel(hostEl: HTMLElement, resizerEl: HTMLElement): () => void {
  host = hostEl;
  resizer = resizerEl;
  host.replaceChildren();

  const header = div('usage-header');
  const title = span(t('usagePanel.title'), 'usage-title');
  // «Вернуть из корзины» — только у помеченной цели; видимость обновляет
  // `load` по свежему чтению пометки (задача d23279f6).
  restoreBtn = uiButton({
    label: t('actions.restore'),
    role: 'secondary',
    size: 's',
    title: t('usagePanel.restoreTitle'),
    onClick: () => void restoreTarget(),
  });
  restoreBtn.hidden = true;
  closeBtn = iconButton({
    icon: svgIcon('x', 14),
    title: t('usagePanel.close'),
    role: 'ghost',
    size: 's',
    onClick: () => closeUsagePanel(),
  });
  header.append(title, restoreBtn, closeBtn);
  targetBox = div('usage-target');
  statusBox = div('usage-status');
  statusBox.hidden = true;
  bodyBox = div('usage-body');
  host.append(header, targetBox, statusBox, bodyBox);

  current = null;
  return () => {
    host = null;
    resizer = null;
    targetBox = null;
    statusBox = null;
    bodyBox = null;
    closeBtn = null;
    restoreBtn = null;
    current = null;
  };
}

/**
 * Открывает панель для сущности. Без `forceOpen` повторный вызов для той же
 * цели закрывает её (toggle — вход из диалога удаления). `forceOpen` (вход из
 * корзины) открывает панель всегда. Для другой цели панель перерисовывается.
 * Фокус после открытия переводится в панель (крестик).
 */
export function openUsagePanel(
  target: UsagePanelTarget,
  options: OpenUsagePanelOptions = {},
): void {
  if (host === null) return;
  if (usagePanelRepeatAction(current, target, options.forceOpen === true) === 'close') {
    closeUsagePanel();
    return;
  }
  current = target;
  host.classList.remove('hidden');
  resizer?.classList.remove('hidden');
  if (targetBox !== null) targetBox.textContent = target.title;
  setStatus(null);
  // Пока не пришло свежее чтение пометки — действие скрыто (чужая цель не
  // должна показывать restore от предыдущей).
  updateRestoreButton(false);
  void load(target);
  closeBtn?.focus();
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
  setStatus(null);
  if (restoreBtn !== null) restoreBtn.hidden = true;
}

/** Строка состояния панели (сообщение об ошибке restore); `null` — скрыть. */
function setStatus(text: string | null): void {
  if (statusBox === null) return;
  statusBox.textContent = text ?? '';
  statusBox.hidden = text === null;
}

/** Видимость действия «Вернуть из корзины» — только у помеченной цели. */
function updateRestoreButton(marked: boolean): void {
  if (restoreBtn === null) return;
  restoreBtn.hidden = !marked;
  restoreBtn.disabled = !marked;
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
    bodyBox.replaceChildren(errorState(t('usagePanel.noNetwork')));
    return;
  }
  bodyBox.replaceChildren(loadingState(t('usagePanel.loading')));

  let usage: ThoughtUsage | null = null;
  let layersFromCheck: HoldingLayerRef[] = [];
  // Пометка на удаление читается свежим запросом при каждом открытии и
  // перечитывании панели (задача d23279f6) — устаревшее действие не висит.
  let marked = false;
  try {
    if (target.kind === 'thought') {
      const [loadedUsage, checks, entity] = await Promise.all([
        etn.thoughts.usage(networkId, target.id),
        etn.thoughts.deletionCheck(networkId, [target.id]),
        etn.thoughts.get(networkId, target.id),
      ]);
      usage = loadedUsage;
      layersFromCheck = checks[target.id]?.blocking.layers ?? [];
      marked = entity.marked_for_deletion;
    } else {
      const [checks, entity] = await Promise.all([
        etn.links.deletionCheck(networkId, [target.id]),
        etn.links.get(networkId, target.id),
      ]);
      layersFromCheck = checks[target.id]?.blocking.layers ?? [];
      marked = entity.marked_for_deletion;
    }
  } catch (err) {
    if (generation === loadGeneration && bodyBox !== null) {
      updateRestoreButton(false);
      bodyBox.replaceChildren(errorState(errText(err), {
        label: t('usagePanel.retry'),
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
    marked,
  };
  renderBody(target, data);
  updateRestoreButton(marked);

  // «После удаления слоя панель перечитывает deletion-check и обновляет
  // открытые диалоги удаления» (f7623077): обновляем видимую блокировку.
  bodyBox.dataset['blocked'] = data.layers.length > 0 ? 'true' : 'false';
}

/**
 * «Вернуть из корзины» из панели. Пометка и версия читаются СВЕЖИМ запросом
 * (без захвата, обычный PATCH с If-Match): чужая пометка восстанавливается,
 * `blocked` не препятствует. 404/412/409 оставляют панель открытой с
 * сообщением в строке состояния; после успеха действие скрывается, панель
 * перечитывается, а холст/редактор получают обновлённую сущность.
 */
async function restoreTarget(): Promise<void> {
  const target = current;
  const networkId = store.state.networkId;
  if (target === null || networkId === null) return;
  setStatus(null);
  try {
    if (target.kind === 'thought') {
      const entity = await etn.thoughts.get(networkId, target.id);
      if (!entity.marked_for_deletion) {
        updateRestoreButton(false);
        setStatus(t('usagePanel.restoreNotMarked'));
        return;
      }
      const updated = await etn.thoughts.update(
        networkId,
        target.id,
        { marked_for_deletion: false },
        entity.version,
      );
      // B1: собственное realtime-эхо приходит позже — отражаем ответ сразу
      // (холст, редактор, структуры, полосы истории/закреплённых).
      reflectThoughtUpdate(updated, { marked_for_deletion: false });
    } else {
      const entity = await etn.links.get(networkId, target.id);
      if (!entity.marked_for_deletion) {
        updateRestoreButton(false);
        setStatus(t('usagePanel.restoreNotMarked'));
        return;
      }
      await etn.links.update(
        networkId,
        target.id,
        { marked_for_deletion: false },
        entity.version,
      );
      // Не полагаемся на собственное эхо: холст перечитывает связи вручную.
      const { scheduleRefresh } = await import('../app.js');
      scheduleRefresh();
    }
    updateRestoreButton(false);
    await reloadAfterMutation(target);
  } catch (err) {
    // 404/412/409 — панель остаётся открытой и объясняет причину строкой.
    if (err instanceof EtnError && isRestorePanelError(err.code)) {
      setStatus(errText(err));
      return;
    }
    errorDialog(t('actions.restore'), err);
  }
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
    label: t('usagePanel.properties.clearAll'),
    size: 's',
    onClick: () => {
      void clearAllProperties(target);
    },
  });
  clearAllBtn.disabled = data.total === 0;

  const group = collapsibleSection({
    title: t('usagePanel.properties.title'),
    count: String(data.total),
    collapsed: false,
    actions: [clearAllBtn],
    classes: { root: 'usage-group', header: 'usage-group-header', body: 'usage-group-body' },
    buildBody: () =>
      data.properties.length === 0
        ? span(t('usagePanel.properties.empty'), 'usage-empty')
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
    menuAction(t('usagePanel.properties.clearOne'), () => {
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
    notice(t('usagePanel.properties.cleared'));
    await reloadAfterMutation(target);
  } catch (err) {
    errorDialog(t('usagePanel.properties.clearOne'), err);
  }
}

/** `POST …/usage/clear` — необратимо снимает все ссылки на мысль. */
async function clearAllProperties(target: UsagePanelTarget): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const ok = await confirmDialog(
    t('usagePanel.properties.clearAllTitle'),
    t('usagePanel.properties.clearAllMessage'),
    true,
    t('usagePanel.properties.clearAllConfirm'),
  );
  if (!ok) return;
  try {
    const { cleared } = await etn.thoughts.usageClear(networkId, target.id);
    notice(
      cleared > 0
        ? t('usagePanel.properties.clearedCount', String(cleared))
        : t('usagePanel.properties.nothingCleared'),
    );
    await reloadAfterMutation(target);
  } catch (err) {
    errorDialog(t('usagePanel.properties.clearAllTitle'), err);
  }
}

/** Группа «Используется в слоях» (мысль и связь). */
function buildLayersGroup(target: UsagePanelTarget, data: UsagePanelData): HTMLElement {
  const group = collapsibleSection({
    title: t('usagePanel.layers.title'),
    count: String(data.layers.length),
    collapsed: false,
    classes: { root: 'usage-group', header: 'usage-group-header', body: 'usage-group-body' },
    buildBody: () =>
      data.layers.length === 0
        ? span(t('usagePanel.layers.empty'), 'usage-empty')
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
        label: t('usagePanel.layers.delete'),
        size: 's',
        role: 'danger',
        onClick: () => {
          const networkId = store.state.networkId;
          if (networkId === null) return;
          void openDeleteLayerDialog(networkId, layer.id, () => {
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

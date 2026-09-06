/**
 * Change-layer menu and dialogs (S11, 13-layers.md §10.3; 08-ui-spec.md §8.2).
 *
 * The «Основа» toolbar menu is the constant indicator of the session's
 * current layer — its label IS the layer title (§10.3: «заголовок меню и есть
 * постоянный индикатор»). Commands: pick a layer, create a new one; while a
 * non-base layer is active — merge it into the parent and delete it.
 *
 * The layer is a property of the TAB (§10.3): `tabs.layer_id` (main-process
 * row) is the source of truth, and {@link syncLayersForTab} aligns the
 * server-side session to the active tab's layer on every tab activation.
 * Service (reserve) layers never appear in the selection list (§2.2).
 *
 * The diff dialog shows both views of «чем слой отличается» (§10.3): the
 * structural link diff (added/removed/type-changed/reparented/reordered) and
 * the textual diff of two deterministically assembled documents.
 */

import { BASE_LAYER_ID, type Layer, type LayerColors, type LayerDiffResult, type LayerMergeReport } from '@etn/shared';

import { etn } from '../lib/etn.js';
import { closeMenu, MENU_SEPARATOR, showMenuAt, type MenuItem } from '../lib/menu.js';
import { errorDialog, field, showDialog } from '../lib/dialog.js';
import { button, div, el, span } from '../lib/dom.js';
import { svgIcon } from '../lib/icons.js';
import {
  defaultLayerColors,
  invertThemeColor,
} from '../lib/layer-colors.js';
import { onRealtimeEvent } from '../realtime.js';
import { resyncAfterLayerSwitch } from '../app.js';
import { store, requireNetworkId, type Theme } from '../state.js';
import { upsertTab } from './tabs/tab-state.js';
import type { WorkspaceHandles } from './workspace.js';
import { lineDiff } from '../lib/diff.js';

/** One line of the structural diff, human-readable via batch-resolved titles. */
interface StructuralLine {
  text: string;
  sub?: string;
}

/**
 * Aligns the server-side session layer to the active tab's `layer_id` and
 * refreshes `store.layers` / `store.currentLayer` / `store.layerOverrides`.
 *
 * Called on every tab activation (app.openNetwork) and after every layer
 * mutation. `tabLayerId` may be stale (the layer was deleted from another
 * session) — the list check falls back to the base and repairs the tab row.
 */
export async function syncLayersForTab(networkId: string, tabLayerId: string | null): Promise<void> {
  const layers = await etn.layers.list(networkId);
  const base = layers.find((l) => l.is_base);
  if (base === undefined) {
    store.update({ layers, currentLayer: null, layerOverrides: { thought_ids: [], link_ids: [] } });
    return;
  }
  let wanted = layers.find((l) => l.id === tabLayerId) ?? base;
  const current = layers.find((l) => l.current) ?? base;

  if (current.id !== wanted.id) {
    const echo = await etn.layers.select(networkId, wanted.id);
    wanted = { ...wanted, id: echo.id, title: echo.title };
  }

  let overrides: { thought_ids: string[]; link_ids: string[] } = {
    thought_ids: [],
    link_ids: [],
  };
  if (!wanted.is_base) {
    const diff = await etn.layers.diff(networkId, wanted.id);
    overrides = { thought_ids: diff.overridden.thought_ids, link_ids: diff.overridden.link_ids };
  }

  store.update({
    layers,
    currentLayer: { id: wanted.id, title: wanted.title },
    layerOverrides: overrides,
  });

  // Repair a stale tab layer (deleted elsewhere): point it back at the base.
  if (wanted.id !== tabLayerId && tabLayerId !== null) {
    const tab = store.state.tabs.find((t) => t.network_id === networkId);
    if (tab !== undefined) {
      await etn.tabs
        .updateState(tab.tab_id, { layer_id: null })
        .then(() => etn.tabs.list())
        .then((tabs) => store.update({ tabs }));
    }
  }
}

/** Wires the «Основа» toolbar menu button. */
export function wireLayerMenu(handles: WorkspaceHandles): void {
  handles.layerMenuButton.addEventListener('click', (event) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    void (async () => {
      const networkId = store.state.networkId;
      if (networkId === null) return;
      let layers = store.state.layers;
      try {
        layers = await etn.layers.list(networkId);
        store.update({ layers });
      } catch {
        // Offline — show the last known list.
      }
      showMenuAt(rect.left, rect.bottom + 4, buildLayerMenuItems(networkId, layers));
    })();
  });
}

/**
 * Menu items of «Основа» (08-ui-spec.md §8.2): the selectable layers (service
 * ones hidden), «Создать новый слой», and — while a layer is active — the
 * merge/delete pair. Pure of DOM for unit tests.
 */
export function buildLayerMenuItems(networkId: string, layers: Layer[]): MenuItem[] {
  const current = layers.find((l) => l.current);
  const items: MenuItem[] = [];
  const selectable = layers
    .filter((l) => !l.is_service)
    .sort((a, b) => a.depth - b.depth || a.created_at.localeCompare(b.created_at));
  for (const l of selectable) {
    const indent = l.is_base ? '' : '\u00A0\u00A0'.repeat(l.depth - 1);
    items.push({
      label: `${indent}${l.is_base ? 'Основа' : l.title}`,
      checked: l.current,
      onClick: () => void selectLayerForTab(networkId, l.id),
    });
  }
  items.push(MENU_SEPARATOR);
  items.push({ label: 'Создать новый слой…', onClick: () => void openCreateLayerDialog(networkId) });
  if (current !== undefined) {
    items.push({
      label: current.is_base ? 'Свойства основы…' : 'Свойства слоя…',
      onClick: () => void openLayerPropsDialog(networkId, current.id),
    });
  }
  if (current !== undefined && !current.is_base) {
    const targetTitle =
      layers.find((l) => l.id === current.parent_id)?.title ?? 'Основу';
    items.push(MENU_SEPARATOR);
    items.push({
      label: `Отличия от «${targetTitle}»…`,
      onClick: () => void openDiffDialog(networkId, current.id),
    });
    items.push({
      label: `Слить «${current.title}» в «${targetTitle}»…`,
      onClick: () => void openMergeLayerDialog(networkId, current.id),
    });
    items.push({
      label: `Удалить «${current.title}»…`,
      danger: true,
      onClick: () => void openDeleteLayerDialog(networkId, current.id),
    });
  }
  return items;
}

/** Select a layer: switch the server session, record it on the active tab,
 *  then fully resync the visible state (13-layers.md §12 — the layer switch
 *  invalidates the client cache as a whole, not just the layer list). */
async function selectLayerForTab(networkId: string, layerId: string): Promise<void> {
  let layer = store.state.layers.find((l) => l.id === layerId);
  if (layer === undefined) {
    // The layer may be fresh — created a moment ago (the create dialog),
    // while `store.layers` predates it. Re-read the list once instead of
    // silently doing nothing (bug: no switch to a newly created layer).
    try {
      const layers = await etn.layers.list(networkId);
      store.update({ layers });
      layer = layers.find((l) => l.id === layerId);
    } catch {
      // Offline — nothing to select; the next menu open repairs the list.
    }
  }
  if (layer === undefined) return;
  await etn.layers.select(networkId, layerId);
  const tab = store.state.tabs.find((t) => t.network_id === networkId && t.tab_id === store.state.activeTabId);
  if (tab !== undefined) {
    await etn.tabs.updateState(tab.tab_id, { layer_id: layer.is_base ? null : layerId });
    const tabs = await etn.tabs.list();
    store.update({ tabs, currentLayer: { id: layer.id, title: layer.title } });
    const fresh = tabs.find((t) => t.tab_id === tab.tab_id);
    if (fresh !== undefined) upsertTab(fresh);
  }
  await syncLayersForTab(networkId, layer.is_base ? null : layerId);
  await resyncAfterLayerSwitch();
}

/** Debounce for coalescing post-mutation override refreshes, ms. */
const OVERRIDES_REFRESH_MS = 300;
let overridesTimer: number | null = null;

/** Re-reads the current layer's overridden ids and stores them for the
 *  canvas marking (08-ui-spec.md §2.2). No-op while the base layer is
 *  current — there is nothing to mark. */
async function refreshLayerOverrides(): Promise<void> {
  const networkId = store.state.networkId;
  const current = store.state.currentLayer;
  if (networkId === null || current === null || current.id === BASE_LAYER_ID) return;
  try {
    const diff = await etn.layers.diff(networkId, current.id);
    if (store.state.currentLayer?.id !== current.id) return; // switched away meanwhile
    store.update({
      layerOverrides: {
        thought_ids: diff.overridden.thought_ids,
        link_ids: diff.overridden.link_ids,
      },
    });
  } catch {
    // Offline / the layer died — the next syncLayersForTab repairs the state.
  }
}

/**
 * Schedules an override refresh after something may have changed the current
 * layer's rows (08-ui-spec.md §2.2): own mutations (flagged by main as
 * `realtime:selfmut` — the server echo is suppressed for the applier) and
 * foreign realtime events. The badge must appear the moment a thought gains
 * a layer version, not on the next layer/tab switch.
 */
export function scheduleLayerOverridesRefresh(): void {
  const current = store.state.currentLayer;
  if (current === null || current.id === BASE_LAYER_ID) return;
  if (overridesTimer !== null) window.clearTimeout(overridesTimer);
  overridesTimer = window.setTimeout(() => {
    overridesTimer = null;
    void refreshLayerOverrides();
  }, OVERRIDES_REFRESH_MS);
}

/** Event types whose application can create/drop layer shadow rows. */
const OVERRIDE_RELEVANT_EVENTS = new Set([
  'thought.created',
  'thought.updated',
  'thought.reordered',
  'thought.deleted',
  'link.created',
  'link.updated',
  'link.deleted',
  'property-value.set',
  'property-value.deleted',
  'comment.created',
  'comment.updated',
  'comment.deleted',
  'attachment.created',
  'attachment.updated',
  'attachment.deleted',
]);

let overridesTrackingInitialized = false;

/**
 * Wires the live override tracking (08-ui-spec.md §2.2): own mutations via
 * the `realtime:selfmut` flag from main, foreign changes via the realtime
 * event bus. Idempotent — call once when the workspace mounts.
 */
export function initLayerOverridesTracking(): void {
  if (overridesTrackingInitialized) return;
  overridesTrackingInitialized = true;
  etn.realtime.onSelfMutated((payload) => {
    if (payload.networkId === store.state.networkId) scheduleLayerOverridesRefresh();
  });
  onRealtimeEvent((evt) => {
    if (evt.network_id !== store.state.networkId) return;
    if (OVERRIDE_RELEVANT_EVENTS.has(evt.type)) scheduleLayerOverridesRefresh();
  });
}

/** One «picker + hex field» row of the layer-colours editor (0.6.4 §2.2a).
 *  The native colour input carries the visual picking; the hex field accepts
 *  exact values; both stay in sync. */
function colorPickerRow(label: string, initial: string): {
  root: HTMLElement;
  get: () => string;
} {
  const picker = el('input', 'color-input') as HTMLInputElement;
  picker.type = 'color';
  picker.value = initial;
  const hex = el('input', 'text-input layer-color-hex') as HTMLInputElement;
  hex.value = initial;
  picker.addEventListener('input', () => {
    hex.value = picker.value;
  });
  hex.addEventListener('change', () => {
    const trimmed = hex.value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) picker.value = trimmed.toLowerCase();
    else hex.value = picker.value;
  });
  const row = div('layer-color-row');
  row.append(picker, hex);
  const wrap = field(label, row);
  return {
    root: wrap,
    get: () => picker.value.toLowerCase(),
  };
}

/**
 * Layer properties dialog (§10.1, matrix §15 «Править комментарий слоя»):
 * rename and/or edit the comment. The base title is fixed (input disabled) —
 * only its comment is editable. Non-base layers also edit their colour
 * indication (0.6.4 §2.2a): two colours for the CURRENT theme, always active
 * — no on/off switch (colours exist to tell the layer apart, picking them
 * applies them); the opposite theme's pair is computed on save by flipping
 * HSL lightness. The base layer hides the colour fields — it always uses the
 * theme defaults.
 */
/**
 * Диалог свойств слоя (название, комментарий, цвета) — экспортирован, чтобы
 * открываться из ленты событий (задача 59119797: клик по `entity_type='layer'`
 * → диалог редактирования слоя, а не снимок).
 *
 * Если слой отсутствует в `store.state.layers` (например, его только что
 * создали и кэш ещё не успел обновиться, или он был удалён), подтягиваем
 * его с сервера отдельным запросом.
 */
export function openLayerPropsDialog(networkId: string, layerId: string): void {
  let layer = store.state.layers.find((l) => l.id === layerId);
  if (layer === undefined) {
    void openLayerPropsDialogAsync(networkId, layerId);
    return;
  }
  showLayerPropsDialog(networkId, layer);
}

async function openLayerPropsDialogAsync(networkId: string, layerId: string): Promise<void> {
  try {
    // Слои не имеют GET-by-id — забираем весь список и ищем там.
    const layers = await etn.layers.list(networkId);
    const layer = layers.find((l) => l.id === layerId);
    if (layer === undefined) {
      errorDialog('Свойства слоя', new Error(`Слой ${layerId} не найден`));
      return;
    }
    showLayerPropsDialog(networkId, layer);
  } catch (err) {
    errorDialog('Свойства слоя', err);
  }
}

function showLayerPropsDialog(networkId: string, layer: Layer): void {
  const theme: Theme = store.state.theme;

  const titleInput = el('input', 'text-input') as HTMLInputElement;
  titleInput.value = layer.title;
  if (layer.is_base) titleInput.disabled = true;
  const commentInput = el('textarea', 'textarea-input') as HTMLTextAreaElement;
  commentInput.value = layer.comment ?? '';

  const body = div('form-stack');
  body.append(field('Название', titleInput), field('Комментарий', commentInput));

  // Colour indication (0.6.4): only for non-base layers.
  const themeLabel = theme === 'dark' ? 'тёмной' : 'светлой';
  let stripeRow: ReturnType<typeof colorPickerRow> | null = null;
  let bgRow: ReturnType<typeof colorPickerRow> | null = null;
  if (!layer.is_base) {
    const defaults = defaultLayerColors();
    const initialStripe = layer.colors?.focus_stripe[theme] ?? defaults.focus_stripe[theme];
    const initialBg = layer.colors?.background[theme] ?? defaults.background[theme];
    stripeRow = colorPickerRow('Полоса фокуса', initialStripe);
    bgRow = colorPickerRow('Фон холста', initialBg);
    const hint = div('layer-hint');
    hint.textContent = `Цвета для ${themeLabel} темы; второй вариант вычисляется инверсией светлоты.`;
    const colorsBlock = div('form-stack layer-colors-block');
    colorsBlock.append(hint, stripeRow.root, bgRow.root);
    body.append(colorsBlock);
  }

  showDialog({
    title: layer.is_base ? 'Свойства основы' : `Свойства слоя «${layer.title}»`,
    body,
    width: 460,
    buttons: [
      { label: 'Отмена', onClick: (close) => close() },
      {
        label: 'Сохранить',
        primary: true,
        onClick: async (close) => {
          const title = titleInput.value.trim();
          const comment = commentInput.value.trim();
          if (!layer.is_base && title.length === 0) return;
          // Colours: `undefined` — untouched, an object — the picked pair
          // plus the inverted opposite theme (§2.2a). There is no «off»
          // switch anymore: the shown pair is always what gets saved, so a
          // layer without stored colours picks up the shown defaults.
          let colors: LayerColors | undefined;
          if (stripeRow !== null && bgRow !== null) {
            const next: LayerColors = {
              focus_stripe: invertThemeColor(
                { dark: stripeRow.get(), light: stripeRow.get() },
                theme,
              ),
              background: invertThemeColor({ dark: bgRow.get(), light: bgRow.get() }, theme),
            };
            if (JSON.stringify(next) !== JSON.stringify(layer.colors)) colors = next;
          }
          try {
            const updated = await etn.layers.update(
              networkId,
              layer.id,
              {
                ...(layer.is_base || title === layer.title ? {} : { title }),
                ...(comment === (layer.comment ?? '') ? {} : { comment: comment.length > 0 ? comment : null }),
                ...(colors !== undefined ? { colors } : {}),
              },
              layer.version,
            );
            close();
            await syncLayersForTab(networkId, store.state.currentLayer?.id ?? null);
            void updated;
          } catch (err) {
            errorDialog('Не удалось сохранить слой', err);
          }
        },
      },
    ],
    onMount: () => titleInput.focus(),
  });
}

/** Create-layer dialog (§10.3: the explaining one-liner + comment + git branch). */function openCreateLayerDialog(networkId: string): void {
  const titleInput = el('input', 'text-input') as HTMLInputElement;
  titleInput.placeholder = 'Например: Правки августа';
  const commentInput = el('textarea', 'textarea-input') as HTMLTextAreaElement;
  commentInput.placeholder = 'Зачем этот слой — чтобы следующий (или агент) понял без расспросов';
  const branchInput = el('input', 'text-input') as HTMLInputElement;
  branchInput.placeholder = 'ветка git (необязательно)';

  const body = div('form-stack');
  const hint = div('layer-hint');
  hint.append('Правки останутся в слое. Основа не изменится, пока вы не сольёте слой.');
  const colorsHint = div('layer-hint');
  colorsHint.textContent =
    'Новый слой получит собственные цвета карты (полоса фокуса и фон), чтобы его было видно; их можно поменять в «Свойствах слоя».';
  body.append(
    hint,
    field('Название', titleInput),
    field('Комментарий', commentInput),
    field('Ветка git', branchInput),
    colorsHint,
  );

  showDialog({
    title: 'Новый слой изменений',
    body,
    width: 460,
    buttons: [
      { label: 'Отмена', onClick: (close) => close() },
      {
        label: 'Создать',
        primary: true,
        onClick: async (close) => {
          const title = titleInput.value.trim();
          if (title.length === 0) return;
          const comment = commentInput.value.trim();
          const gitBranch = branchInput.value.trim();
          try {
            // Creation defaults (0.6.4 §2.2a): the layer is immediately
            // visually distinct from the base; the opposite theme's pair is
            // the lightness inversion of these.
            const layer = await etn.layers.create(networkId, {
              title,
              ...(comment.length > 0 ? { comment } : {}),
              ...(gitBranch.length > 0 ? { git_branch: gitBranch } : {}),
              colors: defaultLayerColors(),
            });
            close();
            await selectLayerForTab(networkId, layer.id);
          } catch (err) {
            errorDialog('Не удалось создать слой', err);
          }
        },
      },
    ],
    extraShortcuts: undefined,
    onMount: () => titleInput.focus(),
  });
}

/** Delete-layer dialog (§2.4): descendant count + titles, «основа не пострадает». */
function openDeleteLayerDialog(networkId: string, layerId: string): void {
  const layer = store.state.layers.find((l) => l.id === layerId);
  if (layer === undefined) return;

  const body = div('form-stack');
  const children = store.state.layers.filter((l) => l.parent_id === layerId);
  if (children.length > 0) {
    body.append(
      span(
        `Слой будет удалён вместе с ${children.length} дочерними слоями: ${children
          .map((c) => `«${c.title}»`)
          .join(', ')}.`,
        'layer-hint',
      ),
    );
  }
  const safeNote = div('layer-hint layer-hint-safe');
  safeNote.textContent =
    'Удаление слоя не меняет основу: теневые правки слоя будут потеряны, всё остальное останется как есть.';
  body.append(safeNote);

  showDialog({
    title: `Удалить слой «${layer.title}»?`,
    body,
    width: 460,
    buttons: [
      { label: 'Отмена', onClick: (close) => close() },
      {
        label: 'Удалить слой',
        danger: true,
        onClick: async (close) => {
          try {
            await etn.layers.remove(networkId, layerId, layer.children_count);
            close();
            // The server re-pointed the session to the parent; align the tab
            // and the store — the realtime `layer.deleted` frame does the rest
            // when the session was this one.
            const tab = store.state.tabs.find((t) => t.tab_id === store.state.activeTabId);
            if (tab !== undefined) {
              const parentId =
                layer.parent_id !== null && !store.state.layers.find((l) => l.id === layer.parent_id)?.is_base
                  ? layer.parent_id
                  : null;
              await etn.tabs.updateState(tab.tab_id, { layer_id: parentId });
              const tabs = await etn.tabs.list();
              store.update({ tabs });
            }
            await syncLayersForTab(networkId, layer.parent_id);
          } catch (err) {
            errorDialog('Не удалось удалить слой', err);
          }
        },
      },
    ],
  });
}

/** Merge dialog: confirms, then shows the report (or the conflict list). */
function openMergeLayerDialog(networkId: string, layerId: string): void {
  const layer = store.state.layers.find((l) => l.id === layerId);
  if (layer === undefined) return;
  const targetTitle =
    store.state.layers.find((l) => l.id === layer.parent_id)?.title ?? 'Основу';

  const body = div('form-stack');
  const hint = div('layer-hint');
  hint.append(
    `Все правки слоя будут перенесены в «${targetTitle}». При конфликте (строка изменилась в основе после создания слоя) слияние не выполнится — вы увидите список расхождений.`,
  );
  body.append(hint);

  showDialog({
    title: `Слить «${layer.title}» в «${targetTitle}»?`,
    body,
    width: 460,
    buttons: [
      { label: 'Отмена', onClick: (close) => close() },
      {
        label: 'Слить',
        primary: true,
        onClick: async (close) => {
          try {
            const report = await etn.layers.merge(networkId, layerId);
            close();
            showMergeReport(report);
            await syncLayersForTab(networkId, layer.id);
          } catch (err) {
            errorDialog('Слияние отклонено', err);
          }
        },
      },
    ],
  });
}

/** Success report of a merge (§8.3). */
function showMergeReport(report: LayerMergeReport): void {
  const lines: string[] = [];
  const totals = Object.entries(report.applied);
  if (totals.length > 0) {
    lines.push('Перенесено строк:');
    for (const [table, count] of totals) lines.push(`• ${table}: ${count}`);
  }
  if (report.reorder_collapsed.length > 0) {
    lines.push(
      `Порядок связей изменён у ${report.reorder_collapsed.length} мыслей (свёрнуто).`,
    );
  }
  if (report.skipped.length > 0) {
    lines.push(`Связи с исчезнувшим концом пропущены: ${report.skipped.length}.`);
  }
  lines.push(
    report.reserve_layer_id !== null
      ? 'Перед слиянием создан резервный слой для ручного отката.'
      : 'Резервный слой не понадобился.',
  );

  const body = div('form-stack');
  for (const line of lines) {
    const row = div('layer-report-line');
    row.textContent = line;
    body.append(row);
  }
  showDialog({
    title: 'Слой слит',
    body,
    width: 460,
    buttons: [{ label: 'Закрыть', onClick: (close) => close() }],
  });
}

/**
 * The diff dialog: «Структура» (the link-level changes a text diff is blind
 * to) and «Содержание» (the plain text diff of two documents).
 */
export async function openDiffDialog(networkId: string, layerId: string): Promise<void> {
  const layer = store.state.layers.find((l) => l.id === layerId);
  const targetTitle =
    store.state.layers.find((l) => l.id === layer?.parent_id)?.title ?? 'Основа';

  const tabBar = div('diff-tabs');
  const contentHost = div('diff-content');
  const body = div('diff-body');
  body.append(tabBar, contentHost);

  const structuralBtn = el('button', 'diff-tab active', 'Связи') as HTMLButtonElement;
  structuralBtn.type = 'button';
  const textBtn = el('button', 'diff-tab', 'Содержание') as HTMLButtonElement;
  textBtn.type = 'button';
  tabBar.append(structuralBtn, textBtn);

  let structural: LayerDiffResult | null = null;
  let textEntries: ReturnType<typeof lineDiff> | null = null;

  const render = (mode: 'structural' | 'text'): void => {
    structuralBtn.classList.toggle('active', mode === 'structural');
    textBtn.classList.toggle('active', mode === 'text');
    contentHost.replaceChildren();
    if (mode === 'structural' && structural !== null) {
      contentHost.append(renderStructuralDiff(networkId, structural));
    } else if (mode === 'text' && textEntries !== null) {
      contentHost.append(renderTextDiff(textEntries));
    } else {
      const loading = span('Загрузка…', 'layer-hint');
      contentHost.append(loading);
    }
  };

  showDialog({
    title: `Отличия «${layer?.title ?? 'слоя'}» от «${targetTitle}»`,
    body,
    width: 720,
    boxClass: 'diff-dialog',
    buttons: [{ label: 'Закрыть', onClick: (close) => close() }],
    onMount: () => {
      structuralBtn.addEventListener('click', () => render('structural'));
      textBtn.addEventListener('click', () => render('text'));
      void (async () => {
        try {
          structural = await etn.layers.diff(networkId, layerId);
          render('structural');
          const docs = await etn.layers.diffDoc(networkId, layerId);
          textEntries = lineDiff(docs.target_doc, docs.layer_doc);
          render('text');
        } catch (err) {
          contentHost.replaceChildren(span(`Не удалось загрузить дифф: ${String(err)}`));
        }
      })();
    },
  });
}

/** Builds the structural diff view — each change class as a labelled group. */
function renderStructuralDiff(networkId: string, diff: LayerDiffResult): HTMLElement {
  const host = div('diff-structural');
  void (async () => {
    const lines: StructuralLine[] = [];
    const allIds = new Set<string>();
    for (const r of diff.links.added) {
      allIds.add(r.source_id);
      allIds.add(r.target_id);
    }
    for (const r of diff.links.removed) {
      allIds.add(r.source_id);
      allIds.add(r.target_id);
    }
    for (const r of diff.links.reparented) {
      allIds.add(r.thought_id);
      allIds.add(r.from_parent_id);
      allIds.add(r.to_parent_id);
    }
    for (const r of diff.links.reorder_collapsed) allIds.add(r.thought_id);

    const titles = new Map<string, string>();
    try {
      const refs = await etn.thoughts.resolve(networkId, [...allIds]);
      for (const ref of refs) titles.set(ref.id, ref.title);
    } catch {
      // Titles degrade to raw ids — the diff itself is still shown.
    }
    const name = (id: string): string => titles.get(id) ?? id.slice(0, 8);

    for (const r of diff.links.added) {
      lines.push({ text: `+ ${name(r.source_id)} → ${name(r.target_id)}`, sub: 'добавлена' });
    }
    for (const r of diff.links.removed) {
      lines.push({ text: `− ${name(r.source_id)} → ${name(r.target_id)}`, sub: 'удалена' });
    }
    for (const r of diff.links.type_changed) {
      lines.push({ text: `≈ связь ${r.id.slice(0, 8)}`, sub: 'сменился тип' });
    }
    for (const r of diff.links.reparented) {
      lines.push({
        text: `↳ ${name(r.thought_id)}: ${name(r.from_parent_id)} → ${name(r.to_parent_id)}`,
        sub: 'сменился родитель',
      });
    }
    for (const r of diff.links.reorder_collapsed) {
      lines.push({ text: `⇅ ${name(r.thought_id)}: ${r.count} связей`, sub: 'изменён порядок' });
    }

    host.replaceChildren();
    if (lines.length === 0) {
      const empty = div('layer-hint layer-hint-safe');
      empty.textContent = 'Отличий нет — слой не меняет структуру связей.';
      host.append(empty);
      return;
    }
    const groups = new Map<string, StructuralLine[]>();
    for (const line of lines) {
      const key = line.sub ?? '';
      const list = groups.get(key) ?? [];
      list.push(line);
      groups.set(key, list);
    }
    for (const [label, entries] of groups) {
      const groupTitle = div('diff-group-title');
      groupTitle.textContent = label;
      host.append(groupTitle);
      for (const e of entries) {
        const groupLine = div('diff-group-line');
        groupLine.textContent = e.text;
        host.append(groupLine);
      }
    }
  })();
  return host;
}

/** Builds the textual diff view — `del`/`add`/`same` lines with colouring. */
function renderTextDiff(entries: ReturnType<typeof lineDiff>): HTMLElement {
  const host = div('diff-text');
  for (const entry of entries) {
    const line = div(`diff-line diff-${entry.kind}`);
    line.textContent = entry.text === '' ? ' ' : entry.text;
    host.append(line);
  }
  return host;
}

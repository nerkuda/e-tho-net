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
 * The diff dialog shows «чем слой отличается» as ONE lazily paged list of the
 * structural link changes and the overridden entities (задача 52c776f1); the
 * line diff of a single thought opens in its own dialog on click.
 */

import {
  BASE_LAYER_ID,
  LAYER_DIFF_SECTIONS,
  type Layer,
  type LayerColors,
  type LayerDiffCounts,
  type LayerDiffPage,
  type LayerDiffSection,
  type LayerMergeReport,
  type LayerThoughtDiff,
  type LayerThoughtDiffFieldKey,
} from '@etn/shared';
import { t } from '../lib/i18n.js';

import { etn } from '../lib/etn.js';
import {
  MENU_SEPARATOR,
  menuAction,
  menuChoice,
  showMenuAt,
  type MenuItem,
} from '../lib/menu.js';
import { errorDialog, showDialog } from '../lib/dialog.js';
import { div, span } from '../lib/dom.js';
import { colorField } from '../lib/ui/color-field.js';
import { fieldInput, fieldRow, fieldTextarea } from '../lib/ui/field.js';
import { emptyState, errorState, loadingState } from '../lib/ui/empty-state.js';
import { reconcileKeyed } from '../lib/ui/keyed-list.js';
import {
  defaultLayerColors,
  invertThemeColor,
} from '../lib/layer-colors.js';
import { onRoutedRealtimeEvent } from '../lib/live/index.js';
import { resyncAfterLayerSwitch } from '../app.js';
import { store, type Theme } from '../state.js';
import { upsertTab } from './tabs/tab-state.js';
import type { WorkspaceHandles } from './workspace.js';
import { lineDiff } from '../lib/diff.js';

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
    items.push(
      menuChoice(
        `${indent}${l.is_base ? t('layers.menu.base') : l.title}`,
        l.current,
        () => void selectLayerForTab(networkId, l.id),
      ),
    );
  }
  items.push(MENU_SEPARATOR);
  items.push(menuAction(t('layers.menu.create'), () => void openCreateLayerDialog(networkId)));
  if (current !== undefined) {
    items.push(
      menuAction(
        current.is_base ? t('layers.menu.propsBase') : t('layers.menu.propsLayer'),
        () => void openLayerPropsDialog(networkId, current.id),
      ),
    );
  }
  if (current !== undefined && !current.is_base) {
    const targetTitle =
      layers.find((l) => l.id === current.parent_id)?.title ?? t('layers.menu.baseTo');
    items.push(MENU_SEPARATOR);
    items.push(
      menuAction(t('layers.menu.diff', targetTitle), () =>
        void openDiffDialog(networkId, current.id),
      ),
    );
    items.push(
      menuAction(t('layers.menu.merge', [current.title, targetTitle]), () =>
        void openMergeLayerDialog(networkId, current.id),
      ),
    );
    items.push(
      menuAction(t('layers.menu.delete', current.title), () => void openDeleteLayerDialog(networkId, current.id), {
        danger: true,
      }),
    );
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
  // Чужие изменения — через СЛОЙ (G6): подписка на события, прошедшие роутер
  // (`onRoutedRealtimeEvent`), а не на шину напрямую. Побочный эффект
  // (переопределения объектов текущим слоем) не выражается ключом запроса.
  onRoutedRealtimeEvent((evt) => {
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
  const f = colorField({ value: initial, withHex: true, extraClass: 'layer-color-row' });
  const wrap = fieldRow({ label, control: f.root });
  return {
    root: wrap,
    get: () => f.value(),
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
  const layer = store.state.layers.find((l) => l.id === layerId);
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

  const titleInput = fieldInput({ value: layer.title });
  if (layer.is_base) titleInput.disabled = true;
  const commentInput = fieldTextarea({ value: layer.comment ?? '' });

  const body = div('form-stack');
  body.append(
    fieldRow({ label: 'Название', control: titleInput }),
    fieldRow({ label: 'Комментарий', control: commentInput }),
  );

  // Colour indication (0.6.4): only for non-base layers.
  const themeLabel = theme === 'dark' ? 'тёмной' : 'светлой';
  let stripeRow: ReturnType<typeof colorPickerRow> | null = null;
  let bgRow: ReturnType<typeof colorPickerRow> | null = null;
  /** Исходные цвета пары при открытии — база «грязной» проверки (b58f6aad). */
  let stripeInitial: string | null = null;
  let bgInitial: string | null = null;
  if (!layer.is_base) {
    const defaults = defaultLayerColors();
    const initialStripe = layer.colors?.focus_stripe[theme] ?? defaults.focus_stripe[theme];
    const initialBg = layer.colors?.background[theme] ?? defaults.background[theme];
    stripeInitial = initialStripe;
    bgInitial = initialBg;
    stripeRow = colorPickerRow('Полоса фокуса', initialStripe);
    bgRow = colorPickerRow('Фон холста', initialBg);
    const hint = div('layer-hint');
    hint.textContent = `Цвета для ${themeLabel} темы; второй вариант вычисляется инверсией светлоты.`;
    // Парные цветовые поля — на одной строке (ошибка 57e05439): в столбик они
    // съедали высоту и выталкивали содержимое за роль размера.
    const colorsRow = div('form-row two-col-row layer-colors-row');
    colorsRow.append(stripeRow.root, bgRow.root);
    const colorsBlock = div('form-stack layer-colors-block');
    colorsBlock.append(hint, colorsRow);
    body.append(colorsBlock);
  }

  /** Запись изменений слоя и закрытие — общий путь кнопки и подтверждения. */
  async function save(close: () => void): Promise<void> {
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
  }

  showDialog({
    title: layer.is_base ? 'Свойства основы' : `Свойства слоя «${layer.title}»`,
    body,
    // Роль `m` (требование 13464c39): имя, комментарий и парные цветовые поля
    // (в одну строку) помещаются без прокрутки (ошибка 57e05439).
    size: 'm',
    // Грязная форма (требование b58f6aad): Esc/крестик при изменениях требуют
    // подтверждения; «Сохранить» идёт тем же путём, что «Применить».
    dirty: {
      isDirty: () =>
        (!layer.is_base && titleInput.value.trim() !== layer.title) ||
        commentInput.value.trim() !== (layer.comment ?? '') ||
        (stripeRow !== null && stripeRow.get() !== stripeInitial) ||
        (bgRow !== null && bgRow.get() !== bgInitial),
      save: (close) => void save(close),
    },
    buttons: [
      { label: t('actions.cancel'), onClick: (close) => close() },
      { label: t('actions.apply'), primary: true, onClick: (close) => void save(close) },
    ],
    onMount: () => titleInput.focus(),
  });
}

/** Create-layer dialog (§10.3: the explaining one-liner + comment + git branch). */function openCreateLayerDialog(networkId: string): void {
  const titleInput = fieldInput({ placeholder: 'Например: Правки августа' });
  const commentInput = fieldTextarea({
    placeholder: 'Зачем этот слой — чтобы следующий (или агент) понял без расспросов',
  });
  const branchInput = fieldInput({ placeholder: 'ветка git (необязательно)' });

  const body = div('form-stack');
  const hint = div('layer-hint');
  hint.append('Правки останутся в слое. Основа не изменится, пока вы не сольёте слой.');
  const colorsHint = div('layer-hint');
  colorsHint.textContent =
    'Новый слой получит собственные цвета карты (полоса фокуса и фон), чтобы его было видно; их можно поменять в «Свойствах слоя».';
  body.append(
    hint,
    fieldRow({ label: 'Название', control: titleInput }),
    fieldRow({ label: 'Комментарий', control: commentInput }),
    fieldRow({ label: 'Ветка git', control: branchInput }),
    colorsHint,
  );

  /** Создание слоя и закрытие — общий путь кнопки и подтверждения (b58f6aad). */
  async function create(close: () => void): Promise<void> {
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
  }

  showDialog({
    title: 'Новый слой изменений',
    body,
    // Роль `m` (требование 13464c39): подсказки, имя, комментарий и ветка
    // помещаются без прокрутки (ошибка 57e05439).
    size: 'm',
    // Грязная форма (требование b58f6aad): Esc/крестик при заполненной форме
    // требуют подтверждения; «Сохранить» идёт тем же путём, что «Создать».
    dirty: {
      isDirty: () =>
        titleInput.value.trim() !== '' ||
        commentInput.value.trim() !== '' ||
        branchInput.value.trim() !== '',
      save: (close) => void create(close),
    },
    buttons: [
      { label: t('actions.cancel'), onClick: (close) => close() },
      { label: 'Создать', primary: true, onClick: (close) => void create(close) },
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
    size: 's',
    buttons: [
      { label: t('actions.cancel'), onClick: (close) => close() },
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
    size: 's',
    buttons: [
      { label: t('actions.cancel'), onClick: (close) => close() },
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
    size: 's',
    buttons: [{ label: t('actions.close'), onClick: (close) => close() }],
  });
}

/**
 * The diff dialog (задача 52c776f1): one lazily paged list of the structural
 * differences between the layer and its target. The list never pulls the whole
 * (heavy) report nor `diff/doc`: it walks `layers.diffPage` by `next_cursor`
 * as the user scrolls, with a loader while a page is in flight. Clicking an
 * overridden thought opens the separate per-thought text diff dialog (the old
 * «Содержание» tab showed the line diff of EVERY difference at once — that is
 * gone, and with it the `diff/doc` request that froze the client on big nets).
 */
export async function openDiffDialog(networkId: string, layerId: string): Promise<void> {
  const layer = store.state.layers.find((l) => l.id === layerId);
  const targetTitle =
    store.state.layers.find((l) => l.id === layer?.parent_id)?.title ?? 'Основа';

  // Слот состояний (загрузка/пусто/ошибка) и отдельный keyed-контейнер списка:
  // дозагрузка обязана обновлять только новые строки, не трогая существующие
  // (стандарт «Списки рендерятся инкрементально», `reconcileKeyed`).
  const stateHost = div('diff-state');
  const listHost = div('diff-list');
  const body = div('diff-body');
  body.append(stateHost, listHost);

  let rows: DiffRow[] = [];
  let counts: LayerDiffCounts | null = null;
  let cursor: string | null = null;
  let done = false;
  let loading = false;
  let scrollEl: HTMLElement | null = null;
  let scrollHandler: (() => void) | null = null;

  const setState = (node: HTMLElement | null): void => {
    // Одиночный слот состояния, не коллекция списка (белый список сторожа).
    stateHost.replaceChildren();
    if (node !== null) stateHost.append(node);
  };

  const openThought = (row: DiffRow): void => {
    if (row.thoughtId !== null) {
      openThoughtDiffDialog(networkId, layerId, row.thoughtId, row.text);
    }
  };

  const renderRows = (): void => {
    reconcileKeyed(listHost, buildDiffRenderItems(rows, counts), {
      key: (item) => item.key,
      // Строки дописываются и не меняются — `update` не нужен.
      build: (item) =>
        item.kind === 'header' ? diffHeaderNode(item) : diffRowNode(item.row, openThought),
      update: () => undefined,
    });
  };

  const maybeFill = (): void => {
    if (scrollEl === null) return;
    // Не измеренный контейнер (скрытое окно, момент до раскладки) не считаем
    // «незаполненным»: иначе автодогрузка вытянула бы все страницы вслепую.
    if (scrollEl.clientHeight === 0) return;
    if (scrollEl.scrollHeight <= scrollEl.clientHeight + 24 && !done && !loading) {
      void loadNext();
    }
  };

  async function loadNext(): Promise<void> {
    if (loading || done) return;
    loading = true;
    const first = rows.length === 0;
    if (first) setState(loadingState('Загрузка списка отличий…'));
    try {
      const page = await etn.layers.diffPage(networkId, layerId, {
        limit: DIFF_PAGE_LIMIT,
        cursor,
      });
      counts = page.counts;
      cursor = page.next_cursor;
      done = !page.truncated;
      rows = rows.concat(await pageToRows(networkId, page));
      if (rows.length === 0 && done) {
        setState(
          emptyState({
            title: 'Отличий нет',
            hint: 'Слой не меняет основу — сравнивать нечего.',
          }),
        );
      } else {
        setState(null);
      }
      renderRows();
    } catch (err) {
      setState(
        errorState(
          rows.length === 0
            ? `Не удалось загрузить отличия: ${String(err)}`
            : `Не удалось догрузить отличия: ${String(err)}`,
          { label: 'Повторить', onClick: () => void loadNext() },
        ),
      );
    } finally {
      loading = false;
    }
    maybeFill();
  }

  showDialog({
    title: `Отличия «${layer?.title ?? 'слоя'}» от «${targetTitle}»`,
    // Роль `l` + фиксированная высота (требование 13464c39): список растёт
    // дозагрузкой, окно при этом не «дёргается», прокрутка — в теле диалога.
    size: 'l',
    fixedHeight: true,
    body,
    buttons: [{ label: t('actions.close'), onClick: (close) => close() }],
    onMount: (_close, box) => {
      const el = box.querySelector<HTMLElement>('.dialog-body');
      scrollEl = el;
      if (el !== null) {
        scrollHandler = () => {
          if (el.scrollTop + el.clientHeight >= el.scrollHeight - 48) void loadNext();
        };
        el.addEventListener('scroll', scrollHandler);
      }
      void loadNext();
    },
    onClose: () => {
      if (scrollEl !== null && scrollHandler !== null) {
        scrollEl.removeEventListener('scroll', scrollHandler);
      }
    },
  });
}

/** Page size (items) of one `layers.diffPage` request. */
const DIFF_PAGE_LIMIT = 100;

/** Human-readable heading of every diff section (the canonical server order
 *  is preserved; headings appear in the order the stream delivers them). */
const DIFF_SECTION_LABELS: Record<LayerDiffSection, string> = {
  'links.added': 'Добавленные связи',
  'links.removed': 'Удалённые связи',
  'links.type_changed': 'Изменённый тип связи',
  'links.reorder_collapsed': 'Изменённый порядок связей',
  'links.reparented': 'Сменённый родитель',
  'overridden.thought_ids': 'Изменённые мысли',
  'overridden.link_ids': 'Изменённые связи',
};

/** One rendered difference: a link change or an overridden entity. */
interface DiffRow {
  /** `<section>:<item id>` — stable across pages (keyed reconcile). */
  key: string;
  section: LayerDiffSection;
  /** Thought to open the text diff for; `null` — non-clickable row. */
  thoughtId: string | null;
  text: string;
}

/** One entry of the keyed list: a section heading or a difference row. */
type DiffRenderItem =
  | { kind: 'header'; key: string; label: string; count: number }
  | { kind: 'row'; key: string; row: DiffRow };

/** Section heading node — label + the total count for that section. */
function diffHeaderNode(header: { label: string; count: number }): HTMLElement {
  const node = div('diff-group-title');
  node.textContent = `${header.label} · ${header.count}`;
  return node;
}

/** Row node; overridden thoughts become keyboard/click-activated buttons that
 *  open the per-thought text diff dialog. */
function diffRowNode(row: DiffRow, onOpen: (row: DiffRow) => void): HTMLElement {
  const node = div('diff-group-line diff-row');
  node.textContent = row.text;
  if (row.thoughtId !== null) {
    node.classList.add('diff-row-thought');
    node.setAttribute('role', 'button');
    node.tabIndex = 0;
    node.title = 'Показать построчный дифф';
    node.addEventListener('click', () => onOpen(row));
    node.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onOpen(row);
      }
    });
  }
  return node;
}

/** Interleave section headings with rows in the canonical section order, keyed
 *  so `reconcileKeyed` appends only what a new page brought. Grouping by the
 *  section (not by arrival) keeps the list grouped even when a page boundary
 *  splits a section and survives out-of-order appends. */
function buildDiffRenderItems(
  rows: readonly DiffRow[],
  counts: LayerDiffCounts | null,
): DiffRenderItem[] {
  const bySection = new Map<LayerDiffSection, DiffRow[]>();
  for (const row of rows) {
    const list = bySection.get(row.section) ?? [];
    list.push(row);
    bySection.set(row.section, list);
  }
  const items: DiffRenderItem[] = [];
  for (const section of LAYER_DIFF_SECTIONS) {
    const list = bySection.get(section);
    if (list === undefined || list.length === 0) continue;
    items.push({
      kind: 'header',
      key: `hdr:${section}`,
      label: DIFF_SECTION_LABELS[section],
      count: counts?.[section] ?? 0,
    });
    for (const row of list) items.push({ kind: 'row', key: row.key, row });
  }
  return items;
}

/** Convert one page into rows, batch-resolving the titles of the referenced
 *  thoughts (a title that cannot be resolved degrades to a short id — the same
 *  fallback the old structural view used). */
async function pageToRows(networkId: string, page: LayerDiffPage): Promise<DiffRow[]> {
  const ids = new Set<string>();
  for (const r of page.links.added ?? []) {
    ids.add(r.source_id);
    ids.add(r.target_id);
  }
  for (const r of page.links.removed ?? []) {
    ids.add(r.source_id);
    ids.add(r.target_id);
  }
  for (const r of page.links.reparented ?? []) {
    ids.add(r.thought_id);
    ids.add(r.from_parent_id);
    ids.add(r.to_parent_id);
  }
  for (const r of page.links.reorder_collapsed ?? []) ids.add(r.thought_id);
  for (const id of page.overridden.thought_ids ?? []) ids.add(id);

  const titles = new Map<string, string>();
  if (ids.size > 0) {
    try {
      const refs = await etn.thoughts.resolve(networkId, [...ids]);
      for (const ref of refs) titles.set(ref.id, ref.title);
    } catch {
      // Заголовки деградируют к id — сам список отличий всё равно показан.
    }
  }
  const name = (id: string): string => titles.get(id) ?? id.slice(0, 8);

  const rows: DiffRow[] = [];
  const push = (
    section: LayerDiffSection,
    key: string,
    thoughtId: string | null,
    text: string,
  ): void => {
    rows.push({ key: `${section}:${key}`, section, thoughtId, text });
  };

  for (const r of page.links.added ?? []) {
    push('links.added', r.id, null, `+ ${name(r.source_id)} → ${name(r.target_id)}`);
  }
  for (const r of page.links.removed ?? []) {
    push('links.removed', r.id, null, `− ${name(r.source_id)} → ${name(r.target_id)}`);
  }
  for (const r of page.links.type_changed ?? []) {
    push('links.type_changed', r.id, null, `≈ связь ${r.id.slice(0, 8)}`);
  }
  for (const r of page.links.reparented ?? []) {
    push(
      'links.reparented',
      r.thought_id,
      null,
      `↳ ${name(r.thought_id)}: ${name(r.from_parent_id)} → ${name(r.to_parent_id)}`,
    );
  }
  for (const r of page.links.reorder_collapsed ?? []) {
    push('links.reorder_collapsed', r.thought_id, null, `⇅ ${name(r.thought_id)} · ${r.count}`);
  }
  for (const id of page.overridden.thought_ids ?? []) {
    push('overridden.thought_ids', id, id, name(id));
  }
  for (const id of page.overridden.link_ids ?? []) {
    push('overridden.link_ids', id, null, `связь ${id.slice(0, 8)}`);
  }
  return rows;
}

/**
 * Separate dialog with the line diff of ONE thought (задача 52c776f1): the
 * server hands the field pairs of both contexts (`layers.thoughtDiff`), the
 * client renders a `lineDiff` per changed attribute. Opened from a click on an
 * overridden thought in the diff list.
 */
function openThoughtDiffDialog(
  networkId: string,
  layerId: string,
  thoughtId: string,
  title: string,
): void {
  const host = div('diff-thought');
  host.append(loadingState('Загрузка текстового диффа…'));

  const load = async (): Promise<void> => {
    host.replaceChildren(loadingState('Загрузка текстового диффа…'));
    try {
      const diff = await etn.layers.thoughtDiff(networkId, layerId, thoughtId);
      host.replaceChildren(renderThoughtDiff(diff));
    } catch (err) {
      host.replaceChildren(
        errorState(`Не удалось загрузить текстовый дифф: ${String(err)}`, {
          label: 'Повторить',
          onClick: () => void load(),
        }),
      );
    }
  };

  showDialog({
    title: `Правки мысли «${title}»`,
    size: 'l',
    fixedHeight: true,
    body: host,
    buttons: [{ label: t('actions.close'), onClick: (close) => close() }],
    onMount: () => {
      void load();
    },
  });
}

/** Field label of the per-thought diff, by server field key. */
const THOUGHT_DIFF_FIELD_LABELS: Record<LayerThoughtDiffFieldKey, string> = {
  title: 'Название',
  type: 'Тип',
  synonyms: 'Синонимы',
  active: 'Актуальность',
  comment: 'Постоянный комментарий',
};

/** Render the per-thought diff: one labelled block per changed attribute with
 *  the line diff of its two values; a note when nothing changed. */
function renderThoughtDiff(diff: LayerThoughtDiff): HTMLElement {
  const host = div('diff-text');
  const changed = diff.fields.filter((f) => f.changed);
  if (changed.length === 0) {
    host.append(
      emptyState({ title: 'Отличий нет', hint: 'Мысль в слое совпадает с основой.' }),
    );
    return host;
  }
  for (const field of changed) {
    const label = div('diff-group-title');
    label.textContent = THOUGHT_DIFF_FIELD_LABELS[field.key];
    host.append(label);
    for (const entry of lineDiff(field.target, field.layer)) {
      const line = div(`diff-line diff-${entry.kind}`);
      line.textContent = entry.text === '' ? ' ' : entry.text;
      host.append(line);
    }
  }
  return host;
}

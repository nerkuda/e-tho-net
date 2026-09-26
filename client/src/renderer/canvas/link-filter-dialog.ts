/**
 * Диалог фильтра типов связей на карте (задача «Фильтр типов связей на карте
 * мыслей», 0.8.1, элемент интерфейса «Диалог фильтра типов связей на карте»).
 *
 * Открывается кнопкой-воронкой в полосе отборов (`focus-filter-strip.ts`),
 * справа от «+». Позволяет пользователю ограничить типы связей, видимые на
 * холсте: и состав зон (родители/дети/родственники), и сами рёбра — сервер
 * применяет тот же `link_filter`, что и обход графа (`etn.thoughts.focus`),
 * резолвя его из сохранённого предпочтения пользователя (`PREF_KEY.
 * CANVAS_LINK_FILTER`) или из живого дефолта по `show_on_map`, когда
 * предпочтение не задано (см. `resolveCanvasLinkFilter` на сервере).
 *
 * Чек-лист рисует общий пикер сущностей (`lib/entity-picker.ts`, ADR «выбор
 * сущности — один пикер», задача a1f5141b): строки типов связей — облачками
 * фабрики, команды «Пометить все» / «Вернуть умолчания» — иконками в ОДНОЙ
 * строке с поиском (тултип = полное название); «Очистить» (ластик) пикер
 * добавляет сам. В футере — только «Отмена» и «Применить и закрыть»: ряд
 * текстовых кнопок-команд вылезал за границы диалога (ошибка bd8b78a0).
 *
 * Строка «Структура (Родители/Потомки)» — синтетическая: у структурных
 * связей нет типа в реестре, их присутствие в фильтре кодируется отдельным
 * флагом `include_structural`. По умолчанию отмечена.
 */

import type { LinkTypeFilterInput, NetworkProperty } from '@etn/shared';
import { t } from '../lib/i18n.js';
import { PREF_KEY, computeDefaultCanvasLinkFilter, parseStoredCanvasLinkFilter } from '@etn/shared';

import { refreshFocus } from '../app.js';
import {
  pickEntitiesModal,
  type EntityOption,
  type EntityPickerCommand,
  type EntityPickerDialogCtx,
} from '../lib/entity-picker.js';
import { etn } from '../lib/etn.js';
import { notice } from '../lib/notice.js';
import { store } from '../state.js';

/** Synthetic row id for the structural («Родители»/«Потомки») checkbox —
 *  never a real link-type id, so it can share the same `checked` set. */
const STRUCTURAL_ROW_ID = '__structural__';
const STRUCTURAL_LABEL = 'Структура (Родители/Потомки)';

/** Синтетический вариант пикера — строка «Структура». */
const STRUCTURAL_OPTION: EntityOption = {
  id: STRUCTURAL_ROW_ID,
  title: STRUCTURAL_LABEL,
  depth: 0,
  selectable: true,
  cloud: { id: STRUCTURAL_ROW_ID, title: STRUCTURAL_LABEL, icon: '🔗', icon_kind: 'emoji' },
};

/** Opens the dialog. Fetches the current preference + property registry
 *  fresh on every open — infrequent action, no need to cache. */
export function openCanvasLinkFilterDialog(networkId: string): void {
  void loadAndOpen(networkId);
}

async function loadAndOpen(networkId: string): Promise<void> {
  let properties: NetworkProperty[];
  let storedRaw: unknown;
  try {
    const [propsResp, prefs] = await Promise.all([
      etn.propertyRegistry.list(networkId),
      etn.networks.getPreferences(networkId),
    ]);
    properties = propsResp;
    storedRaw = prefs.find((p) => p.key === PREF_KEY.CANVAS_LINK_FILTER)?.value;
  } catch (err) {
    notice(formatError(err, 'Не удалось загрузить фильтр типов связей.'), 'error');
    return;
  }
  const defaultFilter = computeDefaultCanvasLinkFilter(properties);
  const stored = parseStoredCanvasLinkFilter(storedRaw);
  const initial = stored ?? defaultFilter;

  const checked = new Set<string>(initial.type_ids ?? []);
  if (initial.include_structural === true) checked.add(STRUCTURAL_ROW_ID);

  const picked = await pickEntitiesModal({
    networkId,
    kind: 'link-types',
    title: 'Фильтр типов связей на карте',
    currentIds: [...checked],
    allowEmpty: false,
    applyLabel: t('actions.applyClose'),
    extraOptions: [STRUCTURAL_OPTION],
    commands: linkFilterCommands(defaultFilter),
  });
  if (picked === null) return;
  await applyFilter(networkId, new Set(picked));
}

/**
 * Команды верхней строки диалога — иконками с тултипами (ошибка bd8b78a0):
 * «Пометить все» и «Вернуть умолчания». «Очистить» (ластик) пикер добавляет
 * сам и делает ровно то, что делала прежняя текстовая «Снять все пометки», —
 * держать две одинаковые кнопки незачем. Экспортируется для юнит-теста
 * состава иконок.
 */
export function linkFilterCommands(
  defaultFilter: LinkTypeFilterInput,
): (ctx: EntityPickerDialogCtx) => EntityPickerCommand[] {
  return (ctx) => [
    {
      icon: 'check-check',
      title: 'Пометить все',
      onClick: () => {
        const all = [
          ...store.state.linkTypes.filter((t) => !t.is_root).map((t) => t.id),
          STRUCTURAL_ROW_ID,
        ];
        for (const id of all) ctx.checked.add(id);
        ctx.rerender();
      },
    },
    {
      icon: 'rotate-ccw',
      title: 'Вернуть умолчания',
      onClick: () => {
        ctx.checked.clear();
        for (const id of defaultFilter.type_ids ?? []) ctx.checked.add(id);
        if (defaultFilter.include_structural === true) ctx.checked.add(STRUCTURAL_ROW_ID);
        ctx.rerender();
      },
    },
  ];
}

async function applyFilter(networkId: string, checked: ReadonlySet<string>): Promise<void> {
  // Guard is also enforced by the picker's disabled «Применить» button, but
  // a defensive check here keeps the invariant even if the flow is driven
  // programmatically — an empty `{ type_ids: [], include_structural: false }`
  // is rejected by the server as an invalid `link_filter` (see requirement
  // «Дефолт и хранение фильтра типов связей на карте»).
  if (checked.size === 0) {
    notice('Оставьте хотя бы один тип связи.', 'error');
    return;
  }
  const includeStructural = checked.has(STRUCTURAL_ROW_ID);
  const typeIds = [...checked].filter((id) => id !== STRUCTURAL_ROW_ID);
  const value: LinkTypeFilterInput = { include_structural: includeStructural };
  if (typeIds.length > 0) value.type_ids = typeIds;
  try {
    await etn.networks.setPreference(networkId, PREF_KEY.CANVAS_LINK_FILTER, value);
    store.update({ canvasLinkFilter: value });
    await refreshFocus();
  } catch (err) {
    notice(formatError(err, 'Не удалось сохранить фильтр типов связей.'), 'error');
  }
}

function formatError(err: unknown, fallback: string): string {
  if (err !== null && typeof err === 'object' && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.length > 0) return `${fallback} ${msg}`;
  }
  return fallback;
}

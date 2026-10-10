/**
 * Общий каркас панели отбора: скрываемость, положение по ширине полотна и
 * изменение размера перетаскиванием границы (задача 2ebe4206, версия 0.8.2).
 *
 * До этой задачи каждый экран («Структуры мыслей», «Хроника», «События») сам
 * располагал панель отбора и сам менял её размер — тремя разными способами:
 * «Структуры» и «События» имели сплиттер ширины, «Хроника» — сплиттер высоты
 * через общий `rowSplitter`; скрывать панель не умел никто. Каркас сводит это
 * к одному поведению для всех трёх экранов:
 *
 *   - **скрываемость** — плавающая кнопка в левом верхнем углу полотна;
 *     нажата (панель видна) / отжата (скрыта), иконка показывает действие
 *     («скрыть» / «показать»), состояние отражено в `aria-pressed`;
 *   - **положение** — по ширине ПОЛОТНА вида (окно минус панель редактора):
 *     меньше {@link FILTER_PANEL_SIDE_MIN_WIDTH} — панель сверху, иначе слева;
 *     пересчитывается `ResizeObserver`-ом на каждом ресайзе, без перезапуска;
 *   - **размер** — перетаскивание границы: в боковом положении меняется ширина,
 *     в верхнем — высота; значение зажимается диапазоном экрана и полотном;
 *   - **сохранение** — скрытость и размер (отдельно ширина и высота) живут в
 *     локальном L4 `ui_state` под ключом экрана и переживают перезапуск клиента.
 *
 * Экраны строят панель, разделитель и результаты как раньше и передают их
 * каркасу; `mountFilterPanelFrame` добавляет классы положения и поведения и
 * возвращает рукоятку для применения состояния. Своих критериев отбора каркас
 * не знает — он про геометрию панели.
 */

import { store } from '../state.js';
import { el, setTooltip } from './dom.js';
import { etn } from './etn.js';
import { t } from './i18n.js';
import { svgIcon } from './ui/icon.js';
import {
  DEFAULT_FILTER_PANEL_STATE,
  type FilterPanelPlacement,
  type FilterPanelState,
  clampFilterPanelSize,
  filterPanelPlacement,
  parseFilterPanelState,
  serializeFilterPanelState,
} from './pure.js';
import { wireSplitter } from './ui/splitter.js';

/** Параметры каркаса панели отбора одного экрана. */
export interface FilterPanelFrameOptions {
  /** Полотно вида: контейнер с панелью, разделителем и результатами. */
  container: HTMLElement;
  /** Панель отбора. */
  panel: HTMLElement;
  /** Грип-разделитель между панелью и результатами. */
  splitter: HTMLElement;
  /** Ключ L4 `ui_state` состояния панели (UI_STATE_KEY.*_FILTER_PANEL). */
  stateKey: string;
  /** Границы ширины панели (боковое положение), px. */
  minSize: number;
  maxSize: number;
  /** Границы высоты панели (верхнее положение), px (по умолчанию — как ширина). */
  minSizeTop?: number;
  maxSizeTop?: number;
  /**
   * Ширина из прежнего пер-экранного L4-снимка (`structures_state.panelWidth`,
   * `activity_state.panelWidth`) — миграция: используется, пока в `ui_state`
   * своего размера нет. Геттер, а не значение: экран восстанавливает снимок
   * позже монтирования каркаса. После первого перетаскивания значение живёт
   * только в `ui_state`.
   */
  legacySize?: () => number | null;
  /** Минимум места, которое остаётся результатам, px (по умолчанию 160). */
  resultsMinSize?: number;
}

/** Рукоятка каркаса панели отбора. */
export interface FilterPanelFrameHandle {
  /** Применяет состояние к DOM (после пересборки содержимого панели). */
  apply(): void;
  /** Показывает/скрывает панель (сохраняет состояние локально). */
  setHidden(hidden: boolean): void;
  /** Текущее положение панели. */
  placement(): FilterPanelPlacement;
}

/** Классы, которыми каркас помечает узлы экрана (и общий CSS). */
const HOST_CLASS = 'fp-host';
const PANEL_CLASS = 'fp-panel';
const SPLITTER_CLASS = 'fp-splitter';
const TOGGLE_CLASS = 'fp-toggle';

/**
 * Монтирует каркас панели отбора: добавляет плавающую кнопку скрытия, классы
 * положения и обработчики перетаскивания границы. Состояние читается из L4 при
 * монтировании и сохраняется при каждом изменении.
 */
export function mountFilterPanelFrame(opts: FilterPanelFrameOptions): FilterPanelFrameHandle {
  const { container, panel, splitter, stateKey } = opts;
  const resultsMinSize = opts.resultsMinSize ?? 160;
  let state: FilterPanelState = { ...DEFAULT_FILTER_PANEL_STATE };

  container.classList.add(HOST_CLASS);
  panel.classList.add(PANEL_CLASS);
  splitter.classList.add(SPLITTER_CLASS);

  // Плавающая кнопка «скрыть/показать» — левый верхний угол полотна.
  const toggle = el('button', TOGGLE_CLASS) as HTMLButtonElement;
  toggle.type = 'button';
  const iconBox = el('span', 'fp-toggle-icon');
  toggle.append(iconBox);
  container.prepend(toggle);

  const currentPlacement = (): FilterPanelPlacement =>
    filterPanelPlacement(container.clientWidth);

  const limitsOf = (placement: FilterPanelPlacement): { min: number; max: number } => {
    const min = placement === 'top' ? (opts.minSizeTop ?? opts.minSize) : opts.minSize;
    const max = placement === 'top' ? (opts.maxSizeTop ?? opts.maxSize) : opts.maxSize;
    // Размер панели не съедает результаты: верхняя граница упирается в полотно.
    const room =
      (placement === 'top' ? container.clientHeight : container.clientWidth) - resultsMinSize;
    return { min, max: Math.max(min, Math.min(max, room)) };
  };

  /** Размер панели для положения: своё значение, иначе миграционное, иначе CSS. */
  const sizeFor = (placement: FilterPanelPlacement): number | null => {
    if (placement === 'top') return state.height;
    return state.width ?? opts.legacySize?.() ?? null;
  };

  const persist = (): void => {
    const networkId = store.state.networkId;
    if (networkId === null) return;
    void etn.ui.setState(networkId, stateKey, serializeFilterPanelState(state)).catch(() => undefined);
  };

  const renderToggle = (placement: FilterPanelPlacement): void => {
    const visible = !state.hidden;
    toggle.setAttribute('aria-pressed', visible ? 'true' : 'false');
    toggle.classList.toggle('pressed', visible);
    iconBox.replaceChildren(svgIcon(visible ? 'x' : 'filter'));
    setTooltip(
      toggle,
      visible ? 'Скрыть панель отбора' : 'Показать панель отбора',
    );
    toggle.setAttribute('aria-label', visible ? 'Скрыть панель отбора' : 'Показать панель отбора');
    toggle.dataset['placement'] = placement;
  };

  const apply = (): void => {
    const placement = currentPlacement();
    container.classList.toggle('fp-side', !state.hidden && placement === 'side');
    container.classList.toggle('fp-top', !state.hidden && placement === 'top');
    container.classList.toggle('fp-hidden', state.hidden);
    panel.classList.toggle('fp-side', !state.hidden && placement === 'side');
    panel.classList.toggle('fp-top', !state.hidden && placement === 'top');
    splitter.classList.toggle('fp-side', !state.hidden && placement === 'side');
    splitter.classList.toggle('fp-top', !state.hidden && placement === 'top');
    splitter.hidden = state.hidden;
    // Доступное имя и подсказка — по оси панели (положение меняется на ходу):
    // разделитель фокусируем и управляется стрелками (lib/ui/splitter).
    splitter.title = t('splitter.resizeHint');
    splitter.setAttribute(
      'aria-label',
      placement === 'top'
        ? t('splitter.resizeAriaVertical')
        : t('splitter.resizeAriaHorizontal'),
    );

    const size = sizeFor(placement);
    if (size === null) {
      panel.style.removeProperty('flex-basis');
    } else {
      const { min, max } = limitsOf(placement);
      panel.style.flexBasis = `${clampFilterPanelSize(size, min, max)}px`;
    }
    renderToggle(placement);
  };

  toggle.addEventListener('click', () => {
    state = { ...state, hidden: !state.hidden };
    apply();
    persist();
  });

  // Перетаскивание границы ведёт общий компонент `lib/ui/splitter`
  // (задача 50f57b82): каркас задаёт только политику — ось по положению
  // панели (боковое меняет ширину, верхнее — высоту), диапазон экрана и
  // сохранение измеренного размера в своё поле состояния.
  let placementAtStart: FilterPanelPlacement = 'side';
  wireSplitter(splitter, {
    plan: () => {
      if (state.hidden) return null;
      placementAtStart = currentPlacement();
      const rect = panel.getBoundingClientRect();
      const { min, max } = limitsOf(placementAtStart);
      return {
        axis: placementAtStart === 'top' ? 'y' : 'x',
        start: placementAtStart === 'top' ? rect.height : rect.width,
        min,
        max,
      };
    },
    apply: (value) => {
      panel.style.flexBasis = `${value}px`;
    },
    commit: () => {
      const measured =
        placementAtStart === 'top' ? panel.getBoundingClientRect().height : panel.getBoundingClientRect().width;
      const { min, max } = limitsOf(placementAtStart);
      const size = clampFilterPanelSize(measured, min, max);
      state =
        placementAtStart === 'top' ? { ...state, height: size } : { ...state, width: size };
      apply();
      persist();
    },
  });

  // Положение зависит от ширины полотна: пересчитываем на каждом ресайзе
  // (окна, панели редактора, полосы выделения) — без перезапуска.
  const observer = new ResizeObserver(() => apply());
  observer.observe(container);

  const reload = async (): Promise<void> => {
    const networkId = store.state.networkId;
    if (networkId === null) {
      apply();
      return;
    }
    const raw = await etn.ui.getState(networkId, stateKey).catch(() => null);
    state = parseFilterPanelState(raw);
    apply();
  };

  apply();
  void reload();

  return {
    apply,
    placement: currentPlacement,
    setHidden: (hidden: boolean) => {
      state = { ...state, hidden };
      apply();
      persist();
    },
  };
}

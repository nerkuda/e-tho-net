/**
 * Универсальный диалог выбора ресурса (задача d1a56d76).
 *
 * Единственный каркас всех диалогов выбора ресурса клиента — иконки мысли/типа,
 * обложки публикации, будущих картинок в полях. Вместо семейства похожих
 * диалогов: общий КАРКАС (вкладки-источники + нижние кнопки) и набор готовых
 * ИСТОЧНИКОВ ресурса (эмодзи, значки библиотеки, иконки мыслей, URL). Вкладка
 * «Вложения» — отдельный общий компонент `editor/attachment-picker.ts`
 * (`attachmentPickerSourceTab`, задача 0f6c3e39). Новый тип
 * ресурса — новая вкладка-источник ({@link ResourceSourceTab}) без правки
 * каркаса; так закрыто требование «точки расширения».
 *
 * Каркас владеет ЕДИНЫМИ поведениями выбора: вкладки строятся лениво и не
 * пересобираются (состояние источника переживает переключение), активная вкладка
 * управляет доступностью нижней «Применить», «Применить» применяет выбор
 * активного источника, «Отмена»/Esc/крестик закрывают без изменений, а
 * опциональная кнопка «без ресурса» очищает выбор. Немедленные источники
 * (эмодзи, иконка типа) применяют выбор сами по клику — у них нет `apply`, и
 * нижняя «Применить» на такой вкладке недоступна.
 *
 * Где живёт: `editor/`, а не `lib/ui` — источники обращаются к домену
 * (`store`, эмодзи-набор), а `lib/ui` — слой фасадов без
 * знаний о домене. Из `lib/ui` каркас берёт только фасады (диалог, кнопки,
 * вкладки, поля, свёртки), как и требует дизайн-система.
 */

import type { IconKind, ThoughtType } from '@etn/shared';
import { button, div, el, span } from '../lib/dom.js';
import { showDialog, type DialogSize } from '../lib/dialog.js';
import { EMOJI_GROUPS } from '../lib/emoji-data.js';
import { t } from '../lib/i18n.js';
import { collapsibleSection } from '../lib/ui/collapsible.js';
import { colorField } from '../lib/ui/color-field.js';
import { checkboxRow } from '../lib/ui/choice-row.js';
import { fieldInput } from '../lib/ui/field.js';
import {
  loadIconCatalog,
  renderLibraryIcon,
  searchIconCatalog,
  type IconCatalog,
} from '../lib/ui/icon.js';
import { reconcileKeyed } from '../lib/ui/keyed-list.js';

/** Оригинал файла-картинки, выбранного системным диалогом (несётся вызывающему). */
export interface ResourceFileSource {
  dataUrl: string;
  mime: string;
  name: string;
}

/**
 * Контекст источника внутри каркаса. Отдаётся и в `build`, и в `apply` одного
 * источника (один объект на источник).
 */
export interface ResourceSourceContext {
  /** Закрыть диалог (немедленные источники зовут после успешного выбора). */
  close: () => void;
  /**
   * Признак «на активной вкладке есть корректный выбор» — включает нижнюю
   * «Применить». Вызов на неактивной вкладке запоминается и учтётся при её
   * активации.
   */
  setReady: (ready: boolean) => void;
}

/** Один источник ресурса — вкладка диалога. */
export interface ResourceSourceTab {
  /** Устойчивый идентификатор вкладки (внутри диалога). */
  id: string;
  label: string;
  /** Строит содержимое панели (лениво, один раз — состояние переживает смену вкладок). */
  build: (ctx: ResourceSourceContext) => HTMLElement;
  /**
   * Применить выбор активной вкладки (нижняя «Применить»). Нет — источник
   * немедленный (применяет выбор сам по клику), и «Применить» на нём недоступна.
   */
  apply?: (ctx: ResourceSourceContext) => void | Promise<void>;
}

/** Параметры {@link createResourcePicker}. */
export interface ResourcePickerConfig {
  title: string;
  size?: DialogSize;
  /** Источники ресурса; порядок = порядок вкладок. Хотя бы один. */
  tabs: ResourceSourceTab[];
  /** Активная вкладка при открытии; по умолчанию — первая. */
  activeTab?: string;
  /** Подпись нижней «Применить». */
  applyLabel: string;
  /** Подпись кнопки «без ресурса»; не задана — кнопки нет. */
  noneLabel?: string;
  /** «Без ресурса» — опасное действие (красная кнопка), по умолчанию `false`. */
  noneDanger?: boolean;
  /**
   * Куда поставить «без ресурса»: `leading` — перед «Отменой» (диалог иконки),
   * `trailing` (по умолчанию) — между «Отменой» и «Применить» (диалог обложки).
   */
  nonePlacement?: 'leading' | 'trailing';
  /** Обработчик «без ресурса»; получает `close` каркаса. */
  onNone?: (close: () => void) => void;
  /** Строка ошибки в панели кнопок (видна на всех вкладках). */
  footerError?: HTMLElement;
  /** Признак несохранённых изменений (закрытие с подтверждением). */
  dirty?: { isDirty: () => boolean; save: (close: () => void) => void };
}

/**
 * Открывает универсальный диалог выбора ресурса. Возвращает `close` каркаса.
 * Выбор/применение источника выполняет сам источник (`apply`/немедленный
 * клик) — каркас лишь сводит вкладки, доступность «Применить» и общие кнопки.
 */
export function createResourcePicker(config: ResourcePickerConfig): () => void {
  const tabs = config.tabs;
  const initialId =
    config.activeTab !== undefined && tabs.some((tab) => tab.id === config.activeTab)
      ? config.activeTab
      : (tabs[0]?.id ?? '');
  let activeTabId = initialId;
  const readyByTab = new Map<string, boolean>();
  let applyBtn: HTMLButtonElement | null = null;
  let closeSelf: (() => void) | null = null;

  /** Пересчитывает доступность «Применить» по активной вкладке. */
  const refreshApply = (): void => {
    if (applyBtn === null) return;
    const tab = tabs.find((entry) => entry.id === activeTabId);
    const canApply = tab?.apply !== undefined;
    applyBtn.disabled = !(canApply && (readyByTab.get(activeTabId) ?? false));
  };

  /** Один контекст на источник — общий для `build` и `apply`. */
  const ctxByTab = new Map<string, ResourceSourceContext>();
  const contextFor = (id: string): ResourceSourceContext => {
    const existing = ctxByTab.get(id);
    if (existing !== undefined) return existing;
    const ctx: ResourceSourceContext = {
      close: () => closeSelf?.(),
      setReady: (ready) => {
        readyByTab.set(id, ready);
        if (id === activeTabId) refreshApply();
      },
    };
    ctxByTab.set(id, ctx);
    return ctx;
  };

  const cancelButton = { label: t('actions.cancel') };
  const noneButton =
    config.noneLabel === undefined
      ? null
      : {
          label: config.noneLabel,
          danger: config.noneDanger === true,
          keepOpen: true,
          onClick: (close: () => void) => config.onNone?.(close),
        };
  const applyButton = {
    label: config.applyLabel,
    primary: true,
    keepOpen: true,
    ref: (node: HTMLButtonElement) => {
      applyBtn = node;
    },
    onClick: () => {
      const tab = tabs.find((entry) => entry.id === activeTabId);
      if (tab?.apply === undefined) return;
      void Promise.resolve(tab.apply(contextFor(tab.id)));
    },
  };
  const buttons = [
    ...(noneButton !== null && config.nonePlacement === 'leading' ? [noneButton] : []),
    cancelButton,
    ...(noneButton !== null && config.nonePlacement !== 'leading' ? [noneButton] : []),
    applyButton,
  ];

  closeSelf = showDialog({
    title: config.title,
    size: config.size ?? 'm',
    activeTab: activeTabId,
    onTabChange: (id) => {
      activeTabId = id;
      refreshApply();
    },
    tabs: tabs.map((tab) => ({
      id: tab.id,
      label: tab.label,
      content: () => tab.build(contextFor(tab.id)),
    })),
    ...(config.footerError !== undefined ? { footerError: config.footerError } : {}),
    ...(config.dirty !== undefined ? { dirty: config.dirty } : {}),
    buttons,
  });
  refreshApply();
  return closeSelf;
}

// ---------------------------------------------------------------------------
// Готовые источники
// ---------------------------------------------------------------------------

/**
 * Прокручивает выделенную ячейку в вид. Панель строится ДО её вставки в DOM,
 * поэтому прокрутку откладываем микрозадачей: к её исполнению диалог уже
 * собран и узел в документе (иначе `scrollIntoView` — no-op).
 */
function revealCurrent(cell: HTMLElement | null): void {
  if (cell === null || typeof cell.scrollIntoView !== 'function') return;
  queueMicrotask(() => cell.scrollIntoView({ block: 'nearest' }));
}

/**
 * Источник «Эмодзи» — полный набор Unicode 16.0, категории CLDR, группы
 * сворачиваемые (контент строится при раскрытии). Немедленный: клик по глифу
 * применяет выбор; `onPick` сам решает, закрывать ли диалог.
 *
 * `opts.initial` — уже выбранный глиф (ошибка e2407f6d): его категория
 * раскрывается при открытии, а ячейка помечается классом `emoji-cell-current`
 * и прокручивается в вид, чтобы текущий выбор был виден без поиска.
 */
export function emojiSourceTab(
  onPick: (glyph: string, ctx: ResourceSourceContext) => void | Promise<void>,
  opts: { initial?: string | null } = {},
): ResourceSourceTab {
  const initial = opts.initial ?? null;
  return {
    id: 'emoji',
    label: 'Эмодзи',
    build: (ctx) => {
      const root = div('emoji-groups');
      let currentCell: HTMLElement | null = null;
      EMOJI_GROUPS.forEach((group, index) => {
        // Группа текущей иконки разворачивается (иначе выбранный эмодзи скрыт
        // в свёрнутой категории).
        const hasCurrent = initial !== null && group.items.includes(initial);
        // Сворачиваемая эмодзи-группа — общий компонент lib/ui/collapsible.ts.
        const section = collapsibleSection({
          title: `${group.name} · ${group.items.length}`,
          collapsed: hasCurrent ? false : index !== 0,
          caretKind: 'triangle',
          classes: { root: 'emoji-group', header: 'emoji-group-title', body: 'emoji-group-body' },
          buildBody: () => {
            const grid = div('emoji-grid');
            for (const glyph of group.items) {
              const cell = button(glyph, () => void onPick(glyph, ctx), 'emoji-cell');
              if (glyph === initial) {
                cell.classList.add('emoji-cell-current');
                currentCell = cell;
              }
              grid.append(cell);
            }
            return grid;
          },
        });
        root.append(section.root);
      });
      revealCurrent(currentCell);
      return root;
    },
  };
}

/**
 * Источник «Библиотека» — значки иконочной библиотеки (Lucide) с ЖИВЫМ
 * поиском по каталогу имён. Клик применяет выбор немедленно
 * (`icon_kind='icon'`, `icon` = имя значка), как у «Эмодзи»: применяет и
 * закрывает диалог обработчик `onPick`. Полный каталог грузится ЛЕНИВО при
 * первом построении панели (первое открытие вкладки); до загрузки — подсказка,
 * сетка наполняется `reconcileKeyed` по фильтру поиска (стандарт
 * инкрементального рендера списков).
 *
 * `opts.initialIcon` — уже выбранное имя значка (ошибка e2407f6d): ячейка
 * помечается `icon-library-cell-current` и прокручивается в вид, а источник
 * объявляет корректный выбор (`setReady`), поэтому нижняя «Применить» активна
 * — смена ТОЛЬКО цвета ранее выбранной иконки не требует повторного поиска
 * (`apply` применяет текущий значок с новым цветом).
 */
export function libraryIconSourceTab(opts: {
  /**
   * Начальное имя выбранного значка (`null` — прежнее поведение, выбор не
   * отмечен). Заполняет выделение и доступность «Применить» (ошибка e2407f6d).
   */
  initialIcon?: string | null;
  /**
   * Начальный цвет символа (`null` — прежнее поведение, `currentColor`).
   * Заполняет поле цвета (0.12.1, задача 4105bd6a).
   */
  initialColor?: string | null;
  /**
   * Выбор значка: имя каталога + выбранный цвет символа (`null` — не задан).
   * Клик применяет и закрывает диалог; `apply` (нижняя «Применить») применяет
   * уже выбранный значок — для смены только цвета.
   */
  onPick: (
    name: string,
    color: string | null,
    ctx: ResourceSourceContext,
  ) => void | Promise<void>;
}): ResourceSourceTab {
  const initial = opts.initialIcon ?? null;
  /**
   * Применение текущего значка рождается в `build` (нужен выбранный значок и
   * поле цвета), а `apply` нужен каркасу заранее — читаем через холдер, как у
   * `urlSourceTab`.
   */
  const holder: { run: ResourceSourceTab['apply'] } = { run: undefined };
  return {
    id: 'library',
    label: t('icons.library.tab'),
    build: (ctx) => {
      const box = div('icon-source');

      // Цвет символа (0.12.1, задача 4105bd6a): тумблер «свой цвет» + поле
      // выбора. Выключен — цвет не задан (`null`, значок наследует цвет текста).
      let color: string | null = opts.initialColor ?? null;
      const colorRow = div('icon-color-row');
      const colorControl = colorField({ value: color ?? '#20242d' });
      colorControl.picker.disabled = color === null;
      const colorToggle = checkboxRow({
        label: t('icons.library.color'),
        checked: color !== null,
        onChange: (on) => {
          colorControl.picker.disabled = !on;
          color = on ? colorControl.value() : null;
        },
      });
      colorControl.picker.addEventListener('input', () => {
        if (color !== null) color = colorControl.value();
      });
      colorRow.append(colorToggle.row, colorControl.root);

      const row = div('icon-source-row');
      const input = fieldInput({ type: 'search', placeholder: t('icons.library.search') });
      row.append(input);

      const hint = el('p', 'muted', t('icons.library.loading'));
      const grid = div('icon-library-grid');
      box.append(colorRow, row, hint, grid);

      let catalog: IconCatalog | null = null;
      /** Текущий выбор значка (начальный или кликнутый) — источник `apply`. */
      let selected: string | null = initial;
      let currentCell: HTMLElement | null = null;
      let revealedCurrent = false;

      /** Помечает ячейку текущего выбора классом (по `data-icon`). */
      const paintCurrent = (): void => {
        for (const cell of Array.from(grid.children) as HTMLElement[]) {
          cell.classList.toggle('icon-library-cell-current', cell.dataset['icon'] === selected);
        }
      };

      const render = (): void => {
        if (catalog === null) return;
        const matched = searchIconCatalog(catalog.names, input.value);
        const empty = matched.length === 0;
        hint.textContent = empty ? t('icons.library.empty') : '';
        hint.style.display = empty ? '' : 'none';
        reconcileKeyed(grid, matched, {
          key: (name) => name,
          build: (name) => {
            const cell = button(
              '',
              () => {
                // Немедленное применение (поведение вкладки): выбор сразу уходит
                // вызывающему; фиксируем его и для «Применить» (если запись
                // не удалась и диалог остался открытым).
                selected = name;
                void opts.onPick(name, color, ctx);
              },
              'icon-library-cell',
            );
            cell.title = name;
            cell.dataset['icon'] = name;
            void renderLibraryIcon(cell, name, { size: 20 });
            return cell;
          },
          update: () => {},
        });
        paintCurrent();
        if (currentCell === null && selected !== null) {
          currentCell =
            (Array.from(grid.children) as HTMLElement[]).find(
              (cell) => cell.dataset['icon'] === selected,
            ) ?? null;
        }
        // Прокрутка к текущему выбору — один раз, после первой загрузки каталога.
        if (!revealedCurrent) {
          revealedCurrent = true;
          revealCurrent(currentCell);
        }
      };
      input.addEventListener('input', render);
      void loadIconCatalog().then((loaded) => {
        catalog = loaded;
        render();
      });
      // Уже выбранный значок — «Применить» активна (смена только цвета).
      if (selected !== null) ctx.setReady(true);
      holder.run = (c) => {
        if (selected === null) return;
        return opts.onPick(selected, color, c);
      };
      return box;
    },
    // Нижняя «Применить»: применяет выбранный значок с текущим цветом
    // (у немедленных источников `apply` нет; здесь он нужен для смены цвета).
    apply: (ctx) => holder.run?.(ctx),
  };
}

/**
 * Источник «Иконки мыслей» — сетка иконок типов мыслей. Немедленный: клик
 * применяет иконку типа сразу; пустой набор — подсказка.
 */
export function thoughtIconSourceTab(opts: {
  types: readonly ThoughtType[];
  emptyHint?: string;
  /**
   * Растянуть сетку на всю доступную высоту панели (0.12.1, задача 4105bd6a):
   * `true` — вкладка «Иконки мыслей» диалога иконки; `false`/не задано —
   * встроенный быстрый выбор внутри вкладки «Файл» (компактный предел высоты).
   */
  fill?: boolean;
  onPick: (
    icon: string,
    kind: IconKind,
    color: string | null,
    ctx: ResourceSourceContext,
  ) => void | Promise<void>;
}): ResourceSourceTab {
  /** Оборачивает сетку растягивающим контейнером, когда нужна вся высота. */
  const wrap = (grid: HTMLElement): HTMLElement => {
    if (opts.fill !== true) return grid;
    const panel = div('icon-type-panel');
    panel.append(grid);
    return panel;
  };
  return {
    id: 'thought-icons',
    label: 'Иконки мыслей',
    build: (ctx) => {
      const grid = div('icon-type-grid');
      const types = opts.types.filter((type) => type.icon !== null && type.icon !== '');
      if (types.length === 0) {
        grid.append(el('p', 'muted', opts.emptyHint ?? 'Типы мыслей с иконками не заданы.'));
        return wrap(grid);
      }
      for (const type of types) {
        const cell = button(
          '',
          () => void opts.onPick(type.icon ?? '', type.icon_kind, type.icon_color ?? null, ctx),
          'icon-type-cell',
        );
        cell.title = `Иконка типа «${type.name}»`;
        if (type.icon_kind === 'image' && type.icon !== null) {
          const img = el('img');
          img.src = type.icon;
          img.alt = '';
          cell.append(img);
        } else if (type.icon_kind === 'icon' && type.icon !== null) {
          // Библиотечная иконка типа (icon_kind='icon') — значок каталога
          // рисует фасад, отложенно (каталог грузится лениво). Цвет символа —
          // как у типа (0.12.1, задача 4105bd6a).
          const iconOptions: { size: number; color?: string } = { size: 20 };
          if (type.icon_color !== null) iconOptions.color = type.icon_color;
          void renderLibraryIcon(cell, type.icon, iconOptions, '💭');
        } else {
          cell.textContent = type.icon ?? '💭';
        }
        grid.append(cell);
      }
      return wrap(grid);
    },
  };
}

/**
 * Источник «URL» — поле адреса с живым предпросмотром-картинкой. Работает через
 * нижнюю «Применить»: она доступна, только когда введённый URL загрузился как
 * изображение. `onApply` получает проверенный URL и контекст (закрытие — на нём).
 */
export function urlSourceTab(opts: {
  placeholder: string;
  initial?: string;
  previewHint: string;
  onApply: (url: string, ctx: ResourceSourceContext) => void | Promise<void>;
}): ResourceSourceTab {
  // Обработчик применения рождается в `build` (ему нужны ввод и проверенный URL),
  // а `apply` нужен каркасу заранее — читаем через холдер. Активная вкладка
  // строится каркасом при открытии, поэтому к нажатию «Применить» холдер готов.
  const holder: { run: ResourceSourceTab['apply'] } = { run: undefined };
  return {
    id: 'url',
    label: 'URL',
    build: (ctx) => {
      const box = div('icon-source');
      let valid: string | null = null;
      const row = div('icon-source-row');
      const input = fieldInput() as HTMLInputElement;
      input.type = 'text';
      input.value = opts.initial ?? '';
      input.placeholder = opts.placeholder;
      const preview = div('icon-preview');
      const paintHint = (): void => {
        preview.replaceChildren(span(opts.previewHint, 'muted'));
      };
      const validate = (raw: string): void => {
        valid = null;
        ctx.setReady(false);
        preview.replaceChildren();
        preview.classList.remove('icon-preview-error');
        const v = raw.trim();
        if (v === '') {
          paintHint();
          return;
        }
        const img = el('img');
        img.alt = '';
        img.addEventListener('load', () => {
          if (input.value.trim() === v) {
            valid = v;
            ctx.setReady(true);
          }
        });
        img.addEventListener('error', () => {
          if (input.value.trim() === v) {
            preview.replaceChildren(el('span', 'icon-preview-bad', '✕'));
            preview.classList.add('icon-preview-error');
          }
        });
        img.src = v;
        preview.append(img);
      };
      input.addEventListener('input', () => validate(input.value));
      row.append(input);
      box.append(row, preview);
      const initial = opts.initial ?? '';
      if (initial.trim() !== '') validate(initial);
      else paintHint();
      holder.run = (c) => {
        if (valid === null) return;
        return opts.onApply(valid, c);
      };
      return box;
    },
    apply: (ctx) => holder.run?.(ctx),
  };
}

/**
 * Полоса вкладок — единый механизм вкладок клиента (задача a57e7998,
 * требование 88a9225a «Каркас диалога ETN — единственный источник всех
 * диалогов», инвентаризация 3fc7c54d: «Tabs — 6 копий → 1»).
 *
 * Вкладки в диалогах строятся только этим фасадом `lib/ui`; каркас диалога
 * (`lib/dialog.ts`) принимает их описанием (`DialogOptions.tabs`) и не знает
 * о разметке. Своя реализация, а не вендорский `wa-tab-group`, по трём
 * причинам:
 *
 *  1. **Тестируемость.** Юнит-тесты клиента идут на общем DOM-шиме
 *     (`client/tests/dom-shim.ts`), custom elements вендора в нём не
 *     исполняются: у `wa-tab-group` не было бы ни поведения, ни событий, и
 *     переключение вкладок стало бы непроверяемым в Node. Свой фасад даёт
 *     обычные DOM-узлы, события и aria-состояния, которые шим видит.
 *  2. **Ленивое содержимое.** Панели нужны ленивыми: тело вкладки строится
 *     при первом показе (emoji-грид, редактор свойства сети), а не при
 *     открытии диалога. Это проще выразить функцией контента, чем
 *     подстраивать под жизненный цикл `wa-tab-panel`.
 *  3. **API фасада стабилен.** ADR «Основа lib/ui: готовые Web Components за
 *     фасадами» прямо допускает замену реализации фасада: экраны видят
 *     `uiTabs(...)`, и переход на вендорскую реализацию потом не тронет
 *     потребителей.
 *
 * Вид вкладок — один на весь клиент (`./tabs.css`), частные стили вкладок
 * (`admin-tab`, `icon-tab`, `diff-tab`, `type-editor-tab`,
 * `settings-md-tab`) упразднены.
 */

import { div, el } from '../dom.js';

/** Одна вкладка: подпись и содержимое панели. */
export interface TabSpec {
  /** Устойчивый идентификатор вкладки (внутри диалога). */
  id: string;
  label: string;
  /**
   * Счётчик `(N)` у подписи (бейдж), как у вкладок панели мысли
   * (`editor.ts`, `.editor-tab-count`). `undefined` — бейджа нет. Обновляется
   * вызовом {@link TabsHandle.setCount} после изменения набора.
   */
  count?: number;
  /**
   * Содержимое панели. Функция вызывается ЛЕНИВО — при первом показе вкладки,
   * и ровно один раз: возвращённый узел переиспользуется при повторных
   * переключениях (состояние вкладки не теряется).
   */
  content: HTMLElement | (() => HTMLElement);
}

/** Параметры {@link uiTabs}. */
export interface TabsOptions {
  tabs: TabSpec[];
  /** Активная вкладка при построении; по умолчанию — первая. */
  activeId?: string;
  /** Вызывается при переключении вкладки пользователем или `setActive`. */
  onChange?: (id: string) => void;
}

/** Дескриптор построенной полосы вкладок. */
export interface TabsHandle {
  /** Корень компонента: полоса вкладок + хост панелей. */
  root: HTMLElement;
  /** Показывает вкладку `id` (безопасно для отсутствующего id). */
  setActive(id: string): void;
  /** Идентификатор активной вкладки. */
  activeId(): string;
  /** Обновляет счётчик `(N)` вкладки; `undefined` — бейдж скрывается. */
  setCount(id: string, count: number | undefined): void;
}

/** Счётчик для уникальных id вкладок и панелей (aria-связи). */
let tabsSeq = 0;

/**
 * Строит полосу вкладок. Панели сохраняются в DOM (скрытые — `hidden`), их
 * содержимое строится лениво при первом показе; переключение не пересоздаёт
 * узлы, поэтому введённые на вкладке значения не теряются, а высота панели
 * хоста задаётся контейнером-владельцем (в диалоге — ролью размера), а не
 * содержимым вкладки.
 */
export function uiTabs(opts: TabsOptions): TabsHandle {
  const uid = `ui-tabs-${++tabsSeq}`;
  const root = div('ui-tabs');
  const tablist = div('ui-tablist');
  tablist.setAttribute('role', 'tablist');
  const panelHost = div('ui-tabpanels');
  root.append(tablist, panelHost);

  const buttons = new Map<string, HTMLButtonElement>();
  const panes = new Map<string, HTMLElement>();
  /** Бейджи счётчиков `(N)`, по вкладке (для {@link TabsHandle.setCount}). */
  const countBadges = new Map<string, HTMLElement>();
  const built = new Set<string>();
  const first = opts.tabs[0]?.id ?? '';
  let active = opts.activeId !== undefined && opts.tabs.some((t) => t.id === opts.activeId)
    ? opts.activeId
    : first;

  /** Строит содержимое панели при первом показе (один раз на вкладку). */
  const buildPane = (id: string, pane: HTMLElement): void => {
    if (built.has(id)) return;
    built.add(id);
    const spec = opts.tabs.find((t) => t.id === id);
    if (spec === undefined) return;
    pane.append(typeof spec.content === 'function' ? spec.content() : spec.content);
  };

  /** Показывает вкладку; `emit` выключает обратный вызов при первичной сборке. */
  const activate = (id: string, emit: boolean): void => {
    if (!buttons.has(id)) return;
    active = id;
    for (const [key, btn] of buttons) {
      const on = key === id;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      btn.tabIndex = on ? 0 : -1;
      const pane = panes.get(key);
      if (pane === undefined) continue;
      pane.classList.toggle('active', on);
      if (on) {
        pane.removeAttribute('hidden');
        buildPane(key, pane);
      } else {
        pane.setAttribute('hidden', '');
      }
    }
    if (emit) opts.onChange?.(id);
  };

  /** Обновляет бейдж счётчика вкладки; `undefined` — бейдж скрывается. */
  function setCount(id: string, count: number | undefined): void {
    const badge = countBadges.get(id);
    if (badge === undefined) return;
    if (count === undefined) {
      badge.textContent = '';
      badge.classList.add('hidden');
      return;
    }
    badge.textContent = `(${count})`;
    badge.classList.remove('hidden');
  }

  const focusAt = (index: number): void => {
    const list = opts.tabs;
    if (list.length === 0) return;
    const wrapped = ((index % list.length) + list.length) % list.length;
    const target = list[wrapped];
    if (target === undefined) return;
    activate(target.id, true);
    buttons.get(target.id)?.focus();
  };

  opts.tabs.forEach((spec, index) => {
    const tabId = `${uid}-tab-${index}`;
    const paneId = `${uid}-panel-${index}`;
    const btn = el('button', 'ui-tab');
    btn.type = 'button';
    btn.id = tabId;
    btn.textContent = spec.label;
    // Бейдж счётчика — как у вкладок панели мысли (`.editor-tab-count`):
    // рядом с подписью, бледным, скрыт при отсутствии значения.
    const badge = el('span', 'ui-tab-count hidden');
    btn.append(badge);
    countBadges.set(spec.id, badge);
    setCount(spec.id, spec.count);
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-controls', paneId);
    btn.addEventListener('click', () => activate(spec.id, true));
    btn.addEventListener('keydown', (event) => {
      // Клавиатурный контракт WAI-ARIA Tabs: стрелки двигают выбор,
      // Home/End — крайние вкладки; фокус уезжает вместе с выбором.
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        focusAt(index + 1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        focusAt(index - 1);
      } else if (event.key === 'Home') {
        event.preventDefault();
        focusAt(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        focusAt(opts.tabs.length - 1);
      }
    });
    buttons.set(spec.id, btn);
    tablist.append(btn);

    const pane = div('ui-tabpanel');
    pane.id = paneId;
    pane.setAttribute('role', 'tabpanel');
    pane.setAttribute('aria-labelledby', tabId);
    pane.setAttribute('hidden', '');
    panes.set(spec.id, pane);
    panelHost.append(pane);
  });

  activate(active, false);

  return {
    root,
    setActive: (id: string): void => activate(id, true),
    activeId: (): string => active,
    setCount,
  };
}

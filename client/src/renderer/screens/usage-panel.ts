/**
 * Панель использования (спека f7623077, ошибка aca92904; док корзины —
 * задача d23279f6).
 *
 * Интерактивный разбор блокировок удаления — не путать с пассивной группой
 * «Использование» вкладки «Связи» редактора. Панель живёт в двух местах:
 *
 *  - **экранный singleton** в теле рабочего стола (вход из диалога удаления,
 *    toggle, ширина `--usage-w`/`window_layout.u`) — прежние экспорты
 *    `mountUsagePanel`/`openUsagePanel`/`closeUsagePanel`/`isUsagePanelOpenFor`;
 *  - **док-панель корзины** — отдельный экземпляр (`createUsagePanel`) внутри
 *    диалога корзины, свой сплиттер и локальная ширина сессии. Корзина при
 *    входе не закрывается, список остаётся справа.
 *
 * Состояние (хост, цель, поколение загрузки, кнопки) принадлежит экземпляру, а
 * не модулю: два экземпляра не перетирают друг друга.
 *
 * У помеченной на удаление цели в шапке есть «Вернуть из корзины», у помеченной
 * и незаблокированной — «Удалить совсем» (видимость — {@link
 * usageActionVisibility}). Пометка и блокировка читаются СВЕЖИМ запросом при
 * каждом открытии/перечитывании.
 *
 * Источники данных:
 *  - `GET /thoughts/{id}/usage` (`etn.thoughts.usage`) — группы «кто и через
 *    какое свойство ссылается» + `holding_layers`;
 *  - `POST /thoughts/deletion-check-batch` / `POST /links/deletion-check-batch`
 *    — `blocked`, удерживающие слои, `orphaned_children`;
 *  - `GET` сущности — пометка на удаление.
 */

import {
  BASE_LAYER_ID,
  EtnError,
  type HoldingLayerRef,
  type LinkDeletionCheckResult,
  type ThoughtDeletionCheckResult,
  type ThoughtUsage,
} from '@etn/shared';

import { onThoughtDeleted, scheduleRefresh } from '../app.js';
import { etn } from '../lib/etn.js';
import { patchFocusEdge, store } from '../state.js';
import { div, span } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { notice } from '../lib/notice.js';
import { confirmDialog, errorDialog } from '../lib/dialog.js';
import { MENU_SEPARATOR, menuAction, type MenuItem } from '../lib/menu.js';
import { collapsibleSection } from '../lib/ui/collapsible.js';
import { iconButton, uiButton } from '../lib/ui/button.js';
import {
  isRestorePanelError,
  purgePrecheck,
  usageActionVisibility,
  usageLayers,
  usagePropertyRows,
  type PurgePrecheck,
  type UsagePropertyRow,
} from '../lib/usage.js';
import { pluralCategory } from '../lib/plural.js';
import { errorState, loadingState } from '../lib/ui/empty-state.js';
import { svgIcon } from '../lib/ui/icon.js';
import { createThoughtCloud } from '../lib/thought-cloud.js';
import { openThoughtInEditor, reflectLinkUpdate, reflectThoughtUpdate } from '../editor/editor.js';
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
  /** Свежий `deletion-check.blocked` — решает видимость «Удалить совсем». */
  blocked: boolean;
  /** Потомки, которые осиротеют при физическом удалении мысли. */
  orphanedChildren: number;
}

/** Где живёт экземпляр панели: экран или док корзины. */
export type UsagePanelMode = 'screen' | 'dock';

/** Формы предупреждения об осиротевших потомках (согласование числа). */
const ORPHANED_KEYS = {
  one: 'usagePanel.purgeOrphaned.one',
  few: 'usagePanel.purgeOrphaned.few',
  many: 'usagePanel.purgeOrphaned.many',
} as const;

/** Параметры экземпляра панели. */
export interface CreateUsagePanelOptions {
  /** Хост панели (класс `.usage-panel` уже на нём). */
  host: HTMLElement;
  /** Сплиттер экранной панели (`--usage-w`); у дока свой — его ведёт корзина. */
  resizer?: HTMLElement;
  mode: UsagePanelMode;
  /**
   * Любая мутация в панели (restore, purge, очистка свойства/всех свойств,
   * удаление слоя) — хост перечитывает свои данные. В корзине это её `render`:
   * строки, замок, «Ссылок» и кнопки тулбара обновляются без переоткрытия.
   */
  onChanged?: () => void;
  /** Панель закрыта — хост возвращает фокус (таблица корзины). */
  onClosed?: () => void;
}

/** Дескриптор экземпляра панели. */
export interface UsagePanelHandle {
  /** Открыть (док) / перерисовать на цели. Док не toggle-ит. */
  open(target: UsagePanelTarget): void;
  /** Закрыть панель. */
  close(): void;
  /** Перечитать данные текущей цели (например, после действия корзины). */
  reload(): Promise<void>;
  /** Открыта ли панель именно для этой сущности. */
  isOpenFor(kind: 'thought' | 'link', id: string): boolean;
  /** Открыта ли панель (для Esc-слоёв корзины). */
  isOpen(): boolean;
  /** Текущая цель панели (`null` — панель закрыта). */
  currentTarget(): UsagePanelTarget | null;
}

/** Создаёт независимый экземпляр панели в готовом хосте. */
export function createUsagePanel(options: CreateUsagePanelOptions): UsagePanelHandle {
  const { host, resizer, mode } = options;
  host.replaceChildren();

  const header = div('usage-header');
  const title = span(t('usagePanel.title'), 'usage-title');
  // Действия шапки — иконочные кнопки с подсказками (спека f7623077):
  // при минимальной ширине дока они не выдавливаются за границу, а заголовок
  // усекается. Подсказки — из словаря; крестик панели отличается от крестика
  // диалога.
  const restoreBtn = iconButton({
    icon: svgIcon('undo', 14),
    title: t('usagePanel.restoreTitle'),
    role: 'ghost',
    size: 's',
    onClick: () => void restoreTarget(),
  });
  restoreBtn.dataset['usageAction'] = 'restore';
  restoreBtn.hidden = true;
  const purgeBtn = iconButton({
    icon: svgIcon('trash', 14),
    title: t('usagePanel.purgeTitle'),
    role: 'ghost',
    size: 's',
    class: 'usage-action-danger',
    onClick: () => void purgeTarget(),
  });
  purgeBtn.dataset['usageAction'] = 'purge';
  purgeBtn.hidden = true;
  const closeBtn = iconButton({
    icon: svgIcon('x', 14),
    title: t('usagePanel.close'),
    role: 'ghost',
    size: 's',
    onClick: () => close(),
  });
  closeBtn.dataset['usageAction'] = 'close';
  header.append(title, restoreBtn, purgeBtn, closeBtn);

  const targetBox = div('usage-target');
  const statusBox = div('usage-status');
  statusBox.hidden = true;
  const bodyBox = div('usage-body');
  host.append(header, targetBox, statusBox, bodyBox);

  let current: UsagePanelTarget | null = null;
  /** Поколение загрузки: поздний ответ прошлой цели не перерисовывает новую. */
  let loadGeneration = 0;

  /** Строка состояния панели (ошибка действия); `null` — скрыть. */
  function setStatus(text: string | null): void {
    statusBox.textContent = text ?? '';
    statusBox.hidden = text === null;
  }

  /**
   * Видимость действий шапки по свежим данным (чистая модель
   * {@link usageActionVisibility}): restore — у помеченной цели, purge — у
   * помеченной и незаблокированной.
   */
  function updateActions(marked: boolean, blocked: boolean): void {
    const visible = usageActionVisibility(marked, blocked);
    restoreBtn.hidden = !visible.restore;
    restoreBtn.disabled = !visible.restore;
    purgeBtn.hidden = !visible.purge;
    purgeBtn.disabled = !visible.purge;
  }

  /** Закрывает панель и очищает содержимое. */
  function close(): void {
    const wasOpen = current !== null;
    current = null;
    loadGeneration += 1;
    host.classList.add('hidden');
    host.classList.remove('busy');
    if (mode === 'screen') resizer?.classList.add('hidden');
    bodyBox.replaceChildren();
    targetBox.textContent = '';
    targetBox.removeAttribute('title');
    setStatus(null);
    updateActions(false, false);
    if (wasOpen) options.onClosed?.();
  }

  /** Открывает панель для сущности (для дока повторный вход — перерисовка). */
  function open(target: UsagePanelTarget): void {
    current = target;
    host.classList.remove('hidden');
    if (mode === 'screen') resizer?.classList.remove('hidden');
    targetBox.textContent = target.title;
    // Полный текст имени — в подсказке: при узкой панели он обрезается.
    targetBox.title = target.title;
    setStatus(null);
    // Пока не пришло свежее чтение пометки — действия скрыты (чужая цель не
    // должна показывать действия от предыдущей).
    updateActions(false, false);
    void load(target);
    closeBtn.focus();
  }

  /** Загружает данные и собирает тело панели. */
  async function load(target: UsagePanelTarget): Promise<void> {
    const generation = ++loadGeneration;
    const networkId = store.state.networkId;
    if (networkId === null) {
      bodyBox.replaceChildren(errorState(t('usagePanel.noNetwork')));
      return;
    }
    bodyBox.replaceChildren(loadingState(t('usagePanel.loading')));

    let usage: ThoughtUsage | null = null;
    let layersFromCheck: HoldingLayerRef[] = [];
    let marked = false;
    let blocked = false;
    let orphanedChildren = 0;
    try {
      if (target.kind === 'thought') {
        const [loadedUsage, checks, entity] = await Promise.all([
          etn.thoughts.usage(networkId, target.id),
          etn.thoughts.deletionCheck(networkId, [target.id]),
          etn.thoughts.get(networkId, target.id),
        ]);
        usage = loadedUsage;
        const check: ThoughtDeletionCheckResult | undefined = checks[target.id];
        layersFromCheck = check?.blocking.layers ?? [];
        blocked = check?.blocked ?? false;
        orphanedChildren = check?.orphaned_children ?? 0;
        marked = entity.marked_for_deletion;
      } else {
        const [checks, entity] = await Promise.all([
          etn.links.deletionCheck(networkId, [target.id]),
          etn.links.get(networkId, target.id),
        ]);
        const check: LinkDeletionCheckResult | undefined = checks[target.id];
        layersFromCheck = check?.blocking.layers ?? [];
        blocked = check?.blocked ?? false;
        marked = entity.marked_for_deletion;
      }
    } catch (err) {
      if (generation !== loadGeneration) return;
      // Цель исчезла (её удалили из корзины или извне): панель закрывается,
      // хост перечитывает строки. Прочие ошибки — состояние «не загрузилось».
      if (err instanceof EtnError && err.code === 'NOT_FOUND') {
        close();
        options.onChanged?.();
        return;
      }
      updateActions(false, false);
      bodyBox.replaceChildren(
        errorState(errText(err), {
          label: t('usagePanel.retry'),
          onClick: () => void load(target),
        }),
      );
      return;
    }

    // Пока ждали сеть, панель закрыли или переключили на другую сущность.
    if (generation !== loadGeneration || current !== target) return;

    const data: UsagePanelData = {
      properties: usagePropertyRows(usage),
      total: usage?.total ?? 0,
      layers: usageLayers(usage?.holding_layers, layersFromCheck),
      marked,
      blocked,
      orphanedChildren,
    };
    renderBody(target, data);
    updateActions(marked, blocked);

    // «После удаления слоя панель перечитывает deletion-check и обновляет
    // открытые диалоги удаления» (f7623077): обновляем видимую блокировку.
    bodyBox.dataset['blocked'] = data.layers.length > 0 ? 'true' : 'false';
  }

  /**
   * «Вернуть из корзины» из панели. Пометка и версия читаются СВЕЖИМ запросом
   * (без захвата, обычный PATCH с If-Match): чужая пометка восстанавливается,
   * `blocked` не препятствует. 404 и 409 (`VERSION_CONFLICT`/`LOCKED`)
   * оставляют панель открытой с сообщением в строке состояния. В доке после
   * успеха панель закрывается (цель больше не в корзине), в экранном режиме
   * действие скрывается, панель перечитывается.
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
          updateActions(false, false);
          setStatus(t('usagePanel.restoreNotMarked'));
          options.onChanged?.();
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
          updateActions(false, false);
          setStatus(t('usagePanel.restoreNotMarked'));
          options.onChanged?.();
          return;
        }
        const updated = await etn.links.update(
          networkId,
          target.id,
          { marked_for_deletion: false },
          entity.version,
        );
        // Не полагаемся на собственное эхо: ребро фокуса, холст, открытый
        // редактор связи и список структур обновляются тем же общим путём.
        reflectLinkUpdate(updated);
      }
      if (mode === 'dock') {
        close();
        options.onChanged?.();
        return;
      }
      updateActions(false, false);
      await reloadAfterMutation(target);
    } catch (err) {
      // 404/409 (VERSION_CONFLICT/LOCKED) — панель остаётся открытой и
      // объясняет причину строкой.
      if (err instanceof EtnError && isRestorePanelError(err.code)) {
        setStatus(errText(err));
        return;
      }
      errorDialog(t('actions.restore'), err);
    }
  }

  /**
   * «Удалить совсем»: подтверждение danger (при `orphaned_children > 0` —
   * предупреждение), затем физическое удаление. Мысль — `DELETE /thoughts/{id}`
   * со свежей версией; связь — точечный `POST /trash/purge { ids: [id] }`.
   * Захват не берётся. `purged === 0` — гонка с удерживающим слоем: сообщение
   * и перечитывание. После успеха панель закрыта, хост уведомлён, фокус
   * возвращает хост.
   */
  async function purgeTarget(): Promise<void> {
    const target = current;
    const networkId = store.state.networkId;
    if (target === null || networkId === null) return;
    setStatus(null);

    let orphanedChildren = 0;
    try {
      if (target.kind === 'thought') {
        const check = (await etn.thoughts.deletionCheck(networkId, [target.id]))[target.id];
        if (check === undefined || check.blocked) {
          // Гонка: блокировка появилась после отрисовки — перечитываем и
          // показываем актуальное состояние (действие снова скрыто).
          await load(target);
          return;
        }
        orphanedChildren = check.orphaned_children;
      } else {
        const check = (await etn.links.deletionCheck(networkId, [target.id]))[target.id];
        if (check === undefined || check.blocked) {
          await load(target);
          return;
        }
      }
    } catch (err) {
      errorDialog(t('actions.deleteForever'), err);
      return;
    }

    const message =
      orphanedChildren > 0
        ? `${t('usagePanel.purgeConfirmMessage', target.title)} ${t(
            ORPHANED_KEYS[pluralCategory(orphanedChildren)],
            String(orphanedChildren),
          )}`
        : t('usagePanel.purgeConfirmMessage', target.title);
    const ok = await confirmDialog(
      t('usagePanel.purgeConfirmTitle'),
      message,
      true,
      t('actions.deleteForever'),
    );
    if (!ok) return;

    /**
     * Удаление отменено по свежим данным: цель уже восстановлена или снова
     * заблокирована. Панель/строка перечитываются, сущность не трогаем.
     */
    const abortPurge = async (verdict: Exclude<PurgePrecheck, 'purge'>): Promise<void> => {
      if (verdict === 'already-restored') {
        // Сообщение — тостом: панель сейчас закроется (цель уже не в корзине),
        // строку состояния пользователь не успел бы прочитать.
        notice(t('usagePanel.purgeAlreadyRestored'));
      } else {
        setStatus(t('usagePanel.purgeRace'));
      }
      await reloadAfterMutation(target);
    };

    try {
      if (target.kind === 'thought') {
        // Свежие данные ПОСЛЕ подтверждения: пока пользователь читал диалог,
        // другой клиент мог снять пометку (удалять восстановленную сущность
        // нельзя) или снова заблокировать её. Версия тоже берётся свежая.
        const [entity, checks] = await Promise.all([
          etn.thoughts.get(networkId, target.id),
          etn.thoughts.deletionCheck(networkId, [target.id]),
        ]);
        const verdict = purgePrecheck(
          entity.marked_for_deletion,
          checks[target.id]?.blocked ?? true,
        );
        if (verdict !== 'purge') {
          await abortPurge(verdict);
          return;
        }
        await etn.thoughts.remove(networkId, target.id, entity.version);
        await onThoughtDeleted(target.id);
      } else {
        const [link, checks] = await Promise.all([
          etn.links.get(networkId, target.id),
          etn.links.deletionCheck(networkId, [target.id]),
        ]);
        const verdict = purgePrecheck(
          link.marked_for_deletion,
          checks[target.id]?.blocked ?? true,
        );
        if (verdict !== 'purge') {
          await abortPurge(verdict);
          return;
        }
        const { purged } = await etn.trash.purge(networkId, [target.id]);
        if (purged === 0) {
          // Гонка с удерживающим слоем, появившимся после проверки.
          await abortPurge('blocked');
          return;
        }
        patchFocusEdge({ ...link, active: false });
        const editorTarget = store.state.editorTarget;
        if (editorTarget !== null && editorTarget.kind === 'link' && editorTarget.id === target.id) {
          store.update({ editorTarget: null, selectedLinkId: null });
        }
        scheduleRefresh();
      }
      close();
      options.onChanged?.();
    } catch (err) {
      // Сущность исчезла между подтверждением и чтением — то же «уже
      // восстановлена»: панель перечитывается и закрывается.
      if (err instanceof EtnError && err.code === 'NOT_FOUND') {
        await abortPurge('already-restored');
        return;
      }
      errorDialog(t('actions.deleteForever'), err);
    }
  }

  /** Собирает две сворачиваемые группы панели. */
  function renderBody(target: UsagePanelTarget, data: UsagePanelData): void {
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
  function buildLayerRows(
    target: UsagePanelTarget,
    layers: readonly HoldingLayerRef[],
  ): HTMLElement {
    const box = div('usage-group-body');
    for (const layer of layers) {
      const isBase = layer.id === BASE_LAYER_ID;
      const row = div(isBase ? 'usage-layer-row usage-layer-row--base' : 'usage-layer-row');
      const line = div('usage-layer-line');
      line.append(span(layer.title, 'usage-layer-title'));
      // «Основу» удалить нельзя — она не слой правок; строка без кнопки, но с
      // объяснением причины (спека f7623077, критерий 8 задачи d23279f6).
      if (!isBase) {
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
        line.append(del);
      }
      row.append(line);
      if (isBase) row.append(span(t('usagePanel.layers.baseHint'), 'usage-layer-hint'));
      box.append(row);
    }
    return box;
  }

  /** После мутации: перечитать данные, обновить диалоги удаления и хост. */
  async function reloadAfterMutation(target: UsagePanelTarget): Promise<void> {
    await load(target);
    refreshOpenDeleteDialogs();
    options.onChanged?.();
  }

  return {
    open,
    close,
    reload: () => (current === null ? Promise.resolve() : load(current)),
    isOpenFor: (kind, id) => current !== null && current.kind === kind && current.id === id,
    isOpen: () => current !== null,
    currentTarget: () => current,
  };
}

/* ------------------------------------------------------------------ *
 * Экранная панель — singleton в теле рабочего стола (прежний контракт).
 * ------------------------------------------------------------------ */

let screenPanel: UsagePanelHandle | null = null;

/** Монтирует экранную панель; возвращает teardown для смены workspace. */
export function mountUsagePanel(hostEl: HTMLElement, resizerEl: HTMLElement): () => void {
  screenPanel = createUsagePanel({ host: hostEl, resizer: resizerEl, mode: 'screen' });
  return () => {
    screenPanel = null;
  };
}

/**
 * Открывает экранную панель для сущности. Повторный вызов для той же цели
 * закрывает её (toggle — вход из диалога удаления); для другой цели — перерисовывает.
 */
export function openUsagePanel(target: UsagePanelTarget): void {
  if (screenPanel === null) return;
  if (screenPanel.isOpenFor(target.kind, target.id)) {
    screenPanel.close();
    return;
  }
  screenPanel.open(target);
}

/** Закрывает экранную панель. */
export function closeUsagePanel(): void {
  screenPanel?.close();
}

/** Открыта ли экранная панель для указанной сущности. */
export function isUsagePanelOpenFor(kind: 'thought' | 'link', id: string): boolean {
  return screenPanel?.isOpenFor(kind, id) ?? false;
}

/** Текст ошибки для состояния «не загрузилось». */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Экранная обвязка панели «Задачи и напоминания» «Дневника» (0.16.1, задачи
 * `64f7976a`/`7446eb25`; требование `6762adb0`, `0e85b66e`, `e6af8b9e`,
 * `3616cfec`, `db1d9548`).
 *
 * **Тонкая обвязка.** Весь слой «загрузка → операции → устаревание → realtime →
 * кэш субъектов» живёт в единой компоненте `lib/ui/task-list.ts`; здесь только
 * источник «период ленты», переходы «Дневника» (день записи, перечитывание
 * ленты) и персист настроек панели в `ui_state`. Панель стоит НАД лентой, вне
 * блоков дней, и при любом периоде одна.
 *
 * **Слайдер высоты.** «Дневник» держит вертикальный разделитель между панелью и
 * лентой; границы высоты и минимум места для ленты — здешние константы (их
 * использует и раскладка экрана), высоту хранит компонента.
 */

import { UI_STATE_KEY } from '@etn/shared';

import { requireNetworkId } from '../../app.js';
import { createTaskRowEditor } from '../../editor/task-row-editor.js';
import { renderTaskBlock } from '../../editor/task-lines-view.js';
import { renderMarkdownWithWikiLinks } from '../../editor/wiki-link-resolver.js';
import {
  REMINDER_PANEL_ROW_CLASS,
  TASK_PANEL_ROW_CLASS,
  type TaskPanelRow,
} from '../../lib/ui/task-panel.js';
import { TASK_LIST_HEIGHT, mountTaskList } from '../../lib/ui/task-list.js';
import { taskRowKey } from '../../lib/ui/task-panel-model.js';

/** Зависимости экрана, которые остаются у «Дневника». */
export interface TasksPanelDeps {
  /** Применённый период ленты (локальные дни `YYYY-MM-DD`). */
  getPeriod(): { from: string; to: string };
  /** Открыть день ленты (переход к записи-источнику строки). */
  openDay(day: string): void;
  /**
   * Открыть ИСТОЧНИК хроно-строки (0.16.1, задача `cfb8cb72`, пункт 3): запись
   * становится текущей, лента — в верх, тело — в правке на строке задачи
   * (`openChronicleTaskLine`). Прочие строки экран решает сам (день/карточка).
   */
  openRowSource?(row: TaskPanelRow): void;
  /**
   * Перейти к строке только что созданной задачи «на сегодня» (0.16.1, пачка 4,
   * пункт 3). Экран ведёт штатным входом `openChronicleTaskLine`: запись
   * становится текущей (или ставится период по её дате), лента — в начало,
   * тело — в правке, каретка в строку задачи.
   */
  openCreatedTask?(ref: { commentId: string; lineNo: number }): void;
  /** Правки в записях изменились — лента «Дневника» перечитывается. */
  onRecordsChanged(): void;
  /** Панель свёрнута/развёрнута: экран прячет слайдер высоты. */
  onPanelCollapsed?(collapsed: boolean): void;
}

/** Дескриптор панели для экрана. */
export interface TasksPanelHandle {
  /** Перечитать панель (смена периода/отбора, показ вида). */
  refresh(): void;
  /** Снять подписки и размонтировать компоненту. */
  destroy(): void;
  /** Панель свёрнута штатной кареткой: слайдер высоты прячется. */
  panelCollapsed(): boolean;
  /** Высота панели из `ui_state`, `null` — высота по умолчанию. */
  panelHeight(): number | null;
  /** Запомнить высоту панели (слайдер) и применить её сразу. */
  setPanelHeight(height: number): void;
}

/** Границы высоты панели, px: ниже — нечитаемо, выше — не оставляет ленты. */
export const TASKS_PANEL_H_MIN = TASK_LIST_HEIGHT.min;
export const TASKS_PANEL_H_MAX = TASK_LIST_HEIGHT.max;
/** Минимум места для ленты при перетаскивании слайдера, px. */
export const TASKS_PANEL_FEED_MIN = TASK_LIST_HEIGHT.feedMin;

/**
 * Смонтировать панель над лентой и запустить первую загрузку. Панель — часть
 * экрана «Дневник»: одна при любом периоде, вне блоков дней.
 */
export function mountTasksPanel(host: HTMLElement, deps: TasksPanelDeps): TasksPanelHandle {
  const list = mountTaskList(host, {
    source: { kind: 'period', getPeriod: () => deps.getPeriod() },
    view: {
      reminders: true,
      doneSection: 'toggle',
      renderText: (node, row) => renderTaskRowText(node, row.text, requireNetworkId()),
      // Подчинённый блок строки — тем же путём, что просмотр комментария
      // (0.16.1, пачка 7): единый рендерер, вложенные списки/чекбоксы, сворачивание.
      renderBlock: (node, text) => renderTaskBlock(node, text, requireNetworkId()),
    },
    actions: {
      openDay: (day) => deps.openDay(day),
      // «Открыть источник» строки: запись → правка тела на строке задачи.
      // Экран решает адрес, панель только передаёт строку (пункт 3).
      ...(deps.openRowSource !== undefined
        ? { openRowSource: (row: TaskPanelRow) => deps.openRowSource?.(row) }
        : {}),
      // Созданная задача: экран решает адрес перехода (пункт 3 пачки 4).
      ...(deps.openCreatedTask !== undefined
        ? {
            openCreatedTask: (ref: { commentId: string; lineNo: number }) =>
              deps.openCreatedTask?.(ref),
          }
        : {}),
      onRecordsChanged: () => deps.onRecordsChanged(),
      onPanelCollapsed: (collapsed) => deps.onPanelCollapsed?.(collapsed),
    },
    // Правка строки — компонента редактирования комментария (пункт 1); её
    // реализацию даёт слой редактора, панель о CodeMirror не знает.
    createRowEditor: createTaskRowEditor,
    persistence: {
      uiStateKey: UI_STATE_KEY.DIARY_TASKS_PANEL,
      height: {
        min: TASKS_PANEL_H_MIN,
        max: TASKS_PANEL_H_MAX,
        feedMin: TASKS_PANEL_FEED_MIN,
      },
    },
  });
  return {
    refresh: () => list.refresh(),
    destroy: () => list.destroy(),
    panelCollapsed: () => list.panelCollapsed(),
    panelHeight: () => list.panelHeight(),
    setPanelHeight: (height) => list.setPanelHeight(height),
  };
}

/**
 * Нарисовать снапшот текста строки панели: markdown + кликабельные ID-ссылки.
 * Резолв — по ГОТОВОМУ DOM (общий вход `renderMarkdownWithWikiLinks`): серверный
 * HTML несёт пустые `<span class="wiki-link" data-wiki-id>`, и резолвер по строке
 * сниппета их не видит (блокер 399c25d5).
 */
export function renderTaskRowText(node: HTMLElement, text: string, networkId: string): void {
  renderMarkdownWithWikiLinks(node, text, networkId);
}

/** Классы строк панели — реэкспорт для тестов экрана и стенда. */
export const TASKS_PANEL_ROW_CLASSES = {
  task: TASK_PANEL_ROW_CLASS,
  reminder: REMINDER_PANEL_ROW_CLASS,
} as const;

/** Ключ строки задачи — реэкспорт адреса проекции для тестов. */
export { taskRowKey };

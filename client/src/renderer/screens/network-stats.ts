/**
 * Диалог «Статистика мыслесети» (задача c69b078d, версия 0.9.1).
 *
 * Показывает объём данных открытой мыслесети: типы мыслей/связей, свойства,
 * мысли, связи и публикации с разбивкой «всего / актуальные / неактуальные /
 * в корзине», полки, слои и вложения. Числа приходят одним запросом
 * `GET /networks/{id}/statistics` и суммируются по всем слоям сети (в т.ч.
 * теневые копии слоёв — это объём хранения, а не число видимых сущностей).
 *
 * Каркас — общий `lib/dialog` (роль размера `m` плюс модификатор `dialog-stats`:
 * пять колонок не влезают в 560px роли, форма шире — 650px, ошибка 8ca000f0),
 * список — фасад `lib/ui/table` (самодельные таблицы запрещены сторожем
 * `guard-ui-tables`), все строки — из словаря `lib/i18n`. Данные загружаются ДО
 * открытия диалога, поэтому содержимое стабильно и окно не «дёргается»: отказ
 * запроса показывается диалогом ошибки.
 */

import type { NetworkStats, StatsBreakdown } from '@etn/shared';

import { requireNetworkId } from '../app.js';
import { errorDialog, showDialog } from '../lib/dialog.js';
import { div, el } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { t } from '../lib/i18n.js';
import { formatFileSize } from '../lib/pure.js';
import { createTable } from '../lib/ui/table.js';

/** Строка таблицы статистики: расшифровка показателя и его числа. */
export interface StatRow {
  /** Стабильный ключ строки (для фасада таблицы). */
  key: string;
  /** Подпись показателя (локализована вызывающим). */
  label: string;
  /** Количество всего. */
  total: number;
  /** Актуальных; `null` — разбивки у показателя нет (онтология, слои). */
  active: number | null;
  /** Неактуальных; `null` — разбивки нет. */
  inactive: number | null;
  /** В корзине; `null` — разбивки нет. */
  trashed: number | null;
}

/** Строка из разбивки мыслей/связей. */
function breakdownRow(
  key: string,
  label: string,
  value: StatsBreakdown,
): StatRow {
  return {
    key,
    label,
    total: value.total,
    active: value.active,
    inactive: value.inactive,
    trashed: value.trashed,
  };
}

/**
 * Строки таблицы статистики в порядке отображения: типы мыслей, типы связей,
 * свойства, мысли, связи, публикации, полки, слои. У онтологии, полок и слоёв
 * разбивки нет — в колонках актуальности остаются пустые ячейки (не «—»).
 */
export function buildStatisticsRows(stats: NetworkStats): StatRow[] {
  return [
    {
      key: 'thought_types',
      label: t('stats.row.thoughtTypes'),
      total: stats.thought_types,
      active: null,
      inactive: null,
      trashed: null,
    },
    {
      key: 'link_types',
      label: t('stats.row.linkTypes'),
      total: stats.link_types,
      active: null,
      inactive: null,
      trashed: null,
    },
    {
      key: 'properties',
      label: t('stats.row.properties'),
      total: stats.properties,
      active: null,
      inactive: null,
      trashed: null,
    },
    breakdownRow('thoughts', t('stats.row.thoughts'), stats.thoughts),
    breakdownRow('links', t('stats.row.links'), stats.links),
    breakdownRow('publications', t('stats.row.publications'), stats.publications),
    {
      key: 'shelves',
      label: t('stats.row.shelves'),
      total: stats.shelves,
      active: null,
      inactive: null,
      trashed: null,
    },
    {
      key: 'layers',
      label: t('stats.row.layers'),
      total: stats.layers,
      active: null,
      inactive: null,
      trashed: null,
    },
  ];
}

/** Итоговая строка по вложениям: «Вложений: N, файлов N, общий размер <X>». */
export function formatAttachmentsSummary(stats: NetworkStats): string {
  return t('stats.attachments', [
    String(stats.attachments.total),
    String(stats.attachments.files),
    formatFileSize(stats.attachments.file_size_bytes),
  ]);
}

/** Ширина колонки со значением (ошибка 8ca000f0): числа узкие, колонки не
 *  должны распирать форму — не более 90px. Колонка «Показатель» ширины не
 *  задаёт и забирает остаток, поэтому имена показателей помещаются целиком. */
const VALUE_COLUMN_WIDTH = '90px';

/** Таблица показателей: колонка, «всего», «актуальные», «неактуальные», «корзина». */
export function buildStatisticsTable(rows: readonly StatRow[]) {
  return createTable<StatRow>({
    ariaLabel: t('stats.table.aria'),
    rows,
    rowKey: (row) => row.key,
    columns: [
      { key: 'label', header: t('stats.col.indicator'), sortable: false },
      {
        key: 'total',
        header: t('stats.col.total'),
        width: VALUE_COLUMN_WIDTH,
        align: 'end',
        sortable: false,
      },
      {
        key: 'active',
        header: t('stats.col.active'),
        width: VALUE_COLUMN_WIDTH,
        align: 'end',
        sortable: false,
        // Пустая ячейка вместо «—»: у онтологии и слоёв разбивки не существует.
        empty: '',
      },
      {
        key: 'inactive',
        header: t('stats.col.inactive'),
        width: VALUE_COLUMN_WIDTH,
        align: 'end',
        sortable: false,
        empty: '',
      },
      {
        key: 'trashed',
        header: t('stats.col.trashed'),
        width: VALUE_COLUMN_WIDTH,
        align: 'end',
        sortable: false,
        empty: '',
      },
    ],
  });
}

/**
 * Открывает диалог «Статистика мыслесети» для открытой сети. Сводка
 * запрашивается до показа: ошибка запроса показывается диалогом ошибки, а не
 * пустым окном статистики.
 */
export async function showNetworkStatisticsDialog(): Promise<void> {
  const networkId = requireNetworkId();
  let stats: NetworkStats;
  try {
    stats = await etn.networks.statistics(networkId);
  } catch (err) {
    errorDialog(t('stats.title'), err);
    return;
  }

  const tableWrap = div('admin-table-wrap');
  const table = buildStatisticsTable(buildStatisticsRows(stats));
  tableWrap.append(table.element);

  const body = div('form-stack');
  body.append(tableWrap, el('p', 'dialog-text', formatAttachmentsSummary(stats)));

  showDialog({
    title: t('stats.title'),
    size: 'm',
    body,
    buttons: [{ label: t('actions.close'), primary: true }],
    // Ширина формы — 650px: роль `m` (560px) узка для пяти колонок. Ширину
    // задаёт модификатор `dialog-stats` на боксе (styles/dialogs.css) через
    // тот же `--dialog-w`, что и роли размера, — ширина приходит из CSS, не из
    // inline-стиля. `onMount` — единственная точка доступа к боксу диалога.
    onMount: (_close, box) => box.classList.add('dialog-stats'),
  });
}

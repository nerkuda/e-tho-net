/**
 * Шапка слота создания дневной записи («Добавить хроно-запись») — 0.10.2,
 * ошибка 36c330a3.
 *
 * Шапка собирается здесь отдельным помощником, чтобы её можно было ИСПОЛНИТЬ в
 * тесте на DOM-шиме и убедиться, что узел заголовка в шапке — РЕАЛЬНО узел
 * общего компонента `createRecordTitle` (`./record-title.ts`), а не результат
 * локальной сборки. Это даёт сторожу `guard-chronicle-record-title` проверку
 * факта монтирования (идентичность узла) вместо разбора исходника — она не
 * боится ни форматирования, ни подмены узла после монтирования.
 *
 * Состав шапки: подпись даты/периода, узел компонента-заголовка и кнопка
 * «✕» (отмена слота). Слот открывается с заголовком В ПРАВКЕ (текст надо
 * набирать); `Enter`/уход из поля завершают правку и возвращают заголовок в
 * сворачиваемую группу со стрелкой, `Escape` отменяет.
 *
 * Поведение то же, что было в `chronicle.ts` (`startSlot`): вынос не меняет
 * разметку и обработчики, меняется лишь место сборки.
 */

import { div, el } from '../../lib/dom.js';
import { t } from '../../lib/i18n.js';
import { uiButton } from '../../lib/ui/button.js';
import { createRecordTitle, type RecordTitleHandle } from './record-title.js';

/** Действия домена, подставляемые экраном в шапку слота. */
export interface SlotHeadHooks {
  /** Подпись даты/периода слота (псевдо-день). */
  dayLabel: string;
  /** Одиночный клик по заголовку в просмотре — свернуть/развернуть тело слота. */
  onToggle?: () => void;
  /** Завершение правки заголовка (`Enter`/уход из поля) — сохранить черновик. */
  onTitleCommit: (value: string) => void;
  /** Отмена слота (кнопка «✕»). */
  onCancel: () => void;
}

/** Результат сборки шапки слота. */
export interface SlotHead {
  /** Узел шапки: дата + узел компонента-заголовка + «✕». */
  root: HTMLElement;
  /** Дескриптор заголовка-компонента (правка/значение). */
  title: RecordTitleHandle;
}

/** Собрать шапку слота: дата, узел компонента-заголовка, кнопка отмены. */
export function buildSlotHead(hooks: SlotHeadHooks): SlotHead {
  const root = div('diary-record-head');
  const title = createRecordTitle({
    value: '',
    label: t('diary.emptyTitle'),
    editHint: t('diary.titleEditHint'),
    placeholder: t('diary.titlePlaceholder'),
    ...(hooks.onToggle !== undefined ? { onToggle: hooks.onToggle } : {}),
    onCommit: (next) => {
      hooks.onTitleCommit(next);
      return next.trim() || t('diary.emptyTitle');
    },
  });
  // В шапку монтируется ИМЕННО узел компонента (`title.node()`); порядок —
  // дата, заголовок, отмена (тот же, что был в `startSlot`).
  root.append(
    el('span', 'diary-record-date', hooks.dayLabel),
    title.node(),
    uiButton({
      label: '✕',
      role: 'ghost',
      size: 's',
      class: 'diary-slot-cancel',
      title: t('diary.slotCancel'),
      onClick: () => hooks.onCancel(),
    }),
  );
  return { root, title };
}

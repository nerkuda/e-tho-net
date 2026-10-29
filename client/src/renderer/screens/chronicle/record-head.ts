/**
 * Шапка дневниковой записи — единый конструктор карточки записи (0.10.3,
 * ошибка 47c2bf05; ранее `slot-head.ts`).
 *
 * Слот создания демонтирован (ТП «Дневник без псевдослота»): шапку собирает
 * только карточка существующей записи. Компонент сохранён как единый
 * конструктор — строка 1 «период, облачка привязок, + мысль, меню», строка 2 —
 * заголовок (элемент «Лента дневных записей» e01f383a).
 *
 * Состав шапки:
 *  • СТРОКА ПОЛЕЙ (первая): подпись даты/периода, контейнер привязок, кнопка
 *    «+ мысль» и завершающий элемент — меню записи.
 *  • СТРОКА ЗАГОЛОВКА (вторая): узел общего компонента `createRecordTitle`
 *    (`./record-title.ts`) — один контракт правки «просмотр ↔ правка» (ошибка
 *    36c330a3).
 *
 * Шапка собирается отдельным помощником, чтобы её можно было ИСПОЛНИТЬ в тесте
 * на DOM-шиме и убедиться, что узел заголовка — РЕАЛЬНО узел компонента
 * `createRecordTitle`, а не результат локальной сборки (сторож
 * `guard-chronicle-record-title`).
 *
 * **Шапка вне правки.** Дата/период и облачка привязок не входят в единую
 * правку записи (в ней только заголовок и тело), поэтому при обновлении строки
 * их можно синхронизировать, не пересобирая карточку и не отсоединяя живой
 * редактор: {@link RecordHead.setDayLabel} и {@link createRecordChips}. Без
 * этого добавленная к несохранённой записи мысль появлялась в облачках только
 * после сохранения (ошибка 78d600c9).
 */

import type { ChronicleRow, ChronicleTarget } from '@etn/shared';

import { div, el } from '../../lib/dom.js';
import { uiButton } from '../../lib/ui/button.js';
import { visibleChips } from './diary.js';
import {
  createRecordTitle,
  type RecordTitleHandle,
  type RecordTitleOptions,
} from './record-title.js';

/** Данные, подставляемые потребителем в шапку карточки записи. */
export interface RecordHeadHooks {
  /** Подпись даты/периода. */
  dayLabel: string;
  /** Клик по дате (открывает диалог «Дата/период»); нет — подпись без клика. */
  onDateClick?: () => void;
  /** Подсказка кликабельной даты («Период дневниковой записи»). */
  dateTitle?: string;
  /** Контейнер привязок карточки (`+ мысль` внутри шапки). */
  chips: HTMLElement;
  /** Действие «+ мысль». */
  onAddThought: () => void;
  /** Завершающий элемент строки полей — меню записи. */
  trailing: HTMLElement;
  /** Опции заголовка-компонента (надписи и доменные обработчики потребителя). */
  title: RecordTitleOptions;
}

/** Результат сборки шапки. */
export interface RecordHead {
  /** Корень шапки: строка полей + узел заголовка (обе строки). */
  root: HTMLElement;
  /** Строка полей: дата, привязки, «+ мысль», завершающий элемент. */
  row: HTMLElement;
  /** Узел даты/периода: подпись обновляется без пересборки строки. */
  date: HTMLElement;
  /**
   * Задать подпись даты/периода. Дата — не поле единой правки, поэтому её
   * значение синхронизируется сразу, в том числе пока карточка в правке
   * (иначе смена периода не видна до сохранения текста).
   */
  setDayLabel(label: string): void;
  /** Дескриптор заголовка-компонента (правка/значение). */
  title: RecordTitleHandle;
}

/** Опции контейнера облачков привязок записи. */
export interface RecordChipsOptions {
  /** Строка записи на момент сборки. */
  row: ChronicleRow;
  /**
   * HOME сети — служебная первичная привязка, в облачках не показывается
   * (требование c81964c7). Геттер: к моменту перерисовки HOME может
   * разрешиться позже сборки карточки.
   */
  homeId: () => string | null;
  /** Конструктор облачка привязки — доменные правила экрана (мысль/связь). */
  buildChip: (target: ChronicleTarget, rowId: string) => HTMLElement;
}

/** Контейнер облачков привязок записи с перерисовкой НА МЕСТЕ. */
export interface RecordChips {
  /** Узел контейнера (`.diary-record-chips`) для строки полей шапки. */
  box: HTMLElement;
  /**
   * Перерисовать облачка по СВЕЖИМ привязкам, не пересобирая контейнер и
   * карточку: добавленная к несохранённой записи мысль видна сразу, а не после
   * сохранения (ошибка 78d600c9).
   */
  sync(row: ChronicleRow): void;
}

/**
 * Создать контейнер облачков привязок записи. Привязки — часть МОДЕЛИ записи,
 * а не полей единой правки: их состав может измениться, пока карточка в правке
 * (прикрепили мысль, пришло realtime-событие), и отображение обязано догнать
 * модель без пересборки карточки.
 */
export function createRecordChips(opts: RecordChipsOptions): RecordChips {
  const box = div('diary-record-chips');
  const paint = (row: ChronicleRow): void => {
    box.replaceChildren();
    for (const target of visibleChips(row.targets, opts.homeId())) {
      box.append(opts.buildChip(target, row.id));
    }
  };
  paint(opts.row);
  return { box, sync: paint };
}

/** Собрать шапку записи: строка полей (дата, привязки, «+ мысль», завершение) и заголовок. */
export function buildRecordHead(hooks: RecordHeadHooks): RecordHead {
  const root = div('diary-record-head');
  const row = div('diary-record-head-row');

  // Дата: кликабельная кнопка (открывает диалог «Дата/период»), если задан
  // обработчик; иначе — некликабельная подпись. Класс один и тот же —
  // оформление единое.
  const date =
    hooks.onDateClick !== undefined
      ? uiButton({
          label: hooks.dayLabel,
          role: 'ghost',
          size: 's',
          class: 'diary-record-date',
          ...(hooks.dateTitle !== undefined ? { title: hooks.dateTitle } : {}),
          onClick: () => hooks.onDateClick?.(),
        })
      : el('span', 'diary-record-date', hooks.dayLabel);

  row.append(
    date,
    hooks.chips,
    uiButton({
      label: '+ мысль',
      role: 'ghost',
      size: 's',
      class: 'diary-chip-add',
      title: 'Добавить мысль',
      onClick: () => hooks.onAddThought(),
    }),
    hooks.trailing,
  );

  // Заголовок — ИМЕННО узел общего компонента, тот же, что даёт единый контракт
  // правки «просмотр ↔ правка» в обоих состояниях.
  const title = createRecordTitle(hooks.title);
  root.append(row, title.node());
  return {
    root,
    row,
    date,
    setDayLabel: (label: string) => {
      // У кнопки/подписи надпись — единственное содержимое: textContent
      // сохраняет класс и обработчик клика.
      date.textContent = label;
    },
    title,
  };
}

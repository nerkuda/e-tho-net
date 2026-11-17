/**
 * Модель панели «Задачи и напоминания» над лентой «Дневника» (0.16.1, задача
 * 64f7976a; элементы f76ed829/15f8ea2f/498f23e0; требования
 * 6762adb0/0e85b66e/e6af8b9e/3616cfec/db1d9548).
 *
 * Проверяются чистые правила без DOM и сети:
 *  • пороги группировки 1 / 2–14 / 15–50 / >50 (по мыслям/датам/неделям/месяцам);
 *  • неделя начинается с первого дня недели сети (1b77decd), месяц — календарный;
 *  • хвостовые группы «Без даты»/«Без мысли» и порядок строк внутри группы;
 *  • счётчики открытых/выполненных;
 *  • признак «строка устарела» (ревизия источника vs ревизия проекции, события
 *    правки) и общая потребность в «Обновить» (0e85b66e);
 *  • вхождения напоминаний: момент показа отложенного, секции
 *    «просрочено/сегодня/период» по МЕСТНЫМ суткам, названия субъектов.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Reminder, ReminderListResult, TaskDTO } from '@etn/shared';

import {
  TASK_GROUP_NO_DATE,
  TASK_GROUP_NO_SUBJECT,
  calendarDaysBetween,
  groupPanelRows,
  lastDayOfMonth,
  monthKeyOf,
  orderTaskRowsUndatedFirst,
  panelMarkerAdvanced,
  panelNeedsRefresh,
  planTaskBulk,
  flatReminderRows,
  nestedLinesByParent,
  reminderPanelRows,
  reminderRowOverdue,
  dueReminderCount,
  reminderRowKey,
  reminderSectionOf,
  replaceTaskLine,
  replaceTaskLineRange,
  setChecklistLineDone,
  shiftDay,
  taskCounters,
  taskGroupingMode,
  taskRowIsStale,
  taskRowKey,
  taskRowView,
  taskRowsForFilter,
  taskZoneVisible,
  weekStartOf,
  type PanelGroupable,
  type ReminderPanelRow,
} from '../src/renderer/lib/ui/task-panel-model.js';

/** Строка проекции с минимально нужными полями. */
function task(overrides: Partial<TaskDTO> & { comment_id?: string; line_no?: number }): TaskDTO {
  return {
    comment_id: 'c1',
    line_no: 0,
    text: 'задача',
    period_from: null,
    period_to: null,
    due: null,
    auto_period: false,
    done: false,
    subject_thoughts: [],
    subject_state: 'active',
    parent_task: null,
    subtask: false,
    revision: 1,
    parsed_revision: 1,
    owner_type: 'thought',
    owner_id: 't1',
    kind: 'chronological',
    ...overrides,
  };
}

/** Простая строка для проверки группировки. */
function row(key: string, day: string | null, subjectId: string | null = null): PanelGroupable {
  return { key, day, subjectId };
}

describe('пороги группировки (требование 6762adb0)', () => {
  it('1 — по мыслям, 2–14 — по датам, 15–50 — по неделям, >50 — по месяцам', () => {
    // Числа спеки 6762adb0 зафиксированы литералами: тест ловит сдвиг порога
    // (например, 14 → 15 в TASK_GROUP_THRESHOLDS), а не повторяет константу.
    assert.equal(taskGroupingMode(0), 'thoughts');
    assert.equal(taskGroupingMode(1), 'thoughts');
    assert.equal(taskGroupingMode(2), 'dates');
    assert.equal(taskGroupingMode(14), 'dates');
    assert.equal(taskGroupingMode(15), 'weeks');
    assert.equal(taskGroupingMode(50), 'weeks');
    assert.equal(taskGroupingMode(51), 'months');
  });
});

describe('календарные помощники (неделя сети, месяц)', () => {
  it('неделя начинается с первого дня недели сети (1b77decd)', () => {
    // 2026-11-14 — суббота.
    assert.equal(weekStartOf('2026-11-14', 1), '2026-11-09', 'понедельник');
    assert.equal(
      weekStartOf('2026-11-14', 7),
      '2026-11-08',
      'воскресенье: суббота в неделе с вс 8-го',
    );
    assert.equal(weekStartOf('2026-11-09', 7), '2026-11-08');
    // Невалидный номер дня недели трактуется как понедельник.
    assert.equal(weekStartOf('2026-11-14', 0), '2026-11-09');
  });

  it('месяц — календарный, последний день учитывает високосность', () => {
    assert.equal(monthKeyOf('2026-11-14'), '2026-11');
    assert.equal(lastDayOfMonth('2026-11'), '2026-11-30');
    assert.equal(lastDayOfMonth('2024-02'), '2024-02-29');
    assert.equal(lastDayOfMonth('2025-02'), '2025-02-28');
  });

  it('сдвиг дня не выходит за календарь и не портит невалидный вход', () => {
    assert.equal(shiftDay('2026-12-31', 1), '2027-01-01');
    assert.equal(shiftDay('2026-03-01', -1), '2026-02-28');
    assert.equal(shiftDay('', 1), '', 'невалидный день возвращается как есть');
  });
});

describe('группировка строк (пороги 6762adb0)', () => {
  it('по датам: группы дней в порядке появления, «Без даты» — последней', () => {
    const groups = groupPanelRows(
      [row('a', '2026-11-14'), row('b', '2026-11-12'), row('c', '2026-11-14'), row('d', null)],
      'dates',
      { firstDayOfWeek: 1 },
    );
    assert.deepEqual(
      groups.map((group) => [group.key, group.from, group.to]),
      [
        ['date:2026-11-14', '2026-11-14', '2026-11-14'],
        ['date:2026-11-12', '2026-11-12', '2026-11-12'],
        [TASK_GROUP_NO_DATE, null, null],
      ],
    );
    assert.deepEqual(
      groups.map((group) => group.rows.map((item) => item.key)),
      [['a', 'c'], ['b'], ['d']],
    );
  });

  it('по неделям: диапазон недели считается от первого дня недели сети', () => {
    const rows = [row('a', '2026-11-09'), row('b', '2026-11-15'), row('c', '2026-11-16')];
    const monday = groupPanelRows(rows, 'weeks', { firstDayOfWeek: 1 });
    assert.deepEqual(
      monday.map((group) => [group.from, group.to, group.rows.length]),
      [
        ['2026-11-09', '2026-11-15', 2],
        ['2026-11-16', '2026-11-22', 1],
      ],
    );
    const sunday = groupPanelRows(rows, 'weeks', { firstDayOfWeek: 7 });
    assert.deepEqual(
      sunday.map((group) => [group.from, group.to, group.rows.length]),
      [
        ['2026-11-08', '2026-11-14', 1],
        ['2026-11-15', '2026-11-21', 2],
      ],
      'при первом дне недели — воскресенье те же дни попадают в разные недели',
    );
  });

  it('по месяцам: группа месяца и её границы', () => {
    const groups = groupPanelRows([row('a', '2026-01-31'), row('b', '2026-01-01')], 'months', {
      firstDayOfWeek: 1,
    });
    assert.deepEqual(
      groups.map((group) => [group.key, group.from, group.to]),
      [['month:2026-01', '2026-01-01', '2026-01-31']],
    );
  });

  it('по мыслям: группы субъектов, «Без мысли» — последней, диапазон объединяется', () => {
    const groups = groupPanelRows(
      [
        row('a', '2026-11-01', 't1'),
        row('b', '2026-11-05', 't2'),
        row('c', '2026-11-03', 't1'),
        row('d', null, null),
      ],
      'thoughts',
      { firstDayOfWeek: 1 },
    );
    assert.deepEqual(
      groups.map((group) => [group.key, group.subjectId, group.from, group.to]),
      [
        ['thought:t1', 't1', '2026-11-01', '2026-11-03'],
        ['thought:t2', 't2', '2026-11-05', '2026-11-05'],
        [TASK_GROUP_NO_SUBJECT, null, null, null],
      ],
    );
  });
});

describe('счётчики и «серая строка» (0e85b66e)', () => {
  it('счётчики считают открытые и выполненные', () => {
    assert.deepEqual(taskCounters([task({ done: false }), task({ done: true }), task({})]), {
      open: 2,
      done: 1,
    });
    assert.deepEqual(taskCounters([]), { open: 0, done: 0 });
  });

  it('строка устарела при рассинхроне ревизий или изменении записи снаружи', () => {
    const fresh = task({ comment_id: 'a', revision: 4, parsed_revision: 4 });
    assert.equal(taskRowIsStale(fresh), false);
    const behind = task({ comment_id: 'b', revision: 5, parsed_revision: 4 });
    assert.equal(taskRowIsStale(behind), true, 'проекция отстала от ревизии записи');
    assert.equal(
      taskRowIsStale(fresh, { comments: new Set(['a']) }),
      true,
      'внешнее изменение записи красит строку',
    );
    assert.equal(taskRowIsStale(fresh, { comments: new Set(['другой']) }), false);
    // Ошибка d318a647: правка ИЗ ПАНЕЛИ адресует строку, а не запись, поэтому
    // соседняя строка той же записи остаётся свежей и рабочей.
    const neighbour = task({ comment_id: 'a', line_no: 1, revision: 4, parsed_revision: 4 });
    assert.equal(taskRowIsStale(fresh, { rows: new Set(['a:0']) }), true);
    assert.equal(taskRowIsStale(neighbour, { rows: new Set(['a:0']) }), false);
  });

  it('чекбокс переключённой из панели строки показывает новое состояние (d318a647)', () => {
    const row = task({ comment_id: 'a', done: false });
    assert.equal(
      taskRowView(row, {}, true).done,
      true,
      'повторный клик снимает отметку — галочка следует за командой',
    );
    assert.equal(taskRowView(row, {}, false).done, false);
    assert.equal(taskRowView(row).done, false, 'без переопределения — снапшот `done`');
  });

  it('«Обновить» нужен при событиях напоминаний или устаревшей строке', () => {
    const rows = [task({ comment_id: 'a', revision: 2, parsed_revision: 2 })];
    assert.equal(panelNeedsRefresh({ rows }), false);
    assert.equal(panelNeedsRefresh({ rows, remindersChanged: true }), true);
    assert.equal(panelNeedsRefresh({ rows, stale: { comments: new Set(['a']) } }), true);
    assert.equal(
      panelNeedsRefresh({ rows, stale: { rows: new Set(['a:0']) } }),
      true,
      'серая строка подсвечивает «Обновить»',
    );
    assert.equal(
      panelNeedsRefresh({ rows: [task({ comment_id: 'a', revision: 3, parsed_revision: 2 })] }),
      true,
    );
  });

  it('глобальный маркер проекции сравнивается с загруженным `max_revision`', () => {
    assert.equal(panelMarkerAdvanced(8, 7), true, 'ревизия события новее загруженной');
    assert.equal(panelMarkerAdvanced(7, 7), false, 'тот же маркер — не устарело');
    assert.equal(panelMarkerAdvanced(6, 7), false);
    assert.equal(panelMarkerAdvanced(null, 7), false, 'событие без ревизии не красит панель');
    assert.equal(
      panelNeedsRefresh({ rows: [], markerAdvanced: true }),
      true,
      'маркер ушёл вперёд — «Обновить» подсвечена',
    );
  });

  it('массовая команда в периоде не трогает задачи вне периода', () => {
    const rows = [
      task({
        comment_id: 'in',
        period_from: '2026-11-14',
        period_to: '2026-11-20',
        due: '2026-11-20',
      }),
      task({
        comment_id: 'before',
        period_from: '2026-11-01',
        period_to: '2026-11-10',
        due: '2026-11-10',
      }),
      task({
        comment_id: 'after',
        period_from: '2026-12-01',
        period_to: '2026-12-05',
        due: '2026-12-05',
      }),
      task({ comment_id: 'undated', period_from: null, period_to: null, due: null }),
    ];
    const filter = { scope: 'open' as const, from: '2026-11-14', to: '2026-11-20' };
    assert.deepEqual(
      taskRowsForFilter(rows, filter).map((row) => row.comment_id),
      ['in'],
      'пересечение с периодом — только одна строка',
    );
    assert.deepEqual(
      taskRowsForFilter(rows, { scope: 'undated' }).map((row) => row.comment_id),
      ['undated'],
    );
    assert.deepEqual(
      taskRowsForFilter(rows, { scope: 'overdue', today: '2026-11-14' }).map(
        (row) => row.comment_id,
      ),
      ['before'],
    );
  });

  it('подтверждение массовой команды считает строки, а undo — записи', () => {
    const rows = [
      task({ comment_id: 'c1', line_no: 0, period_from: '2026-11-14', period_to: '2026-11-14' }),
      task({ comment_id: 'c1', line_no: 1, period_from: '2026-11-14', period_to: '2026-11-14' }),
      task({ comment_id: 'c2', line_no: 0, period_from: '2026-11-14', period_to: '2026-11-14' }),
    ];
    const plan = planTaskBulk(rows, { scope: 'open', from: '2026-11-14', to: '2026-11-14' });
    assert.equal(plan.rows.length, 3, 'строк — три');
    assert.deepEqual(plan.commentIds, ['c1', 'c2'], 'записей — две');
  });

  it('замена строки сохраняет её сырой текст с маркером', () => {
    const body = '- [ ] старая [[2026-11-14]]\n- [x] вторая';
    assert.equal(
      replaceTaskLine(body, 0, '- [x] новая [[2026-11-15]]'),
      '- [x] новая [[2026-11-15]]\n- [x] вторая',
      'маркер и чекбокс — часть строки, а не снапшота без них',
    );
    assert.equal(replaceTaskLine(body, 1, '- [x] вторая'), body, 'без изменений — тот же текст');
    assert.equal(replaceTaskLine(body, 5, '- [ ] нет строки'), null);
  });

  it('разница дат считается календарными днями', () => {
    assert.equal(calendarDaysBetween('2026-11-14', '2026-11-20'), 6);
    assert.equal(calendarDaysBetween('2026-11-20', '2026-11-14'), -6);
    assert.equal(calendarDaysBetween('2026-12-31', '2027-01-01'), 1);
  });

  // 0.16.1, замечания 3 и 4 ТЗ 2026-11-18 (задача 7446eb25).

  it('блочная правка заменяет диапазон строк включительно и умеет удалять блок', () => {
    const body = '- [ ] задача\n  - [ ] пункт\n  текст\n- [ ] соседняя';
    assert.equal(
      replaceTaskLineRange(body, 0, 2, '- [ ] задача\n  - [x] пункт\n  текст'),
      '- [ ] задача\n  - [x] пункт\n  текст\n- [ ] соседняя',
      'правится весь блок: строка задачи и её вложенные строки',
    );
    assert.equal(
      replaceTaskLineRange(body, 0, 2, ''),
      '- [ ] соседняя',
      'пустой текст удаляет блок целиком',
    );
    assert.equal(
      replaceTaskLineRange(body, 0, 2, '- [ ] задача\n  - [ ] пункт\n  текст'),
      body,
      'тот же блок — тот же текст (лишней ревизии не будет)',
    );
    assert.equal(replaceTaskLineRange(body, 0, 9, 'x'), null, 'диапазон за границей — отказ');
    assert.equal(replaceTaskLineRange(body, 2, 1, 'x'), null, 'обратный диапазон — отказ');
  });

  it('отметка пункта чек-листа правит ровно маркер `[ ]`→`[x]`, сохраняя отступ и текст', () => {
    assert.equal(setChecklistLineDone('  - [ ] пункт', true), '  - [x] пункт');
    assert.equal(setChecklistLineDone('  - [x] пункт', false), '  - [ ] пункт');
    assert.equal(
      setChecklistLineDone('- [X] пункт', false),
      '- [ ] пункт',
      'заглавная отметка снимается',
    );
    assert.equal(
      setChecklistLineDone('- [ ] пункт **[ссылка]**', true),
      '- [x] пункт **[ссылка]**',
      'хвост строки не задет',
    );
    assert.equal(
      setChecklistLineDone('- обычная строка', true),
      null,
      'не пункт чек-листа — отказ',
    );
  });

  it('строка панели несёт адрес проекции, день срока и субъекта', () => {
    const view = taskRowView(
      task({
        comment_id: 'c9',
        line_no: 3,
        text: '- [ ] задача',
        period_from: '2026-11-10',
        due: '2026-11-14',
        subject_thoughts: ['t1', 't2'],
      }),
    );
    assert.equal(view.key, taskRowKey({ comment_id: 'c9', line_no: 3 }), 'ключ = адрес проекции');
    assert.equal(view.day, '2026-11-14', 'день строки — срок');
    assert.equal(view.subjectId, 't1');
    assert.equal(view.stale, false);
  });
});

describe('вхождения напоминаний (требования 6762adb0/86cb7451)', () => {
  /** Напоминание с одним-двумя вхождениями. */
  function reminder(overrides: Partial<Reminder> = {}): Reminder {
    return {
      id: 'r1',
      user_id: 'u1',
      subject_type: 'thought',
      subject_id: 't1',
      subject_state: 'active',
      kind: 'one',
      schedule: { type: 'once' },
      anchor_at: '2026-11-14T09:00:00.000Z',
      next_at: '2026-11-14T09:00:00.000Z',
      exceptions: {},
      state: 'active',
      occurrences: [{ occurrence_at: '2026-11-14T09:00:00.000Z', status: 'active', until: null }],
      created_at: '2026-11-01T00:00:00.000Z',
      updated_at: '2026-11-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('отложенное вхождение показывается в момент `until`, ключ — момент расписания', () => {
    const result: ReminderListResult = {
      reminders: [
        reminder({
          occurrences: [
            {
              occurrence_at: '2026-11-14T09:00:00.000Z',
              status: 'snoozed',
              until: '2026-11-15T10:00:00.000Z',
            },
          ],
        }),
      ],
      from: null,
      to: null,
    };
    const rows = reminderPanelRows(result, new Map([['thought:t1', 'Мысль']]), () => 'однократно');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.moment, '2026-11-15T10:00:00.000Z', 'момент показа — `until`');
    assert.equal(rows[0]?.status, 'snoozed');
    assert.equal(rows[0]?.title, 'Мысль');
    assert.equal(rows[0]?.key, reminderRowKey('r1', '2026-11-14T09:00:00.000Z'));
  });

  it('название субъекта до доразрешения — его id', () => {
    const result: ReminderListResult = { reminders: [reminder()], from: null, to: null };
    const rows = reminderPanelRows(result, new Map(), () => 'однократно');
    assert.equal(rows[0]?.title, 't1');
  });

  it('секция вхождения — по местным суткам: прошлое/сегодня/период', () => {
    const todayStart = Date.parse('2026-11-14T00:00:00.000+03:00');
    const todayEnd = Date.parse('2026-11-15T00:00:00.000+03:00');
    const section = (moment: string): string =>
      reminderSectionOf(
        {
          key: 'k',
          reminderId: 'r1',
          subjectType: 'thought',
          subjectId: 't1',
          title: 't',
          moment,
          occurrenceAt: moment,
          status: 'active',
          repeat: '',
          day: moment.slice(0, 10),
        },
        todayStart,
        todayEnd,
      );
    assert.equal(section('2026-11-13T23:59:00.000+03:00'), 'overdue');
    assert.equal(section('2026-11-14T00:00:00.000+03:00'), 'today');
    assert.equal(section('2026-11-14T23:59:00.000+03:00'), 'today');
    assert.equal(section('2026-11-15T00:00:00.000+03:00'), 'period');
    assert.equal(section('не момент'), 'period', 'невалидный момент — не просрочка');
  });

  it('счётчик бейджа «сегодня»: сегодняшние + просроченные вхождения, будущие — нет', () => {
    const todayEnd = Date.parse('2026-11-15T00:00:00.000+03:00');
    const result: ReminderListResult = {
      reminders: [
        reminder({
          occurrences: [
            { occurrence_at: '2026-11-14T09:00:00.000+03:00', status: 'active', until: null },
            { occurrence_at: '2026-11-10T09:00:00.000+03:00', status: 'active', until: null },
            {
              // Отложенное вхождение видно по `until` — считаем момент показа.
              occurrence_at: '2026-11-01T09:00:00.000+03:00',
              status: 'snoozed',
              until: '2026-11-14T18:00:00.000+03:00',
            },
            { occurrence_at: '2026-11-20T09:00:00.000+03:00', status: 'active', until: null },
            {
              occurrence_at: '2026-11-25T09:00:00.000+03:00',
              status: 'snoozed',
              until: '2026-12-01T09:00:00.000+03:00',
            },
          ],
        }),
      ],
      from: null,
      to: null,
    };
    assert.equal(dueReminderCount(result, todayEnd), 3, 'два вхождения + отложенное на сегодня');
    assert.equal(
      dueReminderCount({ reminders: [], from: null, to: null }, todayEnd),
      0,
      'нет напоминаний — ноль (бейдж скрыт)',
    );
  });
});

describe('порядок панели редактора мысли (элемент f3893859)', () => {
  it('строки без даты — всегда вверху, дальше срок по возрастанию', () => {
    const rows = [
      { key: 'a', due: '2026-11-20' },
      { key: 'b', due: null },
      { key: 'c', due: '2026-11-14' },
      { key: 'd', due: null },
      { key: 'e', due: '2026-11-14' },
    ];
    assert.deepEqual(
      orderTaskRowsUndatedFirst(rows).map((row) => row.key),
      ['b', 'd', 'c', 'e', 'a'],
      'срок по возрастанию, равные сроки — в исходном (серверном) порядке',
    );
  });

  it('исходный массив не мутируется', () => {
    const rows = [
      { key: 'a', due: '2026-11-20' },
      { key: 'b', due: null },
    ];
    const ordered = orderTaskRowsUndatedFirst(rows);
    assert.deepEqual(
      rows.map((row) => row.key),
      ['a', 'b'],
    );
    assert.notEqual(ordered, rows);
  });
});

describe('видимость зоны «Задачи» вкладки «Основное» (f3893859)', () => {
  it('пустая панель скрывается — комментарий занимает вкладку', () => {
    assert.equal(
      taskZoneVisible({ rowCount: 0, loading: false, hasError: false, canUndo: false }),
      false,
    );
  });

  it('строки, загрузка и ошибка держат зону видимой', () => {
    assert.equal(
      taskZoneVisible({ rowCount: 2, loading: false, hasError: false, canUndo: false }),
      true,
    );
    assert.equal(
      taskZoneVisible({ rowCount: 0, loading: true, hasError: false, canUndo: false }),
      true,
    );
    assert.equal(
      taskZoneVisible({ rowCount: 0, loading: false, hasError: true, canUndo: false }),
      true,
    );
  });

  it('доступная отмена массовой команды держит зону видимой (вердикт 7448ac21)', () => {
    // Массовое снятие задач опустошило панель, но «Отменить» живёт в шапке
    // группы: скрытая зона сделала бы её недоступной.
    assert.equal(
      taskZoneVisible({ rowCount: 0, loading: false, hasError: false, canUndo: true }),
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// 0.16.1, замечания пользователя 2026-11-17 (задача 01998381): пункты D и F.
// ---------------------------------------------------------------------------

describe('вложенные строки под задачей (пункт F ТЗ 2026-11-17)', () => {
  it('вложенные строки раскладываются по адресу родителя и несут уровень списка', () => {
    const map = nestedLinesByParent([
      {
        comment_id: 'c1',
        line_no: 1,
        parent: { comment_id: 'c1', line_no: 0 },
        text: 'пункт чек-листа',
        depth: 1,
        checkbox: true,
        done: false,
      },
      {
        comment_id: 'c1',
        line_no: 2,
        parent: { comment_id: 'c1', line_no: 0 },
        text: 'вложенный текст',
        depth: 1,
        checkbox: false,
        done: false,
      },
      {
        comment_id: 'c1',
        line_no: 5,
        parent: { comment_id: 'c1', line_no: 4 },
        text: 'у другой задачи',
        depth: 1,
        checkbox: false,
        done: false,
      },
    ]);
    assert.deepEqual(
      (map.get('c1:0') ?? []).map((child) => [child.text, child.depth, child.checkbox]),
      [
        ['пункт чек-листа', 1, true],
        ['вложенный текст', 1, false],
      ],
      'дети первой задачи идут в порядке источника',
    );
    assert.deepEqual(
      (map.get('c1:4') ?? []).map((child) => child.key),
      ['c1:5'],
      'дети второй задачи — своими',
    );
    assert.equal(map.size, 2, 'лишних адресов нет');
    assert.equal(nestedLinesByParent(undefined).size, 0, 'без флага вложенных строк нет');
  });

  it('строка строки задачи несёт детей и признак просрочки (пункты D и F)', () => {
    const view = taskRowView(
      task({ due: '2026-11-10', period_from: '2026-11-10', period_to: '2026-11-10' }),
      {},
      undefined,
      {
        today: '2026-11-17',
        children: [{ key: 'c1:1', lineNo: 1, text: 'подпункт', depth: 1, checkbox: true }],
      },
    );
    assert.equal(view.overdue, true, 'срок в прошлом — строка красная');
    assert.deepEqual(
      view.children.map((child) => child.text),
      ['подпункт'],
      'дети доехали до строки панели',
    );

    const fresh = taskRowView(task({ due: '2026-11-20' }), {}, undefined, { today: '2026-11-17' });
    assert.equal(fresh.overdue, false, 'будущий срок не просрочен');
    assert.deepEqual(fresh.children, [], 'без детей строка не сворачивается');

    const done = taskRowView(task({ due: '2026-11-10', done: true }), {}, undefined, {
      today: '2026-11-17',
    });
    assert.equal(done.overdue, false, 'выполненная задача не просрочена');
  });

  it('без границы «сегодня» просрочка не считается (сутки считает клиент)', () => {
    const view = taskRowView(task({ due: '2020-01-01' }));
    assert.equal(view.overdue, false);
  });
});

describe('напоминания при одной дате и просрочка (пункт D ТЗ 2026-11-17)', () => {
  function reminderRow(moment: string): ReminderPanelRow {
    return {
      key: `r:${moment}`,
      reminderId: 'r',
      subjectType: 'thought',
      subjectId: 't1',
      title: 'Мысль',
      moment,
      occurrenceAt: moment,
      status: 'active',
      repeat: '',
      day: moment.slice(0, 10),
    };
  }

  it('плоский список — по моменту показа, ближайшее сверху', () => {
    const rows = [
      reminderRow('2026-11-17T18:00:00.000Z'),
      reminderRow('2026-11-17T09:00:00.000Z'),
      reminderRow('2026-11-17T12:00:00.000Z'),
    ];
    assert.deepEqual(
      flatReminderRows(rows).map((row) => row.moment),
      ['2026-11-17T09:00:00.000Z', '2026-11-17T12:00:00.000Z', '2026-11-17T18:00:00.000Z'],
    );
    assert.deepEqual(
      rows.map((row) => row.moment),
      ['2026-11-17T18:00:00.000Z', '2026-11-17T09:00:00.000Z', '2026-11-17T12:00:00.000Z'],
      'исходный массив не мутируется',
    );
  });

  it('просроченность вхождения — момент раньше начала местных суток', () => {
    const todayStart = Date.parse('2026-11-17T00:00:00.000Z');
    assert.equal(reminderRowOverdue(reminderRow('2026-11-16T23:59:00.000Z'), todayStart), true);
    assert.equal(reminderRowOverdue(reminderRow('2026-11-17T00:00:00.000Z'), todayStart), false);
    assert.equal(reminderRowOverdue(reminderRow('2026-11-17T09:00:00.000Z'), todayStart), false);
  });

  it('строки напоминаний получают признак просрочки только при переданной границе', () => {
    const result: ReminderListResult = {
      reminders: [
        {
          id: 'r1',
          user_id: 'u1',
          subject_type: 'thought',
          subject_id: 't1',
          subject_state: 'active',
          kind: 'one',
          schedule: { type: 'once' },
          anchor_at: '2026-11-16T09:00:00.000Z',
          next_at: '2026-11-16T09:00:00.000Z',
          exceptions: {},
          state: 'active',
          occurrences: [
            { occurrence_at: '2026-11-16T09:00:00.000Z', status: 'active', until: null },
          ],
          created_at: '2026-11-01T00:00:00.000Z',
          updated_at: '2026-11-01T00:00:00.000Z',
        },
      ],
      from: null,
      to: null,
    };
    const titles = new Map([['thought:t1', 'Мысль']]);
    const todayStart = Date.parse('2026-11-17T00:00:00.000Z');
    assert.equal(reminderPanelRows(result, titles, () => '', todayStart)[0]?.overdue, true);
    assert.equal(
      reminderPanelRows(result, titles, () => '')[0]?.overdue,
      undefined,
      'без границы признак не считается',
    );
  });
});

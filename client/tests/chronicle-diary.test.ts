/**
 * Чистые помощники экрана «Дневник» (0.10.1, задача T6 64ca2b48):
 * локальный день, периоды календаря, разворот длинной записи по дням,
 * группировка ленты, ленивое создание псевдо-записи и состав чипсов.
 *
 * Тесты без DOM и сети (конвенция `tests/zone-paging.test.ts`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ChronicleRow, ChronicleTarget } from '@etn/shared';

import {
  addDays,
  applyPeriodToFilter,
  clampPseudoDate,
  dayPeriod,
  groupByLocalDays,
  hasRecordContent,
  isLastChip,
  isoWeekNumber,
  localDay,
  resolvePeriodDay,
  rowDays,
  slotDeleteNeedsNetwork,
  visibleChips,
  weekPeriod,
} from '../src/renderer/screens/chronicle/diary.js';

/** Минимальная запись ленты. */
function row(over: Partial<ChronicleRow>): ChronicleRow {
  return {
    id: 'r',
    title: null,
    valid_from: '2026-09-26T12:00:00.000Z',
    valid_to: '2026-09-26T12:00:00.000Z',
    use_time: false,
    version: 1,
    created_at: '2026-09-26T12:00:00.000Z',
    updated_at: '2026-09-26T12:00:00.000Z',
    created_by: 'u',
    updated_by: 'u',
    snippet: '',
    targets: [],
    ...over,
  };
}

function thoughtTarget(id: string): ChronicleTarget {
  return {
    kind: 'thought',
    thought: { id, title: id, icon: null, fg_color: null, bg_color: null } as never,
  };
}

describe('diary: локальный день и токены периода', () => {
  it('«голая дата» возвращается как есть, инстанс — по локальной зоне', () => {
    assert.equal(localDay('2026-09-26'), '2026-09-26');
    // Полдень UTC — один и тот же календарный день для поясов ±11h.
    assert.equal(localDay('2026-09-26T12:00:00.000Z'), '2026-09-26');
    assert.equal(localDay(''), '');
    assert.equal(localDay('не дата'), '');
  });

  it('addDays ходит по календарю без переходов DST', () => {
    assert.equal(addDays('2026-09-26', 1), '2026-09-27');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  });

  it('resolvePeriodDay раскрывает глобальные токены относительно сегодня', () => {
    const today = '2026-09-26';
    assert.equal(resolvePeriodDay('$today', today), '2026-09-26');
    assert.equal(resolvePeriodDay('$now', today), '2026-09-26');
    assert.equal(resolvePeriodDay('$today-7d', today), '2026-09-19');
    assert.equal(resolvePeriodDay('$today+1d', today), '2026-09-27');
    assert.equal(resolvePeriodDay('2026-01-02', today), '2026-01-02');
    assert.equal(resolvePeriodDay('', today), '');
  });

  it('clampPseudoDate зажимает сегодня в границы периода (26f0aa52)', () => {
    assert.equal(clampPseudoDate('2026-09-26', '', ''), '2026-09-26');
    assert.equal(clampPseudoDate('2026-09-01', '2026-09-10', '2026-09-20'), '2026-09-10');
    assert.equal(clampPseudoDate('2026-09-30', '2026-09-10', '2026-09-20'), '2026-09-20');
    assert.equal(clampPseudoDate('2026-09-15', '2026-09-10', '2026-09-20'), '2026-09-15');
  });
});

describe('diary: разворот записи по дням периода (e0970b70)', () => {
  it('однодневная запись видна только в своём дне', () => {
    assert.deepEqual(rowDays(row({})), ['2026-09-26']);
  });

  it('длительная запись видна в каждом дне интервала', () => {
    const long = row({
      valid_from: '2026-09-25T12:00:00.000Z',
      valid_to: '2026-09-27T12:00:00.000Z',
    });
    assert.deepEqual(rowDays(long), ['2026-09-25', '2026-09-26', '2026-09-27']);
  });

  it('границы периода включительны, а не пересечение — запись отсекается', () => {
    const long = row({
      valid_from: '2026-09-25T12:00:00.000Z',
      valid_to: '2026-09-27T12:00:00.000Z',
    });
    assert.deepEqual(rowDays(long, '2026-09-26', '2026-09-26'), ['2026-09-26']);
    assert.deepEqual(rowDays(long, '2026-09-26', '2026-09-30'), ['2026-09-26', '2026-09-27']);
    assert.deepEqual(rowDays(long, '2026-10-01', '2026-10-05'), []);
  });
});

describe('diary: группировка ленты по дням (c6ddc1ea)', () => {
  it('сохраняет серверный порядок записей внутри дня', () => {
    // Сервер уже отсортировал (класс 0 впереди): клиент не пересортировывает.
    const first = row({ id: 'class0', valid_from: '2026-09-26T13:00:00.000Z' });
    const second = row({ id: 'class1', valid_from: '2026-09-26T12:00:00.000Z' });
    const days = groupByLocalDays([first, second]);
    assert.equal(days.length, 1);
    assert.deepEqual(days[0]!.rows.map((r) => r.id), ['class0', 'class1']);
  });

  it('дни идут по возрастанию, длинная запись попадает в каждый день', () => {
    const long = row({
      id: 'long',
      valid_from: '2026-09-25T12:00:00.000Z',
      valid_to: '2026-09-27T12:00:00.000Z',
    });
    const only = row({ id: 'only', valid_from: '2026-09-26T12:00:00.000Z' });
    const days = groupByLocalDays([only, long]);
    assert.deepEqual(days.map((d) => d.day), ['2026-09-25', '2026-09-26', '2026-09-27']);
    const d26 = days.find((d) => d.day === '2026-09-26')!;
    assert.deepEqual(d26.rows.map((r) => r.id), ['only', 'long']);
    assert.deepEqual(days.find((d) => d.day === '2026-09-25')!.rows.map((r) => r.id), ['long']);
  });

  it('период ограничивает дни ленты', () => {
    const long = row({
      id: 'long',
      valid_from: '2026-09-25T12:00:00.000Z',
      valid_to: '2026-09-27T12:00:00.000Z',
    });
    const days = groupByLocalDays([long], { from: '2026-09-26', to: '2026-09-27' });
    assert.deepEqual(days.map((d) => d.day), ['2026-09-26', '2026-09-27']);
  });
});

describe('diary: клик календаря = новый период, прочие критерии целы', () => {
  it('день даёт период из одной даты, неделя — понедельник…воскресенье', () => {
    assert.deepEqual(dayPeriod('2026-09-26'), { from: '2026-09-26', to: '2026-09-26' });
    // 2026-09-26 — суббота; неделя начинается с понедельника 2026-09-21.
    assert.deepEqual(weekPeriod('2026-09-26'), { from: '2026-09-21', to: '2026-09-27' });
  });

  it('applyPeriodToFilter меняет только поля периода (копия, не мутация)', () => {
    const filter = {
      dateFrom: '',
      dateTo: '',
      keywords: 'важное',
      thoughtIds: ['a'],
      order: 'desc' as const,
    };
    const next = applyPeriodToFilter(filter, dayPeriod('2026-09-26'));
    assert.notEqual(next, filter, 'возвращается копия');
    assert.deepEqual(next, {
      dateFrom: '2026-09-26',
      dateTo: '2026-09-26',
      keywords: 'важное',
      thoughtIds: ['a'],
      order: 'desc',
    });
    assert.equal(filter.dateFrom, '', 'исходный отбор не мутируется');
  });

  it('isoWeekNumber считает номер ISO-недели по четвергу', () => {
    assert.equal(isoWeekNumber('2024-01-01'), 1);
    assert.equal(isoWeekNumber('2023-01-01'), 52, 'воскресенье относится к прошлой ISO-неделе');
    assert.equal(isoWeekNumber('2021-01-01'), 53);
    assert.equal(isoWeekNumber('2026-09-26'), isoWeekNumber('2026-09-21'));
  });
});

describe('diary: ленивое создание псевдо-записи (26f0aa52)', () => {
  it('пустая псевдо-запись не создаётся, любой содержательный элемент — да', () => {
    assert.equal(hasRecordContent({}), false);
    assert.equal(hasRecordContent({ title: '  ', body: '\n' }), false);
    assert.equal(hasRecordContent({ title: 'Встреча' }), true);
    assert.equal(hasRecordContent({ body: 'текст' }), true);
    assert.equal(hasRecordContent({ bindings: 1 }), true);
  });

  it('удаление пустого слота не требует сети', () => {
    assert.equal(slotDeleteNeedsNetwork(null), false);
    assert.equal(slotDeleteNeedsNetwork('comment-1'), true);
  });
});

describe('diary: чипсы записи (c81964c7)', () => {
  it('HOME не показывается чипом, прочие привязки — да', () => {
    const targets = [thoughtTarget('home'), thoughtTarget('idea')];
    assert.deepEqual(
      visibleChips(targets, 'home').map((t) => (t.kind === 'thought' ? t.thought.id : 'link')),
      ['idea'],
    );
    assert.deepEqual(visibleChips(targets, null).length, 2);
  });

  it('снятие последнего чипса распознаётся', () => {
    assert.equal(isLastChip([]), true);
    assert.equal(isLastChip([thoughtTarget('a')]), true);
    assert.equal(isLastChip([thoughtTarget('a'), thoughtTarget('b')]), false);
  });
});

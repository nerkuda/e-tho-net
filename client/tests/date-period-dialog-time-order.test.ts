/**
 * Регресс ошибки d4fbeaf7: диалог даты/периода не проверял ВРЕМЯ — при
 * одинаковых датах «время по» можно было поставить раньше «времени с».
 *
 * Ожидаемое поведение (карточка ошибки): при одинаковых датах «С» и «По»
 * проверка времени зеркалит проверку дат — «время по» не раньше «времени с»
 * (ввод «время с» > «время по» подтягивает «По» к «С» и наоборот); при разных
 * датах период охватывает больше суток, время границ свободно.
 *
 * Проверки — на РЕАЛЬНОМ компоненте `buildDatePeriodDialog` под DOM-шимом
 * (как `chronicle-acceptance-iter8.test.ts`): и через событие `change` поля
 * времени, и через «живое» чтение `getValue()` (подтверждение «ОК» без потери
 * фокуса, штатный путь `showDialog`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

/** Минимальный DOM-шим: хватает для диалога и полей `lib/ui` (из iter8). */
function installShim(): void {
  const body = new ShimElement('body');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).document = {
    documentElement: new ShimElement('html'),
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (text: string) => new ShimElement('#text', undefined, text),
    body,
    activeElement: body,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  win['setTimeout'] = setTimeout;
  win['clearTimeout'] = clearTimeout;
  win['innerWidth'] = 1200;
  win['innerHeight'] = 800;
  win['addEventListener'] = () => undefined;
  win['removeEventListener'] = () => undefined;
  win['dispatchEvent'] = () => undefined;
}

interface DialogHandle {
  root: ShimElement;
  getValue(): {
    mode: string;
    from: string;
    to: string;
    hasTime: boolean;
    fromTime: string;
    toTime: string;
  };
}

/** Поля времени нижней строки значения: [«с», «по»]. */
function timeInputs(root: ShimElement): ShimElement[] {
  return root.querySelectorAll('.dpd-time');
}

async function buildDialog(
  initial: Record<string, unknown>,
): Promise<DialogHandle> {
  installShim();
  const mod = (await import('../src/renderer/lib/date-period-dialog.js')) as unknown as {
    buildDatePeriodDialog: (o: Record<string, unknown>) => DialogHandle;
  };
  return mod.buildDatePeriodDialog({ allowPeriod: true, allowTime: true, initial });
}

describe('диалог даты/периода: порядок времени (ошибка d4fbeaf7)', () => {
  it('одинаковые даты: «время по» раньше «времени с» → обе границы равны «времени по»', async () => {
    const dialog = await buildDialog({
      mode: 'period',
      from: '2026-09-26',
      to: '2026-09-26',
      hasTime: true,
      fromTime: '10:00',
      toTime: '10:00',
    });
    const times = timeInputs(dialog.root);
    assert.equal(times.length, 2, 'в периоде два поля времени');
    times[1]!.value = '08:00';
    times[1]!.emit('change');
    assert.deepEqual(
      { fromTime: dialog.getValue().fromTime, toTime: dialog.getValue().toTime },
      { fromTime: '08:00', toTime: '08:00' },
      '«время по» < «время с» двигает «с» к «по»',
    );
  });

  it('одинаковые даты: «время с» позже «времени по» → обе границы равны «времени с»', async () => {
    const dialog = await buildDialog({
      mode: 'period',
      from: '2026-09-26',
      to: '2026-09-26',
      hasTime: true,
      fromTime: '10:00',
      toTime: '10:00',
    });
    const times = timeInputs(dialog.root);
    times[0]!.value = '12:30';
    times[0]!.emit('change');
    assert.deepEqual(
      { fromTime: dialog.getValue().fromTime, toTime: dialog.getValue().toTime },
      { fromTime: '12:30', toTime: '12:30' },
      '«время с» > «время по» двигает «по» к «с»',
    );
  });

  it('разные даты: время границ свободно (порядок не навязывается)', async () => {
    const dialog = await buildDialog({
      mode: 'period',
      from: '2026-09-26',
      to: '2026-09-27',
      hasTime: true,
      fromTime: '10:00',
      toTime: '10:00',
    });
    const times = timeInputs(dialog.root);
    times[1]!.value = '08:00';
    times[1]!.emit('change');
    assert.deepEqual(
      { fromTime: dialog.getValue().fromTime, toTime: dialog.getValue().toTime },
      { fromTime: '10:00', toTime: '08:00' },
      'при разных датах «время по» раньше «времени с» допустимо',
    );
  });

  it('«ОК» без потери фокуса: getValue() проверяет порядок живых полей', async () => {
    const dialog = await buildDialog({
      mode: 'period',
      from: '2026-09-26',
      to: '2026-09-26',
      hasTime: true,
      fromTime: '10:00',
      toTime: '10:00',
    });
    const times = timeInputs(dialog.root);
    // Ввод без эмита `change` — как подтверждение, не сместив фокус.
    times[1]!.value = '07:45';
    assert.deepEqual(
      { fromTime: dialog.getValue().fromTime, toTime: dialog.getValue().toTime },
      { fromTime: '07:45', toTime: '07:45' },
      'живое значение на «ОК» сводится по тому же правилу',
    );
  });

  it('режим «Дата»: одно время, порядок границ не применяется', async () => {
    const dialog = await buildDialog({
      mode: 'date',
      from: '2026-09-26',
      to: '2026-09-26',
      hasTime: true,
      fromTime: '10:00',
      toTime: '10:00',
    });
    const times = timeInputs(dialog.root);
    assert.equal(times.length, 1, 'в режиме «Дата» одно поле времени');
    times[0]!.value = '23:00';
    times[0]!.emit('change');
    const value = dialog.getValue();
    assert.equal(value.fromTime, '23:00');
    assert.equal(value.hasTime, true);
  });
});

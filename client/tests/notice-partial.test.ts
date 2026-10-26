/**
 * Частичные итоги операции (задача 28d22b8a, замечание проверки):
 * итог с ненулевым счётчиком проблем — важное предупреждение тостом,
 * итог без проблем — рутинное подтверждение в статус-баре.
 *
 * Плюс сторож проводки: итоговые сообщения со счётчиками не должны снова
 * уехать в `info`/статусбар, иначе «часть работы не выполнена» останется
 * незамеченной.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ShimElement } from './dom-shim.js';

const body = new ShimElement('body');
interface FakeTimer {
  callback: () => void;
  ms: number;
  cancelled: boolean;
}
const timers: FakeTimer[] = [];
/* eslint-disable @typescript-eslint/no-explicit-any */
(globalThis as any).document = {
  createElement: (tag: string) => new ShimElement(tag),
  createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
  documentElement: new ShimElement('html'),
  body,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  activeElement: null,
  querySelector: () => null,
};
const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
win['setTimeout'] = (callback: () => void, ms: number) => {
  timers.push({ callback, ms, cancelled: false });
  return timers.length;
};
win['clearTimeout'] = (id: number) => {
  const timer = timers[id - 1];
  if (timer !== undefined) timer.cancelled = true;
};
win['addEventListener'] = () => undefined;
win['removeEventListener'] = () => undefined;
/* eslint-enable @typescript-eslint/no-explicit-any */

import { noticePartial } from '../src/renderer/lib/notice.js';
import { mountStatusMessage } from '../src/renderer/lib/status-message.js';

const host = new ShimElement('span', 'sb-item sb-message');
body.append(host);
mountStatusMessage(host);

function stackTexts(): string[] {
  const stack = body.children.find((child) => child.classList.contains('notice-stack'));
  if (stack === undefined) return [];
  return stack.children.map(
    (box) => box.children.find((child) => child.classList.contains('notice-text'))?.textContent ?? '',
  );
}

function stackBoxes(): ShimElement[] {
  const stack = body.children.find((child) => child.classList.contains('notice-stack'));
  return stack?.children ?? [];
}

beforeEach(() => {
  body.replaceChildren();
  body.append(host);
  mountStatusMessage(host);
  timers.length = 0;
});

test('ненулевой счётчик проблем — warning в стеке, статусбар пуст', () => {
  noticePartial('Применено, ошибок: 2.', 2);

  assert.deepEqual(stackTexts(), ['Применено, ошибок: 2.'], 'частичный сбой — тост');
  assert.equal(host.textContent, '', 'в статусбар ничего не ушло');
  assert.equal(stackBoxes()[0]?.classList.contains('warning'), true, 'вид — предупреждение');
});

test('нулевой счётчик — подтверждение в статусбаре без тоста', () => {
  noticePartial('Применено.', 0);

  assert.deepEqual(stackTexts(), [], 'тоста нет');
  assert.equal(host.textContent, 'Применено.', 'подтверждение в зоне статус-бара');
});

test('сторож: все итоги со счётчиками проблем идут через noticePartial', () => {
  const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = (relative: string): string => fs.readFileSync(path.join(clientRoot, relative), 'utf8');

  assert.match(
    read('src/renderer/trash.ts'),
    /noticePartial\(failures > 0 \?/,
    '«Применено, ошибок: N» — частичный итог',
  );
  assert.match(
    read('src/renderer/trash.ts'),
    /noticePartial\(`Удалено \$\{purged\}, осталось заблокировано \$\{skipped\}\.`, skipped\)/,
    '«осталось заблокировано N» — частичный итог',
  );
  assert.match(
    read('src/renderer/screens/layer-thought-merge.ts'),
    /noticePartial\(\s*`Слито мыслей[\s\S]*?result\.conflicts,/,
    '«конфликтных блоков: N» — частичный итог',
  );
  assert.match(
    read('src/renderer/canvas/add-dialog.ts'),
    /noticePartial\(\s*failed > 0 \?/,
    '«Создано/связано: N, ошибок: M» — частичный итог',
  );
  assert.match(
    read('src/renderer/editor/wiki-link-create.ts'),
    /noticePartial\(\s*failed > 0 \?/,
    '«Создано/связано: N, ошибок: M» в редакторе — частичный итог',
  );
  assert.match(
    read('src/renderer/editor/value-editor.ts'),
    /noticePartial\(\s*unresolved === 0/,
    '«Обновлено X из Y; N нерезолвлено» — частичный итог',
  );
  assert.match(
    read('src/renderer/editor/link-value-removal.ts'),
    /Часть связей заблокирована и осталась в корзине\.', 'warning'\)/,
    'частичная блокировка рёбер — предупреждение',
  );
});

/**
 * Диалог: роли размеров S/M/L/XL и стабильная высота вкладочного диалога
 * (задача a57e7998, требование 13464c39 «Стабильные размеры диалога:
 * роли S/M/L/XL, высота не зависит от вкладки»).
 *
 * Что закрепляем (каркас `lib/dialog.ts` + `lib/ui/tabs.ts`):
 *   1. Роль размера выставляется атрибутом `data-dialog-size` — размер
 *      задаёт CSS, а не содержимое (нет inline-высоты/ширины).
 *   2. Вкладочный диалог помечен `data-dialog-tabs="true"`, и CSS задаёт ему
 *      ФИКСИРОВАННУЮ высоту роли — переключение вкладок высоту не меняет.
 *   3. Переключение вкладок не меняет ни роль, ни пометку вкладочности, ни
 *      inline-высоту; активная панель ровно одна.
 *   4. Панели ленивы: содержимое вкладки строится при первом показе и не
 *      пересобирается при повторных переключениях.
 *
 * Дом — минимальный шим (конвенция `dialog-backdrop-close.test.ts`): размер и
 * переключение вкладок наблюдаемы только с DOM.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

const CSS_PATH = resolve(import.meta.dirname, '..', 'src', 'renderer', 'styles.css');

const windowListeners: Array<{ type: string; listener: (event: any) => void }> = [];

function installShim(): void {
  windowListeners.length = 0;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
  };
  (globalThis as any).window = {
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: (type: string, listener: (event: any) => void) => {
      windowListeners.push({ type, listener });
    },
    removeEventListener: (type: string, listener: (event: any) => void) => {
      const index = windowListeners.findIndex((l) => l.type === type && l.listener === listener);
      if (index >= 0) windowListeners.splice(index, 1);
    },
  };
}

installShim();

const { closeDialog, showDialog } = await import('../src/renderer/lib/dialog.js');

function body(): ShimElement {
  return (globalThis as any).document.body as ShimElement;
}

function lastBox(): ShimElement {
  const backdrops = body().children.filter((c) => c.classList.contains('dialog-backdrop'));
  const backdrop = backdrops[backdrops.length - 1]!;
  const box = backdrop.querySelector('.dialog-box');
  assert.ok(box !== null, 'в диалоге есть тело');
  return box!;
}

function tab(label: string): ShimElement {
  const btn = lastBox().querySelectorAll('.ui-tab').find((b) => b.textContent === label);
  assert.ok(btn !== undefined, `вкладка «${label}» есть`);
  return btn!;
}

function paneCount(): number {
  return lastBox().querySelectorAll('.ui-tabpanel').length;
}

describe('диалог: роли размера (требование 13464c39)', () => {
  it('роль размера выставляется атрибутом data-dialog-size', () => {
    for (const size of ['s', 'm', 'l', 'xl'] as const) {
      installShim();
      showDialog({ title: 'Диалог', size, body: new ShimElement('div', 'dialog-body') as any });
      assert.equal(lastBox().dataset['dialogSize'], size, `роль ${size} выставлена атрибутом`);
      closeDialog();
    }
  });

  it('размер задаёт CSS, а не содержимое: inline-высота/ширина не выставляются', () => {
    installShim();
    showDialog({ title: 'Диалог', size: 'l', body: new ShimElement('div', 'dialog-body') as any });
    const box = lastBox();
    assert.equal(box.style.getPropertyValue('height'), '', 'высота не задаётся из содержимого');
    assert.equal(box.style.getPropertyValue('width'), '', 'ширина приходит от роли, а не из inline-стиля');
    closeDialog();
  });

  it('CSS фиксирует высоту вкладочного диалога ролью', () => {
    const css = readFileSync(CSS_PATH, 'utf8');
    assert.match(
      css,
      /\.dialog-box\[data-dialog-tabs='true'\]\s*\{[^}]*height:\s*var\(--dialog-h/,
      'вкладочный диалог обязан иметь фиксированную высоту роли',
    );
    for (const [size, width] of [
      ['s', '460px'],
      ['m', '560px'],
      ['l', '900px'],
      ['xl', '1240px'],
    ] as const) {
      assert.match(
        css,
        new RegExp(`\\.dialog-box\\[data-dialog-size='${size}'\\][^}]*--dialog-w:\\s*${width}`),
        `роль ${size} задаёт ширину ${width}`,
      );
    }
  });
});

describe('диалог: вкладки общего механизма и стабильная высота', () => {
  it('вкладочный диалог помечен, активна первая вкладка', () => {
    installShim();
    showDialog({
      title: 'Диалог',
      size: 'm',
      tabs: [
        { id: 'a', label: 'Первая', content: new ShimElement('div') as any },
        { id: 'b', label: 'Вторая', content: new ShimElement('div') as any },
      ],
    });
    const box = lastBox();
    assert.equal(box.dataset['dialogTabs'], 'true', 'диалог помечен как вкладочный');
    assert.equal(tab('Первая').classList.contains('active'), true, 'первая вкладка активна');
    assert.equal(tab('Вторая').classList.contains('active'), false);
    assert.equal(paneCount(), 2, 'панели обеих вкладок в DOM');
    closeDialog();
  });

  it('переключение вкладок не меняет роль, пометку вкладочности и высоту', () => {
    installShim();
    showDialog({
      title: 'Диалог',
      size: 'l',
      tabs: [
        { id: 'a', label: 'Первая', content: new ShimElement('div') as any },
        { id: 'b', label: 'Вторая', content: new ShimElement('div') as any },
      ],
    });
    const box = lastBox();
    const sizeBefore = box.dataset['dialogSize'];
    const tabsBefore = box.dataset['dialogTabs'];
    const heightBefore = box.style.getPropertyValue('height');

    tab('Вторая').click();

    assert.equal(box.dataset['dialogSize'], sizeBefore, 'роль не изменилась');
    assert.equal(box.dataset['dialogTabs'], tabsBefore, 'пометка вкладочности не изменилась');
    assert.equal(box.style.getPropertyValue('height'), heightBefore, 'inline-высота не появилась');
    assert.equal(tab('Вторая').classList.contains('active'), true, 'активна вторая вкладка');
    assert.equal(tab('Первая').classList.contains('active'), false);
    // Активна ровно одна панель.
    const active = box.querySelectorAll('.ui-tabpanel').filter((p) => !p.hasAttribute('hidden'));
    assert.equal(active.length, 1, 'показана ровно одна панель');
    closeDialog();
  });

  it('содержимое вкладки строится при первом показе и переиспользуется', () => {
    installShim();
    let firstBuilds = 0;
    showDialog({
      title: 'Диалог',
      size: 'm',
      tabs: [
        {
          id: 'a',
          label: 'Первая',
          content: () => {
            firstBuilds++;
            return new ShimElement('div') as any;
          },
        },
        { id: 'b', label: 'Вторая', content: new ShimElement('div') as any },
      ],
    });
    assert.equal(firstBuilds, 1, 'активная вкладка построена сразу');
    tab('Вторая').click();
    tab('Первая').click();
    assert.equal(firstBuilds, 1, 'повторное переключение не пересобирает содержимое');
    closeDialog();
  });
});

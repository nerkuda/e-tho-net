/**
 * Универсальный диалог выбора ресурса (задача d1a56d76) — поведенческий тест
 * каркаса и готовых источников.
 *
 * Что закрепляем (DoD задачи):
 *   1. Вкладки-источники настраиваются: опциональные «Эмодзи»/«Иконки мыслей»
 *      появляются только когда источник передан в конфиг.
 *   2. Единые поведения выбора: нижняя «Применить» недоступна, пока активный
 *      источник не сообщил о корректном выборе; «Применить» зовёт `apply`
 *      активного источника; «Отмена» закрывает без изменений; «без ресурса»
 *      зовёт обработчик и закрывает.
 *   3. Панели источников ленивы: содержимое неактивной вкладки не строится.
 *
 * jsdom в проекте нет — минимальный DOM-шим (конвенция `dialog-size-tabs.test.ts`).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

function installShim(): void {
  const body = new ShimElement('body');
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body,
    activeElement: body,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  };
  (globalThis as any).window = {
    innerWidth: 1200,
    innerHeight: 800,
    etn: {},
    setTimeout: (fn: () => void, ms?: number) => (globalThis as any).setTimeout(fn, ms),
    clearTimeout: (handle: any) => (globalThis as any).clearTimeout(handle),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
}

installShim();

const { createResourcePicker, urlSourceTab } = await import(
  '../src/renderer/editor/resource-picker.js'
);

function body(): ShimElement {
  return (globalThis as any).document.body as ShimElement;
}

function lastBox(): ShimElement {
  const backdrops = body().children.filter((c) => c.classList.contains('dialog-backdrop'));
  const backdrop = backdrops[backdrops.length - 1];
  assert.ok(backdrop !== undefined, 'диалог открыт');
  const box = backdrop.querySelector('.dialog-box');
  assert.ok(box !== null, 'в диалоге есть тело');
  return box as ShimElement;
}

function hasBackdrop(): boolean {
  return body().children.some((c) => c.classList.contains('dialog-backdrop'));
}

function tabBtn(label: string): ShimElement | undefined {
  return lastBox()
    .querySelectorAll('.ui-tab')
    .find((b) => b.textContent === label) as unknown as ShimElement | undefined;
}

/** Все потомки с данным тегом (шим понимает только простые селекторы). */
function findByTag(root: ShimElement, tag: string): ShimElement[] {
  const wanted = tag.toUpperCase();
  const hits: ShimElement[] = [];
  const walk = (node: ShimElement): void => {
    for (const child of node.children) {
      if ((child.tagName ?? '').toUpperCase() === wanted) hits.push(child);
      walk(child);
    }
  };
  walk(root);
  return hits;
}

function footerBtn(label: string): ShimElement {
  const footer = lastBox().querySelector('.dialog-footer');
  assert.ok(footer !== null, 'футер диалога построен');
  const btn = findByTag(footer as ShimElement, 'BUTTON').find((b) => b.textContent === label);
  assert.ok(btn !== undefined, `кнопка «${label}» в футере`);
  return btn;
}

function click(node: ShimElement): void {
  node.emit('click', { preventDefault: () => undefined });
}

/** Заблокирована ли кнопка: каркас ставит свойство `disabled`, не атрибут. */
function isDisabled(node: ShimElement): boolean {
  return (node as unknown as { disabled?: boolean }).disabled === true;
}

/** Простой источник-заглушка с настраиваемыми id/немедленностью. */
function stubTab(id: string, label: string, opts: { immediate?: boolean; builds?: string[] } = {}) {
  const tab: any = {
    id,
    label,
    build: () => {
      opts.builds?.push(id);
      return new ShimElement('div');
    },
  };
  if (opts.immediate !== true) tab.apply = () => undefined;
  return tab;
}

describe('универсальный диалог выбора ресурса (d1a56d76)', () => {
  // Каждый тест — своя страница: незакрытый диалог предыдущего не влияет
  // на `hasBackdrop`.
  beforeEach(() => installShim());

  it('опциональные вкладки включаются только конфигом', () => {
    createResourcePicker({
      title: 'Ресурс',
      applyLabel: 'Применить',
      tabs: [stubTab('url', 'URL'), stubTab('emoji', 'Эмодзи'), stubTab('thought-icons', 'Иконки мыслей')],
    });
    assert.ok(tabBtn('URL') !== undefined, 'вкладка URL есть');
    assert.ok(tabBtn('Эмодзи') !== undefined, 'вкладка Эмодзи есть по конфигу');
    assert.ok(tabBtn('Иконки мыслей') !== undefined, 'вкладка Иконки мыслей есть по конфигу');
    click(footerBtn('Отмена'));
    assert.equal(hasBackdrop(), false, 'диалог закрыт');

    createResourcePicker({
      title: 'Ресурс',
      applyLabel: 'Применить',
      tabs: [stubTab('url', 'URL')],
    });
    assert.ok(tabBtn('URL') !== undefined, 'единственная вкладка URL есть');
    assert.equal(tabBtn('Эмодзи'), undefined, 'без источника эмодзи вкладки нет');
    assert.equal(tabBtn('Иконки мыслей'), undefined, 'без источника иконок вкладки нет');
    click(footerBtn('Отмена'));
  });

  it('«Применить» недоступна, пока источник не сообщил о выборе', () => {
    createResourcePicker({
      title: 'Ресурс',
      applyLabel: 'Применить',
      tabs: [stubTab('url', 'URL')],
    });
    const apply = footerBtn('Применить');
    assert.equal(isDisabled(apply), true, 'по умолчанию «Применить» недоступна');
    click(footerBtn('Отмена'));
  });

  it('«Применить» зовёт apply активного источника и закрывает диалог', () => {
    let applied = 0;
    const tab: any = {
      id: 'url',
      label: 'URL',
      build: (ctx: any) => {
        // Источник сразу объявляет корректный выбор (модель загрузки URL).
        ctx.setReady(true);
        return new ShimElement('div');
      },
      apply: (ctx: any) => {
        applied += 1;
        ctx.close();
      },
    };
    createResourcePicker({ title: 'Ресурс', applyLabel: 'Применить', tabs: [tab] });
    const apply = footerBtn('Применить');
    assert.equal(isDisabled(apply), false, 'после выбора «Применить» доступна');
    click(apply);
    assert.equal(applied, 1, 'apply активного источника вызван');
    assert.equal(hasBackdrop(), false, 'диалог закрыт источником');
  });

  it('немедленный источник (без apply) держит «Применить» недоступной', () => {
    const tab: any = {
      id: 'emoji',
      label: 'Эмодзи',
      build: (ctx: any) => {
        ctx.setReady(true);
        return new ShimElement('div');
      },
    };
    createResourcePicker({ title: 'Ресурс', applyLabel: 'Применить', tabs: [tab] });
    assert.equal(isDisabled(footerBtn('Применить')), true);
    click(footerBtn('Отмена'));
  });

  it('«без ресурса» зовёт обработчик и закрывает диалог', () => {
    let noneCalls = 0;
    createResourcePicker({
      title: 'Ресурс',
      applyLabel: 'Применить',
      noneLabel: 'Очистить',
      noneDanger: true,
      onNone: (close: () => void) => {
        noneCalls += 1;
        close();
      },
      tabs: [stubTab('url', 'URL')],
    });
    click(footerBtn('Очистить'));
    assert.equal(noneCalls, 1, 'обработчик «без ресурса» вызван');
    assert.equal(hasBackdrop(), false, 'диалог закрыт');
  });

  it('панели источников ленивы: неактивная вкладка не строится до показа', () => {
    const builds: string[] = [];
    createResourcePicker({
      title: 'Ресурс',
      applyLabel: 'Применить',
      tabs: [stubTab('url', 'URL', { builds }), stubTab('emoji', 'Эмодзи', { immediate: true, builds })],
    });
    assert.deepEqual(builds, ['url'], 'построена только активная вкладка');
    click(tabBtn('Эмодзи') as ShimElement);
    assert.deepEqual(builds, ['url', 'emoji'], 'вкладка строится при первом показе');
    click(tabBtn('URL') as ShimElement);
    assert.deepEqual(builds, ['url', 'emoji'], 'повторный показ не пересобирает панель');
    click(footerBtn('Отмена'));
  });

  it('urlSourceTab: «Применить» включается после загрузки картинки и отдаёт URL', async () => {
    let appliedUrl = '';
    createResourcePicker({
      title: 'Ресурс',
      applyLabel: 'Применить',
      tabs: [
        urlSourceTab({
          placeholder: 'URL',
          previewHint: 'Предпросмотр',
          onApply: (url, ctx) => {
            appliedUrl = url;
            ctx.close();
          },
        }),
      ],
    });
    const input = findByTag(lastBox(), 'INPUT')[0];
    assert.ok(input !== undefined, 'поле URL построено');
    assert.equal(isDisabled(footerBtn('Применить')), true);
    input.value = 'https://example.test/a.png';
    input.emit('input', {});
    const img = findByTag(lastBox(), 'IMG')[0];
    assert.ok(img !== undefined, 'предпросмотр строит img');
    img.emit('load', {});
    assert.equal(isDisabled(footerBtn('Применить')), false, 'после load доступна');
    click(footerBtn('Применить'));
    assert.equal(appliedUrl, 'https://example.test/a.png', 'применён проверенный URL');
    assert.equal(hasBackdrop(), false, 'диалог закрыт');
  });
});

/**
 * Общий компонент выбора вложения: layout-фикс ошибки 3250096a и пагинация
 * большого списка (задача 0f6c3e39).
 *
 * Проверяется:
 *   1. Строка поиска закреплена сверху, список прокручивается ВНУТРИ себя, а
 *      правый предпросмотр зафиксирован (не растягивается по длине списка) —
 *      якоря CSS-модуля `styles/editor.css` (классы `.att-pick-*`).
 *   2. Пагинация: компонент запрашивает страницы эндпоинта `GET /attachments`
 *      (`limit` = серверный предел 200, `offset`), а кнопка «Показать ещё»
 *      догружает следующую страницу — ПОВЕДЕНЧЕСКИ на DOM-шиме.
 *
 * jsdom в проекте нет — минимальный DOM-шим (конвенция `resource-picker.test.ts`).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';

import type { Attachment } from '@etn/shared';

import { ShimElement } from './dom-shim.js';

const CLIENT_ROOT = path.resolve(import.meta.dirname, '..');
const EDITOR_CSS = path.join(CLIENT_ROOT, 'src', 'renderer', 'styles', 'editor.css');

/** Блоки `селектор { … }` без комментариев. */
function cssBlocks(css: string): Map<string, string> {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = new Map<string, string>();
  for (const m of code.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.set(m[1]!.trim().replace(/\s+/g, ' '), m[2]!);
  }
  return out;
}

/** Вложение-картинка (носитель — свой файл). */
function imageAttachment(id: string): Attachment {
  return {
    id,
    owner_type: 'thought',
    owner_id: 'th-1',
    kind: 'file',
    url: null,
    file_path: `C:/pics/${id}.png`,
    file_size: null,
    mime_type: 'image/png',
    title: id,
    icon: null,
    description: null,
    position: 0,
    created_at: '2026-10-01T00:00:00.000Z',
    created_by: 'u',
  };
}

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

const { attachmentPickerSourceTab } = await import('../src/renderer/editor/attachment-picker.js');
const { store } = await import('../src/renderer/state.js');
const { t } = await import('../src/renderer/lib/i18n.js');

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

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('общий компонент выбора вложения: layout (ошибка 3250096a)', () => {
  it('поиск закреплён сверху, список прокручивается внутри, предпросмотр зафиксирован', () => {
    const css = cssBlocks(fs.readFileSync(EDITOR_CSS, 'utf8'));

    const pane = css.get('.att-pick-pane') ?? '';
    assert.ok(pane.includes('height: 100%'), 'панель занимает высоту вкладки целиком');
    assert.ok(pane.includes('min-height: 0'), 'панель не растягивается по содержимому');

    const top = css.get('.att-pick-top') ?? '';
    assert.ok(top.includes('flex: none'), 'строка поиска/загрузки не сжимается и не уезжает');
    assert.ok(top.includes('display: flex'), 'строка поиска — flex-ряд');

    const split = css.get('.att-pick-split') ?? '';
    assert.ok(split.includes('flex: 1 1 auto'), 'сплит забирает остаток высоты панели');
    assert.ok(split.includes('min-height: 0'), 'сплит не превышает высоту панели');

    const list = css.get('.att-pick-list') ?? '';
    assert.ok(list.includes('overflow-y: auto'), 'список прокручивается ВНУТРИ себя');
    assert.ok(list.includes('min-height: 0'), 'список не раздувает контейнер по содержимому');

    const preview = css.get('.att-pick-preview') ?? '';
    assert.ok(preview.includes('flex: none'), 'правая колонка предпросмотра зафиксирована по ширине');
    assert.ok(
      preview.includes('align-items: center'),
      'предпросмотр выровнен по видимой части, а не по длине списка',
    );
  });
});

describe('общий компонент выбора вложения: пагинация (задача 0f6c3e39)', () => {
  beforeEach(() => installShim());

  it('запрашивает страницы limit=200/offset и догружает «Показать ещё»', async () => {
    store.update({ networkId: 'net-1' });
    const calls: Array<{ q: string; limit?: number; offset?: number }> = [];
    const firstPage = Array.from({ length: 200 }, (_, i) => imageAttachment(`att-${i}`));
    const secondPage = [imageAttachment('att-200'), imageAttachment('att-201')];
    (globalThis as any).window.etn = {
      attachments: {
        search: async (_n: string, query: { q: string; limit?: number; offset?: number }) => {
          calls.push(query);
          return query.offset === 0 ? firstPage : secondPage;
        },
        getUsage: async () => ({ owners: [] }),
      },
    };

    const tab = attachmentPickerSourceTab({
      label: 'Вложения',
      onPick: () => undefined,
    });
    const root = tab.build({ close: () => undefined, setReady: () => undefined } as any) as
      unknown as ShimElement;
    await flush();

    // Первая страница: серверный предел страницы 200, смещение 0.
    assert.equal(calls.length, 1, 'первый запрос страницы');
    assert.equal(calls[0]?.limit, 200, 'страница ограничена серверным пределом 200');
    assert.equal(calls[0]?.offset, 0, 'первая страница с начала');
    assert.equal(root.querySelectorAll('.att-pick-item').length, 200, 'загружено 200 строк');

    // Кнопка догрузки видна (страница полная — есть хвост).
    const more = findByTag(root, 'BUTTON').find(
      (b) => b.textContent === t('attachments.picker.more'),
    );
    assert.ok(more !== undefined, 'кнопка «Показать ещё» построена');
    const moreRow = root.querySelector('.att-pick-more');
    assert.ok(moreRow !== null, 'контейнер кнопки догрузки построен');
    assert.ok(!moreRow.classList.contains('hidden'), 'хвост есть — кнопка видна');

    more!.emit('click', { preventDefault: () => undefined });
    await flush();

    assert.equal(calls.length, 2, 'догружен второй запрос');
    assert.equal(calls[1]?.offset, 200, 'вторая страница со смещением 200');
    assert.equal(root.querySelectorAll('.att-pick-item').length, 202, 'строки догружены');

    // Последняя страница неполная — хвоста нет, кнопка скрыта.
    assert.ok(moreRow!.classList.contains('hidden'), 'хвост закончился — кнопка скрыта');
  });

  it('живой поиск debounced: запрос не летит на каждое нажатие', async () => {
    store.update({ networkId: 'net-1' });
    const calls: Array<{ q: string; limit?: number; offset?: number }> = [];
    (globalThis as any).window.etn = {
      attachments: {
        search: async (_n: string, query: { q: string; limit?: number; offset?: number }) => {
          calls.push(query);
          return query.q === '*' ? [imageAttachment('att-0')] : [];
        },
        getUsage: async () => ({ owners: [] }),
      },
    };

    const tab = attachmentPickerSourceTab({ label: 'Вложения', onPick: () => undefined });
    const root = tab.build({ close: () => undefined, setReady: () => undefined } as any) as
      unknown as ShimElement;
    await flush();
    assert.equal(calls.length, 1, 'первая загрузка списка — сразу');

    const searchInput = root.querySelector('.att-pick-search');
    assert.ok(searchInput !== null, 'поле поиска построено');
    searchInput!.value = 'att-00';
    searchInput!.emit('input', {});

    // Запрос НЕ ушёл синхронно — он отложен debounce. Убрать debounce →
    // calls сразу станет 2, тест покраснеет (мутационно-проверяемо).
    assert.equal(calls.length, 1, 'запрос отложен, а не на каждое нажатие');

    await new Promise((resolve) => setTimeout(resolve, 260));
    assert.equal(calls.length, 2, 'после задержки поиск выполнен один раз');
    assert.equal(calls[1]?.q, 'att-00', 'запрос с введённым текстом');
    assert.equal(calls[1]?.offset, 0, 'поиск начинается с первой страницы');
  });
});

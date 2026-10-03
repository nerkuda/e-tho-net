/**
 * Юнит-тесты облачка публикации `lib/ui/publication-cloud.ts` (замечание Б2
 * приёмки b02ef1cf): прямые углы, всегда значок-книга, крестик снятия владельца
 * и контекстное меню по переданным действиям/подписям. Гоняется под Node с
 * минимальным DOM-шимом (как `lib-ui-chip-list.test.ts`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createPublicationCloud } from '../src/renderer/lib/ui/publication-cloud.js';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

function installShim(): void {
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
  };
}

const asShim = (el: HTMLElement): ShimElement => el as unknown as ShimElement;

describe('lib/ui/publication-cloud', () => {
  it('рисует облачко: корень, книга, название с подсказкой, ширина по контейнеру', () => {
    installShim();
    const cloud = asShim(
      createPublicationCloud({ id: 'p1', title: 'Руководство' }, { width: 'container' }),
    );
    assert.ok(cloud.classList.contains('ui-pub-cloud'), 'корень облачка публикации');
    assert.ok(cloud.classList.contains('ui-pub-cloud-container'), 'ширина по контейнеру');
    assert.equal(cloud.dataset['id'], 'p1');
    const icon = cloud.querySelector('.ui-pub-cloud-icon');
    assert.ok(icon !== null, 'значок есть');
    const svg = icon!.querySelector('svg');
    assert.ok(svg !== null, 'значок-книга — svg');
    assert.ok(svg!.innerHTML.includes('M12 7v14'), 'использована иконка книги value-publication');
    const title = cloud.querySelector('.ui-pub-cloud-title');
    assert.equal(title?.textContent, 'Руководство');
    assert.equal(
      (title as unknown as { title?: string } | null)?.title,
      'Руководство',
      'подсказка с полным названием',
    );
  });

  it('крестик вызывает onRemove с id владельца', () => {
    installShim();
    const removed: string[] = [];
    const cloud = asShim(
      createPublicationCloud(
        { id: 'p2', title: 'Док' },
        { labels: { remove: 'Убрать владельца' }, actions: { onRemove: (id) => removed.push(id) } },
      ),
    );
    const btn = cloud.querySelector('.ui-pub-cloud-remove');
    assert.ok(btn !== null, 'крестик снятия владельца есть');
    btn!.click();
    assert.deepEqual(removed, ['p2']);
  });

  it('без действий крестика и меню нет', () => {
    installShim();
    const cloud = asShim(createPublicationCloud({ id: 'p3', title: 'Док' }));
    assert.equal(cloud.querySelector('.ui-pub-cloud-remove'), null, 'крестика нет');
    assert.ok(!('contextmenu' in cloud.listeners), 'контекстное меню не монтируется');
  });

  it('контекстное меню монтируется только при действиях и подписях', () => {
    installShim();
    const cloud = asShim(
      createPublicationCloud(
        { id: 'p4', title: 'Док' },
        {
          labels: { open: 'Открыть', read: 'Читать', findOnShelf: 'Найти на полке' },
          actions: { onOpen: () => undefined, onRead: () => undefined, onFindOnShelf: () => undefined },
        },
      ),
    );
    assert.ok('contextmenu' in cloud.listeners, 'обработчик контекстного меню навешен');
  });
});

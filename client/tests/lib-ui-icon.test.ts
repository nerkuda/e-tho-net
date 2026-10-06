/**
 * Юнит-тесты фасада иконок `lib/ui/icon.ts` (задача 6d8db38b, ADR bd224643,
 * требование e52d249e).
 *
 * Проверяется: сборка значка из узла Lucide с применением размера/цвета/
 * толщины, совместимый `svgIcon`, kebab-имена экспортов, каталог с
 * дедупликацией алиасов и поиск по нему. jsdom в проекте нет — используется
 * общий DOM-шим (`./dom-shim.js`).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

function shimDom(): void {
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
  };
}

shimDom();

type IconModule = typeof import('../src/renderer/lib/ui/icon.js');

const {
  ICON_CLASS,
  ICON_NAMES,
  svgIcon,
  renderIcon,
  renderIconNode,
  isIconName,
  iconNameFromExport,
  buildIconCatalog,
  loadIconCatalog,
  searchIconCatalog,
} = (await import('../src/renderer/lib/ui/icon.js')) as IconModule;

describe('фасад иконок: рендер значка', () => {
  it('svgIcon рисует значок класса icon заданного размера', () => {
    const svg = svgIcon('search', 20) as unknown as ShimElement;
    assert.equal(svg.tagName, 'svg');
    assert.ok(svg.classList.contains(ICON_CLASS), 'значок несёт класс icon');
    assert.equal(svg.getAttribute('width'), '20');
    assert.equal(svg.getAttribute('height'), '20');
    assert.equal(svg.getAttribute('viewBox'), '0 0 24 24');
    assert.equal(svg.getAttribute('stroke'), 'currentColor');
    assert.equal(svg.getAttribute('stroke-width'), '2');
    assert.equal(svg.getAttribute('aria-hidden'), 'true');
    assert.ok(svg.innerHTML.includes('<path'), 'внутри значка есть геометрия Lucide');
  });

  it('renderIcon применяет цвет и толщину штриха', () => {
    const svg = renderIcon('x', { size: 12, color: 'var(--danger)', strokeWidth: 3 }) as unknown as ShimElement;
    assert.equal(svg.getAttribute('width'), '12');
    assert.equal(svg.getAttribute('stroke'), 'var(--danger)');
    assert.equal(svg.getAttribute('stroke-width'), '3');
  });

  it('renderIconNode добавляет пользовательский класс рядом с icon', () => {
    const svg = renderIconNode(
      [['path', { d: 'M0 0' }]],
      { className: 'my-glyph' },
    ) as unknown as ShimElement;
    assert.ok(svg.classList.contains(ICON_CLASS));
    assert.ok(svg.classList.contains('my-glyph'));
    assert.equal(svg.innerHTML, '<path d="M0 0"/>');
  });

  it('isIconName отсекает имена вне набора обвязки', () => {
    assert.equal(isIconName('search'), true);
    assert.equal(isIconName('not-an-icon'), false);
    assert.ok(ICON_NAMES.includes('calendar-month'));
  });
});

describe('фасад иконок: каталог и поиск', () => {
  it('kebab-имя выводится из PascalCase-экспорта Lucide', () => {
    assert.equal(iconNameFromExport('Search'), 'search');
    assert.equal(iconNameFromExport('CalendarDays'), 'calendar-days');
    assert.equal(iconNameFromExport('Undo2'), 'undo-2');
    assert.equal(iconNameFromExport('ALargeSmall'), 'a-large-small');
  });

  it('каталог дедуплицирует алиасы одной геометрии и сортирует имена', () => {
    const nodeA: [string, Record<string, string>][] = [['path', { d: 'a' }]];
    const nodeB: [string, Record<string, string>][] = [['path', { d: 'b' }]];
    const catalog = buildIconCatalog({
      Zebra: nodeA,
      Album: nodeB,
      ZebraAlias: nodeA,
    } as any);
    assert.deepEqual([...catalog.names], ['album', 'zebra']);
    assert.equal(catalog.node('zebra'), nodeA);
    assert.equal(catalog.node('album'), nodeB);
    assert.equal(catalog.node('none'), null);
  });

  it('поиск по каталогу — подстрока, регистр не важен, слова входят все', () => {
    const names = ['arrow-left', 'arrow-right', 'calendar-days', 'search'];
    assert.deepEqual(searchIconCatalog(names, 'ARROW'), ['arrow-left', 'arrow-right']);
    assert.deepEqual(searchIconCatalog(names, 'arrow l'), ['arrow-left']);
    assert.deepEqual(searchIconCatalog(names, '  '), names);
    assert.deepEqual(searchIconCatalog(names, 'нет такого'), []);
  });

  it('полный каталог библиотеки грузится лениво и содержит значки', async () => {
    const catalog = await loadIconCatalog();
    assert.ok(catalog.names.length > 100, 'каталог Lucide непустой');
    assert.ok(catalog.names.includes('search'));
    assert.ok(catalog.names.includes('calendar-days'));
    assert.ok(catalog.names.includes('waypoints'));
    assert.notEqual(catalog.node('search'), null);
    assert.equal(catalog.node(' definitely-not-a-lucide-icon '), null);
  });
});

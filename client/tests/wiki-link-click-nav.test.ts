/**
 * Клик по wiki-ссылке на мысль в РЕЖИМЕ РЕДАКТИРОВАНИЯ открывает цель (ошибка
 * ab8b6da8, симптом 2: «в режиме редактирования клик по ссылкам на мысли —
 * никакой реакции; ожидаю, что мысль будет открыта»).
 *
 * Два контракта, которые это обеспечивают:
 * 1. `shouldNavigateWikiLink` — решение о переходе: спан просмотра и виджет
 *    имени ID-формы в редакторе (`wiki-id-plugin`, класс `wiki-link` без
 *    `md-widget`) переходят; виджет live-preview (`md-widget`, M6) при клике
 *    раскрывает исходник — не переходит; снятый узел — не переходит.
 * 2. Виджет имени несёт данные цели (`data-wiki-id`/`data-wiki-target`,
 *    для кросс-сети `data-wiki-network`) — те же атрибуты, что спан
 *    `@etn/markdown` в просмотре; без них общий обработчик не знает цель.
 *
 * Сторож зелёный на исправленном коде и краснеет, если связь «клик → цель»
 * у виджета или решение о переходе уберут.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  WIKI_LINK_ID_ATTR,
  WIKI_LINK_NETWORK_ATTR,
  WIKI_LINK_TARGET_ATTR,
} from '@etn/markdown';

import { shouldNavigateWikiLink } from '../src/renderer/editor/wiki-link.js';
import { __testing } from '../src/renderer/editor/wiki-id-plugin.js';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const { buildDecorations, cacheKey } = __testing;

const ID_A = '8e0d670e-de61-4da7-b13e-9232cd1c6ca5';
const NET = 'c4f9a3b2-1111-2222-3333-444455556666';
const CUR = 'cur-net-1111-2222-3333-444455556666';

/** Минимальный узел-ссылка для {@link shouldNavigateWikiLink}. */
function clickTarget(opts: {
  connected?: boolean;
  classes?: string[];
  inEditor?: boolean;
}): {
  isConnected: boolean;
  classList: { contains(cls: string): boolean };
  closest(selector: string): unknown;
} {
  return {
    isConnected: opts.connected ?? true,
    classList: { contains: (cls: string) => (opts.classes ?? []).includes(cls) },
    closest: (selector: string) => (selector === '.cm-editor' && opts.inEditor === true ? {} : null),
  };
}

test('shouldNavigateWikiLink: спан просмотра (вне редактора) переходит', () => {
  assert.equal(shouldNavigateWikiLink(clickTarget({ classes: ['wiki-link'] })), true);
});

test('shouldNavigateWikiLink: виджет имени ID-формы в редакторе переходит', () => {
  assert.equal(
    shouldNavigateWikiLink(clickTarget({ classes: ['wiki-link'], inEditor: true })),
    true,
    'ID-форма в редакторе — не md-widget, клик обязан открывать мысль',
  );
});

test('shouldNavigateWikiLink: виджет live-preview (md-widget) раскрывает исходник, а не переходит (M6)', () => {
  assert.equal(
    shouldNavigateWikiLink(clickTarget({ classes: ['md-widget', 'wiki-link'], inEditor: true })),
    false,
  );
});

test('shouldNavigateWikiLink: снятый со страницы узел не переходит', () => {
  assert.equal(
    shouldNavigateWikiLink(clickTarget({ classes: ['wiki-link'], connected: false })),
    false,
  );
});

/** Один виджет normal-mode из документа с одной ID-ссылкой. */
function labelWidget(source: string, cache: Map<string, any>, networkId: string | null): any {
  const decos = buildDecorations(source, { from: 1000, to: 1000 }, cache, networkId);
  let widget: any = null;
  decos.between(0, source.length, (_from, _to, value) => {
    widget = (value as any).spec.widget;
  });
  assert.ok(widget !== null, 'виджет найден');
  return widget;
}

test('виджет имени несёт данные цели и рендерит их в data-атрибуты', () => {
  const source = `[[#${ID_A}]]`;
  const cache = new Map([
    [cacheKey(CUR, ID_A), { title: 'Цель', exists: true, networkId: CUR }],
  ]);
  const widget = labelWidget(source, cache, CUR);
  // Контракт данных цели — то, что читает общий обработчик клика.
  assert.equal(widget.navId, ID_A);
  assert.equal(widget.navNetworkId, null);

  // И сам DOM-виджет несёт те же атрибуты, что спан просмотра.
  (globalThis as any).document = { createElement: (tag: string) => new ShimElement(tag) };
  const el = widget.toDOM() as ShimElement;
  assert.ok(el.classList.contains('wiki-link'), 'виджет — span.wiki-link');
  assert.equal(el.getAttribute(WIKI_LINK_ID_ATTR), ID_A);
  assert.equal(el.getAttribute(WIKI_LINK_TARGET_ATTR), ID_A);
  assert.equal(el.getAttribute(WIKI_LINK_NETWORK_ATTR), null);
});

test('кросс-сетевой виджет имени несёт и сеть цели', () => {
  const source = `[[n:${NET}#${ID_A}]]`;
  const cache = new Map([
    [cacheKey(NET, ID_A), { title: 'Чужая цель', exists: true, networkId: NET }],
  ]);
  const widget = labelWidget(source, cache, null);
  assert.equal(widget.navId, ID_A);
  assert.equal(widget.navNetworkId, NET);

  (globalThis as any).document = { createElement: (tag: string) => new ShimElement(tag) };
  const el = widget.toDOM() as ShimElement;
  assert.equal(el.getAttribute(WIKI_LINK_NETWORK_ATTR), NET);
});

test('виджет публикации не несёт навигации по мысли (иное пространство id)', () => {
  const source = `[[#pub:${ID_A}]]`;
  const widget = labelWidget(source, new Map(), CUR);
  assert.equal(widget.navId, null);
});

/**
 * Расщепление контракта клика (0.12.2, задача 8e4e3dc5): навигация по клику
 * (`initWikiLinkNavigation`) обслуживает ID-форму и спан просмотра; легаси-
 * ссылка в редакторе (`md-widget wiki-link`) переходит в НОВУЮ развилку,
 * которая перехватывает `mousedown` до снятия виджета. Здесь — связка
 * «виджет несёт цель» + «навигация регистрирует развилку» (поведение самого
 * `mousedown` проверяет `md-live-widget-click.test.ts`).
 */
test('легаси-виджет несёт data-wiki-target, навигация регистрирует развилку клика', () => {
  const mdLive = readFileSync(new URL('../src/renderer/editor/md-live.ts', import.meta.url), 'utf8');
  assert.match(
    mdLive,
    /span\.dataset\.wikiTarget\s*=\s*this\.target/,
    'виджет легаси-ссылки несёт data-wiki-target (образец — WikiLinkLabelWidget)',
  );
  const nav = readFileSync(new URL('../src/renderer/editor/wiki-link.ts', import.meta.url), 'utf8');
  assert.match(
    nav,
    /setLegacyWikiLinkClickHandler\(/,
    'навигация регистрирует обработчик развилки для легаси-виджета',
  );
  assert.match(nav, /runLegacyWikiLinkFork\(/, 'развилка вызывается из навигации');
});

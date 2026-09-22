/**
 * Метка корзины в редакторе — задача ff991fb2 (0.8.2).
 *
 * Явная навигация (wiki-ссылка, deep-link) в помеченную мысль разрешена и при
 * выключенной настройке «Показывать содержимое корзины» — ссылки не должны
 * умирать молча. Признак корзины в шапке панели редактора обязан не просто
 * быть, а давать команды: клик открывает общий диалог восстановления/удаления
 * (`openThoughtDeleteDialog`), как метка на карте.
 *
 * DOM-shimmed, как соседние editor-*-тесты. Проводка (ленивый импорт trash.js,
 * вызов диалога) пинится структурно по исходнику: `editor.ts` не поднимается
 * целиком в node:test, а мок модуля диалога ради одного клика — хрупок.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

ShimElement.uppercaseTagNames = true;

const EDITOR_TS = path.resolve(
  import.meta.dirname,
  '..',
  'src',
  'renderer',
  'editor',
  'editor.ts',
);

/** Шим DOM, достаточный для import-time probing CodeMirror (как в editor-header). */
function installShim(): void {
  (globalThis as any).HTMLElement = class {};
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: { style: {} },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => undefined,
    querySelector: () => null,
    activeElement: null,
    body: new ShimElement('body'),
  };
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  win.etn = { ui: { setState: async () => undefined, getState: async () => 'main' } };
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.dispatchEvent = () => undefined;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
}

describe('редактор: метка корзины даёт команды (задача ff991fb2)', () => {
  it('метка — кнопка класса editor-trash-mark со значком и подсказкой о действиях', async () => {
    installShim();
    const { editorInternals } = await import('../src/renderer/editor/editor.js');
    const mark = editorInternals.buildTrashTitleMark({
      id: 't-1',
      title: 'Мысль в корзине',
    } as any) as unknown as ShimElement;

    assert.equal(mark.tagName, 'BUTTON', 'метка кликабельна — это кнопка');
    assert.ok(mark.classList.contains('editor-trash-mark'), 'несёт класс метки корзины');
    assert.equal(mark.type, 'button', 'без отправки формы по Enter');
    assert.equal(mark.children[0]?.tagName, 'SVG', 'значок корзины — SVG');
    assert.match(mark.title, /восстановлени|удалени/i, 'подсказка обещает команды');
  });

  it('updateTitleEl рисует метку помощником, а клик ведёт в общий диалог', () => {
    const source = fs
      .readFileSync(EDITOR_TS, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');

    assert.ok(
      source.includes('titleEl.append(buildTrashTitleMark(ctx.thought))'),
      'метка в заголовке строится общим помощником',
    );

    const start = source.indexOf('function buildTrashTitleMark(');
    assert.ok(start >= 0, 'helper must be defined');
    const body = source.slice(start, source.indexOf('\n}\n', start));
    assert.ok(
      body.includes("import('../trash.js')") && body.includes('openThoughtDeleteDialog'),
      'клик открывает общий диалог удаления/восстановления',
    );
    // Статический импорт замкнул бы цикл: trash.ts тянет editor.ts.
    assert.ok(
      !/^import .*from '..\/trash\.js'/m.test(source),
      'импорт trash.js обязан быть ленивым',
    );
  });
});

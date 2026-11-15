/**
 * Меню команд поля комментария не уезжает при прокрутке длинного текста
 * (ошибка 76691a17, 0.16.1).
 *
 * Симптом до фикса: на вкладке «Основное» у мысли с панелью «Задачи»
 * прокручивается тело группы комментария (`.main-tab > .group > .group-body`),
 * а корень оболочки комментария с модификатором `--scroll` был вторым
 * скролл-контейнером — панель команд уходила вверх вместе с текстом, и до меню
 * форматирования приходилось скроллить обратно к началу комментария.
 *
 * Фикс: панель липнет к верхней кромке прокручиваемой области (правило
 * `.ui-comment .md-field-toolbar`), а внутри вкладки «Основное» корень
 * комментария перестаёт быть скролл-контейнером, чтобы sticky цеплялся за
 * прокручиваемое тело группы.
 *
 * jsdom в проекте нет (конвенция соседних тестов): DOM-часть проверяется под
 * общим шимом, поведение — по правилам собранного CSS рендерера. Мутационная
 * проба: убрать `position: sticky` — второй тест краснеет.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';
import { RENDERER_ROOT } from './renderer-css.js';
import { stripCssComments } from './theme-css.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Устанавливает шим DOM, достаточный для импорта `editor/comment-commands.ts`. */
function installShim(): void {
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: { style: {} },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    body: new ShimElement('body'),
    querySelector: () => null,
    activeElement: null,
  };
  const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  win.innerWidth = 1024;
  win.innerHeight = 768;
}

type Module = typeof import('../src/renderer/editor/comment-commands.js');

let mod: Module;

/**
 * Тело правила по ТОЧНОМУ селектору (`null`, если правила нет). Граница — `}`
 * предыдущего правила или начало текста: селектор-суффикс чужого правила
 * (`.main-tab .ui-comment …`) не должен выдаваться за искомое.
 */
function ruleBody(css: string, selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|[};])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  return match === null ? null : (match[1] ?? '');
}

/** CSS модуля `styles/editor.css` без комментариев — правила тулбара и зон. */
function editorCss(): string {
  return stripCssComments(readFileSync(resolve(RENDERER_ROOT, 'styles', 'editor.css'), 'utf8'));
}

describe('тулбар комментария липнет к верхней кромке (ошибка 76691a17)', () => {
  beforeEach(async () => {
    installShim();
    mod = (await import('../src/renderer/editor/comment-commands.js')) as Module;
  });

  it('панель — первый ребёнок области правки, класс тулбара на ней', async () => {
    const host: any = {
      getEditor: () => ({
        insertAtCaret: () => undefined,
        snapshot: () => ({ text: '', from: 0, to: 0 }),
      }),
      root: new ShimElement('div'),
    };
    const bar = mod.buildCommentToolbar(host) as unknown as ShimElement;
    assert.ok(
      bar.className.split(' ').includes(mod.COMMENT_TOOLBAR_CLASS),
      'тулбар собирается с классом COMMENT_TOOLBAR_CLASS',
    );

    // DOM-порядок: панель вставляется в область правки ДО контейнера прокрутки
    // текста — тогда sticky держит её над текстом (editor/markdown-field.ts).
    const field = readFileSync(resolve(RENDERER_ROOT, 'editor', 'markdown-field.ts'), 'utf8');
    const flat = field.replace(/\s+/g, ' ');
    assert.match(
      flat,
      /area\.replaceChildren\(buildCommentToolbar\(commandHost\), scroller\)/,
      'тулбар вставляется первым ребёнком `.md-field-area`, скроллер — после него',
    );
  });

  it('CSS: панель внутри оболочки комментария — position sticky, top 0, свой фон', () => {
    const css = editorCss();
    const body = ruleBody(css, '.ui-comment .md-field-toolbar');
    assert.ok(body !== null, 'нет правила `.ui-comment .md-field-toolbar`');
    assert.match(body, /position:\s*sticky/, 'панель не липнет: нет position: sticky');
    assert.match(body, /top:\s*0(?:px)?\s*;/, 'панель не крепится к верхней кромке: нет top: 0');
    assert.match(
      body,
      /background:\s*var\(--surface\)/,
      'нет непрозрачного фона токена --surface — текст проплывал бы сквозь панель',
    );
    assert.match(body, /z-index:\s*\d+/, 'нет z-index — текст рисуется поверх панели');
  });

  it('вкладка «Основное»: корень комментария не создаёт свой скролл-контейнер', () => {
    const mainTab = ruleBody(editorCss(), '.main-tab .ui-comment--scroll');
    assert.ok(mainTab !== null, 'нет правила `.main-tab .ui-comment--scroll`');
    assert.match(
      mainTab,
      /overflow:\s*visible/,
      'корень остался scroll-контейнером — sticky цепляется за него, а не за тело группы',
    );
    // Общий модификатор оболочки не сломан: вне «Основного» он по-прежнему даёт
    // прокрутку (правило живёт в стилях фасада `lib/ui/comment.css`, они входят
    // в бандл импортом из TS, а не через манифест `styles.css`).
    const commentCss = stripCssComments(
      readFileSync(resolve(RENDERER_ROOT, 'lib', 'ui', 'comment.css'), 'utf8'),
    );
    const base = ruleBody(commentCss, '.ui-comment--scroll');
    assert.ok(base !== null, 'нет базового правила `.ui-comment--scroll`');
    assert.match(base, /overflow:\s*auto/, 'модификатор --scroll потерял прокрутку');
  });
});

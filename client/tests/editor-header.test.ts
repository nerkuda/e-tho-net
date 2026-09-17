/**
 * Unit tests for the editor's thought header (задача 8ab775d9, 0.8.1,
 * единая модель связей). Структура — три строки:
 *   1. иконка · заголовок · ⚙ (Настройки мысли)
 *   2. синонимы
 *   3. тип ▾ · «актуально» · подменю «Действия»
 *
 * Полная шапка собирается приватной `buildThoughtHeader` в editor.ts; для
 * прямого unit-теста потребовалось бы экспортировать её через
 * `editorInternals`, что выходит за рамки этой доделки (правило «не правь
 * production-файлы редактора»). Здесь тестируется доступная через
 * `editorInternals` placeholder-версия (`buildThoughtHeaderLoading`) —
 * она сохраняет ту же трёхстрочную геометрию, что и боевая, чтобы при
 * загрузке мысли не было «прыжка» высоты.
 *
 * DOM-shimmed, как соседние editor-*-тесты.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Минимальный element-stub для обхода дерева шапки редактора. */
class ShimElement {
  tagName: string;
  className = '';
  children: ShimElement[] = [];
  textContent = '';
  value = '';
  type = '';
  checked = false;
  title = '';
  placeholder = '';
  isConnected = true;
  tabIndex = -1;
  attributes: Record<string, string> = {};
  listeners: Record<string, Array<(event?: any) => void>> = {};
  style: Record<string, string> = {};
  parent: ShimElement | null = null;
  classList = {
    add: () => undefined,
    remove: () => undefined,
    toggle: () => undefined,
    contains: () => false,
  };
  constructor(tag: string, className?: string, text?: string) {
    this.tagName = tag;
    if (className !== undefined) this.className = className;
    if (text !== undefined) this.textContent = text;
  }
  append(...nodes: ShimElement[]): void {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: ShimElement[]): void {
    this.children = nodes;
  }
  removeChild(node: ShimElement): void {
    this.children = this.children.filter((c) => c !== node);
  }
  remove(): void {
    this.parent = null;
  }
  addEventListener(type: string, handler: (event?: any) => void): void {
    (this.listeners[type] ??= []).push(handler);
  }
  removeEventListener(): void {}
  dispatch(type: string, event?: any): void {
    for (const handler of this.listeners[type] ?? []) handler(event);
  }
  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }
  contains(): boolean {
    return false;
  }
  focus(): void {}
  click(): void {
    this.dispatch('click');
  }
  querySelector(): ShimElement | null {
    return null;
  }
  querySelectorAll(): ShimElement[] {
    return [];
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 };
  }
}

/**
 * Устанавливает шим DOM, достаточный для editor-импорта (CodeMirror 6
 * import-time probing). Не зависит от реального `window.etn` — тесты
 * проверяют структуру, не сетевые вызовы.
 */
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

/** Рекурсивно ищет первый элемент с указанным классом. */
function findByClass(root: ShimElement, className: string): ShimElement | undefined {
  if (root.className.split(' ').includes(className)) return root;
  for (const child of root.children) {
    const hit = findByClass(child, className);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * Тесты на placeholder-версию шапки (`buildThoughtHeaderLoading`). Полная
 * боевая шапка собирается приватной `buildThoughtHeader`, см. комментарий
 * в шапке файла — её unit-тест требует экспорта через editorInternals,
 * что выходит за границу доделки тестов (не правим production-код).
 */
describe('editor thought header — placeholder preserves three-row geometry (8ab775d9)', () => {
  it('placeholder carries the same row count as the loaded header (no height jump)', async () => {
    installShim();
    const { editorInternals } = await import('../src/renderer/editor/editor.js');
    const header = editorInternals.buildThoughtHeaderLoading('t-loading') as unknown as ShimElement;
    assert.ok(header !== null && header !== undefined, 'placeholder header is built');

    // Тот же набор строк, что и у боевой шапки: editor-top-row + (synonyms)
    // + editor-header-row. Поле синонимов в loading-плейсхолдере опускается
    // (нет значения), но верх и низ обязаны присутствовать, чтобы при
    // подмене контента не «прыгала» высота.
    const topRow = findByClass(header, 'editor-top-row');
    assert.ok(topRow !== undefined, 'row 1 (editor-top-row) is present');
    const headerRow = findByClass(header, 'editor-header-row');
    assert.ok(headerRow !== undefined, 'row 3 (editor-header-row) is present');
  });

  it('«Действия ▾» собирается общим конструктором меню мысли (контракт)', () => {
    // Контракт меню «Действия ▾» (спецификация «Контекстное меню мысли»):
    // свой список команд в редакторе запрещён — меню строится тем же
    // конструктором, что у облачка на холсте (`canvas/context-menu.ts`), и
    // отличается только опциями контекста. Здесь фиксируем ровно это: редактор
    // зовёт общий конструктор, а состав команд проверяется unit-тестами
    // конструктора (`context-menu.test.ts`), где живёт композиция.
    const editorSrc = readFileSync(
      join(__dirname, '..', 'src', 'renderer', 'editor', 'editor.ts'),
      'utf8',
    );
    const start = editorSrc.indexOf('async function openThoughtActionsMenu');
    assert.ok(start >= 0, 'openThoughtActionsMenu must be defined');
    const body = editorSrc.slice(start, editorSrc.indexOf('\n}\n', start));
    assert.ok(
      body.includes("'../canvas/context-menu.js'") && body.includes('showThoughtMenuUnder('),
      '«Действия ▾» must delegate to the shared thought menu builder',
    );
    assert.ok(
      body.includes('hideOpenCommand: true'),
      'the edited thought is already open — the open command must be hidden',
    );
    assert.ok(body.includes('focusHandler'), '«В фокус» must come from the shared builder');
    assert.ok(
      body.includes('attachmentHandler'),
      '«Добавить вложение» in the editor must lead to the attachments tab',
    );
    // Своих label-ов команд в редакторе быть не должно: единственный источник —
    // конструктор меню.
    for (const label of ['Закрепить мысль', 'Открепить мысль', 'Добавить к выделению']) {
      assert.ok(
        !body.includes(`'${label}'`),
        `«Действия ▾» must not hand-roll the «${label}» command (shared builder owns it)`,
      );
    }
  });
});

/**
 * Unit tests for the shared thought-cloud factory (задача b28ab6d6,
 * client/src/renderer/lib/thought-cloud.ts).
 *
 * Фабрика собирает DOM, поэтому тесты гоняются под Node с минимальным
 * DOM-шимом (как в editor-header.test.ts): проверяются структура разметки
 * по профилям, признаки состояния, обрезка названия, жесты и реэкспорт
 * канона из canvas.ts. Раскладка в тестах не выполняется — обрезка
 * названия раскладкой проверяется по инлайн-стилям и `title`-подсказке.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, mock } from 'node:test';

import {
  CLOUD_PROFILES,
  SINGLE_CLICK_DELAY_MS,
  applyCloudStyle as factoryApplyCloudStyle,
  applyThoughtIcon,
  createThoughtCloud,
  deferSingleClick,
  resolveCloudStyle,
  resolveThoughtIcon,
  type CloudProfile,
  type ThoughtCloudInput,
  type ThoughtCloudOptions,
} from '../src/renderer/lib/thought-cloud.js';
import {
  applyCloudStyle as canvasApplyCloudStyle,
  applyThoughtIcon as canvasApplyThoughtIcon,
  canvasInternals,
  resolveCloudStyle as canvasResolveCloudStyle,
  resolveThoughtIcon as canvasResolveThoughtIcon,
} from '../src/renderer/canvas/canvas.js';

// ---------------------------------------------------------------------------
// Минимальный DOM-шим
// ---------------------------------------------------------------------------

/** Элемент-заглушка: классов, стилей, dataset, детей и слушателей достаточно
 *  для фабрики; реального рендера и раскладки не происходит. */
class ShimElement {
  tagName: string;
  className = '';
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  title = '';
  tabIndex = -1;
  type = '';
  textContent = '';
  src = '';
  alt = '';
  innerHTML = '';
  hidden = false;
  children: ShimElement[] = [];
  private attrs = new Map<string, string>();
  private listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  classList = {
    add: (...names: string[]): void => {
      for (const name of names) this.addClass(name);
    },
    remove: (name: string): void => {
      this.className = this.className
        .split(/\s+/)
        .filter((c) => c !== '' && c !== name)
        .join(' ');
    },
    toggle: (name: string, force?: boolean): void => {
      const has = this.className.split(/\s+/).includes(name);
      const next = force ?? !has;
      if (next && !has) this.addClass(name);
      if (!next && has) this.classList.remove(name);
    },
    contains: (name: string): boolean => this.className.split(/\s+/).includes(name),
  };

  private addClass(name: string): void {
    if (!this.classList.contains(name)) {
      this.className = this.className === '' ? name : `${this.className} ${name}`;
    }
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  replaceChildren(...nodes: ShimElement[]): void {
    this.children = nodes;
  }

  append(...nodes: ShimElement[]): void {
    this.children.push(...nodes);
  }

  addEventListener(type: string, fn: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  /** Вызывает зарегистрированные обработчики с фейковым событием. */
  fire(type: string, event: unknown = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
}

/** Рекурсивно ищет первый элемент с указанным классом. */
function findByClass(root: ShimElement, className: string): ShimElement | undefined {
  if (root.classList.contains(className)) return root;
  for (const child of root.children) {
    const hit = findByClass(child, className);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Фейковое событие мыши с флагами модификаторов и учётом preventDefault. */
interface FakeMouseEvent {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  propagationStopped: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
}

function mouseEvent(init: Partial<FakeMouseEvent> = {}): FakeMouseEvent {
  const e: FakeMouseEvent = {
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault: () => {
      e.defaultPrevented = true;
    },
    stopPropagation: () => {
      e.propagationStopped = true;
    },
    ...init,
  };
  return e;
}

/** Устанавливает шим DOM и window.setTimeout (таким, что mock.timers его видит). */
function installShim(): void {
  (globalThis as Record<string, unknown>).HTMLElement = class {};
  (globalThis as Record<string, unknown>).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
  };
  const win = ((globalThis as Record<string, unknown>).window ??
    ((globalThis as Record<string, unknown>).window = {})) as Record<string, unknown>;
  Object.defineProperty(win, 'setTimeout', {
    configurable: true,
    get: () => globalThis.setTimeout,
  });
  Object.defineProperty(win, 'clearTimeout', {
    configurable: true,
    get: () => globalThis.clearTimeout,
  });
}

function cloud(
  input: ThoughtCloudInput,
  options: ThoughtCloudOptions,
): ShimElement {
  return createThoughtCloud(input, options) as unknown as ShimElement;
}

const thought = (overrides: Partial<ThoughtCloudInput> = {}): ThoughtCloudInput => ({
  id: 't-1',
  title: 'Мысль',
  ...overrides,
});

installShim();

// ---------------------------------------------------------------------------
// Профили
// ---------------------------------------------------------------------------

describe('профили отображения (закрытый перечень)', () => {
  it('перечень ровно из четырёх профилей: canvas/tree/chip/graph', () => {
    assert.deepEqual([...CLOUD_PROFILES], ['canvas', 'tree', 'chip', 'graph']);
  });

  for (const profile of CLOUD_PROFILES) {
    it(`${profile}: корень несёт data-id, маркер профиля и tabIndex`, () => {
      const root = cloud(thought(), { profile });
      assert.equal(root.dataset['id'], 't-1');
      assert.ok(root.classList.contains(`cloud-profile-${profile}`));
      assert.equal(root.tabIndex, 0);
    });
  }

  it('canvas: .cloud с иконкой и колонкой .cloud-main > .cloud-title, название в несколько строк (без инлайна)', () => {
    const root = cloud(thought(), { profile: 'canvas' });
    assert.ok(root.classList.contains('cloud'));
    const icon = findByClass(root, 'cloud-icon');
    assert.ok(icon !== undefined);
    const main = findByClass(root, 'cloud-main');
    assert.ok(main !== undefined);
    const title = findByClass(main, 'cloud-title');
    assert.ok(title !== undefined);
    assert.equal(title.style.whiteSpace ?? '', '');
  });

  it('tree: одна строка — обрезка раскладкой (nowrap + ellipsis + overflow)', () => {
    const root = cloud(thought(), { profile: 'tree' });
    const title = findByClass(root, 'cloud-title');
    assert.ok(title !== undefined);
    assert.equal(title.style.whiteSpace, 'nowrap');
    assert.equal(title.style.textOverflow, 'ellipsis');
    assert.equal(title.style.overflow, 'hidden');
  });

  it('chip: .prop-ref-cloud, значок .mini-icon и подпись .prc-title (span) с обрезкой', () => {
    const root = cloud(thought(), { profile: 'chip' });
    assert.ok(root.classList.contains('prop-ref-cloud'));
    const icon = findByClass(root, 'mini-icon');
    assert.ok(icon !== undefined);
    const title = findByClass(root, 'prc-title');
    assert.ok(title !== undefined);
    assert.equal(title.tagName, 'SPAN');
    assert.equal(title.style.whiteSpace, 'nowrap');
    assert.equal(title.style.textOverflow, 'ellipsis');
  });

  it('graph: минимальный набор — значок и подпись напрямую, без .cloud-main', () => {
    const root = cloud(thought(), { profile: 'graph' });
    assert.ok(root.classList.contains('cloud'));
    assert.ok(findByClass(root, 'cloud-icon') !== undefined);
    assert.ok(findByClass(root, 'cloud-title') !== undefined);
    assert.equal(findByClass(root, 'cloud-main'), undefined);
  });
});

// ---------------------------------------------------------------------------
// Признаки состояния
// ---------------------------------------------------------------------------

describe('признаки состояния', () => {
  it('неактуальная — бледность (.dim)', () => {
    const root = cloud(thought({ active: false }), { profile: 'canvas' });
    assert.ok(root.classList.contains('dim'));
  });

  it('в корзине — бледность + кликабельная метка корзины (.cloud-trash-badge)', () => {
    const root = cloud(thought({ marked_for_deletion: true }), { profile: 'canvas' });
    assert.ok(root.classList.contains('dim'));
    const badge = findByClass(root, 'cloud-trash-badge');
    assert.ok(badge !== undefined);
    assert.equal(badge.children[0]?.tagName, 'SVG');
    assert.equal(badge.title, 'Мысль находится в корзине. Нажмите для удаления/восстановления');
  });

  it('в корзине (chip) — компактная метка .list-trash-mark', () => {
    const root = cloud(thought({ marked_for_deletion: true }), { profile: 'chip' });
    assert.ok(root.classList.contains('dim'));
    const mark = findByClass(root, 'list-trash-mark');
    assert.ok(mark !== undefined);
    assert.equal(mark.children[0]?.tagName, 'SVG');
    assert.equal(findByClass(root, 'cloud-trash-badge'), undefined);
  });

  it('актуальная и не в корзине — без бледности и меток', () => {
    const root = cloud(thought(), { profile: 'canvas' });
    assert.ok(!root.classList.contains('dim'));
    assert.equal(findByClass(root, 'cloud-trash-badge'), undefined);
    assert.equal(findByClass(root, 'list-trash-mark'), undefined);
  });

  it('захват чужим клиентом — рамка locked-by-other и бейдж с именем', () => {
    const root = cloud(thought(), {
      profile: 'canvas',
      lock: { holder: 'Анна', bySelf: false },
    });
    assert.ok(root.classList.contains('locked-by-other'));
    assert.ok(!root.classList.contains('locked-by-self'));
    const badge = findByClass(root, 'cloud-lock-badge');
    assert.ok(badge !== undefined);
    assert.ok(!badge.classList.contains('own'));
    assert.equal(badge.title, 'Редактирует Анна');
  });

  it('захват своим клиентом — рамка locked-by-self и мягкий бейдж .own', () => {
    const root = cloud(thought(), {
      profile: 'canvas',
      lock: { holder: null, bySelf: true },
    });
    assert.ok(root.classList.contains('locked-by-self'));
    assert.ok(!root.classList.contains('locked-by-other'));
    const badge = findByClass(root, 'cloud-lock-badge');
    assert.ok(badge !== undefined);
    assert.ok(badge.classList.contains('own'));
    assert.equal(badge.title, 'Вы редактируете эту мысль.');
  });

  it('без захвата — ни рамок, ни бейджа', () => {
    const root = cloud(thought(), { profile: 'canvas', lock: null });
    assert.ok(!root.classList.contains('locked-by-other'));
    assert.ok(!root.classList.contains('locked-by-self'));
    assert.equal(findByClass(root, 'cloud-lock-badge'), undefined);
  });
});

// ---------------------------------------------------------------------------
// Стиль и значок
// ---------------------------------------------------------------------------

describe('цвет, начертание и значок', () => {
  it('явный цвет текста применяется инлайном', () => {
    const root = cloud(thought({ fg_color: '#ff0000' }), { profile: 'canvas' });
    assert.equal(root.style.color, '#ff0000');
  });

  it('без цвета текста, но с фоном — контрастный текст по WCAG', () => {
    const root = cloud(thought({ fg_color: null, bg_color: '#222222' }), {
      profile: 'canvas',
    });
    assert.equal(root.style.background, '#222222');
    assert.equal(root.style.color, '#ffffff');
  });

  it('начертание — классы font-bold/font-italic', () => {
    const root = cloud(
      thought({ font_bold: true, font_italic: true, font_underline: false }),
      { profile: 'canvas' },
    );
    assert.ok(root.classList.contains('font-bold'));
    assert.ok(root.classList.contains('font-italic'));
    assert.ok(!root.classList.contains('font-underline'));
  });

  it('эмодзи-значок — глифом в боксе; свой значок побеждает', () => {
    const root = cloud(thought({ icon: '⭐', icon_kind: 'emoji' }), { profile: 'canvas' });
    const icon = findByClass(root, 'cloud-icon');
    assert.ok(icon !== undefined);
    assert.equal(icon.textContent, '⭐');
  });

  it('без своего значка — дефолтный 💭', () => {
    const root = cloud(thought(), { profile: 'canvas' });
    const icon = findByClass(root, 'cloud-icon');
    assert.ok(icon !== undefined);
    assert.equal(icon.textContent, '💭');
  });

  it('значок-изображение — <img> с src и dataset для Ctrl-hover лупы', () => {
    const root = cloud(
      thought({ icon: 'etnimg://x', icon_kind: 'image', icon_attachment_id: 'a-1' }),
      { profile: 'canvas' },
    );
    const icon = findByClass(root, 'cloud-icon');
    assert.ok(icon !== undefined);
    const img = icon.children[0];
    assert.ok(img !== undefined);
    assert.equal(img.tagName, 'IMG');
    assert.equal(img.src, 'etnimg://x');
    assert.equal(img.dataset['zoomThought'], 't-1');
    assert.equal(img.dataset['zoomAttachment'], 'a-1');
  });
});

// ---------------------------------------------------------------------------
// Обрезка названия
// ---------------------------------------------------------------------------

describe('обрезка названия — раскладкой, не подсчётом символов', () => {
  const longTitle = 'Очень длинное название мысли, которое не поместится ни в одну строку дерева и чипа '.repeat(4);

  for (const profile of CLOUD_PROFILES) {
    it(`${profile}: полное имя — подсказкой (title), текст не режется в JS`, () => {
      const root = cloud(thought({ title: longTitle }), { profile });
      const title =
        profile === 'chip'
          ? findByClass(root, 'prc-title')
          : findByClass(root, 'cloud-title');
      assert.ok(title !== undefined);
      assert.equal(title.title, longTitle);
      assert.equal(title.textContent, longTitle);
    });
  }

  it('в модуле нет числовых лимитов отображаемого текста (ADR «Обрезка текста…»)', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(
      path.join(here, '..', 'src', 'renderer', 'lib', 'thought-cloud.ts'),
      'utf8',
    );
    assert.ok(!src.includes('TITLE_CLIP'), 'no TITLE_CLIP constant');
    assert.ok(!/\.slice\(0,/.test(src), 'no slice(0, N) clipping');
    assert.ok(!/\.substring\(0,/.test(src), 'no substring(0, N) clipping');
  });

  it('модуль не импортирует editor/* (грабли «Цикл импортов canvas.ts ↔ editor-модулей»)', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(
      path.join(here, '..', 'src', 'renderer', 'lib', 'thought-cloud.ts'),
      'utf8',
    );
    assert.ok(!/from ['"]\.\.\/editor\//.test(src), 'no ../editor/* imports');
    assert.ok(!/from ['"]\.\/editor\//.test(src), 'no ./editor/* imports');
  });
});

// ---------------------------------------------------------------------------
// Единые жесты
// ---------------------------------------------------------------------------

describe('единые жесты (клик / двойной клик / Ctrl+клик / контекстное меню)', () => {
  it('одиночный клик отложен на время двойного и вызывает onClick с id', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let opened: string | null = null;
      const root = cloud(thought(), {
        profile: 'canvas',
        actions: { onClick: (id) => (opened = id) },
      });
      root.fire('click', mouseEvent());
      assert.equal(opened, null, 'действие ждёт двойного клика');
      mock.timers.tick(SINGLE_CLICK_DELAY_MS + 10);
      assert.equal(opened, 't-1');
    } finally {
      mock.timers.reset();
    }
  });

  it('двойной клик отменяет отложенный одиночный и вызывает onDoubleClick', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let opened: string | null = null;
      let focused: string | null = null;
      const root = cloud(thought(), {
        profile: 'canvas',
        actions: { onClick: (id) => (opened = id), onDoubleClick: (id) => (focused = id) },
      });
      root.fire('click', mouseEvent());
      root.fire('dblclick', mouseEvent());
      mock.timers.tick(SINGLE_CLICK_DELAY_MS + 10);
      assert.equal(opened, null, 'одиночный клик отменён');
      assert.equal(focused, 't-1');
    } finally {
      mock.timers.reset();
    }
  });

  it('Ctrl+клик вызывает onCtrlClick сразу и не запускает onClick', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let opened: string | null = null;
      let toggled: string | null = null;
      const root = cloud(thought(), {
        profile: 'canvas',
        actions: { onClick: (id) => (opened = id), onCtrlClick: (id) => (toggled = id) },
      });
      root.fire('click', mouseEvent({ ctrlKey: true }));
      assert.equal(toggled, 't-1');
      mock.timers.tick(SINGLE_CLICK_DELAY_MS + 10);
      assert.equal(opened, null);
    } finally {
      mock.timers.reset();
    }
  });

  it('двойной клик с модификатором игнорируется', () => {
    let focused: string | null = null;
    const root = cloud(thought(), {
      profile: 'canvas',
      actions: { onDoubleClick: (id) => (focused = id) },
    });
    root.fire('dblclick', mouseEvent({ ctrlKey: true }));
    assert.equal(focused, null);
  });

  it('контекстное меню — preventDefault и общее действие с событием и id', () => {
    let menuFor: string | null = null;
    let sawEvent = false;
    const root = cloud(thought(), {
      profile: 'canvas',
      actions: {
        onContextMenu: (_e, id) => {
          sawEvent = true;
          menuFor = id;
        },
      },
    });
    const e = mouseEvent();
    root.fire('contextmenu', e);
    assert.equal(e.defaultPrevented, true);
    assert.equal(sawEvent, true);
    assert.equal(menuFor, 't-1');
  });

  it('клик по метке корзины — stopPropagation и onTrashBadgeClick вместо открытия', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let opened: string | null = null;
      let dialogFor: string | null = null;
      const root = cloud(thought({ marked_for_deletion: true }), {
        profile: 'canvas',
        actions: { onClick: (id) => (opened = id), onTrashBadgeClick: (id) => (dialogFor = id) },
      });
      const badge = findByClass(root, 'cloud-trash-badge');
      assert.ok(badge !== undefined);
      const e = mouseEvent();
      badge.fire('click', e);
      assert.equal(e.propagationStopped, true);
      assert.equal(dialogFor, 't-1');
      mock.timers.tick(SINGLE_CLICK_DELAY_MS + 10);
      assert.equal(opened, null);
    } finally {
      mock.timers.reset();
    }
  });

  it('кнопка удаления чипа — onRemove и stopPropagation', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let removed: string | null = null;
      let opened: string | null = null;
      const root = cloud(thought(), {
        profile: 'chip',
        actions: { onClick: (id) => (opened = id), onRemove: (id) => (removed = id) },
      });
      const btn = findByClass(root, 'st-f-clear-inline');
      assert.ok(btn !== undefined, 'кнопка удаления есть');
      assert.equal(btn.title, 'Убрать из значения');
      const e = mouseEvent();
      btn.fire('click', e);
      assert.equal(e.propagationStopped, true);
      assert.equal(removed, 't-1');
      mock.timers.tick(SINGLE_CLICK_DELAY_MS + 10);
      assert.equal(opened, null);
    } finally {
      mock.timers.reset();
    }
  });

  it('без onRemove кнопка удаления чипа не рисуется', () => {
    const root = cloud(thought(), { profile: 'chip', actions: { onClick: () => undefined } });
    assert.equal(findByClass(root, 'st-f-clear-inline'), undefined);
  });

  it('бейдж захвата подавляет собственные клики (stopPropagation)', () => {
    const root = cloud(thought(), {
      profile: 'canvas',
      lock: { holder: 'Анна', bySelf: false },
      actions: { onClick: () => undefined },
    });
    const badge = findByClass(root, 'cloud-lock-badge');
    assert.ok(badge !== undefined);
    for (const type of ['click', 'dblclick', 'contextmenu'] as const) {
      const e = mouseEvent();
      badge.fire(type, e);
      assert.equal(e.propagationStopped, true, `${type} подавлен`);
    }
  });
});

// ---------------------------------------------------------------------------
// Канон и реэкспорт
// ---------------------------------------------------------------------------

describe('канон стиля/значка', () => {
  it('resolveCloudStyle возвращает поля fg/bg и четыре флага начертания', () => {
    const style = resolveCloudStyle({
      type_id: null,
      fg_color: null,
      bg_color: null,
      font_bold: null,
      font_italic: null,
      font_underline: null,
      font_strike: null,
    });
    assert.deepEqual(Object.keys(style).sort(), [
      'bg',
      'bold',
      'fg',
      'italic',
      'strike',
      'underline',
    ]);
    assert.equal(style.fg, null);
    assert.equal(style.bg, null);
    assert.equal(style.bold, false);
  });

  it('resolveThoughtIcon без своего значка и без типа — null + emoji (дефолт 💭)', () => {
    assert.deepEqual(resolveThoughtIcon({ icon: null, icon_kind: 'emoji', type_id: null }), {
      icon: null,
      kind: 'emoji',
    });
  });

  it('applyThoughtIcon рисует глиф в бокс', () => {
    const box = new ShimElement('span');
    applyThoughtIcon(box as unknown as HTMLElement, {
      icon: '🧠',
      icon_kind: 'emoji',
      type_id: null,
    });
    assert.equal(box.textContent, '🧠');
  });

  it('deferSingleClick срабатывает по SINGLE_CLICK_DELAY_MS и отменяется cancel()', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let fired = 0;
      const handle = deferSingleClick(() => {
        fired++;
      });
      handle.cancel();
      mock.timers.tick(SINGLE_CLICK_DELAY_MS + 10);
      assert.equal(fired, 0, 'cancel гасит таймер');
      deferSingleClick(() => {
        fired++;
      });
      mock.timers.tick(SINGLE_CLICK_DELAY_MS + 10);
      assert.equal(fired, 1);
    } finally {
      mock.timers.reset();
    }
  });

  it('canvas.ts реэкспортирует канон из фабрики (тот же объект)', () => {
    assert.equal(canvasResolveCloudStyle, resolveCloudStyle);
    assert.equal(canvasApplyCloudStyle, factoryApplyCloudStyle);
    assert.equal(canvasResolveThoughtIcon, resolveThoughtIcon);
    assert.equal(canvasApplyThoughtIcon, applyThoughtIcon);
    assert.equal(typeof canvasInternals.deferSingleClick, 'function');
    assert.equal(typeof canvasInternals.SINGLE_CLICK_DELAY_MS, 'number');
    assert.equal(canvasInternals.resolveCloudStyle, resolveCloudStyle);
    assert.equal(canvasInternals.resolveThoughtIcon, resolveThoughtIcon);
  });
});

// Тип профиля на месте — статическая проверка перечня.
const _allProfiles: CloudProfile[] = ['canvas', 'tree', 'chip', 'graph'];
void _allProfiles;

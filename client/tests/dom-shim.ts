/**
 * Общий DOM-шим для клиентских тестов (Node, без jsdom).
 *
 * До этого модуля минимальный `ShimElement` был скопирован в четыре десятка
 * тестовых файлов, и копии разошлись (одни умели событие `remove`, другие —
 * дисциплину `isConnected` по цепочке родителей, третьи — поиск по селекторам).
 * Здесь собран самый полный набор возможностей этих копий; тесты импортируют
 * классы отсюда, а не заводят собственную копию. За этим следит сторож
 * `guard-dom-shim.test.ts`.
 *
 * Намеренно НЕ инкапсулирует установку глобалей (`document`/`window`): у каждого
 * теста свой набор моков (`window.etn`, слушатели, таймеры) и свой момент
 * установки (до первого динамического импорта модулей под тестом). Модуль даёт
 * общий «кирпич» — элемент и класс-лист; сборка окружения остаётся у теста.
 *
 * Ключевые контракты, сведённые из копий:
 * - `classList` привязан к `className` владельца (`attach`) — прямая запись
 *   `className` и операции `classList` видят друг друга;
 * - `isConnected` считается по цепочке `parent` до корня с флагом
 *   `connectedRoot` (по умолчанию `true` — как у «плоских» копий); запись
 *   `el.isConnected = false` меняет флаг корня;
 * - `remove()` вынимает узел из родителя и НЕ шлёт событие `remove` (в
 *   Chromium/Electron `Element.remove()` события не даёт — ошибка 0c45bce8);
 *   очистку потребители зовут напрямую;
 * - `emit`/`dispatch`/`fire` — один и тот же тестовый драйвер событий.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Обработчик события в шиме: форма события максимально свободная. */
export type ShimHandler = (event?: any) => void;

/** Прямоугольник `getBoundingClientRect`. */
export interface ShimRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/**
 * `style` элемента: помимо методов `CSSStyleDeclaration`, в него можно писать
 * произвольные свойства (`el.style.display = 'none'`), как в настоящем DOM.
 */
export interface ShimStyle {
  setProperty(name: string, value: string): void;
  removeProperty(name: string): void;
  getPropertyValue(name: string): string;
  [key: string]: any;
}

function createStyle(): ShimStyle {
  const style: ShimStyle = {
    setProperty: (name: string, value: string): void => {
      style[name] = value;
    },
    removeProperty: (name: string): void => {
      delete style[name];
    },
    getPropertyValue: (name: string): string => {
      const value = style[name];
      return value === undefined || value === null ? '' : String(value);
    },
  };
  return style;
}

/**
 * Класс-лист, хранящий токены в `className` владельца. Владелец назначается
 * методом `attach` в конструкторе элемента; до привязки операции — no-op.
 */
export class ShimClassList {
  private owner: ShimElement | null = null;

  attach(owner: ShimElement): void {
    this.owner = owner;
  }

  private tokens(): Set<string> {
    return new Set(
      (this.owner?.className ?? '')
        .split(/\s+/)
        .filter((token) => token !== ''),
    );
  }

  private write(tokens: Set<string>): void {
    if (this.owner !== null) this.owner.className = [...tokens].join(' ');
  }

  add(...names: string[]): void {
    const tokens = this.tokens();
    for (const name of names) {
      for (const token of name.split(/\s+/).filter((t) => t !== '')) tokens.add(token);
    }
    this.write(tokens);
  }

  remove(...names: string[]): void {
    const tokens = this.tokens();
    for (const name of names) {
      for (const token of name.split(/\s+/).filter((t) => t !== '')) tokens.delete(token);
    }
    this.write(tokens);
  }

  contains(name: string): boolean {
    return this.tokens().has(name);
  }

  /**
   * Итерация токенов, как у реального `DOMTokenList`: продукт обходит классы
   * спредом (`[...el.classList]`, напр. поиск маркера фокуса в
   * `editor.ts` → `restoreEditorFocus`). Без итератора такой код на шиме
   * падал бы «not iterable».
   */
  [Symbol.iterator](): IterableIterator<string> {
    return this.tokens().values();
  }

  toggle(name: string, force?: boolean): void {
    const tokens = this.tokens();
    const next = force ?? !tokens.has(name);
    if (next) tokens.add(name);
    else tokens.delete(name);
    this.write(tokens);
  }
}

/** Универсальный предикат `findAll` — подстрока класса или свой предикат. */
export type ShimMatch = string | ((element: ShimElement) => boolean);

/**
 * Минимальный, но надёжный элемент: переживает сборку/перерисовку интерфейса,
 * классификацию, атрибуты, события и запросы по селекторам.
 */
export class ShimElement {
  /**
   * Отдавать `tagName` в верхнем регистре (как настоящий HTML-DOM). Включено
   * только теми тестами, которые исторически проверяли регистр (`thought-cloud`):
   * большинство копий шима хранило тег как передан.
   */
  static uppercaseTagNames = false;

  tagName: string;
  className = '';
  children: ShimElement[] = [];
  parent: ShimElement | null = null;
  style: ShimStyle = createStyle();
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  innerHTML = '';
  textContent = '';
  value = '';
  valueAsNumber = 0;
  type = '';
  checked = false;
  disabled = false;
  readOnly = false;
  hidden = false;
  title = '';
  name = '';
  id = '';
  htmlFor = '';
  role = '';
  ariaLabel = '';
  placeholder = '';
  autocomplete = '';
  inputMode = '';
  spellcheck = false;
  min = '';
  max = '';
  step = '';
  src = '';
  alt = '';
  rows = 0;
  maxLength = 0;
  colSpan = 0;
  options: ShimElement[] = [];
  scrollTop = 0;
  /** Высота содержимого прокручиваемого контейнера (для клампинга `scrollTop`). */
  scrollHeight = 0;
  /** Видимая высота прокручиваемого контейнера. */
  clientHeight = 0;
  offsetWidth = 0;
  /** Смещение относительно `offsetParent` (якорь сохранения прокрутки). */
  offsetTop = 0;
  tabIndex = 0;
  focused = false;
  /** Корень, подключённый к документу: читается геттером `isConnected`. */
  connectedRoot = true;
  /** Прямоугольник, который отдаёт `getBoundingClientRect`. */
  rect: ShimRect = { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 };
  classList: ShimClassList = new ShimClassList();
  /** Зарегистрированные слушатели по типу события (публичны — тесты их читают). */
  readonly listeners: Record<string, ShimHandler[]> = {};

  constructor(tag: string, className?: string, text?: string) {
    this.tagName = ShimElement.uppercaseTagNames ? tag.toUpperCase() : tag;
    this.classList.attach(this);
    if (className !== undefined && className !== '') this.className = className;
    if (text !== undefined) this.textContent = text;
    // Ссылки на родителя/класс-лист/слушателей/стили делают дерево циклическим:
    // тесты умеют сериализовать элемент (`JSON.stringify`) как текстовый стог,
    // поэтому служебные поля-связи не перечисляемы.
    for (const key of ['parent', 'classList', 'listeners', 'style'] as const) {
      Object.defineProperty(this, key, {
        value: this[key],
        enumerable: false,
        writable: true,
        configurable: true,
      });
    }
  }

  /** `isConnected` — по цепочке родителей до корня с флагом `connectedRoot`. */
  get isConnected(): boolean {
    return this.parent === null ? this.connectedRoot : this.parent.isConnected;
  }

  set isConnected(value: boolean) {
    this.connectedRoot = value;
  }

  /** Разобранный набор классов (только чтение; источник — `className`). */
  get classes(): Set<string> {
    return new Set(this.className.split(/\s+/).filter((token) => token !== ''));
  }

  get firstChild(): ShimElement | null {
    return this.children[0] ?? null;
  }

  /** Первый дочерний УЗЕЛ-элемент (текстовые узлы пропускаются, как в DOM). */
  get firstElementChild(): ShimElement | null {
    return this.children.find((child) => child.tagName !== '#text') ?? null;
  }

  /** Число дочерних УЗЛОВ-элементов (как у настоящего DOM; текстовые узлы,
   *  которыми `append` из строки заворачивает строку в `#text`, тоже
   *  считаются — вызывающие из продукта им не пользуются). */
  get childElementCount(): number {
    return this.children.filter((child) => child.tagName !== '#text').length;
  }

  get childNodes(): ShimElement[] {
    return this.children;
  }

  /** Добавляет класс, не трогая остальные (совместимость со старыми копиями). */
  addClass(...names: string[]): void {
    this.classList.add(...names);
  }

  append(...nodes: Array<ShimElement | string>): void {
    for (const node of nodes) {
      const element = typeof node === 'string' ? new ShimElement('#text', undefined, node) : node;
      // `parent` может быть `undefined` у самодельных заглушек-объектов (тесты
      // подставляют вместо элемента простой литерал) — такое тоже принимаем.
      if (element.parent != null) {
        const index = element.parent.children.indexOf(element);
        if (index >= 0) element.parent.children.splice(index, 1);
      }
      element.parent = this;
      this.children.push(element);
    }
  }

  appendChild(node: ShimElement): ShimElement {
    this.append(node);
    return node;
  }

  prepend(...nodes: ShimElement[]): void {
    for (const node of nodes) {
      if (node.parent != null) {
        const index = node.parent.children.indexOf(node);
        if (index >= 0) node.parent.children.splice(index, 1);
      }
      node.parent = this;
    }
    this.children.unshift(...nodes);
  }

  insertBefore(node: ShimElement, before: ShimElement | null): void {
    // Реальная семантика DOM: insertBefore ПЕРЕМЕЩАЕТ уже подключённый узел
    // (сначала снимает его с прежнего места), а не клонирует. Без этого
    // keyed-reconcile давал бы дубли узлов на шиме.
    if (node.parent !== null) {
      const oldIndex = node.parent.children.indexOf(node);
      if (oldIndex >= 0) node.parent.children.splice(oldIndex, 1);
    }
    node.parent = this;
    if (before === null) {
      this.children.push(node);
      return;
    }
    const index = this.children.indexOf(before);
    if (index < 0) this.children.push(node);
    else this.children.splice(index, 0, node);
  }

  insertAdjacentElement(where: string, node: ShimElement): void {
    if (where === 'afterend' && this.parent !== null) {
      const index = this.parent.children.indexOf(this);
      if (index >= 0) this.parent.children.splice(index + 1, 0, node);
      else this.parent.children.push(node);
      node.parent = this.parent;
    }
  }

  removeChild(node: ShimElement): ShimElement {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
    node.parent = null;
    return node;
  }

  replaceChild(node: ShimElement, old: ShimElement): void {
    const index = this.children.indexOf(old);
    if (index === -1) return;
    this.children[index] = node;
    node.parent = this;
    old.parent = null;
  }

  replaceWith(node: ShimElement): void {
    if (this.parent === null) return;
    const index = this.parent.children.indexOf(this);
    if (index === -1) return;
    this.parent.children[index] = node;
    node.parent = this.parent;
    this.parent = null;
  }

  replaceChildren(...nodes: Array<ShimElement | string>): void {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...nodes);
  }

  /**
   * Снятие узла из DOM. Событий НЕ шлёт: в Chromium/Electron
   * `Element.remove()`/`removeChild()` события `remove` не дают, и шим,
   * который бы его слал, вводил бы тесты в заблуждение (каркас диалога именно
   * на этом событии ошибочно держал очистку — ошибка 0c45bce8, давнее
   * происхождение f0e2fba4). Очистку потребители обязаны звать напрямую.
   */
  remove(): void {
    if (this.parent === null) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
  }

  contains(node: ShimElement | null): boolean {
    if (node === null) return false;
    let current: ShimElement | null = node;
    while (current !== null) {
      if (current === this) return true;
      current = current.parent;
    }
    return false;
  }

  isDescendantOf(node: ShimElement): boolean {
    let current: ShimElement | null = this.parent;
    while (current !== null) {
      if (current === node) return true;
      current = current.parent;
    }
    return false;
  }

  addEventListener(type: string, handler: ShimHandler): void {
    (this.listeners[type] ??= []).push(handler);
  }

  removeEventListener(type: string, handler: ShimHandler): void {
    const list = this.listeners[type];
    if (list === undefined) return;
    this.listeners[type] = list.filter((fn) => fn !== handler);
  }

  hasListeners(): boolean {
    for (const list of Object.values(this.listeners)) if (list.length > 0) return true;
    return false;
  }

  /** Тестовый драйвер событий: синтетическое событие всем слушателям типа. */
  emit(type: string, event: any = {}): void {
    for (const listener of [...(this.listeners[type] ?? [])]) listener(event);
  }

  dispatch(type: string, event?: any): void {
    this.emit(type, event);
  }

  /**
   * `dispatchEvent` реального DOM на элементе: тип берётся из `event.type`.
   * Продукт шлёт на элементах `CustomEvent` (`editor/properties.ts` →
   * `etn:refresh-count` для бейджа группы); шим-`CustomEvent` тестов обязан
   * нести `type`. Без типа — no-op (совместимость с урезанными заглушками).
   */
  dispatchEvent(event: any): boolean {
    const type = event?.type;
    if (typeof type === 'string' && type !== '') this.emit(type, event);
    return true;
  }

  fire(type: string, event?: any): void {
    this.emit(type, event);
  }

  click(): void {
    this.emit('click', {
      target: this,
      preventDefault: (): void => undefined,
      stopPropagation: (): void => undefined,
    });
  }

  dispatchContextMenu(x = 10, y = 20): void {
    this.emit('contextmenu', {
      clientX: x,
      clientY: y,
      preventDefault: (): void => undefined,
      stopPropagation: (): void => undefined,
    });
  }

  focus(): void {
    this.focused = true;
    this.emit('focus');
  }

  blur(): void {
    this.focused = false;
    this.emit('blur');
  }

  select(): void {
    this.emit('select');
  }

  setSelectionRange(): void {
    /* позиция каретки в шиме не наблюдаема */
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  hasAttribute(name: string): boolean {
    return name in this.attributes;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
    if (name === 'role') this.role = value;
    if (name === 'aria-label') this.ariaLabel = value;
    if (name === 'class') this.className = value;
    if (name.startsWith('data-')) {
      const short = name.slice(5);
      const camel = short.replace(/-([a-z])/g, (_match: string, char: string) => char.toUpperCase());
      this.dataset[name] = value;
      this.dataset[camel] = value;
      this.dataset[short] = value;
    }
  }

  removeAttribute(name: string): void {
    delete this.attributes[name];
    delete this.dataset[name];
  }

  closest(selector: string): ShimElement | null {
    let current: ShimElement | null = this.parent;
    while (current !== null) {
      if (selector.startsWith('.') && current.classList.contains(selector.slice(1))) return current;
      if (!selector.startsWith('.') && current.tagName === selector) return current;
      current = current.parent;
    }
    return null;
  }

  querySelectorAll(selector: string): ShimElement[] {
    const hits: ShimElement[] = [];
    const walk = (node: ShimElement): void => {
      for (const child of node.children) {
        if (child.matchesSelector(selector)) hits.push(child);
        walk(child);
      }
    };
    walk(this);
    return hits;
  }

  querySelector(selector: string): ShimElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  /** Все потомки, у которых класс содержит подстроку, либо по предикату. */
  findAll(match: ShimMatch): ShimElement[] {
    const hits: ShimElement[] = [];
    const walk = (node: ShimElement): void => {
      for (const child of node.children) {
        const hit = typeof match === 'string' ? child.className.includes(match) : match(child);
        if (hit) hits.push(child);
        walk(child);
      }
    };
    walk(this);
    return hits;
  }

  /** Селектор элемента: `.class`, `#id`, `tag`, `[data-attr]`/`[data-attr=value]`
   *  и их составные формы (`.a.b[data-x="v"]` — продукт ищет облачко так:
   *  `querySelector('.cloud[data-id="…"]')`). */
  private matchesSelector(selector: string): boolean {
    // Отделяем часть-атрибут (может сопровождать класс/тег): `.cloud[data-id="x"]`.
    let rest = selector;
    const bracket = rest.indexOf('[');
    if (bracket >= 0) {
      const close = rest.indexOf(']', bracket);
      const inner = rest.slice(bracket + 1, close < 0 ? undefined : close);
      if (!this.matchesAttribute(inner)) return false;
      rest = rest.slice(0, bracket) + (close < 0 ? '' : rest.slice(close + 1));
    }
    if (rest.startsWith('.')) {
      return rest
        .slice(1)
        .split('.')
        .every((token) => token !== '' && this.classList.contains(token));
    }
    if (rest.startsWith('#')) return this.id === rest.slice(1);
    if (rest === '') return true;
    return this.tagName === rest;
  }

  /** Предикат части-атрибута селектора (`data-x` или `data-x="v"`). */
  private matchesAttribute(inner: string): boolean {
    const eq = inner.indexOf('=');
    if (eq >= 0) {
      const name = inner.slice(0, eq);
      const value = inner.slice(eq + 1).replace(/"/g, '');
      return this.attributeVariants(name).some((key) => this.dataset[key] === value);
    }
    return this.attributeVariants(inner).some((key) => key in this.dataset);
  }

  private attributeVariants(name: string): string[] {
    if (!name.startsWith('data-')) return [name];
    const short = name.slice(5);
    const camel = short.replace(/-([a-z])/g, (_match: string, char: string) => char.toUpperCase());
    return [name, camel, short];
  }

  cloneNode(deep = true): ShimElement {
    const clone = new ShimElement(this.tagName, this.className, this.textContent);
    clone.value = this.value;
    clone.type = this.type;
    clone.checked = this.checked;
    clone.disabled = this.disabled;
    clone.hidden = this.hidden;
    clone.title = this.title;
    clone.placeholder = this.placeholder;
    clone.dataset = { ...this.dataset };
    clone.attributes = { ...this.attributes };
    if (deep) for (const child of this.children) clone.append(child.cloneNode(true));
    return clone;
  }

  getBoundingClientRect(): ShimRect {
    return this.rect;
  }

  scrollIntoView(): void {
    /* без движка раскладки не нужен */
  }

  /** Плоская склейка текста узла и потомков (assert-помощник тестов). */
  flatText(): string {
    let out = this.textContent;
    for (const child of this.children) out += child.flatText();
    return out;
  }
}

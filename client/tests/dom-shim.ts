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
 *
 * Текст — как в браузере (ошибка cca54310): собственного текста у элемента нет,
 * текст живёт ТЕКСТОВЫМ УЗЛОМ-ребёнком (`#text`, `isTextNode`). Поэтому
 * `textContent = …` снимает детей и кладёт один текстовый узел, геттер
 * агрегирует текст потомков, `replaceChildren`, `appendChild`/`removeChild` и
 * `childElementCount` пересчитываются из детей, а `flatText()` — ровно то, что
 * в браузере отдаёт `textContent` узла. Прежняя форма держала `textContent`
 * отдельным полем рядом с `children` и маскировала дефекты порядка
 * «`textContent = …; replaceChildren()`» (ложно-зелёный контракт текстовой
 * деградации `filter-footer`, задача 58f77990).
 *
 * Методы вставки/удаления — как у `Node`/`ParentNode`/`ChildNode` браузера
 * (круг 2 cca54310): `append`/`prepend`/`replaceChildren`/`replaceWith`
 * принимают и строки, и узлы (строка становится текстовым узлом);
 * `appendChild`/`insertBefore`/`replaceChild` возвращают узел,
 * `removeChild`/`replaceChild` на чужом узле и `insertBefore` с якорем из
 * другого родителя бросают `DOMException` с именем `NotFoundError`;
 * `cloneNode()` по умолчанию неглубокий, как в DOM.
 *
 * `children`/`childNodes` — ЖИВЫЕ коллекции: ссылка, взятая до мутации, видит
 * актуальный состав (`length`, индексы, итерация), как `HTMLCollection`/
 * `NodeList`. Мутирующих методов массива (`push`/`pop`/`splice`) у них нет —
 * состав меняется только методами узла. Для удобства тестов коллекции дают
 * читающие array-методы (`find`/`filter`/`map`/`forEach`/…); это осознанное
 * расширение шима, браузерных мутаторов оно не возвращает.
 *
 * Намеренные расхождения остаются у `innerHTML`: это строковое поле (HTML не
 * разбирается на узлы), поэтому разметка, положенная через `innerHTML`, в
 * `textContent`/`flatText()` не попадает — потребители об этом знают.
 * `parentNode` не заведён отдельным полем — `parent` того же назначения;
 * объекты-заглушки (не `ShimElement`) методы вставки принимают как узлы —
 * этого требует несколько существующих тестов.
 */

/** Тег текстового узла шима (`Node.TEXT_NODE`): собственные данные — `textData`. */
const TEXT_NODE_TAG = '#text';

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
 * Ошибка браузера «узел не является ребёнком этого родителя». Имя
 * (`NotFoundError`) — то, что проверяют тесты и продукт; текст — как у
 * Chromium, чтобы сообщение было узнаваемым.
 */
function notFoundError(operation: string): DOMException {
  return new DOMException(
    `Failed to execute '${operation}' on 'Node': The node to be removed is not a child of this node.`,
    'NotFoundError',
  );
}

/** Аргумент метода вставки: узел шима или строка (в DOM строка тоже допустима
 *  и превращается в текстовый узел). */
export type ShimInsertable = ShimElement | string;

/**
 * Живая коллекция детей (`HTMLCollection`/`NodeList`-подобный `item()` +
 * индексы/итерация). Объявлена наследником массива ради существующих тестов,
 * которые читают её array-методами и сравнивают `deepEqual`; мутаторы
 * (`push`/`pop`/…) на уровне типов видны, но в рантайме отсутствуют — как у
 * браузерных коллекций.
 */
export interface ShimCollection extends Array<ShimElement> {
  item(index: number): ShimElement | null;
}

/** Примитив там, где DOM ждёт `Node`: методы с таким аргументом бросают
 *  `TypeError`, как браузер. Объекты-заглушки (не `ShimElement`) при этом
 *  принимаются — этого требуют существующие тесты. */
function isPrimitive(value: unknown): boolean {
  return value === null || value === undefined || (typeof value !== 'object' && typeof value !== 'function');
}

/**
 * Живая коллекция детей: `length`, индексы и итерация вычисляются из текущего
 * состава при КАЖДОМ обращении, поэтому ссылка, взятая до мутации, видит новый
 * состав (как `HTMLCollection`/`NodeList`). Мутаторов массива нет.
 *
 * Читающие array-методы (`find`, `filter`, `map`, …) — осознанное расширение:
 * на них держатся сотни существующих тестов; они работают по снимку на момент
 * вызова, но сам снимок берётся из живого состава.
 */
function createLiveCollection(resolve: () => ShimElement[]): ShimCollection {
  const readMethods = new Set([
    'at',
    'concat',
    'every',
    'filter',
    'find',
    'findIndex',
    'flatMap',
    'forEach',
    'includes',
    'indexOf',
    'join',
    'lastIndexOf',
    'map',
    'reduce',
    'reduceRight',
    'slice',
    'some',
    'toLocaleString',
    'toString',
  ]);
  // Мутаторы массива браузерным коллекциям не принадлежат. Цель прокси —
  // массив (нужен для `Array.isArray` и `assert.deepEqual` существующих
  // тестов), поэтому его прототипные мутаторы приходится явно скрывать.
  const blockedMethods = new Set([
    'copyWithin',
    'fill',
    'pop',
    'push',
    'reverse',
    'shift',
    'sort',
    'splice',
    'unshift',
  ]);
  // Итераторы читают живой состав на КАЖДОМ шаге: итератор, сохранённый до
  // мутации, обязан видеть актуальные узлы (в браузере `NodeList.values()`
  // и `[Symbol.iterator]()` живые; снимок «замерзал» — замечание круга 3).
  function* liveValues(): Generator<ShimElement> {
    let index = 0;
    while (index < resolve().length) {
      yield resolve()[index]!;
      index += 1;
    }
  }
  function* liveKeys(): Generator<number> {
    let index = 0;
    while (index < resolve().length) {
      yield index;
      index += 1;
    }
  }
  function* liveEntries(): Generator<[number, ShimElement]> {
    let index = 0;
    while (index < resolve().length) {
      yield [index, resolve()[index]!];
      index += 1;
    }
  }
  const handler: ProxyHandler<Record<string | symbol, unknown>> = {
    get(target, property) {
      if (property === 'length') return resolve().length;
      if (property === 'item') {
        return (index: number): ShimElement | null => resolve()[index] ?? null;
      }
      if (property === Symbol.iterator || property === 'values') return liveValues;
      if (property === 'keys') return liveKeys;
      if (property === 'entries') return liveEntries;
      if (typeof property === 'string' && /^\d+$/.test(property)) {
        return resolve()[Number(property)];
      }
      if (typeof property === 'string' && blockedMethods.has(property)) return undefined;
      if (typeof property === 'string' && readMethods.has(property)) {
        return (...args: unknown[]): unknown => {
          // Снимок живого состава на момент вызова: мутации во время самого
          // вызова (например, `forEach` с удалением) ведут себя как у массива.
          const snapshot = resolve() as unknown as Record<string, (...params: unknown[]) => unknown>;
          return snapshot[property]!.apply(resolve(), args);
        };
      }
      return Reflect.get(target, property);
    },
    has(target, property) {
      if (property === 'length') return true;
      if (typeof property === 'string' && /^\d+$/.test(property)) {
        return Number(property) < resolve().length;
      }
      return Reflect.has(target, property);
    },
    ownKeys() {
      // `length` — неконфигурируемое собственное свойство цели-массива:
      // прокси обязан его перечислить.
      return [...resolve().map((_node, index) => String(index)), 'length'];
    },
    getOwnPropertyDescriptor(target, property) {
      if (property === 'length') {
        return { value: resolve().length, writable: true, enumerable: false, configurable: false };
      }
      if (typeof property === 'string' && /^\d+$/.test(property)) {
        const nodes = resolve();
        const index = Number(property);
        if (index < nodes.length) {
          return { value: nodes[index], enumerable: true, configurable: true, writable: false };
        }
        return undefined;
      }
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
    set(target, property, value) {
      // У HTMLCollection/NodeList нет записи: состав меняют методы узла.
      if (property === 'length' || (typeof property === 'string' && /^\d+$/.test(property))) {
        throw new TypeError('Collection is read-only: mutate children through node methods');
      }
      return Reflect.set(target, property, value);
    },
  };
  return new Proxy([] as unknown as Record<string | symbol, unknown>, handler) as unknown as ShimCollection;
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
  /** `Node.ELEMENT_NODE` (1) для элемента, `Node.TEXT_NODE` (3) для текстового
   *  узла — как в браузере: код под тестами различает узлы по `nodeType`. */
  nodeType = 1;
  className = '';
  parent: ShimElement | null = null;
  style: ShimStyle = createStyle();
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  innerHTML = '';
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
    this.nodeType = this.isTextNode ? 3 : 1;
    this.classList.attach(this);
    if (className !== undefined && className !== '') this.className = className;
    if (text !== undefined) this.textContent = text;
    // Ссылки на родителя/класс-лист/слушателей/стили делают дерево
    // циклическим: тесты умеют сериализовать элемент (`JSON.stringify`) как
    // текстовый стог, поэтому служебные поля-связи не перечисляемы. Список
    // узлов (`nodes`) и данные текстового узла (`textData`) намеренно ОСТАЮТСЯ
    // перечисляемыми — по ним `JSON.stringify` элемента и видит текст и классы
    // потомков (тестовый «стог текста», например сверка read-only строк
    // свойств).
    for (const key of [
      'parent',
      'classList',
      'listeners',
      'style',
      'childNodesView',
      'childrenView',
    ] as const) {
      Object.defineProperty(this, key, {
        value: this[key],
        enumerable: false,
        writable: true,
        configurable: true,
      });
    }
  }

  /** Упорядоченный список ВСЕХ дочерних узлов: элементы и текстовые узлы. */
  private nodes: ShimElement[] = [];

  /** Кэш живых коллекций: одна и та же ссылка на элемент (как в DOM). */
  private childNodesView: ShimCollection | null = null;
  private childrenView: ShimCollection | null = null;

  /** Данные текстового узла (`#text`); у элемента всегда пусто. */
  private textData = '';

  /** Текстовый узел (в браузере `nodeType === Node.TEXT_NODE`). */
  get isTextNode(): boolean {
    // Сравнение без регистра: `uppercaseTagNames` (thought-cloud) поднимает тег
    // в верхний регистр, а вид узла от этого не меняется.
    return this.tagName.toLowerCase() === TEXT_NODE_TAG;
  }

  /**
   * `textContent` с семантикой браузера (ошибка cca54310):
   *   • элемент — КОНКАТЕНАЦИЯ текста всех узлов-потомков (собственного текста
   *     у элемента нет, текст живёт текстовыми узлами);
   *   • текстовый узел — собственные данные;
   *   • запись снимает ВСЕХ детей и кладёт один текстовый узел (пустая строка —
   *     детей не остаётся), как `Node.textContent = …` в DOM. Поэтому дефект
   *     порядка «`textContent = …; replaceChildren()`» виден тесту: пустой
   *     `replaceChildren()` снимает только что вставленный текст.
   */
  get textContent(): string {
    if (this.isTextNode) return this.textData;
    let out = '';
    for (const child of this.nodes) out += child.textContent;
    return out;
  }

  set textContent(value: string) {
    const text = value === null || value === undefined ? '' : String(value);
    if (this.isTextNode) {
      this.textData = text;
      return;
    }
    for (const child of this.nodes) child.parent = null;
    // Массив детей меняется НА МЕСТЕ: ссылка на `childNodes`, взятая до этой
    // записи, обязана увидеть новый состав (живая коллекция).
    this.nodes.length = 0;
    if (text !== '') {
      const node = new ShimElement(TEXT_NODE_TAG, undefined, text);
      node.parent = this;
      this.nodes.push(node);
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
    return this.nodes[0] ?? null;
  }

  /** Первый дочерний УЗЕЛ-элемент (текстовые узлы пропускаются, как в DOM). */
  get firstElementChild(): ShimElement | null {
    return this.nodes.find((child) => !child.isTextNode) ?? null;
  }

  /** Дочерние ЭЛЕМЕНТЫ (как `Element.children` в DOM): текстовых узлов нет.
   *  Текст, положенный `textContent = …`/`append('…')`/`replaceChildren('…')`,
   *  живёт в {@link childNodes} — как в браузере. Коллекция ЖИВАЯ: ссылка,
   *  взятая до мутации, видит актуальный состав. */
  get children(): ShimCollection {
    return (this.childrenView ??= createLiveCollection(() =>
      this.nodes.filter((child) => !child.isTextNode),
    ));
  }

  /** Число дочерних ЭЛЕМЕНТОВ (как `Element.childElementCount` в DOM):
   *  текстовые узлы, которыми `textContent = …`/`append('…')` кладут текст,
   *  не считаются. */
  get childElementCount(): number {
    return this.nodes.filter((child) => !child.isTextNode).length;
  }

  /** Все дочерние УЗЛЫ (элементы и текстовые), как `Node.childNodes`.
   *  Коллекция ЖИВАЯ: ссылка, взятая до мутации, видит актуальный состав.
   *  Мутаторов массива (`push`/`pop`) нет — как у `NodeList`. */
  get childNodes(): ShimCollection {
    return (this.childNodesView ??= createLiveCollection(() => this.nodes));
  }

  /** Добавляет класс, не трогая остальные (совместимость со старыми копиями). */
  addClass(...names: string[]): void {
    this.classList.add(...names);
  }

  /** Строка в методе вставки превращается в текстовый узел (как DOMString в
   *  `append`/`prepend`/`replaceWith`/`replaceChildren`). */
  private toNode(node: ShimInsertable): ShimElement {
    return typeof node === 'string' ? new ShimElement(TEXT_NODE_TAG, undefined, node) : node;
  }

  /** Снимает узел с текущего родителя (если он там есть), не трогая прочее. */
  private detach(node: ShimElement): void {
    const parent = node.parent;
    if (parent == null) return;
    const index = parent.nodes.indexOf(node);
    if (index >= 0) parent.nodes.splice(index, 1);
    node.parent = null;
  }

  /** `ParentNode.append`: узлы и строки (строка — текстовый узел), порядок
   *  аргументов сохраняется, уже подключённый узел ПЕРЕМЕЩАЕТСЯ. */
  append(...nodes: ShimInsertable[]): void {
    for (const node of nodes) this.appendChild(this.toNode(node));
  }

  appendChild(node: ShimElement): ShimElement {
    // В DOM `appendChild('x')` — TypeError (параметр обязан быть Node).
    // Объекты-заглушки (не ShimElement) принимаем: этого требуют существующие
    // тесты, подставляющие вместо элемента простой литерал.
    if (isPrimitive(node)) {
      throw new TypeError("Failed to execute 'appendChild' on 'Node': parameter 1 is not of type 'Node'.");
    }
    this.detach(node);
    node.parent = this;
    this.nodes.push(node);
    return node;
  }

  /** `ParentNode.prepend`: как `append`, но в начало (в порядке аргументов). */
  prepend(...nodes: ShimInsertable[]): void {
    const first = this.nodes[0] ?? null;
    for (const node of nodes) this.insertBefore(this.toNode(node), first);
  }

  insertBefore(node: ShimElement, before: ShimElement | null): ShimElement {
    // Реальная семантика DOM: insertBefore ПЕРЕМЕЩАЕТ уже подключённый узел
    // (сначала снимает его с прежнего места), а не клонирует. Без этого
    // keyed-reconcile давал бы дубли узлов на шиме.
    if (isPrimitive(node)) {
      throw new TypeError("Failed to execute 'insertBefore' on 'Node': parameter 1 is not of type 'Node'.");
    }
    if (before !== null && isPrimitive(before)) {
      throw new TypeError("Failed to execute 'insertBefore' on 'Node': parameter 2 is not of type 'Node'.");
    }
    // Якорь обязан быть ребёнком этого родителя: в браузере иначе NotFoundError.
    if (before !== null && before.parent !== this) {
      throw notFoundError('insertBefore');
    }
    // Вставка узла перед самим собой — no-op, узел остаётся на месте.
    if (node === before) return node;
    this.detach(node);
    node.parent = this;
    if (before === null) {
      this.nodes.push(node);
      return node;
    }
    const index = this.nodes.indexOf(before);
    this.nodes.splice(index, 0, node);
    return node;
  }

  insertAdjacentElement(where: string, node: ShimElement): ShimElement | null {
    if (isPrimitive(node)) {
      throw new TypeError("Failed to execute 'insertAdjacentElement' on 'Element': parameter 2 is not of type 'Element'.");
    }
    // Позиция в DOM сравнивается без учёта регистра: `beforeBegin`, `beforebegin`
    // и `BEFOREBEGIN` равнозначны (круг 3 cca54310).
    switch (String(where).toLowerCase()) {
      case 'beforebegin':
        return this.parent === null ? null : this.parent.insertBefore(node, this);
      case 'afterbegin':
        return this.insertBefore(node, this.nodes[0] ?? null);
      case 'beforeend':
        return this.appendChild(node);
      case 'afterend': {
        const parent = this.parent;
        if (parent === null) return null;
        const index = parent.nodes.indexOf(this);
        const next = index >= 0 ? (parent.nodes[index + 1] ?? null) : null;
        return parent.insertBefore(node, next);
      }
      default:
        throw new DOMException(
          `Failed to execute 'insertAdjacentElement' on 'Element': The value provided ('${where}') is not one of 'beforeBegin', 'afterBegin', 'beforeEnd', or 'afterEnd'.`,
          'SyntaxError',
        );
    }
  }

  removeChild(node: ShimElement): ShimElement {
    if (isPrimitive(node)) {
      throw new TypeError("Failed to execute 'removeChild' on 'Node': parameter 1 is not of type 'Node'.");
    }
    // В браузере удаление чужого узла — NotFoundError, а не молчаливый no-op.
    if (node.parent !== this) throw notFoundError('removeChild');
    this.detach(node);
    return node;
  }

  replaceChild(node: ShimElement, old: ShimElement): ShimElement {
    if (isPrimitive(node)) {
      throw new TypeError("Failed to execute 'replaceChild' on 'Node': parameter 1 is not of type 'Node'.");
    }
    if (isPrimitive(old)) {
      throw new TypeError("Failed to execute 'replaceChild' on 'Node': parameter 2 is not of type 'Node'.");
    }
    if (old.parent !== this) throw notFoundError('replaceChild');
    // Замена узла им же самим — no-op, возвращается тот же узел.
    if (node === old) return old;
    this.detach(node);
    const index = this.nodes.indexOf(old);
    node.parent = this;
    this.nodes[index] = node;
    old.parent = null;
    return old;
  }

  /** `ChildNode.replaceWith`: строки становятся текстовыми узлами, аргументов
   *  может быть несколько; detached-узел — no-op. Возврата нет.
   *
   *  Порядок — как в спецификации DOM (круг 3 cca54310):
   *  1) якорь `viableNextSibling` — первый следующий брат, которого НЕТ среди
   *     аргументов (аргументы-братья при «преобразовании во фрагмент» уедут со
   *     своих мест, и якорь по ним поплывёт);
   *  2) аргументы по порядку снимаются со старых мест (как append в
   *     DocumentFragment; повторный аргумент переезжает в конец);
   *  3) если `this` ещё в родителе — штатная замена (якорь — следующий брат
   *     ПОСЛЕ снятия аргументов), иначе pre-insert перед `viableNextSibling`. */
  replaceWith(...nodes: ShimInsertable[]): void {
    const parent = this.parent;
    if (parent === null) return;
    const index = parent.nodes.indexOf(this);
    if (index === -1) return;

    // 1. Аргументы → узлы; строки становятся новыми текстовыми узлами.
    const args = nodes.map((node) => this.toNode(node));

    // 2. `viableNextSibling` — первый следующий брат не из аргументов.
    let viableNextSibling: ShimElement | null = null;
    for (let cursor = index + 1; cursor < parent.nodes.length; cursor += 1) {
      const sibling = parent.nodes[cursor]!;
      if (!args.includes(sibling)) {
        viableNextSibling = sibling;
        break;
      }
    }

    // 3. «Преобразование во фрагмент»: снятие каждого узла со старого места.
    const fragment: ShimElement[] = [];
    for (const node of args) {
      const duplicate = fragment.indexOf(node);
      if (duplicate >= 0) fragment.splice(duplicate, 1);
      this.detach(node);
      fragment.push(node);
    }

    // 4. Штатная замена (this ещё в parent) либо pre-insert перед
    //    viableNextSibling (this сам был аргументом и уже отвязан).
    const stillAttached = this.parent === parent;
    const anchor = stillAttached
      ? (parent.nodes[parent.nodes.indexOf(this) + 1] ?? null)
      : viableNextSibling;
    if (stillAttached) {
      parent.nodes.splice(parent.nodes.indexOf(this), 1);
      this.parent = null;
    }
    let at = anchor === null ? parent.nodes.length : parent.nodes.indexOf(anchor);
    for (const node of fragment) {
      node.parent = parent;
      parent.nodes.splice(at, 0, node);
      at += 1;
    }
  }

  replaceChildren(...nodes: ShimInsertable[]): void {
    for (const child of this.nodes) child.parent = null;
    // Массив детей меняется НА МЕСТЕ — живая `childNodes` видит новый состав.
    this.nodes.length = 0;
    // Текст в шиме — ТЕКСТОВЫЙ УЗЕЛ-ребёнок (как в DOM), поэтому очистка
    // списка узлов выше снимает и текст; отдельный сброс `textContent` не нужен.
    // `textContent` пересчитывается из детей, а не хранится полем (ошибка
    // cca54310): `replaceChildren(a, b)` обязан отдать текст «ab», а не пусто.
    for (const node of nodes) this.appendChild(this.toNode(node));
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
    this.detach(this);
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
      // Как `Element.querySelectorAll`: селектор матчит только элементы.
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
      for (const child of node.nodes) {
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

  cloneNode(deep = false): ShimElement {
    // Текст узла копируется ОДИН раз: у текстового узла — его данные, у
    // элемента — только дети (иначе текст потомков удвоился бы: и полем, и
    // глубокой копией детей).
    const clone = new ShimElement(
      this.tagName,
      this.className,
      this.isTextNode ? this.textData : undefined,
    );
    clone.value = this.value;
    clone.type = this.type;
    clone.checked = this.checked;
    clone.disabled = this.disabled;
    clone.hidden = this.hidden;
    clone.title = this.title;
    clone.placeholder = this.placeholder;
    clone.dataset = { ...this.dataset };
    clone.attributes = { ...this.attributes };
    if (deep) for (const child of this.nodes) clone.append(child.cloneNode(true));
    return clone;
  }

  getBoundingClientRect(): ShimRect {
    return this.rect;
  }

  scrollIntoView(): void {
    /* без движка раскладки не нужен */
  }

  /** Плоский текст узла — ровно то, что в браузере отдаёт `textContent` этого
   *  узла: текст потомков подряд, включая пробелы и переносы. Отдельного
   *  «своего» текста у элемента нет (ошибка cca54310). */
  flatText(): string {
    return this.textContent;
  }
}

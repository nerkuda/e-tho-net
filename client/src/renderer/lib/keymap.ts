/**
 * Общеклиентский диспетчер контекстов сочетаний клавиш (ADR
 * «Диспетчер контекстов сочетаний клавиш — общеклиентский библиотечный модуль
 * lib/keymap.ts», `b420b08c`; задача e7bf87e3, ТП1 «Команды редактирования
 * комментария»).
 *
 * Модуль владеет четырьмя вещами:
 *  1. **Реестр контекстов и привязок** «команда — сочетание — контекст»
 *     ({@link defineKeyContext}). Диспетчер не знает о содержимом команд — он
 *     лишь исполняет зарегистрированные обработчики.
 *  2. **Стек активных контекстов.** «Текущий элемент» = вершина стека. Экран
 *     или поле вызывает {@link pushKeyContext} при получении фокуса и снимает
 *     контекст возвращённой функцией; диалог кладёт свой контекст поверх, и его
 *     сочетания выигрывают у нижележащих (в т.ч. у поля внутри диалога —
 *     поле-вершина перекрывает контекст диалога-хозяина).
 *  3. **Разрешение пользовательских переопределений** сочетаний
 *     ({@link setKeymapOverrides}): значения приходят от слоя настроек, сам
 *     модуль их не хранит.
 *  4. **Единственную точку перехвата `keydown`** ({@link installKeymap}).
 *     Локальный перехват и сравнение сочетаний в экранах и модулях в обход
 *     диспетчера запрещены (ADR `b420b08c`).
 *
 * Сопоставление сочетаний независимо от раскладки: помимо `event.key`
 * учитывается `event.code` (`Ctrl+Shift+8` на любой раскладке совпадает с
 * `Digit8`, `Ctrl+C` — с `KeyC`; ср. ошибка 98302e81). Это требование аудита
 * `2ec4058b`.
 */

/** Обработчик команды. `false` — команда отказалась обработать событие,
 *  поиск продолжается по нижележащим контекстам; любое другое значение —
 *  событие обработано (диспетчер зовёт `preventDefault`). */
export type KeyCommandHandler = (event: KeyboardEvent) => boolean | void;

/** Привязка «команда — сочетание — контекст». */
export interface KeyBindingDef {
  /** Непрозрачный идентификатор команды, напр. `comment.bold`. */
  command: string;
  /** Сочетание по умолчанию, напр. `Ctrl+Shift+8`. */
  chord: string;
  /** Обработчик команды. */
  run: KeyCommandHandler;
  /** Дополнительное условие применимости; `false` — привязка пропускается. */
  when?: (event: KeyboardEvent) => boolean;
}

/** Объявление контекста сочетаний. */
export interface KeyContextDef {
  /** Идентификатор контекста, напр. `global`, `dialog`, `comment-field`. */
  id: string;
  /** Привязки контекста в порядке приоритета внутри контекста. */
  bindings: KeyBindingDef[];
}

/** Пользовательские переопределения: команда → сочетание или `null` (снято). */
export type KeymapOverrides = Readonly<Record<string, string | null>>;

/** Идентификатор базового (глобального) контекста — всегда дно стека. */
export const GLOBAL_CONTEXT_ID = 'global';

/* ------------------------------------------------------------------ *
 * Стандартные сочетания команд редактирования комментария (умолчания
 * из реестра аудита `2ec4058b`). Команды исполняет редактор поля — здесь
 * только таблица «команда — сочетание по умолчанию», единый источник
 * умолчаний для keymap поля, меню и диалога настройки сочетаний.
 * ------------------------------------------------------------------ */

/** Команда → сочетание по умолчанию (реестр аудита `2ec4058b`). */
export const COMMENT_KEYMAP_DEFAULTS: Readonly<Record<string, string>> = Object.freeze({
  'comment.bold': 'Ctrl+B',
  'comment.italic': 'Ctrl+I',
  'comment.underline': 'Ctrl+U',
  'comment.strike': 'Ctrl+S',
  'comment.inlineCode': 'Ctrl+E',
  'comment.highlight': 'Ctrl+Shift+H',
  'comment.h1': 'Ctrl+Alt+1',
  'comment.h2': 'Ctrl+Alt+2',
  'comment.h3': 'Ctrl+Alt+3',
  'comment.bulletList': 'Ctrl+Shift+8',
  'comment.orderedList': 'Ctrl+Shift+7',
  'comment.taskList': 'Ctrl+Shift+9',
  'comment.blockquote': 'Ctrl+Shift+Q',
  'comment.codeBlock': 'Ctrl+Shift+K',
  'comment.moveLineUp': 'Alt+ArrowUp',
  'comment.moveLineDown': 'Alt+ArrowDown',
  'comment.indentList': 'Tab',
  'comment.outdentList': 'Shift+Tab',
  'comment.find': 'Ctrl+F',
  'comment.replace': 'Ctrl+H',
  'comment.findNext': 'F3',
  'comment.findPrevious': 'Shift+F3',
  'comment.globalSearch': 'Ctrl+Shift+F',
});

/* ------------------------------------------------------------------ *
 * Нормализация сочетаний.
 * ------------------------------------------------------------------ */

const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;

const MODIFIER_ALIASES: Readonly<Record<string, string>> = {
  ctrl: 'Ctrl',
  control: 'Ctrl',
  cmd: 'Meta',
  command: 'Meta',
  meta: 'Meta',
  win: 'Meta',
  super: 'Meta',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
};

const KEY_ALIASES: Readonly<Record<string, string>> = {
  ' ': 'Space',
  space: 'Space',
  spacebar: 'Space',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  esc: 'Escape',
  del: 'Delete',
  return: 'Enter',
};

/** Канонизирует имя модификатора; неизвестное — как есть. */
function canonModifier(token: string): string {
  return MODIFIER_ALIASES[token.toLowerCase()] ?? token;
}

/** Канонизирует имя клавиши (регистр буквы, псевдонимы). */
function canonKey(token: string): string {
  if (token.length === 1) return token.toUpperCase();
  return KEY_ALIASES[token.toLowerCase()] ?? token;
}

interface ParsedChord {
  mods: Set<string>;
  key: string;
}

/** Разбирает строку сочетания в модификаторы и клавишу. */
function parseChord(chord: string): ParsedChord {
  const parts = chord.split('+');
  let key = parts.pop() ?? '';
  // Клавиша «+» даёт пустой последний токен (`Ctrl++`) — восстанавливаем её.
  if (key === '' && parts.length > 0) key = '+';
  const mods = new Set<string>();
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed !== '') mods.add(canonModifier(trimmed));
  }
  if (key === '') key = '';
  else key = canonKey(key);
  return { mods, key };
}

/** Канонический префикс модификаторов в фиксированном порядке. */
function modifierPrefix(mods: Set<string>): string {
  return MODIFIER_ORDER.filter((m) => mods.has(m)).join('+');
}

/** Склеивает префикс и клавишу в каноническую строку. */
function composeChord(mods: Set<string>, key: string): string {
  const prefix = modifierPrefix(mods);
  return prefix === '' ? key : `${prefix}+${key}`;
}

/**
 * Эквивалентные токены клавиши: буква — `C` и `KeyC`, цифра — `8` и
 * `Digit8`, символы — их `code`-имя. Нужно для независимости от раскладки.
 */
function keyVariants(key: string): string[] {
  if (key === '') return [];
  const variants = new Set<string>([key]);
  if (/^[A-Z]$/.test(key)) variants.add(`Key${key}`);
  if (/^[0-9]$/.test(key)) variants.add(`Digit${key}`);
  if (key === '=') variants.add('Equal');
  if (key === '-') variants.add('Minus');
  if (key === '+') variants.add('Equal');
  return [...variants];
}

/** Все канонические формы сочетания (с учётом вариантов клавиши). */
export function chordCandidates(chord: string): string[] {
  const { mods, key } = parseChord(chord);
  if (key === '') return [];
  return keyVariants(key).map((variant) => composeChord(mods, variant));
}

/** Токены клавиши из `event.code` (физическая клавиша). */
function codeVariants(code: string): string[] {
  if (code === '') return [];
  if (/^Key[A-Z]$/.test(code)) return [code, code.slice(3)];
  if (/^Digit[0-9]$/.test(code)) return [code, code.slice(5)];
  if (/^Numpad[0-9]$/.test(code)) return [code, code.slice(6)];
  if (code === 'NumpadAdd') return [code, 'Add'];
  if (code === 'NumpadSubtract') return [code, 'Subtract'];
  if (code === 'NumpadMultiply') return [code, 'Multiply'];
  if (code === 'NumpadDivide') return [code, 'Divide'];
  if (code === 'Equal') return [code, '='];
  if (code === 'Minus') return [code, '-'];
  if (code === 'Space') return [code, 'Space'];
  return [code];
}

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);

/** Все канонические формы, которые может дать событие клавиатуры. */
export function eventChordCandidates(event: KeyboardEvent): string[] {
  const mods = new Set<string>();
  if (event.ctrlKey) mods.add('Ctrl');
  if (event.altKey) mods.add('Alt');
  if (event.shiftKey) mods.add('Shift');
  if (event.metaKey) mods.add('Meta');

  const keys = new Set<string>();
  if (event.key !== undefined && !MODIFIER_KEYS.has(event.key)) {
    for (const token of keyVariants(canonKey(event.key))) keys.add(token);
  }
  if (event.code !== undefined && event.code !== '') {
    for (const token of codeVariants(event.code)) keys.add(token);
  }
  return [...keys].map((key) => composeChord(mods, key));
}

/* ------------------------------------------------------------------ *
 * Состояние диспетчера.
 * ------------------------------------------------------------------ */

interface StackEntry {
  id: string;
  token: symbol;
}

const contexts = new Map<string, KeyContextDef>();
const stack: StackEntry[] = [];
let overrides: KeymapOverrides = {};

function isKnownContext(id: string): boolean {
  return id === GLOBAL_CONTEXT_ID || contexts.has(id);
}

/** Объявляет (или заменяет) контекст сочетаний. Базовый контекст
 *  ({@link GLOBAL_CONTEXT_ID}) объявляется так же и всегда разрешается последним. */
export function defineKeyContext(def: KeyContextDef): void {
  contexts.set(def.id, { id: def.id, bindings: [...def.bindings] });
}

/** Убирает объявление контекста и все его активации. */
export function undefineKeyContext(id: string): void {
  contexts.delete(id);
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (stack[i]?.id === id) stack.splice(i, 1);
  }
}

/**
 * Кладёт контекст на вершину стека (текущий элемент). Возвращает функцию
 * снятия; повторный вызов функции идемпотентен.
 */
export function pushKeyContext(id: string): () => void {
  if (!isKnownContext(id)) {
    throw new Error(`Контекст "${id}" не объявлен через defineKeyContext`);
  }
  const token = Symbol(id);
  stack.push({ id, token });
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const index = stack.findIndex((entry) => entry.token === token);
    if (index >= 0) stack.splice(index, 1);
  };
}

/** Снимает верхнее вхождение контекста (идемпотентно). */
export function removeKeyContext(id: string): void {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (stack[i]?.id === id) {
      stack.splice(i, 1);
      return;
    }
  }
}

/** Идентификатор контекста на вершине стека, либо `null` (только глобальный). */
export function currentKeyContext(): string | null {
  return stack.length === 0 ? null : (stack[stack.length - 1]?.id ?? null);
}

/** Снимок стека от дна к вершине (без глобального контекста). */
export function keyContextStack(): readonly string[] {
  return stack.map((entry) => entry.id);
}

/**
 * Устанавливает пользовательские переопределения сочетаний. Значения —
 * сочетание или `null` (команда без сочетания). Полностью заменяет набор.
 */
export function setKeymapOverrides(next: KeymapOverrides): void {
  overrides = { ...next };
}

/** Текущие пользовательские переопределения (копия). */
export function getKeymapOverrides(): KeymapOverrides {
  return { ...overrides };
}

/** Эффективное сочетание команды: пользовательское либо по умолчанию. */
export function effectiveChord(command: string): string | null {
  if (Object.prototype.hasOwnProperty.call(overrides, command)) {
    return overrides[command] ?? null;
  }
  for (const context of contexts.values()) {
    for (const binding of context.bindings) {
      if (binding.command === command) return binding.chord;
    }
  }
  return null;
}

/** Эффективное сочетание конкретной привязки. */
function bindingChord(binding: KeyBindingDef): string | null {
  if (Object.prototype.hasOwnProperty.call(overrides, binding.command)) {
    return overrides[binding.command] ?? null;
  }
  return binding.chord;
}

/** Контексты в порядке приоритета: вершина стека → дно → глобальный. */
function resolutionOrder(): KeyContextDef[] {
  const order: KeyContextDef[] = [];
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const id = stack[i]?.id;
    if (id === undefined) continue;
    const context = contexts.get(id);
    if (context !== undefined) order.push(context);
  }
  const global = contexts.get(GLOBAL_CONTEXT_ID);
  if (global !== undefined) order.push(global);
  return order;
}

/**
 * Разрешает событие клавиатуры по стеку контекстов. Возвращает `true`, если
 * команда обработана (тогда диспетчер зовёт `preventDefault`). Чистая функция
 * без DOM — тестовый слой для {@link installKeymap}.
 */
export function dispatchKeyEvent(event: KeyboardEvent): boolean {
  const candidates = new Set(eventChordCandidates(event));
  if (candidates.size === 0) return false;
  for (const context of resolutionOrder()) {
    for (const binding of context.bindings) {
      const chord = bindingChord(binding);
      if (chord === null) continue;
      if (!chordCandidates(chord).some((candidate) => candidates.has(candidate))) continue;
      if (binding.when !== undefined && !binding.when(event)) continue;
      const handled = binding.run(event);
      if (handled === false) continue;
      event.preventDefault();
      return true;
    }
  }
  return false;
}

/**
 * Единственная точка перехвата `keydown` в клиенте. Ставит один слушатель на
 * `target` (по умолчанию `window`) и маршрутизирует события через
 * {@link dispatchKeyEvent}.
 *
 * Событие, уже помеченное `defaultPrevented` вышестоящим слушателем (например,
 * capture-обработчиком каркаса диалога), диспетчер не трогает — так сохраняется
 * прежний порядок «съеденного» нажатия. Возвращает функцию снятия слушателя.
 */
export function installKeymap(target: EventTarget = window): () => void {
  const listener = (event: Event): void => {
    const keyEvent = event as KeyboardEvent;
    if (keyEvent.defaultPrevented) return;
    dispatchKeyEvent(keyEvent);
  };
  target.addEventListener('keydown', listener);
  return () => target.removeEventListener('keydown', listener);
}

/** Целевой элемент — редактируемая поверхность (input, textarea, contenteditable, CM6). */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (target === null || typeof target !== 'object') return false;
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return true;
  if (target.isContentEditable) return true;
  // CodeMirror 6 puts its editable element inside `.cm-content`.
  if (target.closest('.cm-content') !== null) return true;
  return false;
}

/** Тестовый слой: сброс состояния между тестами. */
export const keymapInternals = {
  reset(): void {
    contexts.clear();
    stack.length = 0;
    overrides = {};
  },
  /** Разбор сочетания — для проверок нормализации. */
  parseChord,
  codeVariants,
};

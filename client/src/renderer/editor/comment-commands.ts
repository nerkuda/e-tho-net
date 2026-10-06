/**
 * Команды поля комментария: тулбар, контекстное меню и регистрация контекста
 * сочетаний (0.12.1, задача 3d6f98cb, ТП1 «Команды редактирования
 * комментария»; требование b5ecb360 — команды есть расширение общего поля
 * markdown, а не отдельный редактор).
 *
 * Модуль владеет:
 *  1. **Раскладкой команд** — элемент интерфейса «Тулбар команд поля
 *     комментария» (`1ab005ca`) и «Контекстное меню поля комментария»
 *     (`0562e0e3`): порядок кнопок, подменю, дублирование команд в меню,
 *     подменю настроек только в тулбаре.
 *  2. **Реестром исполнителей** «команда → обработчик» — точки расширения.
 *     Сами тела команд форматирования приходят задачей `ab0c4470`; команды
 *     «как текст» — ТП2, «разделение» — ТП3. До их регистрации кнопка/пункт
 *     присутствует по макету, но нажатие — no-op (не ошибка).
 *  3. **Подключением к диспетчеру контекстов** `lib/keymap.ts` (ADR
 *     `b420b08c`): контекст `comment-field` со всеми умолчаниями
 *     `COMMENT_KEYMAP_DEFAULTS`. Контекст активен, только пока поле в правке и
 *     в фокусе, поэтому команды доступны лишь в режиме редактирования
 *     (требование `6f8575a5`) и только у текущего элемента.
 *
 * Значки — только через фасад `lib/ui/icon.ts` (требование `c5fedf98`), кнопки —
 * через словарь `lib/ui/button.ts`, пункты меню — через общий словарь
 * `lib/menu.ts` (требование `f9ad4f53`). Строки — из словаря `t()`.
 */

import { div } from '../lib/dom.js';
import type { MessageKey } from '../lib/i18n.js';
import { t } from '../lib/i18n.js';
import {
  COMMENT_KEYMAP_DEFAULTS,
  defineKeyContext,
  effectiveChord,
  pushKeyContext,
  type KeyBindingDef,
} from '../lib/keymap.js';
import {
  MENU_SEPARATOR,
  menuAction,
  menuSubmenu,
  showMenuAt,
  type MenuItem,
} from '../lib/menu.js';
import { iconButton, setButtonActive } from '../lib/ui/button.js';
import { renderIcon, type IconName } from '../lib/ui/icon.js';
import type { MdEditor, MdEditorSnapshot } from './md-editor.js';

/** Идентификатор контекста сочетаний поля комментария. */
export const COMMENT_KEY_CONTEXT_ID = 'comment-field';

/** Класс корня тулбара (вид — в `styles/editor.css`). */
export const COMMENT_TOOLBAR_CLASS = 'md-field-toolbar';

/* ------------------------------------------------------------------ *
 * Хост команд: поле, к которому применяется команда.
 * ------------------------------------------------------------------ */

/**
 * Поле комментария, исполняющее команды. Тулбар/меню собирает владелец поля
 * (markdown-field), поэтому «текущее поле» известно точно; контекст сочетаний
 * берёт поле с вершины стека активных (текущий элемент = фокус).
 */
export interface CommentCommandHost {
  /** Редактор поля; `null` — поле не в правке. */
  getEditor(): MdEditor | null;
  /** Корень поля (для проверок принадлежности фокуса и т. п.). */
  root: HTMLElement;
  /**
   * Команды уровня поля, которые знает само поле (отмена, сохранение и
   * прочие команды режима правки). `true` — команда обработана.
   */
  runFieldCommand?(command: string): boolean;
  /**
   * Подписка на изменения текста/выделения редактора — для обновления
   * состояния кнопок тулбара. Возвращает функцию отписки. Поле может ещё не
   * иметь редактора — тогда подписка на будущий (возвращается no-op).
   */
  subscribe?(listener: () => void): () => void;
}

/** Контекст исполнения команды, передаваемый зарегистрированному обработчику. */
export interface CommentCommandContext {
  /** Редактор текущего поля. */
  editor: MdEditor;
  /** Корень поля. */
  root: HTMLElement;
  /** Запустить другую команду этого же поля (для составных команд). */
  run(command: string): boolean;
}

/** Состояние команды для кнопки тулбара (элемент `1ab005ca`). */
export interface CommentCommandState {
  /** Команда применена к текущему выделению/блоку — кнопка «нажата». */
  active?: boolean;
  /** Команда сейчас неприменима — кнопка заблокирована. */
  disabled?: boolean;
}

/** Запись реестра: обработчик команды и её состояние. */
export interface CommentCommandEntry {
  /** Тело команды. `false` — команда отказалась обрабатывать (как в keymap). */
  run(ctx: CommentCommandContext): boolean | void;
  /** Состояние кнопки для текущего снимка редактора (элемент `1ab005ca`). */
  state?(snapshot: MdEditorSnapshot): CommentCommandState;
}

const commandEntries = new Map<string, CommentCommandEntry>();
const activeHosts: CommentCommandHost[] = [];

/** Регистрирует (или заменяет) обработчик команды поля комментария. */
export function registerCommentCommand(id: string, entry: CommentCommandEntry): void {
  commandEntries.set(id, entry);
}

/** Снимает регистрацию обработчика команды. */
export function unregisterCommentCommand(id: string): void {
  commandEntries.delete(id);
}

/** Есть ли у команды зарегистрированный обработчик. */
export function hasCommentCommandRunner(id: string): boolean {
  return commandEntries.has(id);
}

/** Состояние команды для снимка редактора (по умолчанию — пустое). */
export function commentCommandState(id: string, snapshot: MdEditorSnapshot): CommentCommandState {
  return commandEntries.get(id)?.state?.(snapshot) ?? {};
}

/** Кладёт поле на вершину стека активных (текущий элемент). */
export function pushCommentCommandHost(host: CommentCommandHost): () => void {
  activeHosts.push(host);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const index = activeHosts.lastIndexOf(host);
    if (index >= 0) activeHosts.splice(index, 1);
  };
}

/** Поле на вершине стека активных, либо `null`. */
export function currentCommentCommandHost(): CommentCommandHost | null {
  return activeHosts[activeHosts.length - 1] ?? null;
}

function contextOf(host: CommentCommandHost, editor: MdEditor): CommentCommandContext {
  return {
    editor,
    root: host.root,
    run: (nested) => runCommentCommand(nested, host),
  };
}

/**
 * Исполняет команду у заданного поля (или у текущего активного). Сначала
 * спрашивает само поле (`runFieldCommand`), затем реестр. Возвращает `true`,
 * если команда обработана — этот же признак использует диспетчер сочетаний.
 */
export function runCommentCommand(command: string, host?: CommentCommandHost): boolean {
  const target = host ?? currentCommentCommandHost();
  if (target === null) return false;
  // Поле обрабатывает свои команды первым и без редактора: поиск в просмотре
  // (Ctrl+F) открывает панель, хотя правки нет (требование d72ea6eb).
  if (target.runFieldCommand?.(command) === true) return true;
  const editor = target.getEditor();
  if (editor === null) return false;
  const entry = commandEntries.get(command);
  if (entry === undefined) return false;
  const ctx = contextOf(target, editor);
  return entry.run(ctx) !== false;
}

/* ------------------------------------------------------------------ *
 * Раскладка команд.
 * ------------------------------------------------------------------ */

/** Описание команды: подпись, значок и сочетание по умолчанию. */
export interface CommentCommandDef {
  id: string;
  labelKey: MessageKey;
  icon: IconName;
}

/** Команда-лист раскладки. */
export interface CommentLayoutCommand {
  kind: 'command';
  id: string;
}

/** Подменю раскладки. */
export interface CommentLayoutSubmenu {
  kind: 'submenu';
  id: string;
  labelKey: MessageKey;
  icon: IconName;
  items: CommentLayoutNode[];
}

/** Разделитель (только в контекстном меню). */
export interface CommentLayoutSeparator {
  kind: 'separator';
}

/** Узел раскладки тулбара/меню. */
export type CommentLayoutNode =
  | CommentLayoutCommand
  | CommentLayoutSubmenu
  | CommentLayoutSeparator;

/** Описания команд поля комментария (ключ — идентификатор команды). */
export const COMMENT_COMMANDS: Readonly<Record<string, CommentCommandDef>> = Object.freeze({
  'comment.bold': { id: 'comment.bold', labelKey: 'comment.cmd.bold', icon: 'bold' },
  'comment.italic': { id: 'comment.italic', labelKey: 'comment.cmd.italic', icon: 'italic' },
  'comment.highlight': {
    id: 'comment.highlight',
    labelKey: 'comment.cmd.highlight',
    icon: 'highlight',
  },
  'comment.underline': {
    id: 'comment.underline',
    labelKey: 'comment.cmd.underline',
    icon: 'underline',
  },
  'comment.strike': {
    id: 'comment.strike',
    labelKey: 'comment.cmd.strike',
    icon: 'strikethrough',
  },
  'comment.inlineCode': {
    id: 'comment.inlineCode',
    labelKey: 'comment.cmd.inlineCode',
    icon: 'inline-code',
  },
  'comment.bulletList': {
    id: 'comment.bulletList',
    labelKey: 'comment.cmd.bulletList',
    icon: 'list-bullet',
  },
  'comment.orderedList': {
    id: 'comment.orderedList',
    labelKey: 'comment.cmd.orderedList',
    icon: 'list-ordered',
  },
  'comment.taskList': {
    id: 'comment.taskList',
    labelKey: 'comment.cmd.taskList',
    icon: 'list-task',
  },
  'comment.indentList': {
    id: 'comment.indentList',
    labelKey: 'comment.cmd.indentList',
    icon: 'indent',
  },
  'comment.outdentList': {
    id: 'comment.outdentList',
    labelKey: 'comment.cmd.outdentList',
    icon: 'outdent',
  },
  'comment.h1': { id: 'comment.h1', labelKey: 'comment.cmd.h1', icon: 'heading-1' },
  'comment.h2': { id: 'comment.h2', labelKey: 'comment.cmd.h2', icon: 'heading-2' },
  'comment.h3': { id: 'comment.h3', labelKey: 'comment.cmd.h3', icon: 'heading-3' },
  'comment.blockquote': {
    id: 'comment.blockquote',
    labelKey: 'comment.cmd.blockquote',
    icon: 'quote',
  },
  'comment.codeBlock': {
    id: 'comment.codeBlock',
    labelKey: 'comment.cmd.codeBlock',
    icon: 'code-block',
  },
  'comment.table': { id: 'comment.table', labelKey: 'comment.cmd.table', icon: 'table' },
  'comment.hr': { id: 'comment.hr', labelKey: 'comment.cmd.hr', icon: 'separator' },
  'comment.htmlComment': {
    id: 'comment.htmlComment',
    labelKey: 'comment.cmd.htmlComment',
    icon: 'html-comment',
  },
  'comment.copy': { id: 'comment.copy', labelKey: 'comment.cmd.copy', icon: 'copy' },
  'comment.copyAsText': {
    id: 'comment.copyAsText',
    labelKey: 'comment.cmd.copyAsText',
    icon: 'copy-text',
  },
  'comment.cut': { id: 'comment.cut', labelKey: 'comment.cmd.cut', icon: 'cut' },
  'comment.cutAsText': {
    id: 'comment.cutAsText',
    labelKey: 'comment.cmd.cutAsText',
    icon: 'cut',
  },
  'comment.paste': { id: 'comment.paste', labelKey: 'comment.cmd.paste', icon: 'paste' },
  'comment.pasteAsText': {
    id: 'comment.pasteAsText',
    labelKey: 'comment.cmd.pasteAsText',
    icon: 'paste',
  },
  'comment.find': { id: 'comment.find', labelKey: 'comment.cmd.find', icon: 'search' },
  'comment.replace': { id: 'comment.replace', labelKey: 'comment.cmd.replace', icon: 'replace' },
  'comment.findNext': { id: 'comment.findNext', labelKey: 'comment.cmd.findNext', icon: 'arrow-down' },
  'comment.findPrevious': {
    id: 'comment.findPrevious',
    labelKey: 'comment.cmd.findPrevious',
    icon: 'arrow-up',
  },
  'comment.globalSearch': {
    id: 'comment.globalSearch',
    labelKey: 'comment.cmd.globalSearch',
    icon: 'search',
  },
  'comment.moveLineUp': {
    id: 'comment.moveLineUp',
    labelKey: 'comment.cmd.moveLineUp',
    icon: 'arrow-up',
  },
  'comment.moveLineDown': {
    id: 'comment.moveLineDown',
    labelKey: 'comment.cmd.moveLineDown',
    icon: 'arrow-down',
  },
  'comment.split': { id: 'comment.split', labelKey: 'comment.cmd.split', icon: 'split' },
  'comment.cancel': { id: 'comment.cancel', labelKey: 'comment.cmd.cancel', icon: 'x' },
  'comment.save': { id: 'comment.save', labelKey: 'comment.cmd.save', icon: 'save' },
  'comment.hotkeysDialog': {
    id: 'comment.hotkeysDialog',
    labelKey: 'comment.cmd.hotkeys',
    icon: 'settings',
  },
});

/** Подменю «Прочие внутристрочные». */
const INLINE_MORE: CommentLayoutSubmenu = {
  kind: 'submenu',
  id: 'comment.submenu.inline',
  labelKey: 'comment.tb.inlineMore',
  icon: 'ellipsis',
  items: [
    { kind: 'command', id: 'comment.underline' },
    { kind: 'command', id: 'comment.strike' },
    { kind: 'command', id: 'comment.inlineCode' },
  ],
};

/** Подменю «Прочие блочные». */
const BLOCK_MORE: CommentLayoutSubmenu = {
  kind: 'submenu',
  id: 'comment.submenu.block',
  labelKey: 'comment.tb.blockMore',
  icon: 'ellipsis',
  items: [
    { kind: 'command', id: 'comment.h1' },
    { kind: 'command', id: 'comment.h2' },
    { kind: 'command', id: 'comment.h3' },
    { kind: 'command', id: 'comment.blockquote' },
    { kind: 'command', id: 'comment.codeBlock' },
    { kind: 'command', id: 'comment.table' },
    { kind: 'command', id: 'comment.hr' },
    { kind: 'command', id: 'comment.htmlComment' },
  ],
};

/** Подменю настроек поля — правый край тулбара (в контекстном меню нет). */
export const SETTINGS_SUBMENU_ID = 'comment.submenu.settings';
const SETTINGS_MORE: CommentLayoutSubmenu = {
  kind: 'submenu',
  id: SETTINGS_SUBMENU_ID,
  labelKey: 'comment.tb.settings',
  icon: 'settings',
  items: [{ kind: 'command', id: 'comment.hotkeysDialog' }],
};

/**
 * Раскладка тулбара слева направо (элемент `1ab005ca`): три кнопки выделения,
 * подменю внутристрочных, кнопки списков, подменю блочных, справа — настройки.
 */
export const COMMENT_TOOLBAR_LAYOUT: readonly CommentLayoutNode[] = Object.freeze([
  { kind: 'command', id: 'comment.bold' },
  { kind: 'command', id: 'comment.italic' },
  { kind: 'command', id: 'comment.highlight' },
  INLINE_MORE,
  { kind: 'command', id: 'comment.bulletList' },
  { kind: 'command', id: 'comment.orderedList' },
  { kind: 'command', id: 'comment.taskList' },
  { kind: 'command', id: 'comment.indentList' },
  { kind: 'command', id: 'comment.outdentList' },
  BLOCK_MORE,
  SETTINGS_MORE,
]);

/**
 * Раскладка контекстного меню (элемент `0562e0e3`): повторяет тулбар без
 * подменю настроек и добавляет команды уровня поля. Команды «как текст» (ТП2)
 * и «разделение» (ТП3) присутствуют как точки расширения — их исполнение
 * регистрируют соответствующие под-проекты.
 */
export const COMMENT_MENU_LAYOUT: readonly CommentLayoutNode[] = Object.freeze([
  { kind: 'command', id: 'comment.bold' },
  { kind: 'command', id: 'comment.italic' },
  { kind: 'command', id: 'comment.highlight' },
  INLINE_MORE,
  { kind: 'command', id: 'comment.bulletList' },
  { kind: 'command', id: 'comment.orderedList' },
  { kind: 'command', id: 'comment.taskList' },
  { kind: 'command', id: 'comment.indentList' },
  { kind: 'command', id: 'comment.outdentList' },
  BLOCK_MORE,
  { kind: 'separator' },
  { kind: 'command', id: 'comment.copy' },
  { kind: 'command', id: 'comment.copyAsText' },
  { kind: 'command', id: 'comment.cut' },
  { kind: 'command', id: 'comment.cutAsText' },
  { kind: 'command', id: 'comment.paste' },
  { kind: 'command', id: 'comment.pasteAsText' },
  { kind: 'separator' },
  { kind: 'command', id: 'comment.find' },
  { kind: 'command', id: 'comment.split' },
  { kind: 'separator' },
  { kind: 'command', id: 'comment.cancel' },
  { kind: 'command', id: 'comment.save' },
]);

/* ------------------------------------------------------------------ *
 * Сборка пунктов меню и тулбара.
 * ------------------------------------------------------------------ */

function layoutToMenuItems(
  nodes: readonly CommentLayoutNode[],
  host: CommentCommandHost,
): MenuItem[] {
  const items: MenuItem[] = [];
  for (const node of nodes) {
    if (node.kind === 'separator') {
      items.push(MENU_SEPARATOR);
      continue;
    }
    if (node.kind === 'submenu') {
      items.push(
        menuSubmenu(t(node.labelKey), layoutToMenuItems(node.items, host), {
          icon: renderIcon(node.icon),
        }),
      );
      continue;
    }
    const def = COMMENT_COMMANDS[node.id];
    if (def === undefined) continue;
    items.push(
      menuAction(
        t(def.labelKey),
        () => {
          runCommentCommand(node.id, host);
        },
        { icon: renderIcon(def.icon), disabled: isCommandDisabled(node.id, host) },
      ),
    );
  }
  return items;
}

/** Недоступна ли команда для текущего выделения (для пунктов меню/подменю). */
function isCommandDisabled(id: string, host: CommentCommandHost): boolean {
  const editor = host.getEditor();
  if (editor === null) return false;
  return commentCommandState(id, editor.snapshot()).disabled === true;
}

/** Пункты контекстного меню поля комментария (без подменю настроек). */
export function buildCommentMenuItems(host: CommentCommandHost): MenuItem[] {
  return layoutToMenuItems(COMMENT_MENU_LAYOUT, host);
}

/** Подпись кнопки: название команды и действующее сочетание (если есть). */
function commandTitle(id: string, def: CommentCommandDef): string {
  const label = t(def.labelKey);
  // Действующее сочетание: пользовательское переопределение или сочетание из
  // объявленного контекста, иначе — умолчание реестра (контекст объявляется
  // при входе в правку, а тулбар собирается раньше).
  const chord = effectiveChord(id) ?? COMMENT_KEYMAP_DEFAULTS[id] ?? null;
  return chord === null ? label : `${label} (${chord})`;
}

/**
 * Удерживает фокус и выделение редактора при клике по строке меню: кнопки
 * меню не забирают фокус на mousedown, поэтому поле не выходит из правки и
 * команда применяется к текущему выделению.
 */
export function guardCommentMenuFocus(menuRoot: HTMLElement): void {
  for (const row of menuRoot.querySelectorAll('.menu-item')) {
    row.addEventListener('mousedown', (event) => event.preventDefault());
  }
}

function openToolbarSubmenu(
  anchor: HTMLElement,
  node: CommentLayoutSubmenu,
  host: CommentCommandHost,
): void {
  const rect = anchor.getBoundingClientRect();
  const menuRoot = showMenuAt(rect.left, rect.bottom + 2, layoutToMenuItems(node.items, host));
  guardCommentMenuFocus(menuRoot);
}

function commandButton(id: string, host: CommentCommandHost): HTMLButtonElement {
  const def = COMMENT_COMMANDS[id];
  if (def === undefined) throw new Error(`Неизвестная команда комментария: ${id}`);
  const btn = iconButton({
    icon: renderIcon(def.icon),
    title: commandTitle(id, def),
    role: 'ghost',
    size: 's',
    onClick: () => {
      runCommentCommand(id, host);
    },
  });
  btn.dataset['command'] = id;
  btn.addEventListener('mousedown', (event) => event.preventDefault());
  return btn;
}

function submenuButton(node: CommentLayoutSubmenu, host: CommentCommandHost): HTMLButtonElement {
  const btn = iconButton({
    icon: renderIcon(node.icon),
    title: t(node.labelKey),
    role: 'ghost',
    size: 's',
    onClick: () => openToolbarSubmenu(btn, node, host),
  });
  btn.dataset['submenu'] = node.id;
  btn.addEventListener('mousedown', (event) => event.preventDefault());
  return btn;
}

/**
 * Обновляет состояние кнопок тулбара по текущему выделению/блоку (элемент
 * `1ab005ca`: «кнопка отражает применимость команды к текущему выделению»).
 */
export function refreshCommentToolbar(bar: HTMLElement, host: CommentCommandHost): void {
  const editor = host.getEditor();
  if (editor === null) return;
  const snapshot = editor.snapshot();
  for (const btn of bar.querySelectorAll<HTMLButtonElement>('[data-command]')) {
    const id = btn.dataset['command'];
    if (id === undefined) continue;
    const state = commentCommandState(id, snapshot);
    setButtonActive(btn, state.active === true);
    btn.disabled = state.disabled === true;
  }
}

/** Собирает тулбар команд поля комментария (виден только в правке). */
export function buildCommentToolbar(host: CommentCommandHost): HTMLElement {
  const bar = div(COMMENT_TOOLBAR_CLASS);
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', t('comment.toolbar.label'));
  for (const node of COMMENT_TOOLBAR_LAYOUT) {
    if (node.kind === 'submenu' && node.id === SETTINGS_SUBMENU_ID) {
      bar.append(div('md-field-toolbar__spacer'));
    }
    if (node.kind === 'submenu') {
      bar.append(submenuButton(node, host));
    } else if (node.kind === 'command') {
      bar.append(commandButton(node.id, host));
    }
  }
  refreshCommentToolbar(bar, host);
  host.subscribe?.(() => refreshCommentToolbar(bar, host));
  return bar;
}

/* ------------------------------------------------------------------ *
 * Контекст сочетаний поля комментария.
 * ------------------------------------------------------------------ */

/**
 * Объявляет контекст `comment-field` со всеми умолчаниями команд комментария
 * (`COMMENT_KEYMAP_DEFAULTS`, реестр аудита `2ec4058b`). Идемпотентно.
 */
export function defineCommentKeyContext(): void {
  const bindings: KeyBindingDef[] = [];
  for (const [command, chord] of Object.entries(COMMENT_KEYMAP_DEFAULTS)) {
    bindings.push({
      command,
      chord,
      run: () => runCommentCommand(command),
    });
  }
  defineKeyContext({ id: COMMENT_KEY_CONTEXT_ID, bindings });
}

/**
 * Включает контекст сочетаний поля: поле становится текущим элементом.
 * Возвращает функцию выключения (идемпотентную).
 */
export function enterCommentEdit(host: CommentCommandHost): () => void {
  defineCommentKeyContext();
  const popContext = pushKeyContext(COMMENT_KEY_CONTEXT_ID);
  const popHost = pushCommentCommandHost(host);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    popHost();
    popContext();
  };
}

/** Тестовый слой: сброс реестра и активных полей между тестами. */
export const commentCommandsInternals = {
  reset(): void {
    commandEntries.clear();
    activeHosts.length = 0;
  },
};

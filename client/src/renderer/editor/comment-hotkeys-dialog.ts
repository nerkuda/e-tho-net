/**
 * Диалог настройки пользовательских сочетаний клавиш комментария (0.12.1,
 * задача `d534eb35`, ТП1 «Команды редактирования комментария»; элемент
 * интерфейса «Настройка сочетаний клавиш поля комментария» `41301d7a`).
 *
 * Открывается из подменю настроек тулбара поля (команда `comment.hotkeysDialog`,
 * раскладка `COMMENT_TOOLBAR_LAYOUT`). Показывает список команд с их действующими
 * сочетаниями, позволяет переназначить (перехват следующего нажатия) и сбросить
 * к умолчаниям (построчно и целиком), контролирует конфликты.
 *
 * Сочетания — уровень «пользователь × сервер» (ADR `3a829d25`): читаются и
 * пишутся через `lib/user-settings.ts` (ключ `comment_hotkeys`), применяются к
 * диспетчеру `lib/keymap.ts` (`setKeymapOverrides`). Источник умолчаний и
 * порядка команд — единая таблица `COMMENT_KEYMAP_DEFAULTS`; имена команд —
 * `COMMENT_COMMANDS`; каркас диалога — `lib/dialog.ts`, кнопки — `lib/ui/button`,
 * строки — словарь `t()`. Коллекция строк обновляется инкрементально
 * (`reconcileKeyed`, ADR keyed-обновления).
 */

import { div, el, errText, span } from '../lib/dom.js';
import { showDialog } from '../lib/dialog.js';
import { t } from '../lib/i18n.js';
import {
  chordFromEvent,
  COMMENT_KEYMAP_DEFAULTS,
  getKeymapOverrides,
  normalizeChord,
  setKeymapOverrides,
  type KeymapOverrides,
} from '../lib/keymap.js';
import { notice } from '../lib/notice.js';
import { setButtonActive, iconButton, uiButton } from '../lib/ui/button.js';
import { renderIcon } from '../lib/ui/icon.js';
import { reconcileKeyed } from '../lib/ui/keyed-list.js';
import { footerErrorLine } from '../lib/ui/messages.js';
import { saveCommentHotkeys } from '../lib/user-settings.js';
import { COMMENT_COMMANDS, registerCommentCommand } from './comment-commands.js';

/** Команда тулбара, открывающая этот диалог. */
export const COMMENT_HOTKEYS_DIALOG_COMMAND = 'comment.hotkeysDialog';

/* ------------------------------------------------------------------ *
 * Чистые помощники (тестируются без DOM).
 * ------------------------------------------------------------------ */

/** Порядок команд диалога — ключи единой таблицы умолчаний keymap. */
export function commentHotkeyCommands(): readonly string[] {
  return Object.keys(COMMENT_KEYMAP_DEFAULTS);
}

/** Действующее сочетание команды в наборе переопределений (умолчание — фолбэк). */
export function chordIn(overrides: KeymapOverrides, command: string): string | null {
  if (Object.prototype.hasOwnProperty.call(overrides, command)) return overrides[command] ?? null;
  return COMMENT_KEYMAP_DEFAULTS[command] ?? null;
}

/** Переопределения только команд комментария (чужие ключи отбрасываются). */
export function commentOverrides(overrides: KeymapOverrides): Record<string, string> {
  const out: Record<string, string> = {};
  for (const command of commentHotkeyCommands()) {
    if (!Object.prototype.hasOwnProperty.call(overrides, command)) continue;
    const chord = overrides[command];
    if (typeof chord === 'string' && chord.trim() !== '') out[command] = chord;
  }
  return out;
}

/**
 * Команда, уже использующая это сочетание (кроме `exceptCommand`), либо `null`.
 * Так блокируется конфликт до записи: одно сочетание — одна команда.
 */
export function chordOwner(
  overrides: KeymapOverrides,
  chord: string,
  exceptCommand: string,
): string | null {
  const canonical = normalizeChord(chord);
  if (canonical === null) return null;
  for (const command of commentHotkeyCommands()) {
    if (command === exceptCommand) continue;
    const other = chordIn(overrides, command);
    if (other !== null && normalizeChord(other) === canonical) return command;
  }
  return null;
}

/** Карта «команда → команда-конфликт» по повторяющимся сочетаниям. */
export function commentChordConflicts(overrides: KeymapOverrides): Map<string, string> {
  const byChord = new Map<string, string>();
  const conflicts = new Map<string, string>();
  for (const command of commentHotkeyCommands()) {
    const chord = chordIn(overrides, command);
    if (chord === null) continue;
    const canonical = normalizeChord(chord);
    if (canonical === null) continue;
    const owner = byChord.get(canonical);
    if (owner === undefined) {
      byChord.set(canonical, command);
      continue;
    }
    conflicts.set(command, owner);
    conflicts.set(owner, command);
  }
  return conflicts;
}

/** Равны ли два набора переопределений (порядок ключей не важен). */
function sameOverrides(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  return keysA.every((key) => a[key] === b[key]);
}

/** Имя команды: из реестра `COMMENT_COMMANDS`, иначе — сам идентификатор. */
function labelOf(command: string): string {
  const def = COMMENT_COMMANDS[command];
  return def === undefined ? command : t(def.labelKey);
}

/* ------------------------------------------------------------------ *
 * Диалог.
 * ------------------------------------------------------------------ */

/**
 * Открывает диалог настройки сочетаний. Изменения применяются к диспетчеру и
 * сохраняются на сервере по кнопке «Сохранить» (и по Ctrl+Enter); Esc/крестик
 * при несохранённых изменениях перехватываются подтверждением (`dirty`).
 */
export function showCommentHotkeysDialog(): void {
  const initial = getKeymapOverrides();
  // Сочетания, не относящиеся к полю комментария, не теряем при сохранении:
  // `setKeymapOverrides` заменяет набор целиком.
  const foreignOverrides: Record<string, string | null> = {};
  for (const [command, chord] of Object.entries(initial)) {
    if (!Object.prototype.hasOwnProperty.call(COMMENT_KEYMAP_DEFAULTS, command)) {
      foreignOverrides[command] = chord;
    }
  }
  let overrides: Record<string, string> = commentOverrides(initial);
  const original: Record<string, string> = { ...overrides };

  let capturing: string | null = null;
  let busy = false;
  let closed = false;
  let conflicts = new Map<string, string>();

  const errorLine = footerErrorLine();
  const listHost = div('comment-hotkeys-list');
  const body = div('comment-hotkeys-body');
  body.append(el('p', 'muted comment-hotkeys-hint', t('comment.hotkeys.hint')), listHost);

  function renderRows(): void {
    conflicts = commentChordConflicts(overrides);
    reconcileKeyed(listHost, commentHotkeyCommands(), {
      key: (command) => command,
      build: (command) => buildRow(command),
      update: (node, command) => updateRow(node as HTMLElement, command),
      // Элементы — те же строки-команды, но их ОТОБРАЖЕНИЕ зависит от
      // изменяемого состояния (переопределения, режим записи, конфликты).
      // Структурное равенство строк пропустило бы обновление, поэтому всегда
      // зовём `update` — строк немного, перерисовка дёшева.
      equals: () => false,
    });
  }

  function buildRow(command: string): HTMLElement {
    const row = div('comment-hotkeys-row');
    row.dataset['command'] = command;
    row.append(span(labelOf(command), 'comment-hotkeys-row__label'));

    const chordBtn = uiButton({
      role: 'secondary',
      size: 's',
      class: 'comment-hotkeys-row__chord',
      onClick: () => startCapture(command),
    });
    chordBtn.dataset['chord'] = command;

    const resetBtn = iconButton({
      icon: renderIcon('rotate-ccw'),
      title: t('comment.hotkeys.reset'),
      role: 'ghost',
      size: 's',
      onClick: () => resetCommand(command),
    });
    resetBtn.dataset['reset'] = command;

    const controls = div('comment-hotkeys-row__controls');
    controls.append(chordBtn, resetBtn);
    row.append(controls);
    // reconcileKeyed зовёт `update` только на ИЗМЕНЕНИЯХ, поэтому начальное
    // содержимое (сочетание, доступность сброса) задаём сразу при сборке.
    updateRow(row, command);
    return row;
  }

  function updateRow(row: HTMLElement, command: string): void {
    const chordBtn = row.querySelector<HTMLButtonElement>('[data-chord]');
    const resetBtn = row.querySelector<HTMLButtonElement>('[data-reset]');
    const isCustom = Object.prototype.hasOwnProperty.call(overrides, command);
    const chord = chordIn(overrides, command);
    if (chordBtn !== null) {
      chordBtn.textContent =
        capturing === command
          ? t('comment.hotkeys.capture')
          : (chord ?? t('comment.hotkeys.none'));
      chordBtn.disabled = busy;
      setButtonActive(chordBtn, capturing === command);
    }
    if (resetBtn !== null) resetBtn.disabled = busy || !isCustom;
    row.classList.toggle('comment-hotkeys-row--conflict', conflicts.has(command));
    const isRecording = capturing === command;
    row.classList.toggle('comment-hotkeys-row--recording', isRecording);
  }

  function startCapture(command: string): void {
    if (busy) return;
    capturing = command;
    errorLine.clear();
    renderRows();
  }

  function resetCommand(command: string): void {
    if (busy) return;
    delete overrides[command];
    capturing = null;
    errorLine.clear();
    renderRows();
  }

  function resetAll(): void {
    if (busy) return;
    overrides = {};
    capturing = null;
    errorLine.clear();
    renderRows();
  }

  function assignChord(command: string, rawChord: string): void {
    const chord = normalizeChord(rawChord);
    if (chord === null) return;
    const owner = chordOwner(overrides, chord, command);
    capturing = null;
    if (owner !== null) {
      errorLine.show(t('comment.hotkeys.conflict', [chord, labelOf(owner)]));
      renderRows();
      return;
    }
    if (chord === COMMENT_KEYMAP_DEFAULTS[command]) delete overrides[command];
    else overrides[command] = chord;
    errorLine.clear();
    renderRows();
  }

  /**
   * Перехват следующего нажатия в режиме записи. Capture-фаза на `window`:
   * диалог ловит клавишу раньше обработчиков фокуса/вкладок каркаса, включая
   * `Tab` (команда `comment.indentList`). `Escape` обрабатывает каркас диалога
   * (его capture-слушатель зарегистрирован раньше) — нажатие закрывает диалог и
   * тем отменяет запись.
   */
  function onCaptureKey(event: KeyboardEvent): void {
    if (capturing === null || closed) return;
    // Нажатие уже поглощено каркасом диалога (его capture-слушатель
    // зарегистрирован раньше): `Escape` гасит закрытие/подтверждение —
    // как сочетание его захватывать нельзя.
    if (event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    const chord = chordFromEvent(event);
    if (chord === null) return; // нажат только модификатор — ждём основную клавишу
    assignChord(capturing, chord);
  }

  async function save(close: () => void): Promise<void> {
    if (busy) return;
    const conflict = [...commentChordConflicts(overrides).entries()][0];
    if (conflict !== undefined) {
      const [command, owner] = conflict;
      errorLine.show(
        t('comment.hotkeys.conflict', [chordIn(overrides, command) ?? '', labelOf(owner)]),
      );
      return;
    }
    busy = true;
    errorLine.clear();
    renderRows();
    try {
      await saveCommentHotkeys(overrides);
      setKeymapOverrides({ ...foreignOverrides, ...overrides });
      notice(t('comment.hotkeys.saved'), 'success');
      close();
    } catch (err) {
      errorLine.show(errText(err));
    } finally {
      busy = false;
      renderRows();
    }
  }

  showDialog({
    title: t('comment.hotkeys.title'),
    size: 'm',
    fixedHeight: true,
    body,
    footerError: errorLine,
    buttons: [
      { label: t('comment.hotkeys.resetAll'), keepOpen: true, onClick: () => resetAll() },
      { label: t('actions.cancel') },
      { label: t('actions.save'), primary: true, keepOpen: true, onClick: (close) => void save(close) },
    ],
    dirty: {
      isDirty: () => !sameOverrides(overrides, original),
      save: (close) => void save(close),
    },
    onClose: () => {
      closed = true;
      window.removeEventListener('keydown', onCaptureKey, true);
    },
  });
  window.addEventListener('keydown', onCaptureKey, true);
  renderRows();
}

/**
 * Регистрирует команду открытия диалога в реестре команд поля комментария
 * (идемпотентно). Вызывается вместе с телами команд (`comment-format.ts`).
 */
export function registerCommentHotkeysDialog(): void {
  registerCommentCommand(COMMENT_HOTKEYS_DIALOG_COMMAND, {
    run: () => {
      showCommentHotkeysDialog();
      return true;
    },
  });
}

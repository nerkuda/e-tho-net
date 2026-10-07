/**
 * Тела команд поля комментария (0.12.1, задача ab0c4470, ТП1 «Команды
 * редактирования комментария»).
 *
 * Модуль связывает чистые преобразования {@link file://./comment-format-ops.ts}
 * с реестром исполнителей `comment-commands.ts` (`registerCommentCommand`) и
 * решает две инфраструктурные задачи ТП1:
 *  1. **Копировать/вырезать/вставить** — через операции над текстом CM6, а не
 *     DOM-выделение просмотра (ошибка `80f978e5`).
 *  2. **Точечное перекрытие сочетаний, которые «съедает» CM6** (`Ctrl+I`,
 *     `Ctrl+U`, `Ctrl+Shift+K`, `Tab`/`Shift+Tab`, `Alt+↑/↓`) — расширение
 *     {@link commentFieldKeymapExtension} с `Prec.high`, подключаемое к полю
 *     через `MdEditorCallbacks.extraExtensions`. `defaultKeymap` CM6 НЕ
 *     заменяется: иначе теряются `moveLineUp/Down`, `Mod-i`, `Shift-Mod-k`,
 *     `Escape` и прочие штатные привязки (хроника задач `2ec4058b`/`e7bf87e3`).
 *
 * С ТП2 здесь же живут тела команд «как текст» (задача `e9f553e5`): простые
 * копировать/вырезать/вставить и их варианты с разворотом трансклюзий через
 * {@link TransclusionTextPort} (разбор — в `@etn/markdown`, резолвер — в
 * `transclusion.ts`).
 */

import { completionStatus } from '@codemirror/autocomplete';
import { type Extension, Prec } from '@codemirror/state';
import { type EditorView, keymap } from '@codemirror/view';

import { COMMENT_KEYMAP_DEFAULTS, effectiveChord } from '../lib/keymap.js';
import { registerCommentCommand, runCommentCommand } from './comment-commands.js';
import { registerCommentHotkeysDialog } from './comment-hotkeys-dialog.js';
// Тела команд создания мыслей из выделения (ТП3, задача 5f854e7a) регистрируются
// при загрузке своего модуля; здесь — только подключение к набору команд поля
// (боковой импорт, а не вызов: цикл через `canvas` с комментарием не даёт
// безопасно вызывать чужой модуль из тела `installCommentFormatCommands`).
import './comment-thought-create.js';
import { expandTransclusionsForClipboard } from './transclusion.js';
import {
  blockMarker,
  canMoveLine,
  canOutdent,
  indentLines,
  insertCodeBlock,
  insertHtmlComment,
  insertSeparator,
  insertTable,
  isBlockMarkerActive,
  isHeadingActive,
  isInlineActive,
  moveLine,
  relocatedSelection,
  toggleBlockquote,
  toggleBulletList,
  toggleHeading,
  toggleInline,
  toggleOrderedList,
  toggleTaskList,
} from './comment-format-ops.js';

/* ------------------------------------------------------------------ *
 * Порт системного буфера обмена.
 * ------------------------------------------------------------------ */

/** Минимальный порт буфера обмена — подменяется в тестах. */
export interface CommentClipboardPort {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}

/** Системный буфер обмена через `navigator.clipboard` (Electron-рендерер). */
function systemClipboard(): CommentClipboardPort {
  const nav = globalThis.navigator as Navigator | undefined;
  const api = nav?.clipboard;
  if (api === undefined) {
    return { readText: () => Promise.resolve(''), writeText: () => Promise.resolve() };
  }
  return {
    readText: () => api.readText(),
    writeText: (text) => api.writeText(text),
  };
}

let clipboardPort: CommentClipboardPort | null = null;

/** Подменяет порт буфера обмена (тестовый шов); `null` — системный. */
export function setCommentClipboardPort(port: CommentClipboardPort | null): void {
  clipboardPort = port;
}

/** Действующий порт буфера обмена. */
export function commentClipboard(): CommentClipboardPort {
  return clipboardPort ?? systemClipboard();
}

/* ------------------------------------------------------------------ *
 * Порт развёртки трансклюзий для команд «как текст» (ТП2, задача e9f553e5).
 * ------------------------------------------------------------------ */

/**
 * Разворачивает трансклюзии markdown-текста в чистый текст без ссылок и
 * служебных маркеров. Тела команд «копировать/вырезать/вставить как текст»
 * ходят через этот порт, а не через `@etn/markdown` напрямую, — так их
 * поведение проверяется юнит-тестом без сети. Разбор и развёртку выполняет
 * только `transclusion.ts` поверх единого рендерера (сторож
 * `guard-markdown-single-renderer`).
 */
export interface TransclusionTextPort {
  expand(text: string): Promise<string>;
}

let transclusionTextPort: TransclusionTextPort | null = null;

/** Подменяет порт развёртки (тестовый шов); `null` — системная развёртка. */
export function setTransclusionTextPort(port: TransclusionTextPort | null): void {
  transclusionTextPort = port;
}

/** Действующий порт развёртки. */
export function transclusionText(): TransclusionTextPort {
  return transclusionTextPort ?? { expand: expandTransclusionsForClipboard };
}

/* ------------------------------------------------------------------ *
 * Регистрация тел команд.
 * ------------------------------------------------------------------ */

/** Внутристрочные команды: id → пара маркеров (без `close` — один маркер). */
const INLINE_COMMANDS: ReadonlyArray<readonly [string, string, string?]> = [
  ['comment.bold', '**'],
  ['comment.italic', '*'],
  ['comment.highlight', '=='],
  ['comment.strike', '~~'],
  ['comment.underline', '<u>', '</u>'],
  ['comment.inlineCode', '`'],
];

/**
 * Регистрирует тела внутристрочных и блочных команд (идемпотентно — повторный
 * вызов заменяет записи реестра). Вызывается при импорте модуля; тестовый шов
 * позволяет переустановить набор после сброса реестра.
 */
export function installCommentFormatCommands(): void {
  for (const [id, open, close] of INLINE_COMMANDS) {
    const closing = close ?? open;
    registerCommentCommand(id, {
      run: (ctx) => ctx.editor.applyEdit(toggleInline(ctx.editor.snapshot(), open, closing)),
      state: (snap) => ({ active: isInlineActive(snap, open, closing) }),
    });
  }

  registerCommentCommand('comment.h1', {
    run: (ctx) => ctx.editor.applyEdit(toggleHeading(ctx.editor.snapshot(), 1)),
    state: (snap) => ({ active: isHeadingActive(snap, 1) }),
  });
  registerCommentCommand('comment.h2', {
    run: (ctx) => ctx.editor.applyEdit(toggleHeading(ctx.editor.snapshot(), 2)),
    state: (snap) => ({ active: isHeadingActive(snap, 2) }),
  });
  registerCommentCommand('comment.h3', {
    run: (ctx) => ctx.editor.applyEdit(toggleHeading(ctx.editor.snapshot(), 3)),
    state: (snap) => ({ active: isHeadingActive(snap, 3) }),
  });

  registerCommentCommand('comment.bulletList', {
    run: (ctx) => ctx.editor.applyEdit(toggleBulletList(ctx.editor.snapshot())),
    state: (snap) => ({ active: isBlockMarkerActive(snap, blockMarker.bullet) }),
  });
  registerCommentCommand('comment.orderedList', {
    run: (ctx) => ctx.editor.applyEdit(toggleOrderedList(ctx.editor.snapshot())),
    state: (snap) => ({ active: isBlockMarkerActive(snap, blockMarker.ordered) }),
  });
  registerCommentCommand('comment.taskList', {
    run: (ctx) => ctx.editor.applyEdit(toggleTaskList(ctx.editor.snapshot())),
    state: (snap) => ({ active: isBlockMarkerActive(snap, blockMarker.task) }),
  });
  registerCommentCommand('comment.blockquote', {
    run: (ctx) => ctx.editor.applyEdit(toggleBlockquote(ctx.editor.snapshot())),
    state: (snap) => ({ active: isBlockMarkerActive(snap, blockMarker.quote) }),
  });

  registerCommentCommand('comment.codeBlock', {
    run: (ctx) => ctx.editor.applyEdit(insertCodeBlock(ctx.editor.snapshot())),
  });
  registerCommentCommand('comment.table', {
    run: (ctx) => ctx.editor.applyEdit(insertTable(ctx.editor.snapshot())),
  });
  registerCommentCommand('comment.hr', {
    run: (ctx) => ctx.editor.applyEdit(insertSeparator(ctx.editor.snapshot())),
  });
  registerCommentCommand('comment.htmlComment', {
    run: (ctx) => ctx.editor.applyEdit(insertHtmlComment(ctx.editor.snapshot())),
  });

  registerCommentCommand('comment.indentList', {
    run: (ctx) => ctx.editor.applyEdit(indentLines(ctx.editor.snapshot(), 'in')),
  });
  registerCommentCommand('comment.outdentList', {
    run: (ctx) => ctx.editor.applyEdit(indentLines(ctx.editor.snapshot(), 'out')),
    state: (snap) => ({ disabled: !canOutdent(snap) }),
  });

  registerCommentCommand('comment.moveLineUp', {
    run: (ctx) => {
      const edit = moveLine(ctx.editor.snapshot(), 'up');
      if (edit === null) return false;
      ctx.editor.applyEdit(edit);
      return true;
    },
    state: (snap) => ({ disabled: !canMoveLine(snap, 'up') }),
  });
  registerCommentCommand('comment.moveLineDown', {
    run: (ctx) => {
      const edit = moveLine(ctx.editor.snapshot(), 'down');
      if (edit === null) return false;
      ctx.editor.applyEdit(edit);
      return true;
    },
    state: (snap) => ({ disabled: !canMoveLine(snap, 'down') }),
  });

  // Сворачивание/разворачивание раздела под кареткой (задача 558cac34): тела —
  // в CM6-расширении сворачивания (`MdEditor.toggleCollapseAtCaret`). `false`
  // означает «под кареткой нет сворачиваемого раздела» — команда уступает.
  registerCommentCommand('comment.fold', {
    run: (ctx) => ctx.editor.toggleCollapseAtCaret('fold'),
  });
  registerCommentCommand('comment.unfold', {
    run: (ctx) => ctx.editor.toggleCollapseAtCaret('unfold'),
  });

  registerClipboardCommands();
  registerClipboardAsTextCommands();
  // Команда подменю настроек «Сочетания клавиш» открывает диалог настройки
  // (задача d534eb35); тело команды живёт в модуле диалога.
  registerCommentHotkeysDialog();
}

/** Простые копировать/вырезать/вставить (ошибка `80f978e5`). */
function registerClipboardCommands(): void {
  registerCommentCommand('comment.copy', {
    run: (ctx) => {
      const snap = ctx.editor.snapshot();
      if (snap.from !== snap.to) {
        void commentClipboard().writeText(snap.text.slice(snap.from, snap.to)).catch(() => undefined);
      }
      return true;
    },
    state: (snap) => ({ disabled: snap.from === snap.to }),
  });

  registerCommentCommand('comment.cut', {
    run: (ctx) => {
      const editor = ctx.editor;
      const before = editor.snapshot();
      if (before.from === before.to) return true;
      const selected = before.text.slice(before.from, before.to);
      // Удаляем выделение только при успешной записи в буфер: иначе вырезание
      // потеряло бы текст (буфер недоступен — оставляем как есть). Позиции
      // сняты ДО асинхронной записи, поэтому правку перепрокладываем по
      // актуальному выделению, а при расхождении контекста отменяем (486d0ef1).
      void commentClipboard().writeText(selected).then(
        () => {
          const range = relocatedSelection(before, editor.snapshot());
          if (range === null) return;
          editor.applyEdit({
            changes: [{ from: range.from, to: range.to, insert: '' }],
            selection: { anchor: range.from, head: range.from },
          });
        },
        () => undefined,
      );
      return true;
    },
    state: (snap) => ({ disabled: snap.from === snap.to }),
  });

  registerCommentCommand('comment.paste', {
    run: (ctx) => {
      const editor = ctx.editor;
      const before = editor.snapshot();
      void commentClipboard()
        .readText()
        .then(
          (text) => {
            if (text === '') return;
            // Позиции сняты ДО чтения буфера — перепрокладываем по актуальному
            // выделению (486d0ef1): при расхождении контекста вставку отменяем.
            const range = relocatedSelection(before, editor.snapshot());
            if (range === null) return;
            const caret = range.from + text.length;
            editor.applyEdit({
              changes: [{ from: range.from, to: range.to, insert: text }],
              selection: { anchor: caret, head: caret },
            });
          },
          () => undefined,
        );
      return true;
    },
  });
}

/**
 * Команды «как текст» (ТП2, задача `e9f553e5`): копировать/вырезать/вставить с
 * разворотом трансклюзий. В отличие от простых копировать/вырезать/вставить,
 * текст проходит через {@link TransclusionTextPort}: ссылки-трансклюзии
 * заменяются содержимым источника, а нераскрытые/отсутствующие источники
 * «проглатываются» — в буфере и тексте ссылок не остаётся. Простая вставка
 * (`comment.paste`) исходник ссылки не трогает, поэтому вставленный исходник
 * трансклюзии распознаётся редактором как трансклюзия.
 */
function registerClipboardAsTextCommands(): void {
  /** Разворот с безопасным откатом: сбой развёртки не должен терять текст. */
  const expanded = (text: string): Promise<string> =>
    transclusionText()
      .expand(text)
      .catch(() => text);

  registerCommentCommand('comment.copyAsText', {
    run: (ctx) => {
      const snap = ctx.editor.snapshot();
      if (snap.from === snap.to) return true;
      const selected = snap.text.slice(snap.from, snap.to);
      void expanded(selected).then((text) =>
        commentClipboard().writeText(text).catch(() => undefined),
      );
      return true;
    },
    state: (snap) => ({ disabled: snap.from === snap.to }),
  });

  registerCommentCommand('comment.cutAsText', {
    run: (ctx) => {
      const editor = ctx.editor;
      const before = editor.snapshot();
      if (before.from === before.to) return true;
      const selected = before.text.slice(before.from, before.to);
      // Удаляем выделение только при успешной записи в буфер — как в
      // `comment.cut`. Ожидание длиннее (разворот трансклюзий — сетевой запрос),
      // поэтому после него позиции перепрокладываем, а при расхождении
      // контекста правку отменяем (ошибка 486d0ef1).
      void expanded(selected).then((text) =>
        commentClipboard()
          .writeText(text)
          .then(
            () => {
              const range = relocatedSelection(before, editor.snapshot());
              if (range === null) return;
              editor.applyEdit({
                changes: [{ from: range.from, to: range.to, insert: '' }],
                selection: { anchor: range.from, head: range.from },
              });
            },
            () => undefined,
          ),
      );
      return true;
    },
    state: (snap) => ({ disabled: snap.from === snap.to }),
  });

  registerCommentCommand('comment.pasteAsText', {
    run: (ctx) => {
      const editor = ctx.editor;
      const before = editor.snapshot();
      void commentClipboard()
        .readText()
        .then(
          (text) => {
            if (text === '') return;
            void expanded(text).then((insert) => {
              if (insert === '') return;
              // Разворот трансклюзий — сетевой запрос; позиции сняты ДО него,
              // после ожидания перепрокладываем по актуальному выделению и
              // отменяем вставку при расхождении контекста (ошибка 486d0ef1).
              const range = relocatedSelection(before, editor.snapshot());
              if (range === null) return;
              const caret = range.from + insert.length;
              editor.applyEdit({
                changes: [{ from: range.from, to: range.to, insert }],
                selection: { anchor: caret, head: caret },
              });
            });
          },
          () => undefined,
        );
      return true;
    },
  });
}

installCommentFormatCommands();

/* ------------------------------------------------------------------ *
 * Точечное перекрытие сочетаний, конфликтующих с CM6.
 * ------------------------------------------------------------------ */

/**
 * Команды, чьи сочетания перехватывает сам CM6 (до window-диспетчера),
 * поэтому им нужна привязка `Prec.high` в keymap редактора. Сочетания берутся
 * из единого источника `COMMENT_KEYMAP_DEFAULTS` (реестр аудита `2ec4058b`).
 */
const CM6_OVERRIDE_COMMANDS: readonly string[] = [
  'comment.italic',
  'comment.underline',
  'comment.codeBlock',
  'comment.indentList',
  'comment.outdentList',
  'comment.moveLineUp',
  'comment.moveLineDown',
];

/** Имя клавиши в нотации CM6 (`I` → `i`, `ArrowUp` → `ArrowUp`, `Tab` → `Tab`). */
function cm6KeyName(key: string): string {
  if (key.startsWith('Arrow') || key === 'Tab' || key === 'Enter' || key === 'Escape') return key;
  return key.length === 1 ? key.toLowerCase() : key;
}

/** Сочетание keymap (`Ctrl+Shift+K`) → привязки CM6 (`Ctrl-Shift-k`, `Mod-Shift-k`). */
export function chordToCm6Keys(chord: string): string[] {
  const parts = chord.split('+');
  const key = parts.pop() ?? '';
  const mods: string[] = [];
  let hasCtrl = false;
  for (const part of parts) {
    const mod = part.trim().toLowerCase();
    if (mod === 'ctrl' || mod === 'control' || mod === 'meta') hasCtrl = true;
    else if (mod === 'shift') mods.push('Shift');
    else if (mod === 'alt') mods.push('Alt');
  }
  // Ctrl и Mod дают две эквивалентные привязки (Mod = Ctrl на Windows/Linux,
  // Cmd на macOS) — как и просит аудит `2ec4058b` («Ctrl+I / Mod-i»).
  const ctrlTokens = hasCtrl ? ['Ctrl', 'Mod'] : [''];
  const name = cm6KeyName(key);
  return ctrlTokens.map((ctrl) => {
    const tokens = [ctrl, ...mods].filter((token) => token !== '');
    return tokens.length === 0 ? name : `${tokens.join('-')}-${name}`;
  });
}

/** Команды сдвига списка — не должны мешать автодополнению по Tab. */
const TAB_COMMANDS = new Set(['comment.indentList', 'comment.outdentList']);

/**
 * Расширение keymap поля комментария: точечно перекрывает сочетания,
 * забираемые CM6. Возвращает `false`, когда команда не зарегистрирована или
 * (для Tab) открыт список автодополнения — тогда работает штатное поведение.
 */
export function commentFieldKeymapExtension(): Extension {
  const bindings = CM6_OVERRIDE_COMMANDS.flatMap((command) => {
    const chord = COMMENT_KEYMAP_DEFAULTS[command];
    if (chord === undefined) return [];
    return chordToCm6Keys(chord).map((key) => ({
      key,
      run: (view: EditorView): boolean => {
        if (TAB_COMMANDS.has(command) && completionStatus(view.state) === 'active') return false;
        // Пользовательское переопределение сочетания (задача d534eb35):
        // расширение привязано к УМОЛЧАЛЬНОМУ сочетанию статически, поэтому
        // проверяем, что команда всё ещё закреплена за ним. Переопределил
        // пользователь — умолчальное сочетание уступает штатному поведению CM6,
        // а команду вызывает новое сочетание через диспетчер `lib/keymap.ts`.
        if (effectiveChord(command) !== chord) return false;
        return runCommentCommand(command);
      },
    }));
  });
  return Prec.high(keymap.of(bindings));
}

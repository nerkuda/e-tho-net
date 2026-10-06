/**
 * Юнит-тесты регистрации тел команд поля комментария (0.12.1, задача
 * ab0c4470, ТП1): `editor/comment-format.ts`.
 *
 * DOM-shimmed, как соседний `comment-commands.test.ts`. Проверяются:
 *  - регистрация всех тел команд форматирования и копирования/вырезания/
 *    вставки (ошибка `80f978e5`) в реестре `registerCommentCommand`;
 *  - копировать/вырезать/вставить работают через текст CM6 (снимок/правку),
 *    а не DOM-выделение;
 *  - точечное Prec.high-перекрытие конфликтов CM6 (соответствие сочетаний).
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { parseTransclusions } from '@etn/markdown';

import type { TransclusionTextPort } from '../src/renderer/editor/comment-format.js';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

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

type Commands = typeof import('../src/renderer/editor/comment-commands.js');
type Format = typeof import('../src/renderer/editor/comment-format.js');

let commands: Commands;
let format: Format;

/** Фейковый редактор: хранит снимок и собирает применённые правки. */
function fakeEditor(text: string, from: number, to: number = from) {
  const state = { text, from, to };
  const edits: any[] = [];
  return {
    snapshot: () => ({ ...state }),
    applyEdit: (edit: any) => {
      edits.push(edit);
    },
    /**
     * Меняет документ и выделение — эмулирует правку во время асинхронного
     * ожидания команды. Реальный CM6 сам перепрокладывает выделение через
     * изменения, поэтому тест задаёт и текст, и новые офсеты выделения.
     */
    mutate: (nextText: string, nextFrom: number, nextTo: number = nextFrom) => {
      state.text = nextText;
      state.from = nextFrom;
      state.to = nextTo;
    },
    edits,
  };
}

function host(editor: unknown): any {
  return { getEditor: () => editor, root: new ShimElement('div') };
}

const FORMAT_IDS = [
  'comment.bold',
  'comment.italic',
  'comment.highlight',
  'comment.strike',
  'comment.underline',
  'comment.inlineCode',
  'comment.h1',
  'comment.h2',
  'comment.h3',
  'comment.bulletList',
  'comment.orderedList',
  'comment.taskList',
  'comment.blockquote',
  'comment.codeBlock',
  'comment.table',
  'comment.hr',
  'comment.htmlComment',
  'comment.indentList',
  'comment.outdentList',
  'comment.moveLineUp',
  'comment.moveLineDown',
  'comment.copy',
  'comment.cut',
  'comment.paste',
  'comment.copyAsText',
  'comment.cutAsText',
  'comment.pasteAsText',
];

describe('comment-format: регистрация тел команд', () => {
  beforeEach(async () => {
    installShim();
    commands = (await import('../src/renderer/editor/comment-commands.js')) as Commands;
    commands.commentCommandsInternals.reset();
    format = (await import('../src/renderer/editor/comment-format.js')) as Format;
    format.setCommentClipboardPort(null);
    format.setTransclusionTextPort(null);
    format.installCommentFormatCommands();
  });

  it('регистрирует тела всех внутристрочных и блочных команд', () => {
    for (const id of FORMAT_IDS) {
      assert.equal(commands.hasCommentCommandRunner(id), true, `нет исполнителя команды ${id}`);
    }
  });

  it('команда форматирования применяет правку к снимку редактора', () => {
    const editor = fakeEditor('hello', 0, 5);
    assert.equal(commands.runCommentCommand('comment.bold', host(editor)), true);
    assert.equal(editor.edits.length, 1);
    assert.deepEqual(editor.edits[0].changes, [{ from: 0, to: 5, insert: '**hello**' }]);
  });

  it('состояние кнопки: активность и применимость', () => {
    const active = fakeEditor('**x**', 2, 3);
    assert.equal(commands.commentCommandState('comment.bold', active.snapshot()).active, true);

    const collapsed = fakeEditor('x', 0, 0);
    assert.equal(commands.commentCommandState('comment.copy', collapsed.snapshot()).disabled, true);
    assert.equal(commands.commentCommandState('comment.copy', fakeEditor('x', 0, 1).snapshot()).disabled, false);
    assert.equal(commands.commentCommandState('comment.moveLineUp', collapsed.snapshot()).disabled, true);
  });

  it('копировать кладёт markdown выделения в буфер (не DOM-строку)', () => {
    const written: string[] = [];
    format.setCommentClipboardPort({
      readText: () => Promise.resolve(''),
      writeText: (text) => {
        written.push(text);
        return Promise.resolve();
      },
    });
    const editor = fakeEditor('# Заголовок', 2, 11);
    assert.equal(commands.runCommentCommand('comment.copy', host(editor)), true);
    assert.deepEqual(written, ['Заголовок']);
  });

  it('вырезать копирует и удаляет выделение', async () => {
    const written: string[] = [];
    format.setCommentClipboardPort({
      readText: () => Promise.resolve(''),
      writeText: (text) => {
        written.push(text);
        return Promise.resolve();
      },
    });
    const editor = fakeEditor('abc def', 4, 7);
    assert.equal(commands.runCommentCommand('comment.cut', host(editor)), true);
    await Promise.resolve();
    assert.deepEqual(written, ['def']);
    assert.deepEqual(editor.edits[0].changes, [{ from: 4, to: 7, insert: '' }]);
  });

  it('вставить вставляет текст буфера в позицию каретки', async () => {
    format.setCommentClipboardPort({
      readText: () => Promise.resolve('XY'),
      writeText: () => Promise.resolve(),
    });
    const editor = fakeEditor('ab', 1, 1);
    assert.equal(commands.runCommentCommand('comment.paste', host(editor)), true);
    await Promise.resolve();
    assert.deepEqual(editor.edits[0].changes, [{ from: 1, to: 1, insert: 'XY' }]);
    assert.deepEqual(editor.edits[0].selection, { anchor: 3, head: 3 });
  });

  it('пункты меню отражают применимость: копировать/вырезать недоступны без выделения', () => {
    const collapsed = commands.buildCommentMenuItems(host(fakeEditor('x', 0, 0)));
    const selected = commands.buildCommentMenuItems(host(fakeEditor('x', 0, 1)));
    const copyOf = (items: ReturnType<Commands['buildCommentMenuItems']>): boolean | undefined =>
      items.find((item) => item.label === 'Копировать')?.disabled;
    assert.equal(copyOf(collapsed), true);
    assert.equal(copyOf(selected), false);
  });

  it('сочетания конфликтов CM6 переводятся в нотацию keymap', () => {
    assert.deepEqual(format.chordToCm6Keys('Ctrl+I'), ['Ctrl-i', 'Mod-i']);
    assert.deepEqual(format.chordToCm6Keys('Ctrl+Shift+K'), ['Ctrl-Shift-k', 'Mod-Shift-k']);
    assert.deepEqual(format.chordToCm6Keys('Alt+ArrowUp'), ['Alt-ArrowUp']);
    assert.deepEqual(format.chordToCm6Keys('Tab'), ['Tab']);
    assert.deepEqual(format.chordToCm6Keys('Shift+Tab'), ['Shift-Tab']);
  });

  it('расширение перекрытия собирается без ошибок', () => {
    assert.notEqual(format.commentFieldKeymapExtension(), undefined);
  });
});

// ---------------------------------------------------------------------------
// Команды «как текст» с разворотом трансклюзий (ТП2, задача e9f553e5)
// ---------------------------------------------------------------------------

const SRC = '8e0d670e-de61-4da7-b13e-9232cd1c6ca5';

/** Сливает микрозадачи цепочки async-команд. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Порт развёртки-заглушка: `![[…]]`-ссылки заменяются текстом из карты. */
function stubTextPort(bodies: Record<string, string>): TransclusionTextPort {
  return {
    expand: async (text) => {
      let out = '';
      let last = 0;
      const re = /!\[\[#([0-9a-f-]+)(?:#([^\]]*))?\]\]/g;
      for (const match of text.matchAll(re)) {
        out += text.slice(last, match.index);
        out += bodies[match[1]!.toLowerCase()] ?? '';
        last = match.index! + match[0].length;
      }
      out += text.slice(last);
      return out;
    },
  };
}

describe('comment-format: команды «как текст» (e9f553e5)', () => {
  beforeEach(async () => {
    installShim();
    commands = (await import('../src/renderer/editor/comment-commands.js')) as Commands;
    commands.commentCommandsInternals.reset();
    format = (await import('../src/renderer/editor/comment-format.js')) as Format;
    format.setCommentClipboardPort(null);
    format.setTransclusionTextPort(null);
    format.installCommentFormatCommands();
  });

  it('копировать как текст пишет в буфер развёрнутое содержимое без ссылок', async () => {
    const written: string[] = [];
    format.setCommentClipboardPort({
      readText: () => Promise.resolve(''),
      writeText: (text) => {
        written.push(text);
        return Promise.resolve();
      },
    });
    format.setTransclusionTextPort(stubTextPort({ [SRC]: 'AA' }));

    const source = `до ![[#${SRC}]] после`;
    const editor = fakeEditor(source, 0, source.length);
    assert.equal(commands.runCommentCommand('comment.copyAsText', host(editor)), true);
    await flush();

    assert.deepEqual(written, ['до AA после']);
    assert.ok(!written[0]!.includes('!['), 'ссылок-трансклюзий в буфере нет');
    assert.equal(editor.edits.length, 0, 'копирование документ не меняет');
  });

  it('копировать как текст без выделения недоступно и в буфер не пишет', async () => {
    const written: string[] = [];
    format.setCommentClipboardPort({
      readText: () => Promise.resolve(''),
      writeText: (text) => {
        written.push(text);
        return Promise.resolve();
      },
    });
    format.setTransclusionTextPort(stubTextPort({}));
    const editor = fakeEditor('x', 0, 0);
    assert.equal(
      commands.commentCommandState('comment.copyAsText', editor.snapshot()).disabled,
      true,
    );
    commands.runCommentCommand('comment.copyAsText', host(editor));
    await flush();
    assert.deepEqual(written, []);
  });

  it('вырезать как текст пишет развёртку и удаляет выделение', async () => {
    const written: string[] = [];
    format.setCommentClipboardPort({
      readText: () => Promise.resolve(''),
      writeText: (text) => {
        written.push(text);
        return Promise.resolve();
      },
    });
    format.setTransclusionTextPort(stubTextPort({ [SRC]: 'тело' }));

    const source = `x ![[#${SRC}]] y`;
    const editor = fakeEditor(source, 2, source.length - 2);
    commands.runCommentCommand('comment.cutAsText', host(editor));
    await flush();

    assert.deepEqual(written, ['тело']);
    assert.deepEqual(editor.edits[0].changes, [{ from: 2, to: source.length - 2, insert: '' }]);
    assert.deepEqual(editor.edits[0].selection, { anchor: 2, head: 2 });
  });

  it('вставить как текст вставляет содержимое буфера с разворотом трансклюзий', async () => {
    format.setCommentClipboardPort({
      readText: () => Promise.resolve(`a ![[#${SRC}]] b`),
      writeText: () => Promise.resolve(),
    });
    format.setTransclusionTextPort(stubTextPort({ [SRC]: 'BBB' }));

    const editor = fakeEditor('[]', 1, 1);
    assert.equal(commands.runCommentCommand('comment.pasteAsText', host(editor)), true);
    await flush();

    assert.deepEqual(editor.edits[0].changes, [{ from: 1, to: 1, insert: 'a BBB b' }]);
    assert.deepEqual(editor.edits[0].selection, { anchor: 8, head: 8 });
  });

  it('вставить как текст проглатывает неразрешимую ссылку (пустой результат — без правки)', async () => {
    format.setCommentClipboardPort({
      readText: () => Promise.resolve(`![[#${SRC}]]`),
      writeText: () => Promise.resolve(),
    });
    format.setTransclusionTextPort(stubTextPort({}));

    const editor = fakeEditor('[]', 1, 1);
    commands.runCommentCommand('comment.pasteAsText', host(editor));
    await flush();
    assert.equal(editor.edits.length, 0);
  });

  it('сбой развёртки не теряет текст: копируется исходное выделение', async () => {
    const written: string[] = [];
    format.setCommentClipboardPort({
      readText: () => Promise.resolve(''),
      writeText: (text) => {
        written.push(text);
        return Promise.resolve();
      },
    });
    format.setTransclusionTextPort({ expand: () => Promise.reject(new Error('нет сети')) });

    const source = `a ![[#${SRC}]] b`;
    commands.runCommentCommand('comment.copyAsText', host(fakeEditor(source, 0, source.length)));
    await flush();
    assert.deepEqual(written, [source]);
  });

  it('простая вставка оставляет исходник ссылки — он распознаётся как трансклюзия', async () => {
    format.setCommentClipboardPort({
      readText: () => Promise.resolve(`![[#${SRC}]]`),
      writeText: () => Promise.resolve(),
    });
    const editor = fakeEditor('', 0, 0);
    commands.runCommentCommand('comment.paste', host(editor));
    await flush();

    const inserted = editor.edits[0].changes[0].insert as string;
    assert.equal(inserted, `![[#${SRC}]]`, 'исходник вставляется дословно');
    assert.equal(
      parseTransclusions(inserted).length,
      1,
      'вставленный исходник распознаётся единым парсером как трансклюзия',
    );
  });
});

// ---------------------------------------------------------------------------
// Гонка асинхронного ожидания и позиций правки (ошибка 486d0ef1)
// ---------------------------------------------------------------------------

describe('comment-format: буфер обмена и устаревшие позиции (486d0ef1)', () => {
  beforeEach(async () => {
    installShim();
    commands = (await import('../src/renderer/editor/comment-commands.js')) as Commands;
    commands.commentCommandsInternals.reset();
    format = (await import('../src/renderer/editor/comment-format.js')) as Format;
    format.setCommentClipboardPort(null);
    format.setTransclusionTextPort(null);
    format.installCommentFormatCommands();
  });

  it('вырезать: правка перепрокладывается по актуальному выделению после ожидания', async () => {
    const editor = fakeEditor('abc def', 4, 7);
    format.setCommentClipboardPort({
      readText: () => Promise.resolve(''),
      writeText: () => {
        // Во время асинхронной записи документ изменился: в начало вставили
        // «ZZ», CM6 сдвинул выделение на [6, 9) — там всё ещё «def».
        editor.mutate('ZZabc def', 6, 9);
        return Promise.resolve();
      },
    });

    commands.runCommentCommand('comment.cut', host(editor));
    await flush();

    assert.deepEqual(
      editor.edits[0]?.changes,
      [{ from: 6, to: 9, insert: '' }],
      'удаляется актуальное выделение, а не устаревшие позиции [4, 7)',
    );
  });

  it('вырезать: изменившееся выделение — правка отменяется, текст не портится', async () => {
    const editor = fakeEditor('abc def', 4, 7);
    format.setCommentClipboardPort({
      readText: () => Promise.resolve(''),
      writeText: () => {
        // Пользователь переставил выделение на другой фрагмент.
        editor.mutate('abc def', 0, 3);
        return Promise.resolve();
      },
    });

    commands.runCommentCommand('comment.cut', host(editor));
    await flush();

    assert.equal(editor.edits.length, 0, 'устаревшие позиции не применяются');
  });

  it('вырезать как текст: перепрокладка после сетевого разворота трансклюзий', async () => {
    const written: string[] = [];
    format.setCommentClipboardPort({
      readText: () => Promise.resolve(''),
      writeText: (text) => {
        written.push(text);
        return Promise.resolve();
      },
    });
    const source = `x ![[#${SRC}]] y`;
    const editor = fakeEditor(source, 2, source.length - 2);
    format.setTransclusionTextPort({
      expand: async () => {
        // Долгий разворот: за это время документ изменился (реальное время).
        editor.mutate(`ZZ ${source}`, 5, source.length + 1);
        return 'тело';
      },
    });

    commands.runCommentCommand('comment.cutAsText', host(editor));
    await flush();

    assert.deepEqual(written, ['тело']);
    assert.deepEqual(
      editor.edits[0]?.changes,
      [{ from: 5, to: source.length + 1, insert: '' }],
      'удаление по актуальным позициям выделения',
    );
  });

  it('вставить: изменившееся выделение — вставка отменяется', async () => {
    const editor = fakeEditor('ab', 0, 2);
    // Чтение буфера само по себе документ не меняет; эмулируем правку во время
    // ожидания мутацией из порта — как её сделал бы реальный обмен/ввод.
    format.setCommentClipboardPort({
      readText: () => {
        editor.mutate('ab', 0, 1); // выделение сузилось с «ab» до «a»
        return Promise.resolve('XY');
      },
      writeText: () => Promise.resolve(),
    });

    commands.runCommentCommand('comment.paste', host(editor));
    await flush();

    assert.equal(editor.edits.length, 0, 'вставка не затирает изменившееся выделение');
  });

  it('вставить как текст: перестановка выделения на идентичный фрагмент отменяет вставку', async () => {
    // Непустое выделение (не каретка): именно на нём проявляется дефект 253b0dd3
    // — перестановка на ИДЕНТИЧНЫЙ по тексту, но другое вхождение.
    const text = 'foo bar foo';
    const editor = fakeEditor(text, 0, 3); // первое «foo»
    format.setCommentClipboardPort({
      readText: () => Promise.resolve(`![[#${SRC}]]`),
      writeText: () => Promise.resolve(),
    });
    format.setTransclusionTextPort({
      expand: async () => {
        // Долгий сетевой разворот: за это время выделение переставили на
        // ВТОРОЕ «foo» — тот же текст, другое место. Вставка идти туда не должна.
        editor.mutate(text, 8, 11);
        return 'BBB';
      },
    });

    commands.runCommentCommand('comment.pasteAsText', host(editor));
    await flush();

    assert.equal(editor.edits.length, 0, 'идентичный фрагмент не должен получить вставку');
  });
});

// ---------------------------------------------------------------------------
// Перестановка выделения на идентичный фрагмент (ошибка 253b0dd3)
// ---------------------------------------------------------------------------

describe('comment-format: идентичные фрагменты и устаревшие позиции (253b0dd3)', () => {
  beforeEach(async () => {
    installShim();
    commands = (await import('../src/renderer/editor/comment-commands.js')) as Commands;
    commands.commentCommandsInternals.reset();
    format = (await import('../src/renderer/editor/comment-format.js')) as Format;
    format.setCommentClipboardPort(null);
    format.setTransclusionTextPort(null);
    format.installCommentFormatCommands();
  });

  it('вырезать: выделение переставлено на идентичный фрагмент — правка отменяется', async () => {
    const text = 'foo bar foo';
    const editor = fakeEditor(text, 0, 3); // первое «foo»
    format.setCommentClipboardPort({
      readText: () => Promise.resolve(''),
      writeText: () => {
        // Документ не менялся, но выделение переставили на ВТОРОЕ «foo»
        // (идентичное по тексту) — правку применять нельзя.
        editor.mutate(text, 8, 11);
        return Promise.resolve();
      },
    });

    commands.runCommentCommand('comment.cut', host(editor));
    await flush();

    assert.equal(editor.edits.length, 0, 'идентичный фрагмент не должен быть вырезан');
  });

  it('вырезать: сдвиг документа оставляет правку на ИСХОДНОМ вхождении', async () => {
    const text = 'foo bar foo';
    const editor = fakeEditor(text, 0, 3); // первое «foo»
    format.setCommentClipboardPort({
      readText: () => Promise.resolve(''),
      writeText: () => {
        // Вставка «X » в начало: CM6 сдвинул выделение на +2, но это по-прежнему
        // ПЕРВОЕ «foo», а не идентичное второе.
        editor.mutate(`X ${text}`, 2, 5);
        return Promise.resolve();
      },
    });

    commands.runCommentCommand('comment.cut', host(editor));
    await flush();

    assert.deepEqual(
      editor.edits[0]?.changes,
      [{ from: 2, to: 5, insert: '' }],
      'удаляется исходное вхождение по актуальным позициям',
    );
  });
});

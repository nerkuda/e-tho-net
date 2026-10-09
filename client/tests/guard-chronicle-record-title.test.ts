/**
 * Сторож единой шапки дневниковой записи и ЕДИНОЙ правки карточки (0.12.1, ТП
 * «Дневник без псевдослота»; ранее ошибки 36c330a3, 47c2bf05).
 *
 * Шапка карточки (дата/период, привязки, «+ мысль», меню записи; строка
 * заголовка) собирается единым конструктором `record-head.ts`
 * (`buildRecordHead`), заголовок — одним компонентом `record-title.ts`
 * (`createRecordTitle`, ровно один вызов внутри конструктора шапки).
 *
 * Режим правки принадлежит КАРТОЧКЕ: вход в правку заголовка или тела открывает
 * оба поля (`editGroup` + `onBeginEdit`), уход фокуса правку не закрывает
 * (`commitOnBlur: false`), Enter зовёт хозяина (`onEnter`), Escape — откат обоих
 * (`onEscape`). Псевдозапись/слот отсутствует.
 *
 * Проверка раскладки — В ИСПОЛНЕНИИ на DOM-шиме; контракт компонента заголовка —
 * тоже исполнением (Enter/Escape/blur/setContent).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, it } from 'node:test';

import * as keymap from '../src/renderer/lib/keymap.js';
import { ShimElement } from './dom-shim.js';

// Клавиатура правки идёт через диспетчер контекстов: стек между тестами чист.
beforeEach(() => keymap.keymapInternals.reset());

/** Нажатие через диспетчер (контекст правки уже на стеке после beginEdit). */
function pressViaKeymap(
  node: ShimElement,
  key: string,
  mods: Record<string, boolean> = {},
): void {
  keymap.dispatchKeyEvent({
    key,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods,
    target: node,
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
  } as unknown as KeyboardEvent);
}

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');

function read(...parts: string[]): string {
  return readFileSync(resolve(RENDERER, ...parts), 'utf8');
}

const CHRONICLE = read('screens', 'chronicle', 'chronicle.ts');
const RECORD_TITLE = read('screens', 'chronicle', 'record-title.ts');
const RECORD_HEAD = read('screens', 'chronicle', 'record-head.ts');

/** Минимальный DOM-шим для исполнения компонента и шапки записи. */
function installShim(): void {
  const body = new ShimElement('body');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).document = {
    documentElement: new ShimElement('html'),
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (text: string) => new ShimElement('#text', undefined, text),
    body,
    activeElement: body,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  win['setTimeout'] = setTimeout;
  win['clearTimeout'] = clearTimeout;
  win['addEventListener'] = () => undefined;
  win['removeEventListener'] = () => undefined;
}

interface TitleHandle {
  node(): ShimElement;
  value(): string;
  isEditing(): boolean;
  beginEdit(focus?: boolean): void;
  endEdit(commit: boolean, refocus: boolean): void;
  setContent(value: string, label?: string): void;
}

async function makeTitle(opts: Record<string, unknown>): Promise<TitleHandle> {
  installShim();
  const { createRecordTitle } = await import(
    '../src/renderer/screens/chronicle/record-title.js'
  );
  return createRecordTitle(opts as never) as unknown as TitleHandle;
}

describe('сторож: единая шапка и единая правка записи «Дневника» (0.12.1)', () => {
  it('карточка собирает шапку одним `buildRecordHead`, заголовок — одним `createRecordTitle`', () => {
    const headCalls = (CHRONICLE.match(/buildRecordHead\(/g) ?? []).length;
    assert.equal(headCalls, 1, 'единственная проводка конструктора шапки (карточка)');
    const titleCalls =
      (CHRONICLE.match(/createRecordTitle\(/g) ?? []).length +
      (RECORD_HEAD.match(/createRecordTitle\(/g) ?? []).length;
    assert.equal(
      titleCalls,
      1,
      'заголовок-компонент создаётся ровно один раз — внутри конструктора шапки',
    );
    assert.match(CHRONICLE, /buildRecordHead\(/, 'карточка зовёт конструктор шапки');
    assert.match(
      CHRONICLE,
      /createMarkdownField\(\{/,
      'тело записи использует общий markdown-компонент',
    );
    assert.ok(!/startSlot|ensureSlot|SlotState/.test(CHRONICLE), 'псевдозапись демонтирована');
  });

  it('раскладка: строка полей (дата, привязки, «+ мысль», завершение), затем заголовок', async () => {
    installShim();
    const { buildRecordHead } = await import(
      '../src/renderer/screens/chronicle/record-head.js'
    );
    const chips = new ShimElement('div');
    const trailing = new ShimElement('button');
    const added: number[] = [];
    interface Head {
      root: ShimElement;
      row: ShimElement;
      title: { node(): ShimElement };
    }
    const { root, row, title } = buildRecordHead({
      dayLabel: '1 сентября 2026',
      chips,
      onAddThought: () => added.push(1),
      trailing,
      title: {
        value: '',
        label: 'Пустая запись',
        editHint: 'Правка',
        placeholder: 'Заголовок',
      },
    } as never) as unknown as Head;

    assert.equal(root.children.length, 2, 'шапка — две строки: поля и заголовок');
    assert.ok(root.children[0] === row, 'первая строка — строка полей');
    assert.ok(root.children[1] === title.node(), 'вторая строка — узел заголовка');
    assert.equal(row.children.length, 4, 'в строке полей четыре элемента');
    assert.ok(row.children[0]!.classList.contains('diary-record-date'), 'первый — дата/период');
    assert.ok(row.children[1] === chips, 'второй — контейнер привязок');
    assert.ok(row.children[2]!.classList.contains('diary-chip-add'), 'третий — «+ мысль»');
    assert.ok(row.children[3] === trailing, 'четвёртый — завершающий элемент');

    row.children[2]!.click();
    assert.equal(added.length, 1, '«+ мысль» вызывает `onAddThought`');

    assert.equal(title.node().tagName, 'button', 'в просмотре — кнопка-группа');
    const arrow = title.node().firstChild as ShimElement | null;
    assert.ok(arrow !== null && arrow.tagName === 'svg', 'у группы есть индикатор-стрелка');
  });

  it('единая правка: Enter зовёт хозяина (без завершения), Escape — откат, blur не завершает', async () => {
    const entered: KeyboardEvent[] = [];
    const escapes: number[] = [];
    const commits: string[] = [];
    const handle = await makeTitle({
      value: 'Старый',
      label: 'Старый',
      editHint: 'Правка',
      placeholder: 'Заголовок',
      commitOnBlur: false,
      onEnter: (event: KeyboardEvent) => entered.push(event),
      onEscape: () => escapes.push(1),
      onCommit: (next: string) => {
        commits.push(next);
        return next;
      },
    });
    const host = new ShimElement('div');
    host.append(handle.node());

    handle.beginEdit(true);
    const field = handle.node();
    assert.equal(field.tagName, 'input', 'правка открыта');

    pressViaKeymap(field, 'Enter');
    assert.equal(entered.length, 1, 'обычный Enter зовёт хозяина');
    assert.equal(handle.isEditing(), true, 'правка НЕ завершается (единая модель)');

    pressViaKeymap(field, 'Enter', { ctrlKey: true });
    assert.equal(entered.length, 2, 'Ctrl+Enter тоже уходит хозяину (он решает записать)');

    field.value = 'Изменённый';
    field.emit('blur');
    assert.equal(handle.isEditing(), true, 'blur при `commitOnBlur: false` правку не закрывает');
    assert.deepEqual(commits, [], 'blur ничего не коммитит');

    pressViaKeymap(field, 'Escape');
    assert.equal(escapes.length, 1, 'Escape зовёт хозяина (откат обоих полей)');
  });

  it('`setContent` задаёт показанное значение и надпись просмотра', async () => {
    const handle = await makeTitle({
      value: '',
      label: 'Пустая запись',
      editHint: 'Правка',
      placeholder: 'Заголовок',
    });
    handle.setContent('Встреча', 'Встреча');
    assert.equal(handle.value(), 'Встреча');
    assert.equal(
      handle.node().children[handle.node().children.length - 1]?.textContent,
      'Встреча',
      'надпись просмотра обновилась',
    );
  });

  it('карточка объявляет единую модель правки: editGroup, commitOnBlur, onEnter/onEscape', () => {
    assert.match(CHRONICLE, /editGroup: \(\) => card/, 'группа правки — карточка');
    assert.match(CHRONICLE, /commitOnBlur: false/, 'blur правку не закрывает');
    assert.match(CHRONICLE, /onBeginEdit: \(\) => void enterBodyEdit\('title'\)/, 'вход в тело из заголовка');
    assert.match(CHRONICLE, /onEnter: \(event\) =>/, 'Enter заголовка — хозяину');
    assert.match(CHRONICLE, /onEscape: \(\) => cancelEdit\(\)/, 'Escape — откат обоих полей');
    assert.match(CHRONICLE, /title: \{[\s\S]*?value: row\.title \?\? ''/, 'заголовок — поле ввода');
  });

  it('компонент строит и просмотр-группу, и поле правки из фасадов `lib/ui`', () => {
    assert.match(
      RECORD_TITLE,
      /const view = uiButton\(\{[\s\S]*?class: RECORD_TITLE_CLASS,/,
      'просмотр — кнопка словаря',
    );
    assert.match(
      RECORD_TITLE,
      /fieldInput\(\{\s*extraClass: `\$\{RECORD_TITLE_CLASS\} \$\{RECORD_TITLE_INPUT_CLASS\}`,\s*\}\)/,
      'правка — поле фасада `lib/ui/field`',
    );
  });
});

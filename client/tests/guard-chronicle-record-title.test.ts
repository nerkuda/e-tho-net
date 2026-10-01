/**
 * Сторож единой шапки дневниковой записи (0.10.2, ошибка 36c330a3; 0.10.3,
 * ошибка 47c2bf05).
 *
 * Шапку — строку полей (дата/период, привязки, «+ мысль», завершающий элемент) и
 * строку заголовка — карточка существующей записи и слот создания ОБЯЗАНЫ
 * собирать одним конструктором `screens/chronicle/record-head.ts`
 * (`buildRecordHead`). Раньше их собирали независимо, и компоновка расходилась:
 * в слоте заголовок попадал в строку 1 рядом с периодом, а «+ мысль» уезжала на
 * строку 2 (ошибка 47c2bf05). Заголовок обоих состояний — один компонент
 * `record-title.ts` (`createRecordTitle`, ошибка 36c330a3).
 *
 * Проверка раскладки — В ИСПОЛНЕНИИ, а не разбором текста: сторож монтирует
 * шапку на DOM-шиме и сверяет структуру (две строки; порядок и состав строки
 * полей; заголовок — ИМЕННО `title.node()`, а не локальная сборка). Плюс
 * структурная «привязка» экрана: и карточка, и `startSlot` зовут
 * `buildRecordHead`, а `createRecordTitle` вызывается ровно один раз.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');

function read(...parts: string[]): string {
  return readFileSync(resolve(RENDERER, ...parts), 'utf8');
}

const CHRONICLE = read('screens', 'chronicle', 'chronicle.ts');
const RECORD_TITLE = read('screens', 'chronicle', 'record-title.ts');
const RECORD_HEAD = read('screens', 'chronicle', 'record-head.ts');

/** Тело функции верхнего уровня по объявлению (стиль файла: `}` в колонке 0). */
function functionBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `исходник содержит «${signature}»`);
  const body = src.slice(start);
  const end = body.indexOf('\n}\n');
  assert.ok(end >= 0, `у «${signature}» найдено тело`);
  return body.slice(0, end);
}

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

interface HeadModule {
  buildRecordHead(hooks: {
    dayLabel: string;
    onDateClick?: () => void;
    dateTitle?: string;
    chips: ShimElement;
    onAddThought: () => void;
    trailing: ShimElement;
    title: {
      value: string;
      label: string;
      editHint: string;
      placeholder: string;
      onCommit?: (value: string) => string;
      onCancel?: () => void;
    };
  }): {
    root: ShimElement;
    row: ShimElement;
    title: { node(): ShimElement; isEditing(): boolean; beginEdit(): void };
  };
}

describe('сторож: единая шапка записи «Дневника» (ошибки 36c330a3, 47c2bf05)', () => {
  it('карточка и слот собирают шапку одним `buildRecordHead`, заголовок — одним `createRecordTitle`', () => {
    const headCalls = (CHRONICLE.match(/buildRecordHead\(/g) ?? []).length;
    assert.equal(headCalls, 2, 'карточка и слот — две проводки единого конструктора шапки');
    const titleCalls =
      (CHRONICLE.match(/createRecordTitle\(/g) ?? []).length +
      (RECORD_HEAD.match(/createRecordTitle\(/g) ?? []).length;
    assert.equal(
      titleCalls,
      1,
      'заголовок-компонент создаётся ровно один раз — внутри конструктора шапки',
    );
    assert.match(
      CHRONICLE,
      /recordTitles\.set\(card, head\.title\)/,
      'карточка берёт дескриптор заголовка из шапки',
    );
    const slot = functionBody(
      CHRONICLE,
      'function startSlot(day?: string, presetThoughtIds: string[] = []): void {',
    );
    assert.match(slot, /buildRecordHead\(/, 'слот собирает шапку тем же конструктором');
    assert.match(CHRONICLE, /title: RecordTitleHandle;/, 'слот хранит дескриптор компонента');
    assert.match(CHRONICLE, /state\.title\.beginEdit\(\)/, 'слот открывает заголовок в правке');
    assert.match(
      CHRONICLE,
      /void ensureSlot\(\{ title: next \}\)/,
      'завершение правки заголовка сохраняет черновик через `ensureSlot`',
    );
  });

  it('раскладка: строка полей (дата, привязки, «+ мысль», завершение), затем заголовок — в исполнении', async () => {
    installShim();
    const mod = (await import(
      '../src/renderer/screens/chronicle/record-head.js'
    )) as unknown as HeadModule;
    const chips = new ShimElement('div');
    const trailing = new ShimElement('button');
    const added: number[] = [];
    let commits = 0;
    const { root, row, title } = mod.buildRecordHead({
      dayLabel: '1 сентября 2026',
      chips,
      onAddThought: () => added.push(1),
      trailing,
      title: {
        value: '',
        label: 'Пустая запись',
        editHint: 'Правка',
        placeholder: 'Заголовок',
        onCommit: (value) => {
          commits++;
          return value.trim() || 'Пустая запись';
        },
      },
    });

    // Две строки: строка полей и строка заголовка.
    assert.equal(root.children.length, 2, 'шапка — две строки: поля и заголовок');
    assert.ok(root.children[0] === row, 'первая строка — строка полей');
    assert.ok(
      row.classList.contains('diary-record-head-row'),
      'строка полей носит свой класс',
    );
    const titleNode = root.children[1]!;
    assert.ok(titleNode === title.node(), 'вторая строка — узел компонента-заголовка (идентичность)');
    assert.ok(!row.contains(title.node()), 'заголовок НЕ находится в строке полей');

    // Строка полей: дата, привязки, «+ мысль», завершающий элемент.
    assert.equal(row.children.length, 4, 'в строке полей четыре элемента');
    assert.ok(row.children[0]!.classList.contains('diary-record-date'), 'первый — дата/период');
    assert.ok(row.children[1] === chips, 'второй — контейнер привязок');
    assert.ok(row.children[2]!.classList.contains('diary-chip-add'), 'третий — кнопка «+ мысль»');
    assert.ok(row.children[3] === trailing, 'четвёртый — завершающий элемент (меню/«✕»)');

    // Клик по «+ мысль» дёргает доменное действие.
    row.children[2]!.click();
    assert.equal(added.length, 1, '«+ мысль» вызывает `onAddThought`');

    // Заголовок — кнопка компонента со стрелкой; вход в правку даёт его поле.
    assert.ok(titleNode.classList.contains('diary-record-title'), 'класс заголовка компонента');
    assert.equal(titleNode.tagName, 'button', 'в просмотре — кнопка-группа компонента');
    assert.ok(
      titleNode.firstChild !== null && titleNode.firstChild.tagName === 'svg',
      'у группы есть индикатор-стрелка компонента',
    );
    title.beginEdit();
    assert.ok(root.children[1] === title.node(), 'в правке на той же строке — поле компонента');
    assert.equal(title.node().tagName, 'input', 'правка — поле ввода');
    title.node().value = 'Заголовок';
    title.node().emit('keydown', {
      key: 'Enter',
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });
    assert.equal(commits, 1, 'Enter завершает правку и коммитит значение');
    assert.equal(root.children[1]!.tagName, 'button', 'вернулась кнопка-группа');
  });

  it('`startSlot` не собирает поле ввода локально (запрет сужен до его тела)', () => {
    const slot = functionBody(
      CHRONICLE,
      'function startSlot(day?: string, presetThoughtIds: string[] = []): void {',
    );
    assert.match(slot, /buildRecordHead\(/, 'шапка слота собирается конструктором');
    assert.ok(!/fieldInput\(/.test(slot), 'в теле startSlot нет `fieldInput(`');
    assert.ok(!/el\(\s*['"]input['"]/.test(slot), 'в теле startSlot нет самодельного `el(\'input\')`');
    assert.ok(!/createElement/.test(slot), 'в теле startSlot нет `createElement`');
    assert.ok(
      !/['"]diary['"]\s*\+\s*['"]-record-title['"]/.test(CHRONICLE),
      'класс заголовка не собирается склейкой строк в экране',
    );
    assert.ok(!/RECORD_TITLE_INPUT_CLASS/.test(CHRONICLE), 'класс поля правки — только в компоненте');
  });

  it('контракт правки компонента проверяется ИСПОЛНЕНИЕМ: Enter/Escape/blur', async () => {
    installShim();
    const { createRecordTitle } = await import(
      '../src/renderer/screens/chronicle/record-title.js'
    );
    type El = ShimElement;
    interface H {
      node(): El;
      isEditing(): boolean;
      beginEdit(): void;
    }
    const make = (onCommit: (v: string) => string, onCancel?: () => void): H =>
      createRecordTitle({
        value: 'A',
        label: 'A',
        editHint: 'e',
        placeholder: 'p',
        onCommit,
        ...(onCancel !== undefined ? { onCancel } : {}),
      }) as unknown as H;

    const entered: string[] = [];
    const byEnter = make((v) => {
      entered.push(v);
      return v;
    });
    const host = new ShimElement('div');
    host.append(byEnter.node());
    byEnter.beginEdit();
    assert.equal(byEnter.node().tagName, 'input', 'правка открыта');
    byEnter.node().value = 'B';
    byEnter.node().emit('keydown', {
      key: 'Enter',
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });
    assert.equal(byEnter.isEditing(), false, 'Enter завершил правку');
    assert.equal(byEnter.node().tagName, 'button', 'вернулась кнопка-группа, а не «ничего»');
    assert.deepEqual(entered, ['B'], 'значение закоммичено');

    const cancelled = { n: 0 };
    const commits: string[] = [];
    const byEscape = make(
      (v) => {
        commits.push(v);
        return v;
      },
      () => {
        cancelled.n++;
      },
    );
    byEscape.beginEdit();
    byEscape.node().value = 'C';
    byEscape.node().emit('keydown', {
      key: 'Escape',
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });
    assert.equal(byEscape.isEditing(), false, 'Escape завершил правку');
    assert.deepEqual(commits, [], 'Escape не коммитит');
    assert.equal(cancelled.n, 1, 'отмена замечена');

    const blurred: string[] = [];
    const byBlur = make((v) => {
      blurred.push(v);
      return v;
    });
    byBlur.beginEdit();
    byBlur.node().value = 'D';
    byBlur.node().emit('blur');
    assert.equal(byBlur.isEditing(), false, 'blur завершил правку');
    assert.deepEqual(blurred, ['D'], 'blur сохранил значение');
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

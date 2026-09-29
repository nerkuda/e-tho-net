/**
 * Сторож единой реализации заголовка записи «Дневника» (0.10.2, ошибка
 * 36c330a3).
 *
 * Заголовок существующей карточки и заголовок слота создания ОБЯЗАН собирать
 * один компонент `screens/chronicle/record-title.ts` (`createRecordTitle`).
 * Раньше реализаций было две, и в слоте `Enter` не завершал правку.
 *
 * Проверка — В ИСПОЛНЕНИИ, а не разбором текста. Шапка слота собирается
 * вынесенным помощником `screens/chronicle/slot-head.ts` (`buildSlotHead`) —
 * тот же код, что зовёт `startSlot`. Сторож монтирует шапку на DOM-шиме и
 * сверяет ИДЕНТИЧНОСТЬ узла: в шапке должен лежать ИМЕННО `title.node()`
 * (в просмотре — кнопка `.diary-record-title` со `svg`-стрелкой, в правке —
 * поле того же компонента), а не результат локальной сборки. Так проверка
 * невосприимчива к форматированию исходника и к подмене узла после
 * монтирования, и не требует запрещать `fieldInput` по всему экрану.
 *
 * Структурные проверки оставлены лишь как «привязка» экрана к помощнику:
 * `startSlot` обязан звать `buildSlotHead`, в его теле нет локальной сборки
 * поля ввода.
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
const SLOT_HEAD = read('screens', 'chronicle', 'slot-head.ts');

/** Тело функции верхнего уровня по объявлению (стиль файла: `}` в колонке 0). */
function functionBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `исходник содержит «${signature}»`);
  const body = src.slice(start);
  const end = body.indexOf('\n}\n');
  assert.ok(end >= 0, `у «${signature}» найдено тело`);
  return body.slice(0, end);
}

/** Минимальный DOM-шим для исполнения компонента и шапки слота. */
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

describe('сторож: один компонент заголовка записи (ошибка 36c330a3)', () => {
  it('карточка и слот собирают заголовок одним `createRecordTitle`, слот — через `buildSlotHead`', () => {
    const calls =
      (CHRONICLE.match(/createRecordTitle\(/g) ?? []).length +
      (SLOT_HEAD.match(/createRecordTitle\(/g) ?? []).length;
    assert.equal(calls, 2, 'карточка и шапка слота — две проводки общего компонента');
    const buildTitle = functionBody(
      CHRONICLE,
      'function buildTitle(row: ChronicleRow, card: HTMLElement): HTMLElement {',
    );
    assert.match(buildTitle, /return handle\.node\(\);/, 'карточка отдаёт узел компонента');
    const slot = functionBody(
      CHRONICLE,
      'function startSlot(day?: string, presetThoughtIds: string[] = []): void {',
    );
    assert.match(slot, /buildSlotHead\(/, 'слот собирает шапку общим помощником');
    assert.match(CHRONICLE, /title: RecordTitleHandle;/, 'слот хранит дескриптор компонента');
    assert.match(CHRONICLE, /state\.title\.beginEdit\(\)/, 'слот открывает заголовок в правке');
    assert.match(
      CHRONICLE,
      /void ensureSlot\(\{ title: next \}\)/,
      'завершение правки заголовка сохраняет черновик через `ensureSlot`',
    );
  });

  it('в шапке слота — ИМЕННО узел компонента (проверка в исполнении)', async () => {
    installShim();
    const mod = (await import('../src/renderer/screens/chronicle/slot-head.js')) as unknown as {
      buildSlotHead(hooks: {
        dayLabel: string;
        onTitleCommit: (value: string) => void;
        onCancel: () => void;
      }): { root: ShimElement; title: { node(): ShimElement; beginEdit(): void } };
    };
    const commits: string[] = [];
    let cancelled = 0;
    const { root, title } = mod.buildSlotHead({
      dayLabel: '1 сентября 2026',
      onTitleCommit: (value) => commits.push(value),
      onCancel: () => {
        cancelled++;
      },
    });

    // Шапка: дата, узел компонента-заголовка, кнопка отмены.
    assert.equal(root.children.length, 3, 'в шапке три узла: дата, заголовок, «✕»');
    assert.ok(
      root.children[0]!.classList.contains('diary-record-date'),
      'первый узел — подпись даты',
    );
    const titleNode = root.children[1]!;
    assert.ok(
      titleNode === title.node(),
      'узел заголовка в шапке — узел компонента (идентичность, а не локальная сборка)',
    );
    assert.ok(titleNode.classList.contains('diary-record-title'), 'класс заголовка компонента');
    assert.equal(titleNode.tagName, 'button', 'в просмотре — кнопка-группа компонента');
    assert.ok(
      titleNode.firstChild !== null && titleNode.firstChild.tagName === 'svg',
      'у группы есть индикатор-стрелка компонента',
    );
    assert.ok(
      root.children[2]!.classList.contains('diary-slot-cancel'),
      'третий узел — кнопка отмены',
    );

    // Вход в правку: в шапке оказывается поле ТОГО ЖЕ компонента (идентичность).
    title.beginEdit();
    assert.ok(root.children[1] === title.node(), 'в правке в шапке — поле компонента');
    assert.equal(title.node().tagName, 'input', 'правка — поле ввода');
    assert.ok(
      title.node().classList.contains('diary-record-title-input'),
      'поле носит класс правки компонента',
    );

    // Enter завершает правку и возвращает кнопку компонента на то же место.
    title.node().value = 'Заголовок';
    title.node().emit('keydown', {
      key: 'Enter',
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });
    assert.ok(root.children[1] === title.node(), 'после Enter в шапке снова узел компонента');
    assert.equal(root.children[1]!.tagName, 'button', 'вернулась кнопка-группа');
    assert.deepEqual(commits, ['Заголовок'], 'значение ушло в `onTitleCommit`');

    // Кнопка отмены дёргает доменное действие.
    root.children[2]!.click();
    assert.equal(cancelled, 1, '«✕» вызывает отмену слота');
  });

  it('`startSlot` не собирает поле ввода локально (запрет сужен до его тела)', () => {
    const slot = functionBody(
      CHRONICLE,
      'function startSlot(day?: string, presetThoughtIds: string[] = []): void {',
    );
    assert.match(slot, /buildSlotHead\(/, 'шапка слота собирается помощником');
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

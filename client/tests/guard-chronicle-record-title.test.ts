/**
 * Сторож единой реализации заголовка записи «Дневника» (0.10.2, ошибка
 * 36c330a3).
 *
 * Заголовок существующей карточки и заголовок слота создания ОБЯЗАН собирать
 * один компонент `screens/chronicle/record-title.ts` (`createRecordTitle`).
 * Раньше реализаций было две, и в слоте `Enter` не завершал правку — расхождение
 * возникло именно из-за копии разметки.
 *
 * Почему не хватает запрета литералов. Первая редакция сторожа ловила лишь
 * БУКВАЛЬНУЮ форму второй реализации и обходилась «разорванным» литералом
 * класса (`fieldInput({ extraClass: 'diary'+'-record-title' })`, узел компонента
 * при этом в слот не монтировался). Здесь проверяется ФАКТ МОНТИРОВАНИЯ:
 *   • в слот попадает ИМЕННО узел компонента — `head.append(…, title.node(), …)`
 *     (идентичность выражения `title.node()`, а не совпадение текста класса);
 *   • заголовок-дескриптор слота берётся из компонента (`const title =
 *     createRecordTitle`, `state.title`), а не собирается локально;
 *   • в `chronicle.ts` вообще нет локального создания поля ввода (запрет на
 *     `fieldInput(`/`el('input'`/`createElement('input'`) — любой обход через
 *     «разорванный» литерал или самодельный узел краснеет.
 * Вторая половина (контракт правки) проверяется ИСПОЛНЕНИЕМ компонента на
 * DOM-шиме: `Enter` завершает правку кнопкой-группой, `Escape` отменяет, `blur`
 * сохраняет, — переписывание логики в исходнике сторож не обманет.
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

/** Тело функции верхнего уровня по объявлению (стиль файла: `}` в колонке 0). */
function functionBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `исходник содержит «${signature}»`);
  const body = src.slice(start);
  const end = body.indexOf('\n}\n');
  assert.ok(end >= 0, `у «${signature}» найдено тело`);
  return body.slice(0, end);
}

/** Аргументы вызова по подстроке-маркеру, оканчивающейся на `(`. */
function callArgs(src: string, marker: string): string {
  const at = src.indexOf(marker);
  if (at < 0) return '';
  let depth = 0;
  for (let i = at + marker.length - 1; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return src.slice(at + marker.length, i);
    }
  }
  return '';
}

/** Минимальный DOM-шим для исполнения компонента в сторожевом тесте. */
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
  it('оба потребителя собирают заголовок одним `createRecordTitle`', () => {
    const calls = CHRONICLE.match(/createRecordTitle\(/g) ?? [];
    assert.equal(calls.length, 2, 'карточка и слот — две проводки общего компонента');
    const buildTitle = functionBody(CHRONICLE, 'function buildTitle(row: ChronicleRow, card: HTMLElement): HTMLElement {');
    assert.match(buildTitle, /return handle\.node\(\);/, 'карточка отдаёт узел компонента');
    assert.match(CHRONICLE, /title: RecordTitleHandle;/, 'слот хранит дескриптор компонента');
    assert.match(CHRONICLE, /state\.title\.beginEdit\(\)/, 'слот открывает заголовок в правке');
    assert.match(
      CHRONICLE,
      /void ensureSlot\(\{ title: next \}\)/,
      'завершение правки заголовка сохраняет черновик через `ensureSlot`',
    );
  });

  it('в слот монтируется ИМЕННО узел компонента (`title.node()`), а не локальное поле', () => {
    const slot = functionBody(CHRONICLE, 'function startSlot(day?: string, presetThoughtIds: string[] = []): void {');
    assert.ok(slot !== '', 'тело startSlot найдено');
    // Дескриптор — результат общего компонента и он же лежит в состоянии слота.
    assert.match(slot, /const title = createRecordTitle\(\{/, 'заголовок слота — из компонента');
    assert.match(
      slot,
      /root,\s*\n\s*title,\s*\n\s*from: targetDay,/,
      'в состояние слота кладётся дескриптор компонента (идентичность, а не копия)',
    );
    // ФАКТ МОНТИРОВАНИЯ: в шапку слота добавляется узел компонента.
    const head = callArgs(slot, 'head.append(');
    assert.ok(head !== '', 'найден вызов head.append');
    assert.match(head, /title\.node\(\)/, 'в шапку слота монтируется узел компонента');
    // И это именно заголовочная позиция: между датой и кнопкой отмены.
    assert.match(
      head,
      /el\('span',\s*'diary-record-date',\s*fmtDate\(targetDay\)\),\s*title\.node\(\),\s*uiButton\(/,
      'узел компонента стоит на месте заголовка (между датой и «✕»)',
    );
    assert.ok(
      !/fieldInput|createElement|el\(\s*'input'|innerHTML/.test(head),
      'шапка слота не создаёт поле ввода локально',
    );
  });

  it('в `chronicle.ts` нет локального создания поля ввода (обход «разорванным» литералом)', () => {
    // Разорванный литерал класса (`'diary'+'-record-title'`) не спасёт: запрещено
    // само создание поля/узла ввода в экране, чем бы оно ни собиралось.
    assert.ok(!/fieldInput\(/.test(CHRONICLE), 'поле фасада `fieldInput` в экране не вызывается');
    assert.ok(!/el\(\s*['"]input['"]/.test(CHRONICLE), 'самодельного `el(\'input\')` нет');
    assert.ok(
      !/createElement\(\s*['"]input['"]/.test(CHRONICLE),
      'самодельного `createElement(\'input\')` нет',
    );
    // Класс заголовка — только у компонента: в экране не должно быть строки
    // класса в СКЛЕЙКЕ или литерале (страховка от «случайной» общности).
    assert.ok(
      !/['"]diary['"]\s*\+\s*['"]-record-title['"]/.test(CHRONICLE),
      'класс заголовка не собирается склейкой строк в экране',
    );
    assert.ok(!/RECORD_TITLE_INPUT_CLASS/.test(CHRONICLE), 'класс поля правки — только в компоненте');
  });

  it('контракт правки проверяется ИСПОЛНЕНИЕМ: Enter/Escape/blur (не текстом исходника)', async () => {
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

    // Enter — завершить и вернуть кнопку-группу.
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

    // Escape — отмена без коммита.
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

    // Blur — завершить (слот сохраняет черновик по уходу из поля).
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

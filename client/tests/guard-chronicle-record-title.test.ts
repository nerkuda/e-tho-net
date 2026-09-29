/**
 * Сторож единой реализации заголовка записи «Дневника» (0.10.2, ошибка
 * 36c330a3).
 *
 * Заголовок существующей карточки и заголовок слота создания ОБЯЗАН собирать
 * один компонент `screens/chronicle/record-title.ts` (`createRecordTitle`).
 * Раньше реализаций было две, и в слоте `Enter` не завершал правку — расхождение
 * возникло именно из-за копии разметки. Сторож краснеет, если в `chronicle.ts`
 * снова появится своё поле/кнопка заголовка или пропадёт проводка компонента.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');

function read(...parts: string[]): string {
  return readFileSync(resolve(RENDERER, ...parts), 'utf8');
}

const CHRONICLE = read('screens', 'chronicle', 'chronicle.ts');
const RECORD_TITLE = read('screens', 'chronicle', 'record-title.ts');

describe('сторож: один компонент заголовка записи (ошибка 36c330a3)', () => {
  it('оба потребителя собирают заголовок одним `createRecordTitle`', () => {
    const calls = CHRONICLE.match(/createRecordTitle\(/g) ?? [];
    assert.equal(calls.length, 2, 'карточка и слот — две проводки общего компонента');
    // Карточка: сборка `buildTitle` возвращает узел компонента.
    const buildTitle =
      /function buildTitle\(row: ChronicleRow, card: HTMLElement\): HTMLElement \{([\s\S]*?)\n\}/.exec(
        CHRONICLE,
      )?.[1] ?? '';
    assert.ok(buildTitle !== '', 'тело buildTitle найдено');
    assert.match(buildTitle, /return handle\.node\(\);/, 'карточка отдаёт узел компонента');
    // Слот: заголовок в состоянии слота — дескриптор компонента.
    assert.match(CHRONICLE, /title: RecordTitleHandle;/, 'слот хранит дескриптор компонента');
    assert.match(CHRONICLE, /state\.title\.beginEdit\(\)/, 'слот открывает заголовок в правке');
    assert.match(
      CHRONICLE,
      /void ensureSlot\(\{ title: next \}\)/,
      'завершение правки заголовка сохраняет черновик через `ensureSlot`',
    );
  });

  it('в `chronicle.ts` не осталось второй разметки поля заголовка', () => {
    assert.ok(
      !/RECORD_TITLE_INPUT_CLASS/.test(CHRONICLE),
      'класс поля правки заголовка объявляется и используется только компонентом',
    );
    assert.ok(
      !/fieldInput\(\{\s*extraClass:\s*'diary-record-title'/.test(CHRONICLE),
      'самодельного поля заголовка в слоте нет',
    );
    assert.ok(
      !/titleInput/.test(CHRONICLE),
      'прежнего `titleInput` слота нет — заголовком владеет компонент',
    );
  });

  it('контракт правки компонента: Enter — завершить, Escape — отменить, blur — завершить', () => {
    assert.match(
      RECORD_TITLE,
      /if \(event\.key === 'Enter'\) \{\s*event\.preventDefault\(\);\s*endEdit\(true, true\);/,
      'Enter завершает правку',
    );
    assert.match(
      RECORD_TITLE,
      /else if \(event\.key === 'Escape'\) \{\s*event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*endEdit\(false, true\);/,
      'Escape отменяет правку',
    );
    assert.match(RECORD_TITLE, /addEventListener\('blur', \(\) => endEdit\(true, false\)\)/);
    assert.match(
      RECORD_TITLE,
      /next\.maxLength = maxLength;/,
      'поле правки — ограниченной длины',
    );
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

/**
 * Автокомплит дат в едином дропдауне `[[` (0.16.1, задача 9ec9d72a; элемент
 * интерфейса f9da2100, ADR ef097fad).
 *
 * Проверяется контракт «что видно по вводу» — без DOM и без CodeMirror:
 *  - цифры/точки/дефисы открывают секцию «Даты» сверху, буквы — нет;
 *  - введённая дата предлагается ТОЛЬКО когда она существует (31.02.2026 и
 *    02.13.2026 молчат), подсказка формата `dd.mm.yyyy` → ISO;
 *  - выбор пункта вставляет полную ISO-форму и закрывает `]]`;
 *  - мысли уходят в отдельную секцию «Мысли» ниже дат.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Completion } from '@codemirror/autocomplete';

import {
  dateSuggestOptions,
  datesSection,
  isDatePrefix,
  thoughtsSection,
  typedDateIso,
  withThoughtsSection,
} from '../src/renderer/editor/date-suggest.js';

const TODAY = '2026-11-14';

test('isDatePrefix: цифры, точки и дефисы — дата; буквы и пробелы — нет', () => {
  for (const prefix of ['', '2', '2026', '02.11.', '2026-11-02', '...---']) {
    assert.equal(isDatePrefix(prefix), true, JSON.stringify(prefix));
  }
  for (const prefix of ['м', 'мыс', '2026-11-02a', ' 2026', '02/11/2026']) {
    assert.equal(isDatePrefix(prefix), false, JSON.stringify(prefix));
  }
});

test('typedDateIso: dd.mm.yyyy и ISO → ISO; несуществующие даты — null', () => {
  assert.equal(typedDateIso('02.11.2026'), '2026-11-02');
  assert.equal(typedDateIso('2.11.2026'), '2026-11-02', 'однозначные день/месяц допустимы');
  assert.equal(typedDateIso('2026-11-02'), '2026-11-02');
  assert.equal(typedDateIso('31.02.2026'), null, '31 февраля не существует');
  assert.equal(typedDateIso('02.13.2026'), null, 'месяца 13 нет');
  assert.equal(typedDateIso('2026-11-02 14:30'), null, 'дата со временем — не «введённая дата»');
  assert.equal(typedDateIso(''), null);
  assert.equal(typedDateIso('2026-11'), null);
});

test('секции: «Даты» выше «Мыслей» (ранг меньше)', () => {
  const dates = datesSection();
  const thoughts = thoughtsSection();
  assert.ok(dates.rank! < thoughts.rank!, 'даты показываются над мыслями');
  assert.ok(dates.name !== thoughts.name);
});

test('пустой префикс: сегодня и завтра, оба пункта закрывают скобки', () => {
  const options = dateSuggestOptions('', TODAY);
  assert.equal(options.length, 2);
  assert.equal(options[0]!.apply, `${TODAY}]]`);
  assert.equal(options[1]!.apply, '2026-11-15]]');
  for (const option of options) {
    assert.deepEqual(option.section, datesSection());
  }
});

test('введённая валидная дата добавляется третьим пунктом и вставляет ISO', () => {
  const options = dateSuggestOptions('02.11.2026', TODAY);
  assert.equal(options.length, 3);
  const typed = options[2]!;
  assert.equal(typed.apply, '2026-11-02]]', 'вставляется полная ISO-форма с закрытием');
  assert.match(String(typed.label), /02\.11\.2026/);
  assert.match(String(typed.detail), /ISO 2026-11-02/);
});

test('несуществующая дата не предлагается (список остаётся 2 пункта)', () => {
  assert.equal(dateSuggestOptions('31.02.2026', TODAY).length, 2);
  assert.equal(dateSuggestOptions('02.13.2026', TODAY).length, 2);
});

test('буквенный префикс: секции «Даты» нет вовсе', () => {
  assert.deepEqual(dateSuggestOptions('мыс', TODAY), []);
});

test('withThoughtsSection: при датах мысли уходят в свою секцию, иначе — без заголовка', () => {
  const thoughts: Completion[] = [{ label: 'Мысль', apply: 'Мысль]]' }];
  const sectioned = withThoughtsSection(thoughts, true);
  assert.equal(sectioned.length, 1);
  assert.deepEqual(sectioned[0]!.section, thoughtsSection());
  assert.equal(thoughts[0]!.section, undefined, 'исходный массив не мутируется');

  const plain = withThoughtsSection(thoughts, false);
  assert.equal(plain[0]!.section, undefined, 'буквенный ввод — без заголовка «Мысли»');
});

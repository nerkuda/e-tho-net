/**
 * Тесты парсера строк задач (0.16.1, ТП «Даты, задачи и напоминания»; задача
 * c4cc50f1, требование d957a49d, ADR «парсер строк задач — библиотечный
 * модуль» 20a62354).
 *
 * Проверяется ПОВЕДЕНИЕ публичного API `parseTaskLines` по всем ветвям
 * грамматики: чек-боксы, вложенность/подзадачи, date-ссылки (период/срок),
 * undated, отмена `- текст`, `closed`/`reopened` как текст, субъекты
 * `[[#uuid]]`. Грамматика чтения — единый рендерер, поэтому часть тестов
 * сверяет парсер с HTML `renderMarkdown` (один источник разбора `- [ ]`).
 *
 * Реалистичная фикстура — снимок реального комментария тестовой сети «Тест 1»
 * (etn-dev, публикация a29fd66f), нарезанный из `.etnx`:
 * `client/tests/fixtures/real-markdown/task-template.md` (первые строки —
 * вложенный чек-лист «задача/подзадача»). Нарезка скопирована сюда, чтобы
 * пакетный прогон не зависел от клиентских фикстур.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseTaskLines, renderMarkdown, type TaskLine } from '../src/index.js';

/** Строка выхода по индексу (с явной проверкой наличия). */
function row(rows: TaskLine[], index: number): TaskLine {
  const found = rows[index];
  assert.ok(found !== undefined, `нет строки с индексом ${index} (всего ${rows.length})`);
  return found;
}

/** Строки с чек-боксом. */
function checkboxRows(rows: TaskLine[]): TaskLine[] {
  return rows.filter((r) => r.hasCheckbox);
}

/**
 * Строки `- [ ]` внутри БЛОКА КОДА — код, а не задачи (требование @152@,
 * пачка 7). Корпус границ ограждений: парсер обязан читать ровно то, что
 * показал бы единый рендерер (своего разбора ограждений у него нет и быть не
 * должно — сторож `guard-task-line-grammar`).
 */
const CODE_BLOCK_CORPUS: Array<{ name: string; source: string; checkboxes: number[] }> = [
  {
    name: 'бэктики ```',
    source: ['```', '- [ ] в коде [[2026-11-01]]', '```', '', '- [ ] вне кода'].join('\n'),
    checkboxes: [5],
  },
  {
    name: 'тильды ~~~',
    source: ['~~~', '- [ ] в тильде', '~~~', '', '- [ ] вне кода'].join('\n'),
    checkboxes: [5],
  },
  {
    name: 'ограждение с отступом 1–3 пробела',
    source: ['   ```', '   - [ ] в сдвинутом блоке', '   ```', '', '- [ ] вне кода'].join('\n'),
    checkboxes: [5],
  },
  {
    name: 'закрывающее ограждение с отступом',
    source: ['```', '- [ ] в коде', '   ```', '', '- [ ] вне кода'].join('\n'),
    checkboxes: [5],
  },
  {
    name: '~~~ внутри ```-блока и наоборот',
    source: ['~~~', '```', '- [ ] внутри тильды', '```', '~~~', '', '- [ ] вне кода'].join('\n'),
    checkboxes: [7],
  },
  {
    name: '```` с внутренними ```',
    source: ['````', '```', '- [ ] в коде', '```', '````', '', '- [ ] вне кода'].join('\n'),
    checkboxes: [7],
  },
  {
    name: 'блок кода отступом в четыре пробела',
    source: ['Абзац', '', '    - [ ] в коде отступом', '', '- [ ] вне кода'].join('\n'),
    checkboxes: [5],
  },
  {
    // Пункт вложен в задачу: рендерер рисует ему чек-бокс, а проекция считает
    // его подзадачей (`isTask === false`) — это не строка кода и не задача.
    name: 'блок кода внутри пункта списка',
    source: ['- [ ] задача', '  ```', '  - [ ] код в пункте', '  ```', '  - [ ] пункт'].join('\n'),
    checkboxes: [1, 5],
  },
];

describe('parseTaskLines: строка `- [ ]` в блоке кода — не задача (@152@)', () => {
  for (const sample of CODE_BLOCK_CORPUS) {
    it(`${sample.name}: задача только вне блока, как в HTML рендерера`, () => {
      const rows = parseTaskLines(sample.source);
      const html = renderMarkdown(sample.source);
      const rendered = (html.match(/class="task-list-item-checkbox"/g) ?? []).length;
      assert.equal(
        checkboxRows(rows).length,
        rendered,
        'число чек-боксов парсера совпадает с разметкой единого рендерера',
      );
      assert.deepEqual(
        checkboxRows(rows).map((line) => line.lineNo),
        sample.checkboxes,
        'строки кода в чек-боксы не попали (номера строк — только настоящие)',
      );
    });
  }

  it('незакрытое ограждение тянется до конца комментария: задач после него нет', () => {
    const source = ['```', '- [ ] раз', '- [ ] два [[2026-11-02]]', '', '- [ ] три'].join('\n');
    assert.deepEqual(parseTaskLines(source), []);
    assert.equal(
      (renderMarkdown(source).match(/class="task-list-item-checkbox"/g) ?? []).length,
      0,
      'рендерер тоже не рисует чек-боксов',
    );
  });

  it('адресация toggle тоже не видит строку кода: номер строки не выдаётся', () => {
    // Панель и просмотр адресуют чекбоксы по `lineNo` из этого же разбора:
    // код-строки в выходе нет — значит, и адрес для записи не строится.
    const source = ['```', '- [ ] код', '```', '- [ ] настоящая'].join('\n');
    const rows = checkboxRows(parseTaskLines(source));
    assert.deepEqual(
      rows.map((r) => [r.lineNo, r.text]),
      [[4, 'настоящая']],
    );
  });
});

describe('parseTaskLines: грамматика чек-боксов', () => {
  it('открытый/закрытый чек-бокс, маркеры списков и нумерация', () => {
    const rows = parseTaskLines(
      [
        '- [ ] открытая',
        '- [x] закрытая',
        '- [X] закрытая заглавной',
        '* [ ] звёздочка',
        '+ [x] плюс',
        '1. [ ] нумерованная',
      ].join('\n'),
    );
    assert.equal(rows.length, 6);
    assert.deepEqual(
      rows.map((r) => [r.lineNo, r.hasCheckbox, r.done, r.isTask, r.text]),
      [
        [1, true, false, true, 'открытая'],
        [2, true, true, true, 'закрытая'],
        [3, true, true, true, 'закрытая заглавной'],
        [4, true, false, true, 'звёздочка'],
        [5, true, true, true, 'плюс'],
        [6, true, false, true, 'нумерованная'],
      ],
    );
  });

  it('не задача: code fence, блок кода отступом, экранирование, `- [ ]` без текста, середина строки, HTML-комментарий', () => {
    const rows = parseTaskLines(
      [
        '```',
        '- [ ] в коде',
        '```',
        '',
        '    - [ ] отступ в четыре пробела — блок кода',
        '',
        '\\- [ ] экранировано',
        '',
        '- [ ]',
        '',
        'Текст [ ] не задача',
        '',
        '<!-- - [ ] в комментарии -->',
      ].join('\n'),
    );
    // Единственная строка выхода — пункт `- [ ]` без текста: рендерер тоже НЕ
    // ставит чек-бокс (маркеру нужен пробел и содержимое), строка остаётся
    // обычным пунктом списка.
    assert.equal(rows.length, 1);
    assert.equal(row(rows, 0).hasCheckbox, false);
    assert.equal(row(rows, 0).isTask, false);
    assert.equal(row(rows, 0).text, '[ ]');
  });

  it('маркер задачи во ВТОРОМ абзаце пункта — задача, как в HTML рендерера', () => {
    const source = ['- текст', '', '  [ ] не в начале строки'].join('\n');
    const rows = parseTaskLines(source);
    assert.equal(rows.length, 1);
    assert.equal(row(rows, 0).lineNo, 1);
    assert.equal(row(rows, 0).text, 'текст');
    assert.equal(row(rows, 0).hasCheckbox, true);
    assert.equal(row(rows, 0).done, false);
    // Сверка с единым рендерером: он тоже считает пункт задачей.
    assert.match(
      renderMarkdown(source),
      /class="task-list-item-checkbox" type="checkbox" disabled/,
    );
  });

  it('число задач парсера совпадает с числом чек-боксов HTML рендерера', () => {
    const source = [
      '- [ ] a',
      '- [x] b',
      '- обычная',
      '- [ ] c [[2026-11-02]]',
      '  - [ ] подзадача',
      '',
      '```',
      '- [ ] не задача',
      '```',
      '',
      'Текст [x] не задача',
    ].join('\n');
    const rows = parseTaskLines(source);
    const html = renderMarkdown(source);
    const rendered = html.match(/class="task-list-item-checkbox"/g) ?? [];
    assert.equal(checkboxRows(rows).length, rendered.length);
    assert.equal(checkboxRows(rows).length, 4);
  });
});

describe('parseTaskLines: текст и вложенность', () => {
  it('снапшот текста: без маркера списка и чек-бокса, markdown-разметка сохранена', () => {
    const rows = parseTaskLines(
      '- [ ] Задача с **жирным**, `кодом` и [[#11111111-1111-4111-8111-111111111111|алиасом]] [[2026-11-02]]',
    );
    assert.equal(
      row(rows, 0).text,
      'Задача с **жирным**, `кодом` и [[#11111111-1111-4111-8111-111111111111|алиасом]] [[2026-11-02]]',
    );
    assert.deepEqual(row(rows, 0).subjects, ['11111111-1111-4111-8111-111111111111']);
  });

  it('многострочный пункт: текст с переводом строки, даты продолжения — той же строки', () => {
    const rows = parseTaskLines(
      ['- [ ] Задача', '  продолжение [[2026-11-02]]', '  - [ ] подзадача'].join('\n'),
    );
    assert.equal(rows.length, 2);
    assert.equal(row(rows, 0).lineNo, 1);
    assert.equal(row(rows, 0).text, 'Задача\nпродолжение [[2026-11-02]]');
    assert.equal(row(rows, 0).periodFrom, '2026-11-02');
    assert.equal(row(rows, 1).lineNo, 3);
    assert.equal(row(rows, 1).depth, 1);
    assert.equal(row(rows, 1).subtask, true);
    assert.equal(row(rows, 1).parentLineNo, 1);
  });

  it('реальная фикстура «Тест 1»: задача/подзадача/второй статус', () => {
    // Снимок реального комментария (см. шапку файла), строки 1–5.
    const source = [
      '# Шаблон заметки типа',
      '',
      '- [ ] задача',
      '  - [ ] подзадача',
      '- [ ] второй статус',
    ].join('\n');
    const rows = parseTaskLines(source);
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((r) => [
        r.lineNo,
        r.text,
        r.depth,
        r.hasCheckbox,
        r.isTask,
        r.subtask,
        r.parentLineNo,
      ]),
      [
        [3, 'задача', 0, true, true, false, null],
        [4, 'подзадача', 1, true, false, true, 3],
        [5, 'второй статус', 0, true, true, false, null],
      ],
    );
  });

  it('подзадача с собственной датой — самостоятельная задача', () => {
    const rows = parseTaskLines(
      ['- [ ] родитель [[2026-11-01]]', '  - [ ] с датой [[2026-11-02]] [[2026-11-05]]'].join('\n'),
    );
    const child = row(rows, 1);
    assert.equal(child.depth, 1);
    assert.equal(child.parentLineNo, 1);
    assert.equal(child.subtask, false);
    assert.equal(child.isTask, true);
    assert.equal(child.periodFrom, '2026-11-02');
    assert.equal(child.periodTo, '2026-11-05');
    assert.equal(child.due, '2026-11-05');
  });

  it('вложенный чек-бокс под обычным пунктом: родителя-задачи нет, undated — задача', () => {
    const rows = parseTaskLines(['- [ ] A', '- Заметки', '  - [ ] B'].join('\n'));
    const nested = row(rows, 2);
    assert.equal(nested.depth, 1);
    assert.equal(nested.parentLineNo, null);
    assert.equal(nested.subtask, false);
    assert.equal(nested.isTask, true);
    assert.equal(nested.undated, true);
  });

  it('цепочка вложенности: предок — ближайший пункт-задача, а не первый в документе', () => {
    const rows = parseTaskLines(['- [ ] A', '  - [ ] B', '    - [ ] C'].join('\n'));
    assert.deepEqual(
      rows.map((r) => [r.lineNo, r.depth, r.parentLineNo, r.subtask, r.isTask]),
      [
        [1, 0, null, false, true],
        [2, 1, 1, true, false],
        [3, 2, 2, true, false],
      ],
    );
  });

  it('свободный список: номера строк не сбиваются пустой строкой', () => {
    const rows = parseTaskLines(['- [ ] A', '', '- [x] B'].join('\n'));
    assert.deepEqual(
      rows.map((r) => [r.lineNo, r.text, r.done]),
      [
        [1, 'A', false],
        [3, 'B', true],
      ],
    );
  });

  it('список в цитате — обычные задачи верхнего уровня', () => {
    const rows = parseTaskLines('> - [ ] в цитате [[2026-11-02]]');
    assert.equal(rows.length, 1);
    assert.equal(row(rows, 0).depth, 0);
    assert.equal(row(rows, 0).isTask, true);
    assert.equal(row(rows, 0).periodFrom, '2026-11-02');
  });

  it('CRLF: номера строк и текст без `\\r`', () => {
    const rows = parseTaskLines('- [ ] A\r\n- [x] B\r\n');
    assert.deepEqual(
      rows.map((r) => [r.lineNo, r.text, r.done]),
      [
        [1, 'A', false],
        [2, 'B', true],
      ],
    );
  });

  it('абзац-«хвост» пункта после вложенного списка — текстовая строка, как в рендерере', () => {
    // Рендерер не считает «хвост» после вложенного списка задачей (маркер
    // `[ ]` в нём остаётся текстом); парсер читает тот же ответ и отдаёт
    // отдельную текстовую строку ради её date-ссылки.
    const source = ['- [ ] A', '  - [ ] B', '', '  [ ] хвост [[2026-11-04]]'].join('\n');
    const rows = parseTaskLines(source);
    assert.deepEqual(
      rows.map((r) => [r.lineNo, r.hasCheckbox, r.isTask, r.depth]),
      [
        [1, true, true, 0],
        [2, true, false, 1],
        [4, false, false, 0],
      ],
    );
    assert.equal(row(rows, 2).due, '2026-11-04');
    const html = renderMarkdown(source);
    assert.equal((html.match(/class="task-list-item-checkbox"/g) ?? []).length, 2);
    assert.match(html, /<p>\[ \] хвост/);
  });
});

describe('parseTaskLines: date-ссылки, период и срок', () => {
  it('несколько дат: период — первая..последняя, срок — последняя; время сохраняется', () => {
    const rows = parseTaskLines(
      '- [ ] Позвонить [[2026-11-05]] и [[2026-11-02]] — до [[2026-11-10 18:00]]',
    );
    const task = row(rows, 0);
    assert.deepEqual(task.dates, [
      { date: '2026-11-05', time: null },
      { date: '2026-11-02', time: null },
      { date: '2026-11-10', time: '18:00' },
    ]);
    assert.equal(task.periodFrom, '2026-11-05');
    assert.equal(task.periodTo, '2026-11-10');
    assert.equal(task.due, '2026-11-10');
    assert.equal(task.undated, false);
  });

  it('одна дата: from = to = due', () => {
    const rows = parseTaskLines('- [ ] Оплатить [[2026-11-02]]');
    assert.equal(row(rows, 0).periodFrom, '2026-11-02');
    assert.equal(row(rows, 0).periodTo, '2026-11-02');
    assert.equal(row(rows, 0).due, '2026-11-02');
  });

  it('дубль одной и той же даты в строке: обе сохранены, период не разъезжается', () => {
    const rows = parseTaskLines('- [ ] Дубль [[2026-11-05]] [[2026-11-05]]');
    const task = row(rows, 0);
    assert.equal(task.dates.length, 2);
    assert.equal(task.periodFrom, '2026-11-05');
    assert.equal(task.periodTo, '2026-11-05');
    assert.equal(task.due, '2026-11-05');
  });

  it('невалидная ISO-дата — legacy-ссылка по имени, а не date-ссылка', () => {
    const rows = parseTaskLines('- [ ] [[2026-13-45]] [[2026-1-2]] [[2026-11-02 14:30:00]]');
    const task = row(rows, 0);
    assert.deepEqual(task.dates, []);
    assert.equal(task.undated, true);
    assert.equal(task.due, null);
  });

  it('date-ссылки в коде и блоке кода не считаются', () => {
    const rows = parseTaskLines(
      ['- [ ] `[[2026-11-02]]` в коде', '', '```', '[[2026-11-03]]', '```'].join('\n'),
    );
    assert.equal(rows.length, 1);
    assert.deepEqual(row(rows, 0).dates, []);
  });

  it('без даты — undated, срок пуст', () => {
    const rows = parseTaskLines('- [ ] Без срока');
    const task = row(rows, 0);
    assert.equal(task.undated, true);
    assert.equal(task.periodFrom, null);
    assert.equal(task.periodTo, null);
    assert.equal(task.due, null);
  });
});

describe('parseTaskLines: не-задачные строки (вход task_row_dates)', () => {
  it('абзац без списка попадает в выход только ради date-ссылок', () => {
    const rows = parseTaskLines(
      [
        'Просто текст без дат',
        '',
        'Запись [[2026-11-02]] и [[#11111111-1111-4111-8111-111111111111]].',
      ].join('\n'),
    );
    assert.equal(rows.length, 1);
    const line = row(rows, 0);
    assert.equal(line.lineNo, 3);
    assert.equal(line.hasCheckbox, false);
    assert.equal(line.isTask, false);
    assert.deepEqual(line.dates, [{ date: '2026-11-02', time: null }]);
    assert.equal(line.due, '2026-11-02');
    assert.deepEqual(line.subjects, ['11111111-1111-4111-8111-111111111111']);
  });

  it('отмена `- текст` без чек-бокса: строка остаётся, задача — нет, даты собираются', () => {
    const rows = parseTaskLines(
      ['- [ ] A', '- Отменённая [[2026-11-02]] [[#11111111-1111-4111-8111-111111111111]]'].join(
        '\n',
      ),
    );
    const cancelled = row(rows, 1);
    assert.equal(cancelled.hasCheckbox, false);
    assert.equal(cancelled.done, false);
    assert.equal(cancelled.isTask, false);
    assert.equal(cancelled.subtask, false);
    assert.equal(cancelled.due, '2026-11-02');
    assert.deepEqual(cancelled.subjects, ['11111111-1111-4111-8111-111111111111']);
  });

  it('заголовок и ячейка таблицы с date-ссылками дают строки (строка ячейки — строка tr)', () => {
    const rows = parseTaskLines(
      [
        '## События [[2026-11-07]]',
        '',
        'Запись [[2026-11-02]] и [[#11111111-1111-4111-8111-111111111111]].',
        '',
        '| A | B |',
        '|---|---|',
        '| [[2026-11-08]] | x |',
      ].join('\n'),
    );
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((r) => [r.lineNo, r.hasCheckbox, r.isTask]),
      [
        [1, false, false],
        [3, false, false],
        [7, false, false],
      ],
    );
    assert.equal(row(rows, 0).due, '2026-11-07');
    assert.equal(row(rows, 1).due, '2026-11-02');
    assert.equal(row(rows, 2).due, '2026-11-08');
  });

  it('документ без списков и дат — пустой выход', () => {
    assert.deepEqual(parseTaskLines('# Заголовок\n\nПросто текст.'), []);
  });
});

describe('parseTaskLines: субъекты строки — только ID-ссылки', () => {
  it('`[[#uuid]]` и `[[#uuid|алиас]]`; legacy-имя, битый id и межсетевая ссылка не собираются', () => {
    const rows = parseTaskLines(
      [
        '- [ ] Встреча с [[#AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA|Братом]]',
        '  и [[#bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb]], ',
        '  повтор [[#aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa]], ',
        '  legacy [[Брат]], битый [[#not-a-uuid]], межсетевой [[n:22222222-2222-4222-8222-222222222222#33333333-3333-4333-8333-333333333333]]',
      ].join('\n'),
    );
    assert.equal(rows.length, 1);
    assert.deepEqual(row(rows, 0).subjects, [
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ]);
  });

  it('субъекты второго абзаца пункта принадлежат той же строке (без повторов)', () => {
    const rows = parseTaskLines(
      [
        '- [ ] A [[#11111111-1111-4111-8111-111111111111]]',
        '',
        '  Хвост [[#11111111-1111-4111-8111-111111111111]] [[#22222222-2222-4222-8222-222222222222]]',
      ].join('\n'),
    );
    assert.equal(rows.length, 1);
    assert.deepEqual(row(rows, 0).subjects, [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ]);
  });
});

describe('parseTaskLines: состояние, дубли и границы API', () => {
  it('`closed`/`reopened` в тексте — обычный текст, состояние задаёт только чек-бокс', () => {
    const rows = parseTaskLines(
      ['- [ ] closed — вернуть к жизни', '- [x] reopened — уже сделано'].join('\n'),
    );
    assert.equal(row(rows, 0).done, false);
    assert.equal(row(rows, 0).text, 'closed — вернуть к жизни');
    assert.equal(row(rows, 1).done, true);
    assert.equal(row(rows, 1).text, 'reopened — уже сделано');
  });

  it('дубли строк разрешены: каждая строка — своя задача', () => {
    const rows = parseTaskLines(['- [ ] повторить', '- [ ] повторить'].join('\n'));
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((r) => [r.lineNo, r.text]),
      [
        [1, 'повторить'],
        [2, 'повторить'],
      ],
    );
  });

  it('пустой и пробельный body_md — пустой выход', () => {
    assert.deepEqual(parseTaskLines(''), []);
    assert.deepEqual(parseTaskLines('\n\n   \n'), []);
  });

  it('не строка — исключение', () => {
    assert.throws(() => parseTaskLines(null as unknown as string), /must be a string/);
    assert.throws(() => parseTaskLines(42 as unknown as string), /must be a string/);
  });
});

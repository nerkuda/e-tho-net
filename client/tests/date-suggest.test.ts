/**
 * Автокомплит дат в едином дропдауне `[[` (0.16.1, задача 9ec9d72a; элемент
 * интерфейса f9da2100, ADR ef097fad).
 *
 * Проверяется контракт «что видно по вводу» — без DOM и без CodeMirror:
 *  - цифры/точки/дефисы открывают секцию «Даты» сверху, буквы — нет;
 *  - введённая дата предлагается ТОЛЬКО когда она существует (31.02.2026 и
 *    02.13.2026 молчат), подсказка формата `dd.mm.yyyy` → ISO;
 *  - выбор пункта вставляет полную ISO-форму и закрывает `]]`;
 *  - мысли уходят в отдельную секцию «Мысли» ниже дат;
 *  - источники `[[` (`wikiLinkCompletionSources`) на цифрах/дефисах отдают
 *    «Даты» с `filter: false` (иначе FuzzyMatcher CM6 отбросил бы метки дат),
 *    на буквах — только мысли; пустой префикс после `[[` достижим.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Completion, CompletionContext, CompletionSource } from '@codemirror/autocomplete';

import {
  dateSuggestOptions,
  datesSection,
  isDatePrefix,
  thoughtsSection,
  typedDateIso,
  withThoughtsSection,
} from '../src/renderer/editor/date-suggest.js';
import {
  wikiLinkCompletionSources,
  wikiLinkInternals,
  wikiPrefixAt,
} from '../src/renderer/editor/wiki-link.js';
import { store } from '../src/renderer/state.js';

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

// ---------------------------------------------------------------------------
// Источник автокомплита `[[` (wiki-link.ts): «Даты» + «Мысли» в одном дропдауне
// ---------------------------------------------------------------------------

/**
 * Контекст автокомплита: источникам нужны только `pos` и `state.doc.lineAt` —
 * полноценный `CompletionContext` требует EditorView, а контракт источника
 * (что видно по вводу) от вида не зависит.
 */
function contextAt(doc: string): CompletionContext {
  return {
    pos: doc.length,
    state: { doc: { lineAt: () => ({ from: 0, text: doc }) } },
  } as unknown as CompletionContext;
}

/** Подменить мост `etn` поиском мыслей; возвращает журнал запросов. */
function installSearch(titles: readonly string[]): string[] {
  const queries: string[] = [];
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  (globalThis as any).etn = {
    thoughts: {
      search: async (_networkId: string, req: { q: string }) => {
        queries.push(req.q);
        return {
          by_names: titles.map((title, index) => ({ thought_id: `id-${index}`, title })),
        };
      },
    },
  };
  return queries;
}

/** Источники дропдауна в порядке регистрации: [даты, мысли, трансклюзия]. */
function sources(): readonly CompletionSource[] {
  return wikiLinkCompletionSources();
}

test('wikiPrefixAt: пустой префикс после `[[` — валидное состояние дропдауна', () => {
  assert.deepEqual(wikiPrefixAt('текст [['), { open: 6, prefix: '' });
  assert.deepEqual(wikiPrefixAt('[['), { open: 0, prefix: '' });
  // Закрытая/алиасная форма по-прежнему не префикс, и `![[` — трансклюзия.
  assert.equal(wikiPrefixAt('[[Имя]]'), null);
  assert.deepEqual(wikiPrefixAt('![[abc'), { open: 1, prefix: 'abc', transclusion: true });
});

test('источник дат: цифры/дефисы — секция «Даты» НЕ фильтруется FuzzyMatcher', async () => {
  store.update({ networkId: 'n1' });
  installSearch(['Мысль']);

  for (const prefix of ['2', '2026-', '2026-11', '2026-11-02', '14.11', '']) {
    const dateResult = await sources()[0]!(contextAt(`[[${prefix}`));
    assert.ok(dateResult !== null, `префикс ${JSON.stringify(prefix)} показывает даты`);
    assert.equal(
      dateResult.filter,
      false,
      'кандидатов отобрал date-suggest — FuzzyMatcher CM6 их метки не переживут',
    );
    assert.ok(dateResult.options.length >= 2, 'сегодня и завтра всегда в секции дат');
    for (const option of dateResult.options) {
      assert.deepEqual(option.section, datesSection(), 'пункты дат — в секции «Даты»');
      assert.match(String(option.apply), /^\d{4}-\d{2}-\d{2}\]\]$/, 'вставка ISO + закрытие');
    }
  }
});

test('источник дат: ввод полной даты добавляет третий пункт «введённая дата»', async () => {
  store.update({ networkId: 'n1' });
  installSearch([]);
  const dateResult = await sources()[0]!(contextAt('[[2026-11-02'));
  assert.equal(dateResult?.options.length, 3);
  assert.equal(dateResult!.options[2]!.apply, '2026-11-02]]');
});

test('источник дат: буквы дат не показывают (ADR ef097fad)', async () => {
  store.update({ networkId: 'n1' });
  installSearch(['Брат']);
  assert.equal(await sources()[0]!(contextAt('[[бр')), null);
});

test('источник мыслей: в датном режиме мысли уходят в секцию «Мысли» ниже дат', async () => {
  store.update({ networkId: 'n1' });
  installSearch(['Мысль']);

  const dates = await sources()[0]!(contextAt('[[2026-11'));
  const thoughts = await sources()[1]!(contextAt('[[2026-11'));
  assert.ok(dates !== null && thoughts !== null);
  assert.equal(thoughts.options.length, 1);
  assert.deepEqual(thoughts.options[0]!.section, thoughtsSection());
  assert.ok(datesSection().rank! < thoughtsSection().rank!, 'даты выше мыслей');

  const letters = await sources()[1]!(contextAt('[[бр'));
  assert.equal(
    letters!.options[0]!.section,
    undefined,
    'буквы — единственный список без заголовков',
  );
});

test('пустой префикс: секция «Даты» есть, поиск мыслей не запрашивается', async () => {
  store.update({ networkId: 'n1' });
  const queries = installSearch(['Мысль']);

  const dates = await sources()[0]!(contextAt('[['));
  const thoughts = await sources()[1]!(contextAt('[['));
  assert.ok(dates !== null && dates.options.length >= 2, 'даты доступны сразу после `[[`');
  assert.equal(thoughts, null, 'пустой префикс мыслей не предлагает');
  assert.deepEqual(queries, [], 'по пустому префиксу сервер не ищется (хвост задачи 5)');
});

test('загрузчик подсказок: пустой префикс не зовёт thoughts.search', async () => {
  const queries = installSearch(['Мысль']);
  assert.deepEqual(await wikiLinkInternals.loadCompletions('n1', ''), []);
  assert.deepEqual(queries, [], 'пустая строка поиска на сервер не уходит');
  const hits = await wikiLinkInternals.loadCompletions('n1', 'Мыс');
  assert.equal(hits.length, 1, 'непустой префикс ищется как раньше');
  assert.deepEqual(queries, ['Мыс']);
});

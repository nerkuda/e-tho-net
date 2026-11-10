/**
 * Unit tests for the mentions matching helpers: `splitCompoundTitle`
 * (docs/08-ui-spec.md §2.2.3) and the §21 scan prefilter primitives
 * (`foldCase`, `splitMentionWords`, `mentionPrefilterMarkers`,
 * `mentionPrefilterPass`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  foldCase,
  mentionPrefilterMarkers,
  mentionPrefilterPass,
  regexEscape,
  splitCompoundTitle,
  splitMentionWords,
  synonymPatternToRegex,
  synonymWordPatternMatch,
} from '../src/mentions.js';

describe('splitCompoundTitle (08-ui-spec §2.2.3)', () => {
  it('a title without dots is a single part', () => {
    assert.deepEqual(splitCompoundTitle('Проект А'), ['Проект А']);
  });

  it('a comma no longer splits — it is just punctuation now', () => {
    assert.deepEqual(splitCompoundTitle('Процесс, запущенный из-вне'), [
      'Процесс, запущенный из-вне',
    ]);
  });

  it('splits at dots and trims the parts', () => {
    assert.deepEqual(splitCompoundTitle('Воронеж.Гостиницы.Столичная'), [
      'Воронеж',
      'Гостиницы',
      'Столичная',
    ]);
  });

  it('spaces around a dot are insignificant', () => {
    assert.deepEqual(
      splitCompoundTitle('Москва .   Гостиницы'),
      splitCompoundTitle('Москва.Гостиницы'),
    );
    assert.deepEqual(splitCompoundTitle('Москва.Гостиницы'), ['Москва', 'Гостиницы']);
  });

  it('everything after the 3rd dot is one part', () => {
    assert.deepEqual(splitCompoundTitle('a.b.c.d'), ['a', 'b', 'c', 'd']);
    assert.deepEqual(splitCompoundTitle('a.b.c.d.e'), ['a', 'b', 'c', 'd.e']);
  });

  it('a maxParts override changes how many dots are significant', () => {
    assert.deepEqual(splitCompoundTitle('a.b.c', 2), ['a', 'b.c']);
  });

  it('a quoted part is atomic — dots inside it do not split, quotes are dropped', () => {
    assert.deepEqual(splitCompoundTitle('Аптеки."Столичка.net"'), ['Аптеки', 'Столичка.net']);
  });

  it('a fully quoted title is a single part, quotes dropped', () => {
    assert.deepEqual(splitCompoundTitle('"ПриходнаяНакладная.МодульМенеджера.Провести()"'), [
      'ПриходнаяНакладная.МодульМенеджера.Провести()',
    ]);
  });

  it('single quotes protect the same way as double quotes', () => {
    assert.deepEqual(splitCompoundTitle("Аптеки.'Столичка.net'"), ['Аптеки', 'Столичка.net']);
  });

  it('an unpaired quote makes everything from it to the end one final part', () => {
    assert.deepEqual(splitCompoundTitle(`Выводы."Все.Никаких выводов.'(С)'`), [
      'Выводы',
      `Все.Никаких выводов.'(С)'`,
    ]);
  });

  it('an unpaired quote at the very start makes the whole title one part', () => {
    assert.deepEqual(splitCompoundTitle('"Не закрыта.Всё одна часть'), [
      'Не закрыта.Всё одна часть',
    ]);
  });

  it('empty parts are dropped', () => {
    assert.deepEqual(splitCompoundTitle('Проект..Задача'), ['Проект', 'Задача']);
    assert.deepEqual(splitCompoundTitle('.Проект'), ['Проект']);
  });
});

describe('foldCase — agreement with the iu regex (simple case folding)', () => {
  it('equates the classic toLowerCase/simple-folding divergences the regex matches', () => {
    // For each pair the `iu` regex (simple case folding) treats both sides
    // as equal while plain toLowerCase() does not; the prefilter compares
    // foldCase() on both sides, so they must collapse to the same key.
    const pairs: Array<[string, string]> = [
      ['ς', 'σ'], // Greek final sigma
      ['ſ', 's'], // Latin long s
      ['µ', 'μ'], // micro sign vs Greek mu
      ['ẞ', 'ß'], // capital sharp S (toLowerCase already agrees)
      ['ϐ', 'β'], ['ϑ', 'θ'], ['ϕ', 'φ'], ['ϖ', 'π'], ['ϰ', 'κ'], ['ϱ', 'ρ'], ['ϵ', 'ε'],
      ['ẛ', 'ṡ'],
    ];
    for (const [a, b] of pairs) {
      assert.equal(foldCase(a), foldCase(b), `${a} must fold to ${b}`);
      assert.ok(
        new RegExp(regexEscape(b), 'iu').test(a),
        `the iu regex must equate ${a} and ${b} (otherwise the pair is not a divergence)`,
      );
    }
  });

  it('lowercases like toLowerCase for regular text', () => {
    assert.equal(foldCase('Проект ETN-42 и Прочее'), 'проект etn-42 и прочее');
  });

  it('upper-case counterparts fold to the same key', () => {
    assert.equal(foldCase('ΣΟΦΟΣ'), foldCase('σοφος'));
    assert.equal(foldCase('WASSER'), foldCase('Wasser'));
  });
});

describe('splitMentionWords — same word class as the pattern boundaries', () => {
  it('keeps letters, digits and underscore; everything else separates', () => {
    assert.deepEqual(splitMentionWords('see ProjectX, «Проект А» и foo_bar!'), [
      'see',
      'ProjectX',
      'Проект',
      'А',
      'и',
      'foo_bar',
    ]);
  });

  it('returns [] when there are no word characters', () => {
    assert.deepEqual(splitMentionWords('— !!! … —'), []);
  });
});

describe('mentionPrefilterMarkers + mentionPrefilterPass', () => {
  const pass = (synonym: string, text: string): boolean => {
    const markers = mentionPrefilterMarkers(synonym);
    return mentionPrefilterPass(markers, foldCase(text), new Set(splitMentionWords(text).map(foldCase)));
  };

  it('a plain literal word is a word marker: present token passes, absent fails', () => {
    assert.ok(pass('Проект', 'обсудили Проект вчера'));
    assert.ok(!pass('Проект', 'обсудили проектантство')); // no standalone token
    assert.ok(!pass('Проект', 'ПроектА')); // glued into a longer token
  });

  it('a multi-word literal requires every word token, adjacency still left to the regex', () => {
    assert.ok(pass('Игорь Петров', 'Игорь и Петров разъехались')); // false positive is fine
    assert.ok(!pass('Игорь Петров', 'Игорь и Пётр'));
  });

  it('a word with separator characters becomes a substring marker', () => {
    // 'C++' cannot be a word marker: the tokenizer splits it into 'C'.
    assert.ok(pass('C++', 'написан на C++ отлично'));
    assert.ok(!pass('C++', 'написан на C#'));
    assert.ok(pass('d.e', 'значение d.e указано'));
    assert.ok(!pass('d.e', 'значение d-x-e указано'));
  });

  it('wildcard words contribute folded substring chunks', () => {
    assert.ok(pass('Петров* Игор*', 'встретил Петровым Игорем'));
    assert.ok(!pass('Петров* Игор*', 'встретил Сидоровым Игорем'));
    assert.ok(pass('И*гор*', 'Игорь'));
    assert.ok(!pass('И*гор*', 'Олег'));
  });

  it('case folding is applied to both sides (ς/ſ/µ markers still pass)', () => {
    // The pattern word ends with final sigma ς, the text word with regular σ
    // (and vice versa for µ/μ): foldCase must equate both sides exactly like
    // the iu regex does, or the prefilter would reject a true match.
    assert.ok(pass('σοφος', 'сказал σοφοσ'));
    assert.ok(pass('Wasser', 'выпил Waſſer')); // long s in text
    assert.ok(pass('μs', 'заняло 5 µs всего')); // micro sign in text
  });

  it('a pattern without literal markers always passes (conservative)', () => {
    assert.ok(pass('*', 'любой текст'));
    assert.ok(pass('', 'любой текст'));
  });

  it('the prefilter never rejects what synonymPatternToRegex matches (spot checks)', () => {
    const cases: Array<[string, string]> = [
      ['ProjectX', 'see ProjectX for details'],
      ['C++', 'написан на C++, работает'],
      ['d.e', 'пункт d.e готов'],
      ['Waſſer', 'das Wasser'], // folding in the other direction: ſ in the pattern
      ['σbiz', '5 ςbiz ток'], // folded chunk vs folded text
    ];
    for (const [synonym, text] of cases) {
      const re = new RegExp(synonymPatternToRegex(synonym).source, 'iug');
      assert.ok(re.test(text), `regex must match: ${synonym} in ${text}`);
      assert.ok(pass(synonym, text), `prefilter must pass a matching pair: ${synonym} in ${text}`);
    }
  });
});

describe('synonymPatternToRegex — `*`-синонимы: словоформа и ровное вхождение (ошибка 3ebb6512)', () => {
  /** Текст совпадения: обе границы слова в матчере нулевой ширины. */
  const span = (synonym: string, text: string): string | null => {
    const m = synonymPatternToRegex(synonym).exec(text);
    return m === null ? null : m[0];
  };

  it('`*` разворачивается в словоформу (сценарий упоминаний)', () => {
    // Синонимы заказчика из карточки 3ebb6512.
    assert.equal(span('Пасечн*', 'Поздравление Пасечного 2026'), 'Пасечного');
    assert.equal(span('Пасечн*', 'Как сказал сам Пасечный'), 'Пасечный');
    assert.equal(span('Виктор*', 'Созвон с Виктором'), 'Виктором');
    assert.equal(span('виктор* иванович*', 'Виктор Иванович ответил'), 'Виктор Иванович');
    assert.equal(span('виктор* иванович*', 'Виктором Ивановичем ответил'), 'Виктором Ивановичем');
    assert.equal(span('Пасечн*', 'ПАСЕЧНОГО поздравили'), 'ПАСЕЧНОГО', 'регистронезависимо');
  });

  it('граница слова держится: чужие слова не матчатся', () => {
    assert.equal(span('Пасечн*', 'непасечный текст'), null);
    assert.equal(span('Пасечн*', 'Пасечный65 в начале слова не подходит'), 'Пасечный65');
    assert.equal(span('Виктор*', 'Виктория пришла'), 'Виктория', 'та же словоформа — законно');
    assert.equal(span('Виктор*', 'инвиктор'), null);
  });

  it('подчёркивается ровно вхождение: завершающая пунктуация остаётся снаружи', () => {
    assert.equal(span('Пасечн*', 'Это пасечный? спросил он'), 'пасечный');
    assert.equal(span('Пасечн*', 'Пасечный, Виктор — оба пришли'), 'Пасечный');
    assert.equal(
      span('виктор* иванович*', 'Спросил Виктор Иванович, потом ушёл'),
      'Виктор Иванович',
    );
    assert.equal(span('Пасечн*', 'встретил Пасечного… и забыл'), 'Пасечного');
    assert.equal(span('Пасечн*', '«Пасечный» в кавычках'), 'Пасечный');
  });

  it('`*` не пересекает границу слова: цифры и `_` — часть слова', () => {
    // 02-data-model §3.2: граница — не буква, не цифра, не `_`.
    assert.equal(span('Пасечн*', 'отчёт Пасечный65 сдан'), 'Пасечный65');
    assert.equal(span('Пасечн*', 'отчёт Пасечный-65 сдан'), 'Пасечный', 'дефис — граница слова');
  });

  it('слова многословного синонима обязаны стоять подряд', () => {
    assert.equal(span('Пасечн* Виктор*', 'пришёл Пасечный Виктор'), 'Пасечный Виктор');
    assert.equal(
      span('Пасечн* Виктор*', 'Пасечный, Виктор — оба пришли'),
      null,
      'пунктуация между словами рвёт фразу (каждое слово находится своими синонимами)',
    );
  });
});

describe('synonymWordPatternMatch — сценарий «поиск» (требование 35218826)', () => {
  it('слово запроса совпадает с ОДНИМ словом `*`-синонима по границам слова', () => {
    // DoD задачи f0b06700: словоформа длиннее паттерна совпадает.
    assert.ok(synonymWordPatternMatch('проектирование', 'проектиров* функциональност*'));
    assert.ok(synonymWordPatternMatch('функциональности', 'проектиров* функциональност*'));
    assert.ok(synonymWordPatternMatch('новая', 'дизайн* нов* фич*'));
    assert.ok(synonymWordPatternMatch('функциональность', 'дизайн* нов* фич*') === false);
    // Паттерн не пересекает границу слова: хвост чужого слова не подходит.
    assert.equal(synonymWordPatternMatch('ектир', 'проектиров*'), false);
    assert.equal(synonymWordPatternMatch('проектирование', 'тиров*'), false);
    // `\S*` не пересекает пробел: многословный синоним — это набор отдельных
    // слов-паттернов, каждое слово запроса матчится независимо.
    assert.equal(
      synonymWordPatternMatch('проектиров функциональност', 'проектиров* функциональност*'),
      false,
    );
  });

  it('`*` в конце/середине и пустые чанки', () => {
    assert.ok(synonymWordPatternMatch('ёжик', 'ёж*'));
    assert.ok(synonymWordPatternMatch('новость', 'нов*ть'));
    assert.ok(synonymWordPatternMatch('счетчик', 'сч*т*к'));
    // Одиночная `*` соответствует любому одному слову.
    assert.ok(synonymWordPatternMatch('чтоугодно', '*'));
  });

  it('синоним без `*` не матчится — литеральную ветку держит вызывающий', () => {
    assert.equal(synonymWordPatternMatch('roadmap', 'roadmap'), false);
    assert.equal(synonymWordPatternMatch('', 'нов*'), false);
    assert.equal(synonymWordPatternMatch('нов', ''), false);
  });

  it('нормализация NFC+lowercase с обеих сторон (D6)', () => {
    assert.ok(synonymWordPatternMatch('ПРОЕКТИРОВАНИЕ', 'проектиров*'));
    assert.ok(synonymWordPatternMatch('проектирование'.normalize('NFD'), 'проектиров*'));
    assert.ok(synonymWordPatternMatch('ёжик', 'ЁЖ*'.normalize('NFC').toLowerCase()));
  });
});

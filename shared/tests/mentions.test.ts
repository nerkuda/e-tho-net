/**
 * Unit tests for `splitCompoundTitle` (docs/08-ui-spec.md §2.2.3): dot
 * delimiter, quote protection, unpaired-quote fallback.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { splitCompoundTitle } from '../src/mentions.js';

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

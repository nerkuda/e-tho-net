/**
 * Настройки строки поиска карты — свои у каждой мыслесети (ошибка 438092f6).
 *
 * Контракт:
 *  - хранилище уже per-network: L4 `ui_state` адресуется
 *    `(профиль, network_id, ключ)`, поэтому и `search_state`, и
 *    `search_settings_open` читаются и пишутся С network_id;
 *  - при перемонтировании рабочего пространства (смена сети / вкладки)
 *    модульное состояние строки поиска сбрасывается — иначе настройки одной
 *    сети («Ограничивать потомками мыслей» + мысль и прочее) видны в другой,
 *    а флаг `restored` не даёт прочитать сохранённое состояние новой сети;
 *  - сеть без своей записи получает дефолт, а не чужие настройки;
 *  - ранее сохранённые записи каждой сети не теряются и читаются как прежде
 *    (в т.ч. легаси-формат `subrootId` до 0.8.2).
 *
 * Клиентские тесты идут без jsdom, поэтому чистая логика проверяется напрямую,
 * а сброс модульного состояния — по якорям исходника (конвенция соседних
 * тестов, см. `search-settings-zone.test.ts`).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  defaultSearchCriteriaState,
  parseSearchCriteria,
  searchCriteriaToStored,
} from '../src/renderer/lib/filter-builder.js';

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');
const SEARCH_TS = resolve(RENDERER, 'search', 'search.ts');

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('модульное состояние строки поиска сбрасывается при монтировании (ошибка 438092f6)', () => {
  it('`mountSearch` начинается со сброса — прежняя сеть не переживает пересборку', () => {
    const search = readText(SEARCH_TS);
    assert.match(
      search,
      /export function mountSearch\(next: SearchChrome\): \(\) => void \{\s*(?:\/\/[^\n]*\n\s*)*resetSearchState\(\);/,
      'сброс модульного состояния — первое действие `mountSearch`, до работы с DOM',
    );
  });

  it('сброс обнуляет настройки, флаг восстановления, карты подкорней — но НЕ отложенную запись', () => {
    const search = readText(SEARCH_TS);
    const body = search.match(/function resetSearchState\(\): void \{([\s\S]*?)\n\}/)?.[1] ?? '';
    assert.ok(body !== '', 'функция сброса объявлена');
    assert.match(body, /options = defaultSearchCriteriaState\(\);/, 'настройки — свежий дефолт');
    assert.ok(
      !/options = \{ \.\.\.DEFAULT_OPTIONS \}/.test(body),
      'дефолт берётся свежим вызовом, а не общей константой (иначе массивы подкорней делятся между сетями)',
    );
    assert.match(body, /settingsOpen = false;/, 'лейка сброшена');
    assert.match(body, /restored = false;/, 'снят флаг «состояние уже прочитано»');
    assert.match(body, /lastResults = null;/, 'прошлые результаты не переживают смену сети');
    assert.match(body, /lastSelectedKey = null;/, 'выбранный хит сброшен');
    assert.match(body, /cursor = null;/, 'клавиатурный курсор сброшен');
    assert.match(body, /subrootClouds\.clear\(\);/, 'облачка подкорней прошлой сети сняты');
    assert.match(body, /subrootCloudsRequested\.clear\(\);/, 'реестр догрузки подкорней снят');
    assert.match(body, /window\.clearTimeout\(searchTimer\)/, 'таймер поиска снят');
    // Ключевое (замечание верификатора): отложенную запись сохранения сброс НЕ
    // отменяет — она досылает настройку в свою (старую) сеть.
    assert.ok(
      !body.includes('persistTimer') && !body.includes('persistWriter'),
      'сброс не трогает отложенную запись — иначе «изменил и сразу ушёл» теряет настройку',
    );
  });

  it('сохранение идёт через отложенную запись, фиксирующую сеть и payload при планировании', () => {
    const search = readText(SEARCH_TS);
    assert.match(
      search,
      /createDebouncedWriter\(\(networkId, payload\)/,
      'используется общий помощник отложенной записи (сеть/payload фиксируются сразу)',
    );
    assert.match(
      search,
      /persistWriter\.schedule\(\s*networkId,/,
      'планирование привязано к id сети',
    );
  });
});

describe('хранилище настроек уже адресуется сетью (ошибка 438092f6)', () => {
  it('`search_state` читается и пишется с `networkId`', () => {
    const search = readText(SEARCH_TS);
    assert.match(
      search,
      /etn\.ui\s*\.getState\(networkId, UI_STATE_KEY\.SEARCH_STATE\)/,
      'состояние отбора читается по ключу сети',
    );
    assert.match(
      search,
      /etn\.ui\s*\.setState\(\s*networkId,\s*UI_STATE_KEY\.SEARCH_STATE,/,
      'состояние отбора пишется по ключу сети',
    );
  });
});

describe('дефолт для сети без своей записи (ошибка 438092f6)', () => {
  it('пустой/мусорный вход даёт пустые настройки, а не чужие', () => {
    const empty = defaultSearchCriteriaState();
    assert.equal(empty.subtree, false, 'ограничение потомками выключено');
    assert.deepEqual(empty.subrootIds, [], 'мысли-подкорни пусты');
    for (const raw of [null, undefined, 'мусор', 42, [], {}]) {
      assert.deepEqual(parseSearchCriteria(raw), empty, `«${String(raw)}» → дефолт`);
    }
  });
});

describe('ранее сохранённые записи не теряются (ошибка 438092f6)', () => {
  it('запись сети читается обратно без потерь', () => {
    const saved = searchCriteriaToStored({
      ...defaultSearchCriteriaState(),
      subtree: true,
      subrootIds: ['11111111-1111-4111-8111-111111111111'],
    });
    const parsed = parseSearchCriteria(saved);
    assert.equal(parsed.subtree, true, 'флажок сохранён');
    assert.deepEqual(
      parsed.subrootIds,
      ['11111111-1111-4111-8111-111111111111'],
      'выбранная мысль-подкорень сохранена',
    );
  });

  it('легаси-формат до 0.8.2 (`subrootId`) читается как набор', () => {
    const parsed = parseSearchCriteria({
      subtree: true,
      subrootId: '22222222-2222-4222-8222-222222222222',
    });
    assert.equal(parsed.subtree, true, 'старый флажок учтён');
    assert.deepEqual(
      parsed.subrootIds,
      ['22222222-2222-4222-8222-222222222222'],
      'одиночный `subrootId` прошлых версий → набор из одной мысли',
    );
  });
});

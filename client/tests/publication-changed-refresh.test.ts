/**
 * Реактивность публикации и поведение диалога обложки после замечаний приёмки
 * b02ef1cf (А/В) — в терминах реактивного слоя данных (G4 тех.проекта 269016e2).
 *
 * Прежний локальный канал `lib/publication-events` снесён: своё realtime-эхо
 * подавлено, поэтому источник (карточка редактора) после REST-ответа кладёт
 * снимок в нормализованный кэш (`commitEntity`) и гасит ключи слоя
 * (`invalidateAfterMutation`). Подписчики — библиотека (`publications-list`) и
 * рабочая область (`pub-card`/`pub-assembly`) — реагируют единым кэш-путём.
 *
 * Здесь — дешёвые и устойчивые проверки: слой оповещает подписчиков о правке
 * публикации и ЯКОРЯ проводки в исходниках; поведение (точечное обновление DOM,
 * диалог обложки) проверяется живой пробой на стенде и в отчёте карточки.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { Publication } from '@etn/shared';

import {
  commitEntity,
  getEntity,
  invalidateAfterMutation,
  onQueryInvalidated,
  queryKeys,
  resetQueryRegistry,
} from '../src/renderer/lib/live/index.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');

function read(rel: string): string {
  return fs.readFileSync(path.join(RENDERER_ROOT, rel), 'utf8');
}

/** Тело функции по её заголовку (до конца файла — якорей достаточно). */
function functionBlock(source: string, header: string): string {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `в исходнике нет «${header}»`);
  return source.slice(start);
}

/** Тело функции от заголовка до закрывающей скобки баланса — без «хвоста» файла. */
function functionBody(source: string, header: string): string {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `в исходнике нет «${header}»`);
  const open = source.indexOf('{', start);
  assert.notEqual(open, -1, `у «${header}» нет тела`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start);
}

const publication: Publication = {
  id: 'pub-1',
  title: 'Заголовок',
  subtitle: null,
  summary_md: null,
  authorship: null,
  cover_attachment_id: null,
  cover_url: null,
  cover_kind: 'none',
  assembly_date: null,
  title_recipe: null,
  text_sources: [],
  extra_properties: [],
  numbering_from: null,
  numbering_to: null,
  active: true,
  marked_for_deletion: false,
  marked_for_deletion_at: null,
  marked_for_deletion_by: null,
  version: 1,
  created_at: '2026-10-02T00:00:00.000Z',
  created_by: 'u',
  updated_at: '2026-10-02T00:00:00.000Z',
  updated_by: 'u',
};

describe('публикация: правка через кэш слоя (замечание А приёмки b02ef1cf)', () => {
  it('мутация кладёт снимок в кэш и гасит ключи слоя, подписчик получает оба', () => {
    resetQueryRegistry();
    const prefixes: string[] = [];
    const off = onQueryInvalidated((prefix) => prefixes.push(prefix));

    commitEntity('publication', publication.id, publication);
    invalidateAfterMutation([
      queryKeys.publicationCard(publication.id),
      queryKeys.publicationsListAll(),
    ]);

    off();
    assert.deepEqual(
      getEntity<Publication>('publication', publication.id)?.title,
      'Заголовок',
      'снимок правки лёг в нормализованный кэш',
    );
    assert.ok(
      prefixes.includes(queryKeys.publicationCard(publication.id)),
      'карточка (pub-card) оповещена',
    );
    assert.ok(
      prefixes.includes(queryKeys.publicationsListAll()),
      'библиотека (publications-list) оповещена',
    );
  });

  it('карточка кладёт снимок в кэш после PATCH и гасит ключи вложений после загрузки', () => {
    const source = read('editor/publication-card.ts');
    const save = functionBlock(source, 'async function flushSave(');
    assert.ok(
      save.includes("commitEntity('publication', updated.id, updated)"),
      'карточка кладёт снимок публикации в кэш слоя после PATCH',
    );
    assert.ok(
      save.includes('invalidateAfterMutation(') &&
        save.includes('queryKeys.publicationsListAll()'),
      'карточка гасит ключ библиотеки (кэш-путь)',
    );
    const upload = functionBlock(source, 'async function uploadFromFile(');
    assert.ok(
      upload.includes('invalidatePublicationAttachments(pubId)'),
      'вложение из диалога обложки гасит ключ списка вложений',
    );
  });

  it('экран «Публикации» подписан на слой и перечитывает список', () => {
    const source = read('screens/publications/publications.ts');
    assert.ok(source.includes('onQueryInvalidated'), 'экран подписан на инвалидации слоя');
    assert.ok(
      source.includes('queryKeys.publicationsListAll()') && source.includes('queryKeys.shelves()'),
      'экран слушает ключи библиотеки и полок',
    );
    const listener = functionBlock(source, 'layerUnsub = onQueryInvalidated(');
    assert.ok(
      listener.includes('invalidatePublications()'),
      'инвалидация ключа библиотеки перечитывает снимок',
    );
  });

  it('рабочая область умеет применить снимок, не перечитывая сборку', () => {
    const source = read('screens/publications/workspace.ts');
    assert.ok(source.includes('applyPublication(publication: Publication): void'));
    const apply = functionBody(source, 'function applyPublication(next: Publication): void');
    assert.ok(apply.includes('renderPublicationChrome()'), 'шапка и титул обновляются');
    const chrome = functionBody(source, 'function renderPublicationChrome(): void');
    assert.ok(chrome.includes('renderHeader()'), 'шапка обновляется');
    assert.ok(
      chrome.includes("'.pub-doc-titleblock'") && chrome.includes('buildTitleBlock()'),
      'титульный блок чтения заменяется свежим',
    );
    assert.ok(!apply.includes('reload()'), 'сборка не перечитывается');
  });
});

describe('диалог обложки: якоря поведения (замечание В приёмки b02ef1cf)', () => {
  const source = read('editor/publication-card.ts');

  it('список фокусируем и отдаём ему первую строку при первом показе', () => {
    assert.ok(source.includes('listHost.tabIndex = 0'), 'корень навигации принимает фокус');
    const search = functionBlock(source, 'async function runSearch(');
    assert.ok(search.includes('nav.focusNavigation()'), 'фокус отдаётся списку');
    assert.ok(search.includes('selectRow(first)'), 'первая строка становится текущей');
  });

  it('dblclick и Ctrl+Enter выбирают и применяют с закрытием', () => {
    // Применение выбора живёт в источнике «Вложения» универсального диалога
    // выбора ресурса (задача d1a56d76) — холдер `applyAttachments`, а не
    // прежняя локальная `applySelection`.
    assert.ok(
      /\.addEventListener\('dblclick',[\s\S]*?applyAttachments\(ctx\)/.test(source),
      'двойной клик по строке применяет выбор',
    );
    const navInit = functionBlock(source, 'const nav = createListNav<CoverRow>(');
    assert.ok(navInit.includes('onKey'), 'Ctrl+Enter перехватывается до базовых правил ядра');
    assert.ok(
      /key !== 'Enter' \|\| event\.ctrlKey !== true/.test(navInit) &&
        navInit.includes('applyAttachments(ctx)'),
      'Ctrl+Enter применяет выбор',
    );
  });

  it('облачка владельцев — общие компоненты (мысль/публикация), без самодельных подписей', () => {
    const clouds = functionBlock(source, 'function fillClouds(');
    assert.ok(clouds.includes('buildOwnerCloud('), 'строка владельцев строится компонентом');
    const cloud = functionBlock(source, 'function buildOwnerCloud(');
    assert.ok(cloud.includes('createThoughtCloud('), 'владелец-мысль — общая фабрика облачка мысли');
    assert.ok(
      cloud.includes("profile: 'chip'") && cloud.includes("width: 'container'"),
      'профиль чипа и ширина по контейнеру',
    );
    assert.ok(cloud.includes('createPublicationCloud('), 'владелец-публикация — компонент lib/ui');
    assert.ok(!source.includes('pub-cover-cloud-kind'), 'самодельных подписей вида владельца нет');
  });
});

/**
 * Реактивность публикации и поведение диалога обложки после замечаний приёмки
 * b02ef1cf (А/В). Здесь — дешёвые и устойчивые проверки: локальный канал правок
 * публикации (своё realtime-эхо подавлено) и ЯКОРЯ проводки в исходниках;
 * поведение (фокус списка, клавиши, dblclick, точечное обновление DOM)
 * проверяется живой пробой на стенде и в отчёте карточки.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { Publication } from '@etn/shared';

import {
  notifyPublicationChanged,
  onPublicationChanged,
} from '../src/renderer/lib/publication-events.js';

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

describe('публикация: локальный канал правок (замечание А приёмки b02ef1cf)', () => {
  it('подписчик получает снимок правки, отписка работает', () => {
    const seen: string[] = [];
    const off = onPublicationChanged((event) => seen.push(event.publication.title));
    notifyPublicationChanged({ publication, source: 'card' });
    off();
    notifyPublicationChanged({ publication: { ...publication, title: 'Позже' }, source: 'cover' });
    assert.deepEqual(seen, ['Заголовок'], 'после отписки событий нет');
  });

  it('карточка шлёт канал после успешного PATCH и канал вложений после загрузки файла', () => {
    const source = read('editor/publication-card.ts');
    const save = functionBlock(source, 'async function flushSave(');
    assert.ok(
      save.includes('notifyPublicationChanged({ publication: updated'),
      'карточка уведомляет библиотеку/рабочую область после PATCH',
    );
    const upload = functionBlock(source, 'async function uploadFromFile(');
    assert.ok(
      upload.includes('notifyPublicationAttachmentsChanged(pubId)'),
      'вложение из диалога обложки уведомляет вкладку «Вложения» локально',
    );
  });

  it('экран «Публикации» подписан и обновляет элемент точечно', () => {
    const source = read('screens/publications/publications.ts');
    assert.ok(source.includes('onPublicationChanged'), 'экран подписан на локальный канал');
    assert.ok(
      source.includes('applyPublicationChanged(event.publication)'),
      'правка применяется снимком',
    );
    const apply = functionBlock(source, 'export function applyPublicationChanged(');
    assert.ok(
      apply.includes('next[index] = publication') && apply.includes('publications = next'),
      'список обновляется точечно (элемент по индексу), без перечитывания',
    );
    assert.ok(apply.includes('renderBody()'), 'вид перерисовывается (reconcileKeyed обновит один ключ)');
    assert.ok(apply.includes('workspace.applyPublication(publication)'), 'рабочая область обновляется точечно');
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
    assert.ok(
      /\.addEventListener\('dblclick',[\s\S]*?applySelection\(closeDialog\)/.test(source),
      'двойной клик по строке применяет выбор',
    );
    const navInit = functionBlock(source, 'const nav = createListNav<CoverRow>(');
    assert.ok(navInit.includes('onKey'), 'Ctrl+Enter перехватывается до базовых правил ядра');
    assert.ok(
      /key !== 'Enter' \|\| event\.ctrlKey !== true/.test(navInit) &&
        navInit.includes('applySelection(closeDialog)'),
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

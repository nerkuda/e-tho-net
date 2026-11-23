/**
 * Кеш HTML-разбора markdown live-preview (ошибка 83785f1e).
 *
 * `buildDecorations` пересобирается на каждую транзакцию, поэтому исходник
 * неактивного блока (fence, таблица, картинка) разбирался markdown-it заново на
 * каждый введённый символ. Кеш возвращает тот же HTML по ключу «исходник +
 * опции рендера», ограничен по числу записей и суммарной длине исходников.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  MD_RENDER_CACHE_MAX_CHARS,
  MD_RENDER_CACHE_MAX_ENTRIES,
  cachedRenderMarkdown,
  mdRenderCacheInternals,
} from '../src/renderer/editor/md-render-cache.js';

const TABLE = '| a | b |\n| --- | --- |\n| 1 | 2 |';

beforeEach(() => {
  mdRenderCacheInternals.reset();
});

afterEach(() => {
  mdRenderCacheInternals.reset();
});

describe('кеш разбора markdown (83785f1e)', () => {
  it('повторный разбор того же исходника берётся из кеша, HTML тот же', () => {
    const first = cachedRenderMarkdown(TABLE);
    const second = cachedRenderMarkdown(TABLE);
    assert.equal(second, first, 'вывод побайтово совпадает');
    const stats = mdRenderCacheInternals.stats();
    assert.equal(stats.parses, 1, 'markdown-it разобрал исходник один раз');
    assert.equal(stats.hits, 1, 'второе обращение — попадание');
    assert.equal(stats.entries, 1);
    assert.equal(stats.chars, TABLE.length, 'вес записи — длина исходника');
  });

  it('опции рендера входят в ключ: sourceMap даёт другой HTML и новый разбор', () => {
    const plain = cachedRenderMarkdown(TABLE);
    const mapped = cachedRenderMarkdown(TABLE, { sourceMap: true });
    const mappedAgain = cachedRenderMarkdown(TABLE, { sourceMap: true });
    assert.notEqual(mapped, plain, 'разметка источников меняет HTML');
    assert.equal(mappedAgain, mapped, 'своя запись по опциям');
    const stats = mdRenderCacheInternals.stats();
    assert.equal(stats.parses, 2, 'исходник с другими опциями разобран отдельно');
    assert.equal(stats.hits, 1, 'повтор с теми же опциями — попадание');
    assert.equal(stats.entries, 2, 'две записи: с опциями и без');
  });

  it('изменённый исходник — новый разбор, прежняя запись не подменяется', () => {
    const before = cachedRenderMarkdown(TABLE);
    const after = cachedRenderMarkdown(TABLE.replace('| 1 | 2 |', '| 1 | 3 |'));
    assert.notEqual(after, before, 'HTML отражает правку');
    assert.equal(mdRenderCacheInternals.stats().parses, 2, 'правка требует разбора');
    // Прежний исходник по-прежнему в кеше: возврат к нему — попадание.
    assert.equal(cachedRenderMarkdown(TABLE), before);
    const stats = mdRenderCacheInternals.stats();
    assert.equal(stats.parses, 2);
    assert.equal(stats.hits, 1);
  });

  it('потолок числа записей: вытесняется самая старая, кеш не растёт', () => {
    for (let index = 0; index <= MD_RENDER_CACHE_MAX_ENTRIES; index += 1) {
      cachedRenderMarkdown(`${TABLE}\n\nстрока ${index}`);
    }
    let stats = mdRenderCacheInternals.stats();
    assert.equal(stats.entries, MD_RENDER_CACHE_MAX_ENTRIES, 'записей ровно по потолку');
    assert.equal(stats.parses, MD_RENDER_CACHE_MAX_ENTRIES + 1, 'каждый новый исходник разобран');
    // Самая старая запись вытеснена — новый разбор вместо попадания.
    cachedRenderMarkdown(TABLE);
    stats = mdRenderCacheInternals.stats();
    assert.equal(
      stats.parses,
      MD_RENDER_CACHE_MAX_ENTRIES + 2,
      'вытесненная запись разобрана заново',
    );
    assert.equal(stats.entries, MD_RENDER_CACHE_MAX_ENTRIES, 'потолок держится после вытеснения');
  });

  it('LRU: обращение обновляет запись, она переживает вытеснение соседей', () => {
    const firstSource = `${TABLE}\n\nпервая`;
    const firstHtml = cachedRenderMarkdown(firstSource);
    // Заполняем кеш до потолка соседями (первая запись пока самая старая).
    for (let index = 0; index < MD_RENDER_CACHE_MAX_ENTRIES - 1; index += 1) {
      cachedRenderMarkdown(`${TABLE}\n\nсосед ${index}`);
    }
    // «Касаемся» первой записи — теперь она свежая, соседи старше.
    assert.equal(cachedRenderMarkdown(firstSource), firstHtml);
    // Ещё один исходник обязан вытеснить соседа, а не свежую запись.
    cachedRenderMarkdown(`${TABLE}\n\nновый сосед`);
    assert.equal(cachedRenderMarkdown(firstSource), firstHtml, 'свежая запись выжила');
    const stats = mdRenderCacheInternals.stats();
    assert.equal(
      stats.parses,
      MD_RENDER_CACHE_MAX_ENTRIES + 1,
      'разборов — по числу разных исходников, без повторного разбора выжившей записи',
    );
    assert.equal(stats.hits, 2, 'оба обращения к первой записи — попадания');
  });

  it('исходник крупнее общего потолка не кешируется (кеш не течёт)', () => {
    const huge = 'a'.repeat(MD_RENDER_CACHE_MAX_CHARS + 1);
    const options = { maxLength: MD_RENDER_CACHE_MAX_CHARS * 4 };
    cachedRenderMarkdown(huge, options);
    cachedRenderMarkdown(huge, options);
    const stats = mdRenderCacheInternals.stats();
    assert.equal(stats.entries, 0, 'запись не сохранена');
    assert.equal(stats.chars, 0);
    assert.equal(stats.parses, 2, 'оба обращения разобрали исходник');
    assert.equal(stats.hits, 0);
  });

  it('reset очищает кеш и счётчики', () => {
    cachedRenderMarkdown(TABLE);
    cachedRenderMarkdown(TABLE);
    mdRenderCacheInternals.reset();
    assert.deepEqual(mdRenderCacheInternals.stats(), {
      parses: 0,
      hits: 0,
      entries: 0,
      chars: 0,
    });
  });
});

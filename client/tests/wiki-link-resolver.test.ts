/**
 * Unit tests for the view-mode wiki-link resolver (task R7). Pure tests of
 * the cache invalidation helpers — no DOM, no jsdom (not a dev-dep).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  __testing,
  invalidateWikiLinkCache,
} from '../src/renderer/editor/wiki-link-resolver.js';

const ID_A = '8e0d670e-de61-4da7-b13e-9232cd1c6ca5';
const ID_B = '11111111-2222-3333-4444-555555555555';

test('cache invalidation: invalidateWikiLinkCache удаляет запись для id', () => {
  __testing.cache.clear();
  // Прямое наполнение кеша (имитация успешного resolve).
  __testing.cache.set(`net-a:${ID_A}`, { title: 'Цель A', exists: true });
  assert.ok(__testing.cache.has(`net-a:${ID_A}`), 'cache должен содержать запись перед invalidate');
  invalidateWikiLinkCache(ID_A);
  assert.equal(__testing.cache.has(`net-a:${ID_A}`), false, 'запись должна быть удалена');
});

test('invalidateWikiLinkCache удаляет записи для ВСЕХ сетей', () => {
  __testing.cache.clear();
  __testing.cache.set(`net-a:${ID_A}`, { title: 'A', exists: true });
  __testing.cache.set(`net-b:${ID_A}`, { title: 'B', exists: true });
  __testing.cache.set(`net-a:${ID_B}`, { title: 'C', exists: true });
  invalidateWikiLinkCache(ID_A);
  assert.equal(__testing.cache.has(`net-a:${ID_A}`), false);
  assert.equal(__testing.cache.has(`net-b:${ID_A}`), false);
  assert.equal(__testing.cache.has(`net-a:${ID_B}`), true, 'B не должен быть удалён');
});

test('invalidateWikiLinkCache на отсутствующий id — без побочных эффектов', () => {
  __testing.cache.clear();
  __testing.cache.set(`net-a:${ID_A}`, { title: 'A', exists: true });
  invalidateWikiLinkCache('not-in-cache');
  assert.equal(__testing.cache.has(`net-a:${ID_A}`), true, 'старые записи не должны пострадать');
});

test('cache isolation: разные ключи независимы', () => {
  __testing.cache.clear();
  __testing.cache.set(`net-a:${ID_A}`, { title: 'A', exists: true });
  __testing.cache.set(`net-a:${ID_B}`, { title: 'B', exists: true });
  __testing.cache.set(`net-b:${ID_A}`, { title: 'A2', exists: true });
  assert.equal(__testing.cache.size, 3);
});

test('cache помечает удалённые мысли как exists=false', () => {
  __testing.cache.clear();
  __testing.cache.set(`net-a:${ID_A}`, { title: 'Архивная', exists: false });
  assert.equal(__testing.cache.get(`net-a:${ID_A}`)?.exists, false);
});

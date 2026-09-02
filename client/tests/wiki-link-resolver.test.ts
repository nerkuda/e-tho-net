/**
 * Unit tests for the view-mode wiki-link resolver (task R7) and the
 * snippet text substitution for the backlinks tab. Pure — no DOM, no jsdom
 * (not a dev-dep).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  __testing,
  invalidateWikiLinkCache,
} from '../src/renderer/editor/wiki-link-resolver.js';

const ID_A = '8e0d670e-de61-4da7-b13e-9232cd1c6ca5';
const ID_B = '11111111-2222-3333-4444-555555555555';
const NET = 'c4f9a3b2-1111-2222-3333-444455556666';

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

// ---------------------------------------------------------------------------
// wikiSpanPaint: решение покраски одного ID-form span (карточка feccffcc —
// алиас `[[#<id>|алиас]]` пропадал в режиме просмотра)
// ---------------------------------------------------------------------------

test('wikiSpanPaint: непустой span (алиас) не затирается именем', () => {
  const p = __testing.wikiSpanPaint('мой алиас', { title: 'Цель A', exists: true }, false);
  assert.equal(p.text, null, 'текст алиаса должен остаться');
  assert.equal(p.deleted, false);
  assert.equal(p.markResolved, true);
});

test('wikiSpanPaint: пустой span заполняется именем', () => {
  const p = __testing.wikiSpanPaint('', { title: 'Цель A', exists: true }, false);
  assert.equal(p.text, 'Цель A');
  assert.equal(p.deleted, false);
  assert.equal(p.markResolved, true);
});

test('wikiSpanPaint: удалённая мысль — алиас остаётся (muted), без алиаса — пусто', () => {
  const alias = __testing.wikiSpanPaint('алиас', { title: '', exists: false }, false);
  assert.equal(alias.text, null);
  assert.equal(alias.deleted, true);
  assert.equal(alias.markResolved, false);
  const plain = __testing.wikiSpanPaint('', { title: '', exists: false }, false);
  assert.equal(plain.text, '');
  assert.equal(plain.deleted, true);
});

test('wikiSpanPaint: неактуальная при showInactive — алиас остаётся, пустой span получает имя', () => {
  const alias = __testing.wikiSpanPaint('алиас', { title: 'Старое имя', exists: false }, true);
  assert.equal(alias.text, null);
  assert.equal(alias.deleted, false);
  const plain = __testing.wikiSpanPaint('', { title: 'Старое имя', exists: false }, true);
  assert.equal(plain.text, 'Старое имя');
  assert.equal(plain.deleted, false);
});

test('substituteWikiIdsInSnippet: [[#<id>]] → имя из lookup', () => {
  const { substituteWikiIdsInSnippet } = __testing;
  const out = substituteWikiIdsInSnippet(`см. [[#${ID_A}]] далее`, 'net-a', (net, id) =>
    net === 'net-a' && id === ID_A ? { title: 'Цель A', exists: true } : undefined,
  );
  assert.equal(out, 'см. Цель A далее');
});

test('substituteWikiIdsInSnippet: <mark>-выделение id переносится на имя', () => {
  const { substituteWikiIdsInSnippet } = __testing;
  const out = substituteWikiIdsInSnippet(`[[#<mark>${ID_A}</mark>]]`, 'net-a', () => ({
    title: 'Цель A',
    exists: true,
  }));
  assert.equal(out, '<mark>Цель A</mark>');
});

test('substituteWikiIdsInSnippet: алиас показывается вместо имени', () => {
  const { substituteWikiIdsInSnippet } = __testing;
  const out = substituteWikiIdsInSnippet(`[[#${ID_A}|мой алиас]]`, 'net-a', () => ({
    title: 'Цель A',
    exists: true,
  }));
  assert.equal(out, 'мой алиас');
});

test('substituteWikiIdsInSnippet: кросс-сеть резолвится через сеть ссылки', () => {
  const { substituteWikiIdsInSnippet } = __testing;
  const out = substituteWikiIdsInSnippet(`[[n:${NET}#${ID_A}]]`, 'net-a', (net, id) =>
    net === NET && id === ID_A ? { title: 'Чужая цель', exists: true } : undefined,
  );
  assert.equal(out, 'Чужая цель');
});

test('substituteWikiIdsInSnippet: неизвестный/удалённый id → «…», не сырой id', () => {
  const { substituteWikiIdsInSnippet } = __testing;
  const unknown = substituteWikiIdsInSnippet(`[[#${ID_A}]]`, 'net-a', () => undefined);
  assert.equal(unknown, '…');
  const deleted = substituteWikiIdsInSnippet(`[[#${ID_A}]]`, 'net-a', () => ({
    title: '',
    exists: false,
  }));
  assert.equal(deleted, '…');
  assert.ok(!unknown.includes(ID_A), 'сырой id не должен попасть в вывод');
});

test('substituteWikiIdsInSnippet: title с HTML-символами экранируется', () => {
  const { substituteWikiIdsInSnippet } = __testing;
  const out = substituteWikiIdsInSnippet(`[[#${ID_A}]]`, 'net-a', () => ({
    title: 'A <b> & "Q"',
    exists: true,
  }));
  assert.equal(out, 'A &lt;b&gt; &amp; &quot;Q&quot;');
});

test('substituteWikiIdsInSnippet: legacy [[Имя]] и обрывки не трогаются', () => {
  const { substituteWikiIdsInSnippet } = __testing;
  const source = `обрывок …b82df-ab1e-4540-b846-bff2b77dd0e0]] и legacy [[Имя|алиас]]`;
  const out = substituteWikiIdsInSnippet(source, 'net-a', () => ({ title: 'X', exists: true }));
  assert.equal(out, source);
});

/**
 * Unit tests for the view-mode wiki-link resolver (task R7) and the
 * snippet text substitution for the backlinks tab. Pure — no DOM, no jsdom
 * (not a dev-dep).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { __testing } from '../src/renderer/editor/wiki-link-resolver.js';
import { clearEntities, commitEntity } from '../src/renderer/lib/live/index.js';

const ID_A = '8e0d670e-de61-4da7-b13e-9232cd1c6ca5';
const ID_B = '11111111-2222-3333-4444-555555555555';
const NET = 'c4f9a3b2-1111-2222-3333-444455556666';

test('G6: заголовок из слоя важнее устаревшего отрицательного ответа', () => {
  // Легаси-фасад `invalidateWikiLinkCache` снесён (G6): заголовок — производная
  // нормализованного кэша слоя, и `getCached`/`isKnown` читают его РАНЬШЕ
  // отрицательного кэша. Появление мысли в кэше (роутер/`commitEntity`) делает
  // прежний «отсутствует» неактуальным без отдельного сброса.
  clearEntities();
  __testing.missingIds.clear();
  __testing.missingIds.add(ID_A);
  commitEntity('thought', ID_A, { id: ID_A, title: 'Появилась', active: true });
  assert.deepEqual(__testing.getCached('net-a', ID_A), { title: 'Появилась', exists: true });
  assert.equal(__testing.isKnown('net-a', ID_A), true);
});

test('getCached читает заголовок из нормализованного кэша слоя', () => {
  clearEntities();
  __testing.missingIds.clear();
  commitEntity('thought', ID_A, { id: ID_A, title: 'Цель A', active: true });
  assert.deepEqual(__testing.getCached('net-a', ID_A), { title: 'Цель A', exists: true });
  assert.equal(__testing.isKnown('net-a', ID_A), true);
});

test('getCached: неактуальная мысль — exists=false, заголовок сохранён', () => {
  clearEntities();
  __testing.missingIds.clear();
  commitEntity('thought', ID_A, { id: ID_A, title: 'Архивная', active: false });
  assert.deepEqual(__testing.getCached('net-a', ID_A), { title: 'Архивная', exists: false });
});

test('getCached: отсутствующий id (missingIds) — пустой заголовок, exists=false', () => {
  clearEntities();
  __testing.missingIds.clear();
  __testing.missingIds.add(ID_A);
  assert.deepEqual(__testing.getCached('net-a', ID_A), { title: '', exists: false });
  assert.equal(__testing.isKnown('net-b', ID_A), true, 'отрицательный ответ не сегментирован по сети');
});

test('getCached: неизвестный id — undefined (нет ни в кэше, ни в missing)', () => {
  clearEntities();
  __testing.missingIds.clear();
  assert.equal(__testing.getCached('net-a', ID_B), undefined);
  assert.equal(__testing.isKnown('net-a', ID_B), false);
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

// ---------------------------------------------------------------------------
// Публикации (0.11.1, задача 3275fd8d, требование 7f583ef9)
// ---------------------------------------------------------------------------

test('publicationIdFromTarget: распознаёт серверную legacy-подпись #pub:<uuid>', () => {
  const { publicationIdFromTarget } = __testing;
  assert.equal(publicationIdFromTarget(`#pub:${ID_A}`), ID_A.toLowerCase());
  assert.equal(publicationIdFromTarget(`#pub:${ID_A.toUpperCase()}`), ID_A.toLowerCase());
});

test('publicationIdFromTarget: не публикация — null', () => {
  const { publicationIdFromTarget } = __testing;
  assert.equal(publicationIdFromTarget(`#${ID_A}`), null);
  assert.equal(publicationIdFromTarget('Имя мысли'), null);
  assert.equal(publicationIdFromTarget('#pub:not-a-uuid'), null);
  assert.equal(publicationIdFromTarget(''), null);
});

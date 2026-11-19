/**
 * Релевантность realtime-событий ленте «Дневника» (0.16.1, пачка 3, пункт 6
 * ревью реактивности).
 *
 * Маршрутизатор гасит ключ `chronicle-feed` на любое `comment.*` в сети, но
 * лента показывает только хронологические записи периода. Правка постоянного
 * комментария мысли и удаление незагруженной записи ленту не меняют — их
 * перезапрос/перерисовка были вхолостую (живой дефект пункта 5).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RealtimeCause } from '../src/renderer/lib/live/query-registry.js';
import { feedEventRelevant } from '../src/renderer/screens/chronicle/feed-relevance.js';

function cause(type: string, data: Record<string, unknown>): RealtimeCause {
  return { type, network_id: 'n1', seq: 1, data };
}

const ROWS = [{ id: 'c1' }, { id: 'c2' }];

describe('лента «Дневника»: фильтр релевантности realtime-событий', () => {
  it('правка ПОСТОЯННОГО комментария ленту не трогает', () => {
    assert.equal(
      feedEventRelevant(
        cause('comment.updated', { id: 'c-perm', kind: 'permanent', changes: { body_md: 'x' } }),
        ROWS,
      ),
      false,
      'постоянного комментария в ленте нет',
    );
  });

  it('правка хронологической записи релевантна (текст/заголовок/период/привязки)', () => {
    assert.equal(
      feedEventRelevant(
        cause('comment.updated', {
          id: 'c1',
          kind: 'chronological',
          changes: { body_md: 'x' },
        }),
        ROWS,
      ),
      true,
    );
  });

  it('удаление загруженной записи релевантно, незагруженной — нет', () => {
    assert.equal(feedEventRelevant(cause('comment.deleted', { id: 'c1' }), ROWS), true);
    assert.equal(
      feedEventRelevant(cause('comment.deleted', { id: 'c-unknown' }), ROWS),
      false,
      'запись вне ленты состава не меняет',
    );
  });

  it('создание постоянного комментария нерелевантно, хронологической записи — да', () => {
    assert.equal(
      feedEventRelevant(
        cause('comment.created', { comment: { id: 'p1', kind: 'permanent' } }),
        ROWS,
      ),
      false,
    );
    assert.equal(
      feedEventRelevant(
        cause('comment.created', { comment: { id: 'c3', kind: 'chronological' } }),
        ROWS,
      ),
      true,
    );
  });

  it('локальная причина и прочие события считаются релевантными', () => {
    assert.equal(feedEventRelevant(null, ROWS), true, 'локальная мутация — перечитываем');
    assert.equal(feedEventRelevant(cause('thought.updated', { id: 't1' }), ROWS), true);
  });
});

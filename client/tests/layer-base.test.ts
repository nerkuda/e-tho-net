/**
 * Tests for the «are we in Base layer?» helper (задача d9b66617).
 *
 * Поведение:
 *   - `currentLayer === null` → Основа (слой ещё не выбран в этой сессии);
 *   - `currentLayer.id === BASE_LAYER_ID` → Основа;
 *   - любой другой id → слой изменений.
 *
 * Хелпер — единая точка истины для UX-блокировок правок онтологии (отборы
 * типов мыслей и др.) в слоях изменений.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { BASE_LAYER_ID } from '@etn/shared';

import { isInBaseLayer } from '../src/renderer/lib/layer-base.js';
import { store } from '../src/renderer/state.js';

describe('isInBaseLayer (задача d9b66617)', () => {
  beforeEach(() => {
    store.update({ currentLayer: null });
  });

  it('возвращает true, когда слой не выбран', () => {
    store.update({ currentLayer: null });
    assert.equal(isInBaseLayer(), true);
  });

  it('возвращает true, когда выбран базовый слой', () => {
    store.update({ currentLayer: { id: BASE_LAYER_ID, title: 'Основа' } });
    assert.equal(isInBaseLayer(), true);
  });

  it('возвращает false, когда выбран любой другой слой', () => {
    store.update({ currentLayer: { id: '11111111-2222-3333-4444-555555555555', title: 'Черновик' } });
    assert.equal(isInBaseLayer(), false);
  });

  it('читает актуальное значение из store (не кеширует)', () => {
    assert.equal(isInBaseLayer(), true);
    store.update({ currentLayer: { id: 'change-layer-id', title: 'Слой' } });
    assert.equal(isInBaseLayer(), false);
    store.update({ currentLayer: null });
    assert.equal(isInBaseLayer(), true);
  });
});

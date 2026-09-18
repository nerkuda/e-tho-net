/**
 * Сторож стандарта «Клиент: выбор сущности — только через общий пикер» (S3,
 * задача a1f5141b вехи 3 версии 0.8.2; ADR «выбор сущности — один пикер на
 * типы мыслей, типы связей и мысли»).
 *
 * Правила:
 * 1. `<select>` из типов мыслей или типов связей не собирается вне пикера:
 *    чтение каталога (`store.state.thoughtTypes` / `store.state.linkTypes`)
 *    или дерева типов (`orderedTypeRows(store.state…`), за которым в пределах
 *    окна следует создание `<option>` — признак ручной сборки выпадающего
 *    списка из каталога. Такие списки строит только
 *    `lib/entity-picker.ts` (встроенное комбо — через общую выпадашку).
 * 2. Новый модальный чек-лист выбора сущностей не пишется вне пикера:
 *    классы чек-листа пикера (`st-f-checks` / `st-f-check`) встречаются
 *    только в `lib/entity-picker.ts`.
 *
 * Сторож вводится зелёным — в том же изменении, которое переводит все
 * модальные чек-листы типов и голые `<select>` на общий пикер
 * (мета-стандарт «Правило без теста-сторожа не считается введённым»).
 */

import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertGuardClean } from './guard-helpers.js';

const RENDERER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'renderer',
);

/** Максимальный разрыв между чтением каталога типов и созданием `<option>`:
 *  дальше конструкция уже не «сборка списка из каталога». */
const SELECT_FROM_CATALOGUE_WINDOW = 1500;

describe('guard: выбор сущности делается только общим пикером', () => {
  it('<select> не собирается из типов мыслей или типов связей', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'no-type-select',
        description:
          'Сборка <select> из каталога типов (store.state.thoughtTypes/linkTypes ' +
          'или orderedTypeRows(store.state…)) запрещена: такие списки строит только ' +
          'lib/entity-picker.ts (S3).',
        filePattern: new RegExp(
          `store\\.state\\.(?:thoughtTypes|linkTypes)[\\s\\S]{0,${SELECT_FROM_CATALOGUE_WINDOW}}?el\\(\\s*['"]option['"]`,
          'g',
        ),
      },
      {
        name: 'no-type-select-tree',
        description:
          'Сборка <select> из дерева типов (orderedTypeRows(store.state…)) запрещена: ' +
          'иерархию строит lib/type-tree.ts, список — lib/entity-picker.ts (S3).',
        filePattern: new RegExp(
          `orderedTypeRows\\(\\s*store\\.state\\.[\\s\\S]{0,${SELECT_FROM_CATALOGUE_WINDOW}}?el\\(\\s*['"]option['"]`,
          'g',
        ),
      },
    ]);
  });

  it('модальный чек-лист выбора сущностей не пишется вне пикера', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'no-modal-checklist',
        description:
          'Классы чек-листа пикера (st-f-checks/st-f-check) встречаются только в ' +
          'lib/entity-picker.ts: новый модальный чек-лист выбора сущностей вне пикера ' +
          'запрещён (S3).',
        pattern: /\bst-f-checks?\b/,
        allow: (rel) => rel === 'lib/entity-picker.ts',
      },
    ]);
  });
});

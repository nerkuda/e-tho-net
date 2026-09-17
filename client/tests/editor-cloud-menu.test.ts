/**
 * Structural checks for the unified thought context menu in the editor
 * (спецификация «Контекстное меню мысли»).
 *
 * Правило: у облачка мысли в редакторе — тот же набор команд, что у облачка на
 * холсте. Свой список команд в редакторе запрещён: мини-облачка значений
 * свойств, пилюли локального графа и кнопка «Действия ▾» зовут общий
 * конструктор `canvas/context-menu.ts` (`showThoughtMenuUnder`), а отличия
 * контекста выражают его опциями. Пока таких мест было три с тремя разными
 * меню — они и разъехались (в свойствах оставалось 4 команды).
 *
 * Композиция команд проверяется unit-тестами самого конструктора
 * (`context-menu.test.ts`); здесь — только факт делегирования из редактора.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const SRC = {
  properties: resolve(import.meta.dirname, '..', 'src', 'renderer', 'editor', 'properties.ts'),
  miniGraph: resolve(import.meta.dirname, '..', 'src', 'renderer', 'editor', 'mini-graph.ts'),
  contextMenu: resolve(import.meta.dirname, '..', 'src', 'renderer', 'canvas', 'context-menu.ts'),
};

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

/** Вырезает тело функции по её сигнатуре (до закрывающей скобки в 1-й колонке). */
function functionBody(src: string, signature: string, end = '\n}\n'): string {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `expected ${signature} to be defined`);
  const stop = src.indexOf(end, start);
  assert.ok(stop > start, `expected ${signature} body to be closed with ${JSON.stringify(end)}`);
  return src.slice(start, stop);
}

describe('меню облачка в редакторе — единый конструктор (спецификация «Контекстное меню мысли»)', () => {
  it('конструктор меню мысли экспортирован из холста с опциями контекста', () => {
    const src = readText(SRC.contextMenu);
    assert.ok(
      src.includes('export function buildThoughtMenuItems('),
      'the canvas thought-menu builder must be a public API (the editor reuses it)',
    );
    assert.ok(
      src.includes('export function showThoughtMenuUnder('),
      'an anchor-based opener must exist for editor chips',
    );
    assert.ok(
      src.includes('export interface ThoughtMenuOptions'),
      'context differences are options',
    );
    for (const opt of [
      'openLabel',
      'hideOpenCommand',
      'focusHandler',
      'attachmentHandler',
      'extraItems',
      'siblingParentId',
      'trashed',
    ]) {
      assert.ok(src.includes(opt), `ThoughtMenuOptions must expose «${opt}»`);
    }
    // Родителя для «налево (родственник)» вне холста резолвит один общий
    // помощник (иначе он расползётся копиями по editor-модулям).
    assert.ok(
      src.includes('export async function resolveSiblingParentId('),
      'the sibling-parent lookup must live here, not in the editor',
    );
  });

  it('чип значения свойства зовёт общий конструктор и добавляет «Убрать из значения»', () => {
    const src = readText(SRC.properties);
    const chip = functionBody(src, 'async function showLinkChipMenu(');
    assert.ok(
      chip.includes('await openThoughtCloudMenu(') && chip.includes("label: 'Убрать из значения'"),
      'the value chip menu = shared thought menu + «Убрать из значения»',
    );

    const helper = functionBody(src, 'async function openThoughtCloudMenu(');
    assert.ok(
      helper.includes("'../canvas/context-menu.js'") && helper.includes('await import('),
      'the editor menu must be built by the canvas builder (lazy import: no canvas↔editor cycle)',
    );
    assert.ok(
      helper.includes('showThoughtMenuUnder('),
      'the canvas builder must actually open the editor menu',
    );
    assert.ok(
      helper.includes("openLabel: 'Открыть в редакторе'"),
      'in the editor the opener opens the thought in the editor, without moving the canvas focus',
    );
    assert.ok(helper.includes('focusHandler'), '«В фокус» comes from the shared builder');
    assert.ok(
      helper.includes('resolveSiblingParentId'),
      'the chip is not in a canvas zone — its parent is resolved explicitly',
    );
    // Своего списка команд и своей копии резолвера родителя у чипа больше нет.
    for (const label of ['Копировать ID', 'Открепить мысль', 'Закрепить мысль']) {
      assert.ok(!src.includes(`label: '${label}'`), `the chip must not hand-roll «${label}»`);
    }
    assert.ok(
      !src.includes('async function siblingParentIdOf('),
      'the editor must reuse the shared sibling-parent resolver',
    );
  });

  it('внетиповое ребро («Свойства вне типа») зовёт тот же конструктор без «Убрать из значения»', () => {
    const src = readText(SRC.properties);
    const helper = functionBody(src, 'const openReadonlyMenu = (): void => {', '\n    };');
    assert.ok(helper.includes('void openThoughtCloudMenu('), 'delegates to the shared menu');
    assert.ok(
      !helper.includes('extraItems'),
      'the edge of an outside-type property is not part of the value — nothing to remove',
    );
  });

  it('пилюля локального графа зовёт общий конструктор и не держит свой список команд', () => {
    const src = readText(SRC.miniGraph);
    const menu = functionBody(src, 'async function showCloudContextMenu(');
    assert.ok(
      menu.includes('showThoughtMenuUnder('),
      'the local-graph pill menu must be the shared thought menu',
    );
    assert.ok(
      menu.includes('await import(') && menu.includes("'../canvas/context-menu.js'"),
      'the canvas menu module must be imported lazily (no canvas↔editor cycle)',
    );
    assert.ok(
      menu.includes("openLabel: 'Открыть в редакторе'"),
      'opening does not move the canvas focus',
    );
    assert.ok(menu.includes('focusHandler'), '«В фокус» is available');
    assert.ok(
      menu.includes('trashed: node.ref.marked_for_deletion === true'),
      'the trash flag comes from the node ref (no canvas ref cache here)',
    );
    for (const label of ['Копировать ID', 'Открепить мысль', 'Добавить к выделению']) {
      assert.ok(!src.includes(`label: '${label}'`), `the pill must not hand-roll «${label}»`);
    }
  });
});

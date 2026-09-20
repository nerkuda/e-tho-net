/**
 * Эллипс облачка — источник драга и направление (ошибка c8bd4676).
 *
 * Контракт спецификации (docs/08-ui-spec.md §4.1–4.2): диалог добавления
 * называет ЯКОРЬ — «мысль-владельца вызова». Для drag-жеста на эллипсе
 * владелец — та мысль, чей эллипс потянули, и направление задаёт сам эллипс:
 * верхний — новая мысль становится родителем якоря, нижний — ребёнком. Мысль
 * в фокусе здесь не участвует: именно её подстановка (в подписи диалога)
 * и была дефектом.
 *
 * Чистая логика исхода драга проверяется напрямую (`resolveEllipseDrop`);
 * то, что каждая ветка отрисовки вешает жест на эллипс СОБСТВЕННОЙ мысли и
 * передаёт её имя в диалог, — по якорям исходника (клиентские тесты идут без
 * jsdom, см. конвенцию в соседних тестах).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { resolveEllipseDrop } from '../src/renderer/canvas/canvas.js';

const CANVAS_TS = resolve(import.meta.dirname, '..', 'src', 'renderer', 'canvas', 'canvas.ts');
const ADD_DIALOG_TS = resolve(import.meta.dirname, '..', 'src', 'renderer', 'canvas', 'add-dialog.ts');

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

/** Драг, начатый на нижнем эллипсе нефокусной мысли «Источник». */
function dragOfEllipse(direction: 'parent' | 'child') {
  return { anchorId: 'X', anchorTitle: 'Источник', direction };
}

describe('resolveEllipseDrop: исход драга задаёт эллипс, а не фокус (ошибка c8bd4676)', () => {
  it('нижний эллипс нефокусной мысли, брошенный на пустом месте, открывает диалог ВНИЗ к этой мысли', () => {
    const outcome = resolveEllipseDrop(dragOfEllipse('child'), null);
    assert.deepEqual(outcome, {
      kind: 'add',
      anchorId: 'X',
      anchorTitle: 'Источник',
      direction: 'child',
    });
  });

  it('верхний эллипс ведёт ВВЕРХ — направление берётся из эллипса', () => {
    const outcome = resolveEllipseDrop(dragOfEllipse('parent'), null);
    assert.deepEqual(outcome, {
      kind: 'add',
      anchorId: 'X',
      anchorTitle: 'Источник',
      direction: 'parent',
    });
  });

  it('бросок на другую мысль даёт связь от якоря драга, а не диалог', () => {
    const outcome = resolveEllipseDrop(dragOfEllipse('child'), 'Y');
    assert.deepEqual(outcome, {
      kind: 'link',
      anchorId: 'X',
      direction: 'child',
      droppedId: 'Y',
    });
  });

  it('бросок на сам якорь — не связь с собой, а диалог', () => {
    const outcome = resolveEllipseDrop(dragOfEllipse('parent'), 'X');
    assert.equal(outcome.kind, 'add');
    assert.equal(outcome.anchorId, 'X');
  });

  it('исход не зависит от фокуса: якорь и имя всегда из драга', () => {
    for (const direction of ['parent', 'child'] as const) {
      const outcome = resolveEllipseDrop({ anchorId: 'другая', anchorTitle: 'Другая', direction }, null);
      assert.equal(outcome.kind, 'add');
      assert.ok(outcome.kind === 'add');
      assert.equal(outcome.anchorId, 'другая');
      assert.equal(outcome.anchorTitle, 'Другая');
      assert.equal(outcome.direction, direction);
    }
  });
});

describe('эллипсы холста несут мысль и имя своей мысли (ошибка c8bd4676)', () => {
  it('обе ветки отрисовки вешают жест на эллипс собственной мысли', () => {
    const src = readText(CANVAS_TS);
    // Фокус-облачко — имя из мысли фокуса.
    assert.match(src, /wireEllipseDrag\(topEllipse, thought\.id, thought\.title, 'parent'\);/);
    assert.match(src, /wireEllipseDrag\(bottomEllipse, thought\.id, thought\.title, 'child'\);/);
    // Зональные облачка (в т.ч. нефокусные) — id и полное имя записи зоны,
    // а не мысль в фокусе.
    assert.match(src, /wireEllipseDrag\(topEllipse, entry\.id, cloudTitleFull, 'parent'\);/);
    assert.match(src, /wireEllipseDrag\(bottomEllipse, entry\.id, cloudTitleFull, 'child'\);/);
    assert.equal(
      (src.match(/wireEllipseDrag\(/g) ?? []).length,
      5, // 4 вызова + само объявление функции
      'все эллипсы (фокус + зоны) должны быть подключены к жесту',
    );
  });

  it('жест хранит имя якоря и передаёт его в диалог вместе с id', () => {
    const src = readText(CANVAS_TS);
    assert.match(
      src,
      /addDialogOpener\(\{\s*anchorId: outcome\.anchorId,\s*anchorTitle: outcome\.anchorTitle,/,
      'opener обязан получить имя источника драга',
    );
    assert.doesNotMatch(
      src,
      /addDialogOpener\(\{\s*anchorId: store\.state\.focus/,
      'фокус не должен подставляться якорем вместо источника драга',
    );
    // Двойной клик по пустому месту зоны — владелец вызова действительно фокус.
    assert.match(
      src,
      /addDialogOpener\(\{\s*anchorId: focusId,\s*anchorTitle: focusTitle,/,
    );
  });

  it('openAddDialog прокидывает имя якоря в диалог, не теряя его', () => {
    const src = readText(ADD_DIALOG_TS);
    assert.match(src, /anchorTitle\?: string;/);
    assert.match(src, /anchorTitle: ctx\.anchorTitle,/);
  });
});

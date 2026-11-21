/**
 * Сторож правила «новое поле визуала мысли — только в классификаторе
 * `isThoughtVisualEvent`» (0.16.1, задача 739eb698; доработка по вердикту
 * 35656dfb, замечание 2).
 *
 * **Что стережёт.** Панели задач и лента «Дневника» обновляют облачка по
 * классификатору `lib/live/thought-visual-events.ts`, а фабрика облачка читает
 * визуальные поля `ThoughtRef` (`lib/thought-cloud.ts`). Если поле визуала
 * появилось в `ThoughtRef`, а классификатор его не учитывает, один экран
 * обновится, другой останется со старым видом. Сторож сверяет набор полей
 * классификатора с интерфейсом `ThoughtRef` — источником истины DTO.
 *
 * **Исключения.** `id` — адрес мысли, а не визуал; `marked_for_deletion` —
 * видимость корзины, её ведёт отдельный классификатор `isTrashVisibilityEvent`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { isThoughtVisualEvent } from '../src/renderer/lib/live/thought-visual-events.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const THOUGHT_TYPES = path.join(ROOT, 'shared', 'src', 'types', 'thought.ts');
const CLASSIFIER = path.join(
  ROOT,
  'client',
  'src',
  'renderer',
  'lib',
  'live',
  'thought-visual-events.ts',
);

/** Поля `ThoughtRef`, которые визуалом облачка не являются. */
const NON_VISUAL = new Set(['id', 'marked_for_deletion']);

/** Realtime-событие с минимальным набором полей для классификатора. */
function routedEvent(type: string, data: Record<string, unknown>) {
  return {
    type,
    network_id: 'n1',
    seq: 1,
    data,
  } as unknown as Parameters<typeof isThoughtVisualEvent>[0];
}

/** Поля интерфейса `ThoughtRef` из общей спецификации типов. */
function thoughtRefFields(): string[] {
  const source = fs.readFileSync(THOUGHT_TYPES, 'utf8');
  const start = source.indexOf('export interface ThoughtRef {');
  assert.notEqual(start, -1, 'в shared/src/types/thought.ts есть ThoughtRef');
  const end = source.indexOf('\n}', start);
  assert.ok(end > start, 'интерфейс ThoughtRef закрыт');
  const body = source.slice(start, end);
  return [...body.matchAll(/^\s{2}([a-z_]+)\??:/gm)].map((match) => match[1]!);
}

/** Поля, объявленные визуальными в классификаторе. */
function classifierFields(): string[] {
  const source = fs.readFileSync(CLASSIFIER, 'utf8');
  const start = source.indexOf('const VISUAL_FIELDS = [');
  assert.notEqual(start, -1, 'в классификаторе есть VISUAL_FIELDS');
  const end = source.indexOf('] as const;', start);
  assert.ok(end > start, 'список VISUAL_FIELDS закрыт');
  return [...source.slice(start, end).matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!);
}

describe('сторож классификатора визуала мысли (739eb698)', () => {
  it('учитывает КАЖДОЕ визуальное поле ThoughtRef', () => {
    const required = thoughtRefFields().filter((field) => !NON_VISUAL.has(field));
    const declared = new Set(classifierFields());
    const missing = required.filter((field) => !declared.has(field));
    assert.deepEqual(missing, [], `поля без классификатора: ${missing.join(', ')}`);
  });

  it('срабатывает на каждое объявленное поле в thought.updated', () => {
    for (const field of classifierFields()) {
      assert.equal(
        isThoughtVisualEvent(
          routedEvent('thought.updated', { id: 't1', changes: { [field]: true } }),
        ),
        true,
        `поле ${field} обязано давать перечитывание`,
      );
    }
  });

  it('не трогает корзину и посторонние события', () => {
    assert.equal(
      isThoughtVisualEvent(
        routedEvent('thought.updated', { id: 't1', changes: { marked_for_deletion: true } }),
      ),
      false,
      'корзину ведёт isTrashVisibilityEvent',
    );
    assert.equal(
      isThoughtVisualEvent(routedEvent('comment.updated', { id: 'c1', changes: { title: 'x' } })),
      false,
      'визуал мысли приходит только thought.updated',
    );
  });
});

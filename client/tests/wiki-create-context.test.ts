/**
 * Реестр контекста владельца поверхности (задача 8e4e3dc5, дефект визуальной
 * проверки 2026-10-11).
 *
 * Клик по легаси-ссылке `[[Имя]]` в ПРОСМОТРЕ при нуле кандидатов обязан
 * открыть диалог создания, а не уведомление «Мысль «…» не найдена.». Отказ
 * возникал потому, что поиск контекста был привязан к классу `.md-field`:
 * статичный просмотр без поля markdown (лента «Дневника», `recordView`) не
 * находил владельца, флоу создания возвращал `false` и звал уведомление.
 *
 * Красная фиксация: контекст находится на ПРОИЗВОЛЬНОМ привязанном корне (не
 * обязательно `.md-field`), поднимаясь по предкам; `*`-поведение прежней
 * реализации (`.closest('.md-field')`) роняло первый тест.
 *
 * Модуль чистый (без импортов) — под тестом минимальные фейковые элементы с
 * цепочкой `parentElement`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  bindWikiCreateContext,
  findWikiCreateContext,
  type WikiCreateCommentContext,
} from '../src/renderer/lib/wiki-create-context.js';

/** Минимальный элемент с цепочкой предков, как её видит `findWikiCreateContext`. */
interface FakeEl {
  parentElement: FakeEl | null;
}

function el(parent: FakeEl | null = null): FakeEl {
  return { parentElement: parent };
}

function asElement(node: FakeEl): Element {
  return node as unknown as Element;
}

function asRoot(node: FakeEl): HTMLElement {
  return node as unknown as HTMLElement;
}

const OWNER: WikiCreateCommentContext = { ownerType: 'thought', ownerId: 'a-thought' };

describe('findWikiCreateContext: контекст поверхности', () => {
  it('находит владельца на привязанном корне БЕЗ класса .md-field (красная фиксация)', () => {
    // Статичный просмотр ленты «Дневника»: корень оболочки — не `.md-field`.
    const surface = el();
    const link = el(surface);
    bindWikiCreateContext(asRoot(surface), OWNER);

    assert.deepEqual(findWikiCreateContext(asElement(link)), OWNER);
  });

  it('ближайший привязанный узел побеждает внешний', () => {
    const outer = el();
    const inner = el(outer);
    const leaf = el(inner);
    bindWikiCreateContext(asRoot(outer), { ownerType: 'thought', ownerId: 'outer' });
    bindWikiCreateContext(asRoot(inner), { ownerType: 'link', ownerId: 'inner' });

    assert.deepEqual(findWikiCreateContext(asElement(leaf)), {
      ownerType: 'link',
      ownerId: 'inner',
    });
  });

  it('ленивый источник читается при обращении; null — поиск продолжается выше', () => {
    const outer = el();
    const lazily = el(outer);
    const leaf = el(lazily);
    let calls = 0;
    bindWikiCreateContext(asRoot(outer), OWNER);
    bindWikiCreateContext(asRoot(lazily), () => {
      calls += 1;
      return null;
    });

    assert.deepEqual(findWikiCreateContext(asElement(leaf)), OWNER);
    assert.equal(calls, 1, 'ленивый источник должен быть вызван ровно при чтении');
  });

  it('без привязки на цепочке предков — null (диалог откроется без родителя)', () => {
    const leaf = el(el());
    assert.equal(findWikiCreateContext(asElement(leaf)), null);
  });

  it('null-элемент — null', () => {
    assert.equal(findWikiCreateContext(null), null);
  });
});

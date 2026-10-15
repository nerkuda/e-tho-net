/**
 * Сторож правила A1 «типовые операнды — без выборки» (ошибка 609deba0 п.1,
 * версия 0.13.1; элемент интерфейса f5005daa).
 *
 * Переключатель «Список ↔ Выборка» НЕ предлагается на типовых операндах
 * («Тип мысли»/«Тип связи»): редактор предлагал бы собирать отбор по МЫСЛЯМ там,
 * где значение — тип (сервер под-выборку по типам исполняет, ограничение —
 * только UI). Точка правды — `SUBQUERY_HIDDEN_KINDS` в
 * `lib/filter-subquery.ts` и её потребитель `filterSubqueryRelevantLeaf`.
 *
 * Прежде правило покрывалось лишь обычным `filter-subquery.test.ts`; по стандарту
 * чистоты запрет, нарушаемый кодом, действует только вместе со сторожем
 * `guard-*.test.ts` (мета-стандарт «Правило без теста-сторожа не считается
 * введённым»). Сторож вводится зелёным.
 *
 * Проверяется ПОВЕДЕНИЕ и в переборе по единому реестру видов/операторов ядра:
 * мутация «убрать скрытие типового операнда» (снять ветку `SUBQUERY_HIDDEN_KINDS`
 * из `filterSubqueryRelevantLeaf`) краснеет здесь на первом же поддерживаемом
 * операторе — перебор идёт по ВСЕМ операторам ядра, а не по одному.
 */

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import {
  FILTER_AST_ENTITY_KINDS,
  FILTER_AST_OPERATORS,
  type FilterAstEntityKind,
  type FilterAstOperator,
} from '@etn/shared';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Типовые операнды, которым выборка в 0.13.1 не предлагается. Ожидание зашито
 * явно: расширение/сужение набора обязано быть осознанным (правкой теста вместе
 * с правкой правила), а не тихим.
 */
const HIDDEN_KINDS_EXPECTED: readonly FilterAstEntityKind[] = ['link_type', 'type'];

let sub: typeof import('../src/renderer/lib/filter-subquery.js');

/** Минимальный DOM/window-шим, которого требуют фасады (как в filter-subquery.test.ts). */
function installShim(): void {
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    activeElement: null,
    querySelector: () => null,
  };
  const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
  win['innerWidth'] = 1200;
  win['innerHeight'] = 800;
  win['setTimeout'] = (fn: () => void) => {
    fn();
    return 1;
  };
  win['clearTimeout'] = () => undefined;
  win['addEventListener'] = () => undefined;
  win['removeEventListener'] = () => undefined;
  win['matchMedia'] = () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
}

/** Лист единой модели с заданным операндом/оператором. */
function leafOf(kind: FilterAstEntityKind, operator: FilterAstOperator): any {
  return { kind: 'leaf', entity: { kind }, operator, value: { kind: 'none' } };
}

/** Пустые данные сети: релевантность типовых операндов от свойств не зависит. */
const DATA: any = { registry: new Map(), linkTypes: [] };

describe('guard: типовые операнды — без выборки (правило A1, ошибка 609deba0 п.1)', () => {
  before(async () => {
    installShim();
    sub = await import('../src/renderer/lib/filter-subquery.js');
  });

  it('скрыты РОВНО типовые операнды (type/link_type) по единому реестру видов', () => {
    const hidden = FILTER_AST_ENTITY_KINDS.filter((kind) => sub.filterSubqueryHidden(kind));
    assert.deepEqual(
      [...hidden].sort(),
      [...HIDDEN_KINDS_EXPECTED].sort(),
      'набор скрытых видов разошёлся с ожиданием (правило A1)',
    );
  });

  it('ни на одном операторе ядра скрытый операнд не получает переключатель режима', () => {
    // Перебор по ВСЕМ операторам ядра: если скрытие типового операнда пропадёт,
    // первый же поддерживаемый оператор (`in`) вернёт true и сторож покраснеет.
    for (const kind of HIDDEN_KINDS_EXPECTED) {
      for (const operator of FILTER_AST_OPERATORS) {
        assert.equal(
          sub.filterSubqueryRelevantLeaf(leafOf(kind, operator), DATA),
          false,
          `типовой операнд «${kind}» не должен получать выборку (оператор ${operator})`,
        );
      }
    }
  });

  it('обратная сторона: нетривиальные ссылочные операнды выборку получают', () => {
    // Сторож ловит и обратную поломку — «скрыть всё»: структурные операнды и
    // «Мысль» обязаны сохранять переключатель.
    for (const operator of ['in', 'not_in', 'in_hierarchy'] as const) {
      assert.equal(
        sub.filterSubqueryRelevantLeaf(leafOf('parents', operator), DATA),
        true,
        `«Родители» обязаны получать выборку (оператор ${operator})`,
      );
    }
    assert.equal(sub.filterSubqueryRelevantLeaf(leafOf('id', 'in'), DATA), true, '«Мысль» — наборная выборка');
  });
});

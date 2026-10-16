/**
 * Сторож: списки операторов в теме `etn.guide` совпадают с реестром профилей
 * отбора (`shared/src/filter-profiles.ts`).
 *
 * Исходный дефект (ошибка 71f547c1): тема `etn.guide { topic: "activity.list" }`
 * описывала операторы «Типа действия» как `eq/ne/contains/not_contains/in/not_in`,
 * а профиль «события» (`EVENT_OPERATOR_SETS.action`) принимает ТОЛЬКО `in`/`not_in`.
 * Агент, читающий справку, строил невалидное тело и получал `VALIDATION_ERROR`
 * «оператор недопустим в точке применения». Тот же класс — расхождение справки и
 * реестра в ЛЮБУЮ сторону: справка шире реестра обещает невалидный ввод, уже —
 * прячет рабочие операторы.
 *
 * Правило (согласовано при работе над 71f547c1): каждый операнд профиля,
 * перечисленный в теме гайда, объявляет РОВНО тот набор операторов, что и реестр.
 * Тема обязана документировать каждый операнд профиля (полнота) и не обещать
 * оператора вне реестра (точность). Сторож парсит операторные списки
 * (markdown-спаны вида `` `op/op/…` ``) в буллетах `` - `operand` — … `` и
 * сверяет их с `FILTER_PROFILES[profile].operand_operators`.
 *
 * Охват — тема `activity.list` (профиль `events`). Прочие темы-таблицы
 * (`thoughts.query`, `chronicle`) — предметный отбор: они могут намеренно
 * перечислять ПОДмножество операторов (напр. «текстовые» операторы свойства), а
 * не исчерпывающий список, поэтому здесь не проверяются.
 *
 * Тест читает `GUIDE_TOPICS` напрямую (без поднятия MCP-сессии): контракт темы —
 * её текст, а не транспорт. Нативный биндинг не нужен.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FILTER_PROFILES } from '@etn/shared';

import { GUIDE_TOPICS_BY_NAME } from '../src/mcp/tools/ops-catalog.js';

/** Буллет темы: `- \`operand\` — …`. */
const OPERAND_BULLET = /^-\s+`([a-z_]+)`\s+—\s+(.*)$/;

/** Операторный спан `` `a/b/c` `` (минимум два оператора через `/`). */
const OPERATOR_SPAN = /`([a-z][a-z_]*\/[a-z_/]*)`/g;

/**
 * Секция темы с операндами AST-тела: от строки-заголовка списка до следующего
 * раздела (`## …`). Вне неё буллеты `` - `limit` — … `` описывают параметры
 * пагинации, а не операнды, и в сверку попадать не должны.
 */
function operandSection(bodyMd: string): string {
  const lines = bodyMd.split('\n');
  const start = lines.findIndex((l) => l.includes('Операнды записи события'));
  assert.ok(start !== -1, 'в теме activity.list не найдена секция «Операнды записи события»');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i]!.startsWith('## ')) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/**
 * Операторы, объявленные в буллетах темы по операндам. Возврат — карта
 * `operand → Set<operator>`; операнд без буллета в карту не попадает.
 */
function declaredOperators(bodyMd: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const line of bodyMd.split('\n')) {
    const bullet = OPERAND_BULLET.exec(line);
    if (bullet === null) continue;
    const [, operand, rest] = bullet;
    const ops = out.get(operand!) ?? new Set<string>();
    OPERATOR_SPAN.lastIndex = 0;
    let span: RegExpExecArray | null;
    while ((span = OPERATOR_SPAN.exec(rest!)) !== null) {
      for (const op of span[1]!.split('/')) if (op.length > 0) ops.add(op);
    }
    out.set(operand!, ops);
  }
  return out;
}

describe('guard: списки операторов темы гайда = реестр профилей (71f547c1)', () => {
  it('activity.list: каждый операнд профиля «события» документирован ровно по реестру', () => {
    const topic = GUIDE_TOPICS_BY_NAME.get('activity.list');
    assert.ok(topic !== undefined, 'тема activity.list обязана быть в реестре гайда');

    const registry = FILTER_PROFILES.events.operand_operators!;
    const declared = declaredOperators(operandSection(topic.body_md));

    for (const [operand, expected] of Object.entries(registry)) {
      const actual = declared.get(operand);
      assert.ok(actual !== undefined, `операнд «${operand}» не документирован в теме activity.list`);
      assert.deepEqual(
        [...actual].sort(),
        [...expected].sort(),
        `операторы «${operand}» в теме activity.list разошлись с реестром профиля events`,
      );
    }

    // Обратная сторона: тема не объявляет операндов, которых нет в профиле.
    for (const operand of declared.keys()) {
      assert.ok(
        operand in registry,
        `тема activity.list документирует операнд «${operand}», которого нет в профиле events`,
      );
    }
  });
});

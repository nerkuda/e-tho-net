/**
 * Сторож: списки операторов в темах `etn.guide` совпадают с реестром профилей
 * отбора (`shared/src/filter-profiles.ts`).
 *
 * Исходный дефект (ошибка 71f547c1): тема `etn.guide { topic: "activity.list" }`
 * описывала операторы «Типа действия» как `eq/ne/contains/not_contains/in/not_in`,
 * а профиль «события» (`EVENT_OPERATOR_SETS.action`) принимает ТОЛЬКО `in`/`not_in`.
 * Тот же класс шире (ошибка 6a224eba): таблица операндов мыслей в теме
 * `thoughts.query` занижала наборы относительно `THOUGHT_OPERATOR_SETS` /
 * `PROPERTY_OPERATOR_SETS` (не было оператора `id`, `any_of`/`none_of` у типа,
 * `between`/`not_between` у датовых, `is_empty`/`not_empty` у свойств и т.д.).
 * Агент, читающий справку, строил невалидное тело либо не знал о рабочих
 * операторах; класс — расхождение справки и реестра в ЛЮБУЮ сторону.
 *
 * Правило (согласовано при работе над 71f547c1): каждый операнд профиля,
 * перечисленный в теме гайда, объявляет РОВНО тот набор операторов, что и реестр.
 * Тема обязана документировать каждый операнд профиля (полнота) и не обещать
 * оператора вне реестра (точность). Сторож парсит буллеты `` - `operand` — … ``,
 * беря список операторов из бэктик-спанов-перечислений (операторы через `/`;
 * список может быть разбит на несколько спанов, как у `entity_id` профиля
 * «события»), а при отсутствии таких спанов — одиночный оператор из первого
 * бэктик-сегмента после тире (операнд `keywords` — только `matches`). Сверка —
 * с `FILTER_PROFILES[profile].operand_operators`.
 *
 * Полиморфный операнд «Свойство» в теме мыслей раскрыт по природе свойства:
 * буллет-указатель `property` плюс наборы `` `property: <value_type>` ``,
 * сверяемые с `operand_operators_by_value_type`.
 *
 * Охвачены обе темы-списка: `thoughts.query` (профиль `thoughts`) и
 * `activity.list` (профиль `events`). Прочая справка по AST — прозаическая
 * (секция хроники в теме мыслей), её можно покрыть тем же способом при переводе
 * списка в буллеты.
 *
 * Тест читает `GUIDE_TOPICS` напрямую (без поднятия MCP-сессии): контракт темы —
 * её текст, а не транспорт. Нативный биндинг не нужен.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FILTER_PROFILES, type FilterProfileId } from '@etn/shared';

import { GUIDE_TOPICS_BY_NAME } from '../src/mcp/tools/ops-catalog.js';

/** Буллет темы: `- \`operand\` — …`; полиморфный — `- \`operand: variant\` — …`. */
const OPERAND_BULLET = /^-\s+`([a-z_]+(?::\s+[a-z_]+)?)`\s+—\s+(.*)$/;

/** Спан-перечисление операторов `` `a/b/c` `` (минимум два через `/`). */
const OPERATOR_SPAN = /`([a-z][a-z_]*\/[a-z_/]*)`/g;

/** Одиночный оператор: первый бэктик-сегмент после тире (напр. `matches`). */
const LEADING_OPERATOR_LIST = /^`([a-z][a-z_]*)`/;

/**
 * Секция темы со списком операндов: от строки с маркером до ближайшего заголовка
 * (`# …`). Вне неё буллеты `` - `limit` — … `` описывают параметры пагинации, а не
 * операнды, и в сверку попадать не должны.
 */
function operandSection(bodyMd: string, marker: string): string {
  const lines = bodyMd.split('\n');
  const start = lines.findIndex((l) => l.includes(marker));
  assert.ok(start !== -1, `в теме не найдена секция операндов («${marker}»)`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i]!.startsWith('#')) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/**
 * Операторы, объявленные в буллетах темы по операндам. Возврат — карта
 * `operand → Set<operator>`; операнд без буллета в карту не попадает. Сначала
 * собираются спаны-перечисления со слэшами; если таких нет — берётся одиночный
 * оператор из первого бэктик-сегмента после тире.
 */
function declaredOperators(section: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const line of section.split('\n')) {
    const bullet = OPERAND_BULLET.exec(line);
    if (bullet === null) continue;
    const [, operand, rest] = bullet;
    const ops = out.get(operand!) ?? new Set<string>();
    OPERATOR_SPAN.lastIndex = 0;
    let span: RegExpExecArray | null;
    while ((span = OPERATOR_SPAN.exec(rest!)) !== null) {
      for (const op of span[1]!.split('/')) if (op.length > 0) ops.add(op);
    }
    if (ops.size === 0) {
      const lead = LEADING_OPERATOR_LIST.exec(rest!);
      if (lead !== null) ops.add(lead[1]!);
    }
    out.set(operand!, ops);
  }
  return out;
}

/**
 * Сверка одной темы с реестром её профиля: полнота и точность по каждому
 * операнду (прямая проверка) плюс отсутствие операндов вне профиля (обратная).
 */
function assertTopicMatchesRegistry(
  profileId: FilterProfileId,
  topicName: string,
  marker: string,
): void {
  const topic = GUIDE_TOPICS_BY_NAME.get(topicName);
  assert.ok(topic !== undefined, `тема ${topicName} обязана быть в реестре гайда`);

  const profile = FILTER_PROFILES[profileId];
  const registry = profile.operand_operators!;
  const byValueType = profile.operand_operators_by_value_type;
  const declared = declaredOperators(operandSection(topic.body_md, marker));

  /** Ключи-поднаборы полиморфного операнда (`property: <value_type>`). */
  const variantKeys = new Set<string>();

  for (const [operand, expected] of Object.entries(registry)) {
    if (byValueType !== undefined && operand === 'property') {
      // Полиморфный операнд: буллет-указатель + по одному набору на `value_type`.
      assert.ok(declared.has('property'), `операнд «property» не документирован в теме ${topicName}`);
      for (const [valueType, vtOps] of Object.entries(byValueType)) {
        const key = `property: ${valueType}`;
        variantKeys.add(key);
        const actual = declared.get(key);
        assert.ok(actual !== undefined, `«${key}» не документирован в теме ${topicName}`);
        assert.deepEqual(
          [...actual].sort(),
          [...vtOps].sort(),
          `операторы «${key}» в теме ${topicName} разошлись с реестром профиля ${profileId}`,
        );
      }
      continue;
    }
    const actual = declared.get(operand);
    assert.ok(actual !== undefined, `операнд «${operand}» не документирован в теме ${topicName}`);
    assert.ok(actual.size > 0, `буллет «${operand}» в теме ${topicName} не называет операторов`);
    assert.deepEqual(
      [...actual].sort(),
      [...expected].sort(),
      `операторы «${operand}» в теме ${topicName} разошлись с реестром профиля ${profileId}`,
    );
  }

  // Обратная сторона: тема не объявляет операндов, которых нет в профиле.
  for (const operand of declared.keys()) {
    assert.ok(
      operand in registry || variantKeys.has(operand),
      `тема ${topicName} документирует операнд «${operand}», которого нет в профиле ${profileId}`,
    );
  }
}

describe('guard: списки операторов темы гайда = реестр профилей (71f547c1, 6a224eba)', () => {
  it('thoughts.query: операнды профиля мыслей документированы ровно по реестру', () => {
    assertTopicMatchesRegistry('thoughts', 'thoughts.query', 'Операнды (`entity.kind`)');
  });

  it('activity.list: каждый операнд профиля «события» документирован ровно по реестру', () => {
    assertTopicMatchesRegistry('events', 'activity.list', 'Операнды записи события');
  });
});

/**
 * Сторож: гайд MCP не отстаёт от реализации грамматики повтора и контрактов
 * задач/напоминаний (ошибки b87dc2db, 56ffc776).
 *
 * `etn.guide` — единственная MCP-документация действий: агент строит сценарии
 * по её тексту, а не по коду. Два класса расхождений уже приводили к живым
 * дефектам:
 *  • текст темы `reminders` описывал старую редакцию грамматики повтора
 *    (не упоминались `every_weeks`/`every_years`/`skip_weekends`) и обещал
 *    «прижатие к последнему дню» вместо ПРОПУСКА месяца/года (решение
 *    пользователя 2026-11-16, требование bbca8f7d; реализация —
 *    `shared/src/reminder-repeat.ts`);
 *  • в секции `params` трёх действий не хватало полей, объявленных контрактами
 *    (`occurrence_at` у `reminders.snooze`/`reminders.dismiss`,
 *    `include_nested` у `tasks.list`): `etn.ops` их принимает, а гайд о них
 *    молчит — агент снова адресует «ближайшее» вхождение (ошибка 31e2a374) или
 *    не знает, что вложенные строки можно дочитать.
 *
 * Сторож статический (без БД и MCP-сессии): сверяет текст темы с грамматикой по
 * ключевым словам и `entry.params` со схемой `entry.paramsContract` для групп
 * `tasks.*`/`reminders.*`. Проверяются ВСЕ ключи схемы, а не только
 * обязательные: `occurrence_at` необязателен, но его отсутствие в гайде —
 * именно тот дефект, который сторож закрывает.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GUIDE_TOPICS_BY_NAME, OPS_ACTIONS } from '../src/mcp/tools/ops-catalog.js';

/** Ключи закрытой грамматики повтора (поля интервалов и перенос выходных). */
const GRAMMAR_INTERVAL_KEYS = [
  'every_weeks',
  'every_months',
  'every_years',
  'skip_weekends',
] as const;

describe('guard: гайд reminders/tasks совпадает с грамматикой и контрактами (b87dc2db, 56ffc776)', () => {
  it('тема reminders знает интервалы грамматики и ПРОПУСК краёв серии', () => {
    const topic = GUIDE_TOPICS_BY_NAME.get('reminders');
    assert.ok(topic !== undefined, 'тема reminders есть в реестре гайда');
    const text = topic.body_md;

    for (const key of GRAMMAR_INTERVAL_KEYS) {
      assert.ok(text.includes(key), `тема reminders не упоминает \`${key}\` из грамматики`);
    }
    // Каждое поле — рядом со своим типом расписания (таблица грамматики).
    assert.match(text, /weekdays[^\n]*every_weeks/, 'weekdays: нет интервала every_weeks');
    assert.match(
      text,
      /weekday_of_month[^\n]*every_months/,
      'weekday_of_month: нет интервала every_months',
    );
    assert.match(text, /yearly[^\n]*every_years/, 'yearly: нет интервала every_years');
    assert.match(text, /every_days[^\n]*skip_weekends/, 'every_days: нет skip_weekends');

    // Края серии — ПРОПУСК месяца/года, а не прижатие к последнему дню
    // (decision 2026-11-16): обратная семантика подталкивала агента строить
    // неверные сценарии и подсказки пользователю.
    assert.equal(
      /fall\s*back/i.test(text),
      false,
      'тема reminders снова обещает «fall back» на последний день вместо пропуска',
    );
    assert.match(text, /skipped/i, 'тема reminders не описывает пропуск вхождения');

    // Та же грамматика обязана быть в `params` действия создания напоминания:
    // именно этот текст агент видит при `etn.guide { topic: "reminders.create" }`.
    const create = OPS_ACTIONS.find((entry) => entry.action === 'reminders.create');
    assert.ok(create !== undefined, 'действие reminders.create есть в реестре');
    const schedule = create.params.find((param) => param.name === 'schedule');
    assert.ok(schedule !== undefined, 'params reminders.create описывает `schedule`');
    for (const key of GRAMMAR_INTERVAL_KEYS) {
      assert.ok(
        schedule.desc.includes(key),
        `params reminders.create не упоминает \`${key}\` — гайд отстал от грамматики`,
      );
    }
  });

  it('params tasks.*/reminders.* покрывают поля своих контрактов', () => {
    const violations: string[] = [];
    for (const entry of OPS_ACTIONS) {
      if (entry.group !== 'tasks' && entry.group !== 'reminders') continue;
      const shape = (entry.paramsContract.schema as unknown as { shape?: Record<string, unknown> })
        .shape;
      if (shape === undefined) {
        violations.push(`  • ${entry.action}: у контракта нет объектной схемы`);
        continue;
      }
      const documented = new Set(entry.params.map((param) => param.name));
      for (const key of Object.keys(shape)) {
        if (!documented.has(key)) {
          violations.push(
            '  • ' + entry.action + ': поле `' + key + '` контракта не описано в params гайда',
          );
        }
      }
    }
    assert.deepEqual(
      violations,
      [],
      'Секция params гайда разошлась с контрактами (etn.ops принимает эти поля, агент о них не знает):\n' +
        violations.join('\n'),
    );
  });
});

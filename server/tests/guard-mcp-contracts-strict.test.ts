/**
 * Сторож: схемы верхнего уровня ВСЕХ зарегистрированных контрактов — `.strict()`
 * (задача c245e7de, после ea4581c5). Неизвестный ключ верхнего уровня в любом
 * MCP/REST-контракте обязан отвергаться `VALIDATION_ERROR` с `details.fields`,
 * а не молча отбрасываться. До правки тройки (`etn.thoughts.write` /
 * `etn.ontology.write` / `etn.thoughts.bulk_update`) почти все контракты
 * наследовали `z.object({...})` без `.strict()` — опечатка в имени ключа
 * (`duplicate_policyy`, `parent_ids` вне `args`, `links` в корне `write`)
 * теряла намерение агента без сигнала.
 *
 * Гарантия идёт из `defineContract` (см. `server/src/contracts.ts`): если
 * переданная схема — `z.ZodObject`, она автоматически оборачивается в `.strict()`.
 * Для схем с `.refine()` (ZodEffects) `.strict()` ставится ДО refine
 * (`SearchFields`, `QueryFields`, `GetCommentFields`, `EditCommentFields`,
 * `MentionsScanFields`). Этот сторож краснеет, если кто-то снова забудет:
 *  - добавил новый контракт через `z.object({...})` без strict;
 *  - обернул `z.object({...}).refine(...)` без `.strict()` перед refine;
 *  - передал в `defineContract` ZodEffects, у которого внутренний ZodObject
 *    не strict.
 *
 * Подобно `guard-server-layers`/`guard-db-layer` — падает на каждой регрессии
 * при обычном `npm test`, поэтому правило действует вместе со сторожем
 * («правило без сторожа не считается введённым», AGENTS.md §2 п.5).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { contractsByName } from '../src/contracts.js';

/** Проверочный ключ, который не должен совпасть ни с одним реальным полем. */
const PROBE_KEY = '__bogus_strict_probe_key__';

/** Контракт считается strict, если его схема отвергает неизвестный ключ PROBE_KEY.
 *  Проверяем через `safeParse` — это работает и для ZodObject (где `.strict()`
 *  добавляется `defineContract`), и для ZodEffects с внутренним strict-объектом
 *  (например, `SearchFields.strict().refine(...)`). */
function isStrict(schema: { safeParse: (input: unknown) => { success: boolean; error?: { issues: Array<{ code: string; keys?: unknown[] }> } } }): boolean {
  const res = schema.safeParse({ [PROBE_KEY]: 1 });
  if (res.success) {
    // Схема с required-полями не пройдёт без них — это не значит «не strict».
    // Но если прошла С `PROBE_KEY` и без required — точно не strict (лишний ключ принят).
    return false;
  }
  const issues = res.error?.issues ?? [];
  for (const issue of issues) {
    if (issue.code === 'unrecognized_keys' && Array.isArray(issue.keys) && issue.keys.includes(PROBE_KEY)) {
      return true;
    }
  }
  // Схема упала, но НЕ из-за `PROBE_KEY` — скорее всего, required-поле не заполнено.
  // Чтобы отделить «не strict, но required не заполнен» от «strict, но required не заполнен»,
  // повторяем safeParse с заполненным required-минимумом: подсунем `network_id` как пустышку,
  // и снова добавим PROBE_KEY. Если после этого осталась только `unrecognized_keys` —
  // strict; иначе — нет.
  const withDummy = schema.safeParse({ [PROBE_KEY]: 1, network_id: 'x' });
  if (withDummy.success) return false;
  for (const issue of withDummy.error?.issues ?? []) {
    if (issue.code === 'unrecognized_keys' && Array.isArray(issue.keys) && issue.keys.includes(PROBE_KEY)) {
      return true;
    }
  }
  // Доп. попытка — почти у всех контрактов первый required — это `network_id` или `lock_id`.
  // Если даже с `network_id: 'x'` + PROBE нет `unrecognized_keys` — значит схема не strict
  // (либо имеет другие required, до которых мы не добрались — это уже отдельный кейс).
  return false;
}

describe('guard: контракты MCP верхнего уровня — .strict()', () => {
  it('все MCP-схемы (etn.*), зарегистрированные через defineContract, отвергают неизвестный ключ', () => {
    const violations: string[] = [];
    for (const [name, contract] of contractsByName) {
      // Только MCP-контракты — REST (`rest:`) исторически опирается на
      // rest-карту как на единственный источник объявленных полей и может
      // иметь поля вне общей схемы; strict для REST — отдельный заход.
      if (!name.startsWith('etn.')) continue;
      if (!isStrict(contract.schema)) {
        violations.push(`  • ${name}: схема не .strict() — лишний ключ верхнего уровня не отвергается`);
      }
    }
    assert.deepEqual(
      violations,
      [],
      `Найдены MCP-контракты без .strict() (задача c245e7de, после ea4581c5).\n` +
        `Любой MCP-инструмент без .strict() теряет опечатки в ключах без сигнала.\n` +
        `Чинить: либо передавать в defineContract уже strict-схему ` +
        `(или z.strictObject(...)), либо добавить .strict() ДО .refine() для ZodEffects:\n` +
        violations.join('\n'),
    );
  });

  it('реестр MCP-контрактов не пуст (защита от случайного обнуления)', () => {
    let mcpCount = 0;
    for (const name of contractsByName.keys()) if (name.startsWith('etn.')) mcpCount++;
    assert.ok(mcpCount > 50, `ожидалось много MCP-контрактов, найдено ${mcpCount}`);
  });
});

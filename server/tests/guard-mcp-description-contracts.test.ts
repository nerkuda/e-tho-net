/**
 * Сторож: контрактные формулировки в описаниях MCP-инструментов.
 *
 * Аудит 0.14.1 показал систематический дефект: фактическое поведение
 * инструмента уже расширено, а `description` в `tools/list` об этом молчит —
 * агент планирует вызов по неполному контракту и делает ложные выводы
 * (ошибки d47e5ba3, feb520de, 1eaf36df, 6ff9749f, 8a87586d). Класс повторяемый:
 * те же формулировки живут в трёх местах (код, MCP-описание, тема `etn.guide`),
 * и при правке поведения легко забыть про описание.
 *
 * Сторож фиксирует только те фразы, которые несут смысл контракта (параметр,
 * семантика совпадения, исключение из выдачи), а не дословную редакцию:
 * переформулировка допустима, потеря смысла — нет.
 *
 * Проверка идёт по реально рекламируемому каталогу (`tools/list`), а не по
 * исходникам: агент видит именно его. Правило действует вместе со сторожем
 * (AGENTS.md §2 п.5).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  nativeAvailable,
} from './mcp-helpers.js';

/** Описания инструментов из `tools/list` по имени. */
async function toolDescriptions(): Promise<Map<string, string>> {
  const ctx = await buildMcpContext();
  try {
    const handle = await connectMcpClient(ctx, ctx.adminKey);
    try {
      const { tools } = await handle.client.listTools();
      return new Map(tools.map((t) => [t.name, t.description ?? '']));
    } finally {
      await handle.close();
    }
  } finally {
    await closeMcpContext(ctx);
  }
}

/** Описание инструмента; отсутствие инструмента — провал сторожа. */
function descriptionOf(all: Map<string, string>, name: string): string {
  const description = all.get(name);
  assert.ok(description !== undefined, `инструмент ${name} отсутствует в tools/list`);
  return description;
}

/** Каждая фраза обязана присутствовать в описании. */
function assertMentions(description: string, name: string, phrases: string[]): void {
  const missing = phrases.filter((phrase) => !description.includes(phrase));
  assert.deepEqual(
    missing,
    [],
    `${name}: описание потеряло контрактные формулировки: ${missing.join(' | ')}\n---\n${description}`,
  );
}

describe('guard: MCP — описания несут контрактные формулировки', { skip: !nativeAvailable() }, () => {
  it('etn.chronicle.query документирует keywords/keyword_scope и *-синонимы (d47e5ba3)', async () => {
    const all = await toolDescriptions();
    const description = descriptionOf(all, 'etn.chronicle.query');
    assertMentions(description, 'etn.chronicle.query', [
      '`keywords`',
      '`keyword_scope`',
      '§6.10',
      '`*`-синонима',
    ]);
  });

  it('etn.instructions: ROOT only — нет ДРУГОЙ инструкции среди родителей (feb520de)', async () => {
    const all = await toolDescriptions();
    const description = descriptionOf(all, 'etn.instructions');
    assertMentions(description, 'etn.instructions', [
      'INSTRUCTION among structural parents',
      'sections/catalogues',
      // 0.14.1 (задача 54573522): keywords-режим корневой фильтр не применяет —
      // под-инструкции находятся keywords или scope:"all" (instructions-service.ts).
      'of ALL instructions incl. sub-instructions',
    ]);
    assert.ok(
      !description.includes('no untyped parent link'),
      `etn.instructions: вернулась вводящая в заблуждение формулировка «no untyped parent link»\n---\n${description}`,
    );
  });

  it('etn.thoughts.find_duplicates перечисляет четвёртый тир — stored *-синоним (1eaf36df)', async () => {
    const all = await toolDescriptions();
    const description = descriptionOf(all, 'etn.thoughts.find_duplicates');
    assertMentions(description, 'etn.thoughts.find_duplicates', [
      'stored `*`-synonym',
      'WHOLE term',
      'word boundaries',
      '`matched_on: "synonym"`',
      '`matched_synonym`',
    ]);
  });

  it('etn.thoughts.query: NOT_FOUND для плоских имён, только id в ast-листьях, unresolved — только ast-токены (6ff9749f, 54573522)', async () => {
    const all = await toolDescriptions();
    const description = descriptionOf(all, 'etn.thoughts.query');
    assertMentions(description, 'etn.thoughts.query', [
      'неизвестное имя в плоских полях — `NOT_FOUND`',
      'значения `ast`-листьев — только id',
      'не резолвятся и молча не совпадают',
      '`ast`-токен → пустая страница и `unresolved`',
    ]);
    // «Пустая страница и `unresolved`» — корректная семантика ТОЛЬКО для
    // ast-токенов (проба: `$thought.id` → hits: [], unresolved: […]): для
    // плоских имён ответ — `NOT_FOUND`, поля `unresolved` нет. Сторож запрещает
    // вернуть формулировку БЕЗ привязки к ast-токенам, но не блокирует
    // корректную клаузу (задача 54573522); семантика `views.run` — свой сторож
    // ниже, её проверка не расширяется.
    const phrase = 'пустая страница и `unresolved`';
    const scopedPhrase = '`ast`-токен → пустая страница и `unresolved`';
    const occurrences = description.split(phrase).length - 1;
    const scopedOccurrences = description.split(scopedPhrase).length - 1;
    assert.equal(
      occurrences,
      scopedOccurrences,
      `etn.thoughts.query: «${phrase}» допустимо только с привязкой к ast-токенам ` +
        `(плоские имена дают NOT_FOUND) — найдено ${occurrences} упоминаний, ` +
        `из них в корректной форме ${scopedOccurrences}\n---\n${description}`,
    );
  });

  it('etn.views.run: якорная мысль исключается из выдачи и total (8a87586d)', async () => {
    const all = await toolDescriptions();
    const description = descriptionOf(all, 'etn.views.run');
    assertMentions(description, 'etn.views.run', [
      '`thought_id` исключается из выдачи и `total`',
      '`etn.thoughts.get`',
      // 0.14.1 (задача 54573522): `total` корректируется только когда якорь
      // попал на страницу (REST-спека c989a4e2) — оговорка обязательна.
      '`total` уменьшается, только если якорь попал на страницу',
    ]);
  });
});

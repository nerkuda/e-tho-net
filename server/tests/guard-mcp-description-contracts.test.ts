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
    ]);
    assert.ok(
      !description.includes('no untyped parent link'),
      `etn.instructions: вернулась вводящая в заблуждение формулировка «no untyped parent link»\n---\n${description}`,
    );
  });
});

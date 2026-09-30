/**
 * Сторож: полнота справочника `etn.guide` относительно набора инструментов MCP
 * (ошибка 5f08daee-5bb6-45c5-a7ed-53eda44c3c38).
 *
 * Правило (согласовано при планировании 0.10.3). У каждой операции постоянного
 * набора MCP есть либо полное описание в `tools/list`, либо тема в `etn.guide`.
 * Инструмент, чьё описание выносит детали в справочник, обязан ссылаться на
 * существующую тему вида `etn.guide { topic: "<имя>" }`; справочник, в свою
 * очередь, обязан знать каждое такое имя. Расхождение (тема исчезла из
 * реестра, а ссылка в описании осталась) роняет сторож при обычном `npm test`.
 *
 * Исходный дефект: `etn.activity.list` был в постоянном наборе (`tools/list`),
 * но выпал из реестра гайда — группа `activity` знала только `rollup`/
 * `truncate`; `etn.guide { topic: "activity.list" }` падал VALIDATION_ERROR.
 * Так как правило действует на будущее, сторож фиксирует три инварианта:
 *
 *   1. фактический `tools/list` совпадает с каноническим `MCP_TOOL_NAMES`;
 *   2. каждая ссылка описания на тему гайда резолвится в `etn.guide`;
 *   3. каждое имя гайда (тема или редкое действие) реально отдаётся
 *      `etn.guide { topic }` — реестр и обработчик не разошлись.
 *
 * Сторож поднимает реальную MCP-сессию (`buildMcpContext` + `connectMcpClient`)
 * поверх production-фабрики `createMcpServer`, поэтому видит именно тот набор
 * инструментов и тот справочник, что увидят агенты.
 *
 * Пропускается, если нативный биндинг `better-sqlite3` недоступен.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MCP_TOOL_NAMES } from '@etn/shared';

import { GUIDE_TOPIC_NAMES, OPS_ACTION_NAMES } from '../src/mcp/tools/ops-catalog.js';
import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  nativeAvailable,
  toolText,
} from './mcp-helpers.js';

/**
 * Ссылка описания инструмента на тему гайда. Именно этот формат используют
 * `ontology.write`, `thoughts.query` и `activity.list`; он и есть контракт,
 * который проверяет сторож.
 */
const GUIDE_TOPIC_REF = /etn\.guide\s*\{\s*topic:\s*"([^"]+)"\s*\}/g;

/** Нормализовать имя темы: убрать необязательный префикс `etn.`. */
function normalizeTopic(topic: string): string {
  return topic.replace(/^etn\./, '');
}

describe('guard: справочник etn.guide покрывает набор инструментов MCP (5f08daee)', { skip: !nativeAvailable() }, () => {
  it('tools/list совпадает с MCP_TOOL_NAMES, а каждая ссылка на тему гайда резолвится', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const listed = await handle.client.listTools();
        const registered = listed.tools.map((t) => t.name).sort();

        // 1. Витрина не разошлась с каноническим списком инструментов.
        assert.deepEqual(
          registered,
          [...MCP_TOOL_NAMES].sort(),
          'набор инструментов tools/list разошёлся с MCP_TOOL_NAMES (shared/src/types/mcp.ts)',
        );

        const topicNames = new Set(GUIDE_TOPIC_NAMES.map(normalizeTopic));
        const violations: string[] = [];

        for (const tool of listed.tools) {
          const description = tool.description ?? '';
          // «Полное описание в tools/list»: описание обязано быть непустым.
          if (description.trim().length === 0) {
            violations.push(`  • ${tool.name}: пустое описание в tools/list`);
          }
          // 2. Каждая ссылка на тему обязана существовать в реестре гайда.
          for (const match of description.matchAll(GUIDE_TOPIC_REF)) {
            const ref = normalizeTopic(match[1]!);
            if (!topicNames.has(ref)) {
              violations.push(
                `  • ${tool.name}: описание ссылается на тему «${match[1]}», которой нет в GUIDE_TOPICS`,
              );
            }
          }
        }

        assert.deepEqual(
          violations,
          [],
          'Операции набора MCP ссылаются на несуществующие темы etn.guide (ошибка 5f08daee).\n' +
            'У каждой операции должно быть либо полное описание в tools/list, либо существующая тема:\n' +
            violations.join('\n'),
        );

        // Ни одно действие реестра не должно маскироваться под тему и наоборот.
        const opsSet = new Set(OPS_ACTION_NAMES);
        for (const topic of GUIDE_TOPIC_NAMES) {
          assert.equal(
            opsSet.has(topic),
            false,
            `имя «${topic}» одновременно и тема гайда, и редкое действие — двусмысленный резолв`,
          );
        }
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('каждое имя гайда (тема и редкое действие) реально отдаётся etn.guide { topic }', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const failures: string[] = [];
        for (const name of [...OPS_ACTION_NAMES, ...GUIDE_TOPIC_NAMES]) {
          const res = await handle.client.callTool({
            name: 'etn.guide',
            arguments: { topic: name },
          });
          if (res.isError === true) {
            const text = toolText(res);
            failures.push(`  • ${name}: ${text.split('\n')[0] ?? text}`);
            continue;
          }
          assert.ok(toolText(res).trim().length > 0, `гайд по теме «${name}» вернул пустой текст`);
        }
        assert.deepEqual(
          failures,
          [],
          'etn.guide { topic } не отдаёт часть имён реестра (ошибка 5f08daee):\n' + failures.join('\n'),
        );
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});

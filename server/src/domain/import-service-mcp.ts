/**
 * MCP-фасад над `etn.import.*` (задача e488f4c1, версия 0.7.2).
 *
 * Поверх уже существующего `import-service.ts` (`importFromEtnx` +
 * `previewFromEtnx`) добавляем:
 *
 *   * `planImportFromBuffer` — читает .etnx-архив (Buffer) и возвращает
 *     план: что создастся / переиспользуется / пропустится. Используется
 *     и для `dry_run`, и для `subgraph` (перед запуском, для отчёта).
 *   * `importFromBuffer` — обёртка над `importFromEtnx`, принимающая
 *     `Buffer` вместо пути к файлу.
 *
 * Чтение источника (`etnx_file` / `etnx_base64`) делает MCP-фасад.
 */

import { Buffer } from 'node:buffer';

import { readFileSync } from 'node:fs';

import {
  EtnError,
  ETNX_MAX_BYTES,
  type McpImportPolicy,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import type { Logger } from '../logger.js';
import {
  importFromEtnx,
  planImportThoughts,
  readManifestFromBuffer,
  type ImportOptions,
  type ImportResult,
} from './import-service.js';
import { parseManifest } from './etnx-format.js';

/** Результат `planImportFromBuffer` — что произойдёт при импорте. */
export interface ImportPlanResult {
  manifest_version: string;
  source_network_name?: string;
  plan: {
    thoughts_to_create: number;
    thoughts_to_reuse: number;
    thoughts_to_skip: number;
    /** `fail` + конфликты: импорт будет отвергнут целиком (0.8.3). */
    rejected: boolean;
    links_to_create: number;
    attachments_to_import: number;
    thought_types_to_create: number;
    thought_types_to_reuse: number;
    link_types_to_create: number;
    link_types_to_reuse: number;
  };
  conflicts: Array<{ kind: string; title?: string; id?: string; reason: string }>;
}

/**
 * Прочитать .etnx-источник (file или base64) и вернуть Buffer. Лимит — те же
 * `ETNX_MAX_BYTES`, что и у импорт-сервиса (защита от OOM).
 */
export function readImportSource(
  source: { kind: 'etnx_file'; path: string } | { kind: 'etnx_base64'; content_base64: string },
): Buffer {
  if (source.kind === 'etnx_file') {
    let buf: Buffer;
    try {
      buf = readFileSync(source.path);
    } catch (err) {
      throw new EtnError('NOT_FOUND', `Файл не найден: ${source.path}`, {
        path: source.path,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
    if (buf.length > ETNX_MAX_BYTES) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `Размер .etnx (${buf.length} байт) превышает лимит ${ETNX_MAX_BYTES}.`,
        { size: buf.length, limit: ETNX_MAX_BYTES },
      );
    }
    return buf;
  }
  // etnx_base64
  let buf: Buffer;
  try {
    buf = Buffer.from(source.content_base64, 'base64');
  } catch (err) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'Не удалось декодировать base64-архив.',
      { cause: err instanceof Error ? err.message : String(err) },
    );
  }
  if (buf.length > ETNX_MAX_BYTES) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `Размер .etnx (${buf.length} байт) превышает лимит ${ETNX_MAX_BYTES}.`,
      { size: buf.length, limit: ETNX_MAX_BYTES },
    );
  }
  return buf;
}

/**
 * Построить план импорта без побочных эффектов (dry_run). Используется и для
 * `import.subgraph` — план показывается в отчёте.
 *
 * Семантика `thoughts_to_create/reuse/skip` отражает `collision_policy`
 * относительно целевой сети (ошибка ebe93450): `findImportConflicts` даёт
 * список коллизий, `planImportThoughts` превращает его в счётчики. Коллизии
 * попадают в `conflicts` — так превью предупреждает об отказе `fail` и о
 * пропуске `skip` до фактической записи.
 */
export async function planImportFromBuffer(
  ndb: NetworkDb,
  buf: Buffer,
  policy: McpImportPolicy | undefined,
  logger: Logger,
): Promise<ImportPlanResult> {
  const manifest = await readManifestFromBuffer(buf, logger);
  const thoughtPlan = planImportThoughts(ndb, manifest, policy ?? 'overwrite');
  const plan: ImportPlanResult['plan'] = {
    thoughts_to_create: thoughtPlan.thoughts_to_create,
    thoughts_to_reuse: thoughtPlan.thoughts_to_reuse,
    thoughts_to_skip: thoughtPlan.thoughts_to_skip,
    rejected: thoughtPlan.rejected,
    links_to_create: manifest.links.length,
    attachments_to_import: manifest.attachments.length,
    thought_types_to_create: manifest.thought_types.length,
    thought_types_to_reuse: 0,
    link_types_to_create: manifest.link_types.length,
    link_types_to_reuse: 0,
  };
  return {
    manifest_version: manifest.version,
    source_network_name: manifest.source.network_name ?? undefined,
    plan,
    conflicts: thoughtPlan.conflicts.map((c) => ({
      kind: c.kind === 'id' ? 'duplicate_id' : 'duplicate_title',
      id: c.id,
      title: c.title,
      reason:
        c.kind === 'id'
          ? 'мысль с таким id уже есть в целевой сети'
          : `совпадает title с мыслью ${c.existing_id ?? ''}`.trim(),
    })),
  };
}

/**
 * Реальный импорт архива через `importFromEtnx` с учётом `collision_policy`
 * (ошибка ebe93450): политика пробрасывается в `ImportOptions.collisionPolicy`
 * и применяется на шаге мыслей `applyManifest` (`fail` — VALIDATION_ERROR со
 * списком конфликтов, `rename` — новая мысль с уникальным title, `skip` —
 * пропуск дубля и его подграфа, `overwrite` — историческое поведение).
 */
export async function importFromBuffer(
  ndb: NetworkDb,
  buf: Buffer,
  opts: ImportOptions,
  logger: Logger,
  policy: McpImportPolicy | undefined,
): Promise<ImportResult> {
  return importFromEtnx(
    ndb,
    buf,
    { ...opts, ...(policy !== undefined ? { collisionPolicy: policy } : {}) },
    logger,
  );
}

// Re-export `applyManifest`/`readArchive` не нужны — они приватные утилиты.
// Но `parseManifest` экспортирован из etnx-format и его можно использовать
// напрямую из MCP-фасада.
export { parseManifest };

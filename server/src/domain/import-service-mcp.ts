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

import type { Logger } from '../logger.js';
import { importFromEtnx, type ImportOptions, type ImportResult } from './import-service.js';
import { parseManifest } from './etnx-format.js';

/** Результат `planImportFromBuffer` — что произойдёт при импорте. */
export interface ImportPlanResult {
  manifest_version: string;
  source_network_name?: string;
  plan: {
    thoughts_to_create: number;
    thoughts_to_reuse: number;
    thoughts_to_skip: number;
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
 * Реализация: `previewFromEtnx` (читает архив и валидирует manifest).
 * Семантика `thoughts_to_create/reuse/skip` зависит от `collision_policy`,
 * которую план не выбирает — на уровне dry_run мы возвращаем «best case»
 * (всё новое); точный учёт коллизий остаётся за `importFromEtnx`.
 */
export async function planImportFromBuffer(
  buf: Buffer,
  logger: Logger,
): Promise<ImportPlanResult> {
  const { previewFromEtnx } = await import('./import-service.js');
  const preview = await previewFromEtnx(buf, logger);
  const plan: ImportPlanResult['plan'] = {
    thoughts_to_create: preview.counts.thoughts,
    thoughts_to_reuse: 0,
    thoughts_to_skip: 0,
    links_to_create: preview.counts.links,
    attachments_to_import: preview.counts.attachments,
    thought_types_to_create: preview.counts.thought_types,
    thought_types_to_reuse: 0,
    link_types_to_create: preview.counts.link_types,
    link_types_to_reuse: 0,
  };
  return {
    manifest_version: preview.manifest_version,
    source_network_name: preview.source_network_name ?? undefined,
    plan,
    conflicts: [],
  };
}

/**
 * Реальный импорт архива через `importFromEtnx`. Политика `collision_policy`
 * сейчас не пробрасывается отдельной переменной — `importFromEtnx` использует
 * встроенные правила `applyManifest` (поиск дублей по id → по title →
 * создание). Расхождение по политике на уровне MCP считается
 * best-effort-планом; точное разграничение оставлено для следующей версии.
 */
export async function importFromBuffer(
  ndb: import('../db/network-db.js').NetworkDb,
  buf: Buffer,
  opts: ImportOptions,
  logger: Logger,
  _policy: McpImportPolicy | undefined,
): Promise<ImportResult> {
  return importFromEtnx(ndb, buf, opts, logger);
}

// Re-export `applyManifest`/`readArchive` не нужны — они приватные утилиты.
// Но `parseManifest` экспортирован из etnx-format и его можно использовать
// напрямую из MCP-фасада.
export { parseManifest };

/**
 * Структура сети (type_roles.table_of_contents) — доменные чтения для
 * `etn.networks.structure` (ADR 8c93f03a, веха 7 версии 0.8.2). Раньше
 * сырой SELECT жил в MCP-фасаде; теперь выборка секций — здесь, а фасад
 * обогащает строки превью комментариев, свойствами и счётчиками через
 * остальные доменные сервисы.
 */

import type { NetworkDb } from '../db/network-db.js';

/** Строка секции оглавления (мысли-разделы роли table_of_contents). */
export interface TocSectionRow {
  id: string;
  title: string;
  type_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

/**
 * Активные мысли типа-роли `table_of_contents`, в порядке создания.
 * Только актуальные (`active = 1`); слой контекста задаёт переданный `ndb`.
 */
export function listTocSections(ndb: NetworkDb, sectionTypeId: string): TocSectionRow[] {
  return ndb
    .prepare(
      `SELECT id, title, type_id, active, version, created_at, updated_at
         FROM thoughts_v
        WHERE type_id = ? AND active = 1
        ORDER BY created_at ASC`,
    )
    .all(sectionTypeId) as Array<{
    id: string;
    title: string;
    type_id: string | null;
    active: number;
    version: number;
    created_at: string;
    updated_at: string;
  }>;
}

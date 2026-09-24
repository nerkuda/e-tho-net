/**
 * Нормализация коротких id мыслей в аргументах MCP-инструментов
 * (ошибка d8893a1f-e35e-4b4a-af40-391f992d28fc).
 *
 * Агент в рассуждениях сплошь и рядом оперирует усечённым id (hex-префикс
 * UUID). Инструменты обязаны принимать обе формы. Чтобы не расползаться по
 * десяткам тулов, нормализация сделана **одним проходом на границе MCP** —
 * в общем перехватчике `tools/call` (`mcp/server.ts`): до вызова обработчика
 * каждый короткий id в известных id-слотах аргументов заменяется полным.
 *
 * Слоты — по именам ключей, а не эвристикой по форме строки: так короткая
 * hex-строка, случайно оказавшаяся значением не-id поля (например `title`
 * или текстовое свойство), не портится. Реф нового можно задавать только
 * как `ref`/`target_ref` — эти ключи в набор не входят, семантика создания
 * не меняется.
 *
 * Резолвит домен (`domain/thought-id.ts`): неоднозначный префикс — ошибка со
 * списком кандидатов, отсутствующий — NOT_FOUND. SQL остаётся в домене
 * (сторож `guard-server-layers`).
 */

import type { NetworkDb } from '../db/network-db.js';

import { openMemberNetwork, type McpRuntime } from './context.js';
import { isIdPrefix, resolveThoughtIdOrThrow } from '../domain/thought-id.js';

/** Скалярные ключи-слоты id мысли (значение — строка). */
const THOUGHT_ID_SCALAR_KEYS = new Set<string>([
  'thought_id',
  'in_subtree_of',
  'from_id',
  'to_id',
  'target_parent_thought_id',
  'parent_thought_id',
  'source_thought_id',
  'target_id',
]);

/** Ключи-слоты со списком id мыслей (значение — массив строк). */
const THOUGHT_ID_ARRAY_KEYS = new Set<string>([
  'thought_ids',
  'seed_ids',
  'ids',
  'parent_ids',
  'child_ids',
  'root_thought_ids',
]);

/** Инструменты работы со свойствами-связями: `value`/`owner_id` — id мысли. */
function isPropertyTool(toolName: string): boolean {
  return toolName.startsWith('etn.properties.');
}

/** Входит ли ключ `key` объекта `obj` в набор id-слотов для этого инструмента. */
function isThoughtScalarSlot(toolName: string, key: string, obj: Record<string, unknown>): boolean {
  if (THOUGHT_ID_SCALAR_KEYS.has(key)) return true;
  if (key === 'owner_id') return obj['owner_type'] === 'thought';
  if (key === 'value') return isPropertyTool(toolName);
  return false;
}

/** Слот нормализации: либо поле-строка, либо массив строк (правится на месте). */
type Slot = { obj: Record<string, unknown>; key: string } | { array: unknown[] };

/**
 * Инструменты, где неразрешимый короткий id в МАССИВНОМ слоте не должен
 * рушить вызов: `etn.thoughts.resolve` кладёт такие id в `missing[]`
 * (ошибка 8f42dbf3). Прочие инструменты сохраняют прежний отказ NOT_FOUND.
 */
const BATCH_MISSING_ARRAY_TOOLS = new Set<string>(['etn.thoughts.resolve']);

/** Собрать все id-слоты с короткой формой id (полные UUID не трогаем). */
function collect(value: unknown, key: string | undefined, toolName: string, out: Slot[]): void {
  if (Array.isArray(value)) {
    if (key !== undefined && THOUGHT_ID_ARRAY_KEYS.has(key)) {
      if (value.some((e) => typeof e === 'string' && isIdPrefix(e))) out.push({ array: value });
      return;
    }
    for (const item of value) collect(item, undefined, toolName, out);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const obj = value as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') {
      if (isThoughtScalarSlot(toolName, k, obj) && isIdPrefix(v)) out.push({ obj, key: k });
    } else {
      collect(v, k, toolName, out);
    }
  }
}

/** Сеть вызова: `network_id`, у диспетчера `etn.ops` — из `params`, у копирования — источник. */
function pickNetworkId(args: Record<string, unknown>): string | null {
  const direct = args['network_id'];
  if (typeof direct === 'string' && direct !== '') return direct;
  const params = args['params'];
  if (typeof params === 'object' && params !== null) {
    const nested = (params as Record<string, unknown>)['network_id'];
    if (typeof nested === 'string' && nested !== '') return nested;
  }
  const source = args['source_network_id'];
  if (typeof source === 'string' && source !== '') return source;
  return null;
}

/**
 * Заменить короткие id мыслей на полные в аргументах инструмента (in place).
 * Ничего не делает, когда коротких id в id-слотах нет (нет лишнего открытия
 * сети); при неоднозначном префиксе бросает `VALIDATION_ERROR`, при
 * отсутствующем — `NOT_FOUND`.
 */
export function normalizeThoughtIdArgs(
  rt: McpRuntime,
  toolName: string,
  args: unknown,
): void {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return;
  const record = args as Record<string, unknown>;
  const slots: Slot[] = [];
  collect(record, undefined, toolName, slots);
  if (slots.length === 0) return;
  const networkId = pickNetworkId(record);
  if (networkId === null) return;
  const ndb: NetworkDb = openMemberNetwork(rt, networkId);
  const resolve = (id: string): string => resolveThoughtIdOrThrow(ndb, id);
  const batchMissing = BATCH_MISSING_ARRAY_TOOLS.has(toolName);
  for (const slot of slots) {
    if ('array' in slot) {
      const arr = slot.array;
      for (let i = 0; i < arr.length; i += 1) {
        const e = arr[i];
        if (typeof e !== 'string' || !isIdPrefix(e)) continue;
        if (batchMissing) {
          // Неразрешимый (ненайденный или неоднозначный) короткий id оставляем
          // как есть — домен положит его в `missing[]`, а не отвергнет батч.
          try {
            arr[i] = resolve(e);
          } catch {
            // оставляем исходное значение
          }
        } else {
          arr[i] = resolve(e);
        }
      }
    } else {
      slot.obj[slot.key] = resolve(slot.obj[slot.key] as string);
    }
  }
}

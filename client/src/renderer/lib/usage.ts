/**
 * Чистые данные панели использования (спека f7623077, ошибка aca92904).
 *
 * Вынесено из `screens/usage-panel.ts`, чтобы модель строк проверялась без
 * DOM и без тяжёлых зависимостей панели (редактор, меню, диалоги).
 */

import type { HoldingLayerRef, ThoughtRef, ThoughtUsage } from '@etn/shared';

/** Строка группы «Используется в свойствах» (мысль + имя свойства). */
export interface UsagePropertyRow {
  thought: ThoughtRef;
  propertyKey: string;
  propertyId: string;
}

/**
 * Плоский список строк группы «Используется в свойствах»: по строке на пару
 * «ссылающаяся мысль + свойство» (спека f7623077). Группы уже упорядочены
 * сервером по имени свойства, мысли — по названию.
 */
export function usagePropertyRows(usage: ThoughtUsage | null): UsagePropertyRow[] {
  if (usage === null) return [];
  const rows: UsagePropertyRow[] = [];
  for (const group of usage.groups) {
    for (const thought of group.thoughts) {
      rows.push({ thought, propertyKey: group.key, propertyId: group.property_id });
    }
  }
  return rows;
}

/**
 * Удерживающие слои для показа. Основной источник — `usage.holding_layers`;
 * `deletion-check` подстраховывает (связь своего usage не имеет, а старый
 * сервер мог отдать пустой список). Дубли схлопываются по id, порядок —
 * порядок появления в `deletion-check` (там «Основа» идёт первой), затем
 * остальные из usage.
 */
export function usageLayers(
  fromUsage: readonly HoldingLayerRef[] | null | undefined,
  fromCheck: readonly HoldingLayerRef[] | null | undefined,
): HoldingLayerRef[] {
  const out: HoldingLayerRef[] = [];
  const seen = new Set<string>();
  for (const layer of [...(fromCheck ?? []), ...(fromUsage ?? [])]) {
    if (seen.has(layer.id)) continue;
    seen.add(layer.id);
    out.push(layer);
  }
  return out;
}

/**
 * Что делает повторный вызов панели для той же цели (спека f7623077):
 * из диалога удаления — toggle (закрыть), из корзины — `forceOpen` (открыть
 * заново). Для другой цели всегда открытие/перерисовка.
 */
export function usagePanelRepeatAction(
  current: { kind: string; id: string } | null,
  next: { kind: string; id: string },
  forceOpen: boolean,
): 'close' | 'open' {
  if (forceOpen) return 'open';
  if (current !== null && current.kind === next.kind && current.id === next.id) return 'close';
  return 'open';
}

/**
 * Коды отказа действия «Вернуть из корзины», при которых панель остаётся
 * открытой и показывает сообщение (задача d23279f6): сущность уже удалена
 * (`NOT_FOUND`), пометку успел снять/изменить кто-то другой
 * (`VERSION_CONFLICT`) или сущность захвачена (`LOCKED`).
 */
export function isRestorePanelError(code: string): boolean {
  return code === 'NOT_FOUND' || code === 'VERSION_CONFLICT' || code === 'LOCKED';
}

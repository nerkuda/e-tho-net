/**
 * Видимость сущности в текущей окрестности фокуса (локальные производители,
 * этап G6 техпроекта 269016e2 — вынесено из снесённого `realtime-ui.ts`).
 *
 * Локальная правка невидимой сущности карту не меняет — перечитывать
 * окрестность из-за неё не нужно (ошибка f0b959dd). Живёт в `lib/` (без
 * зависимостей от холста/редактора), чтобы юнит-тесты проверяли гейт без
 * подъёма всего DOM-стека.
 */

import { store } from '../state.js';

/** True when the thought id participates in the current focus neighbourhood. */
export function inNeighbourhood(id: string): boolean {
  const focus = store.state.focus;
  if (focus === null) return false;
  return (
    focus.focused.id === id ||
    focus.parents.some((n) => n.id === id) ||
    focus.children.some((n) => n.id === id) ||
    focus.siblings.some((n) => n.id === id)
  );
}

/**
 * Виден ли владелец значения в текущей окрестности фокуса: мысль — сам фокус
 * или его сосед, связь — ребро этой окрестности (`focus.edges`). Локальные
 * производители (сохранение значения свойства-связи) по этому признаку решают,
 * нужен ли пересчёт холста: правка невидимой сущности карту не меняет, и
 * перечитывать окрестность из-за неё не нужно (ошибка f0b959dd).
 */
export function inFocusNeighbourhood(
  ownerType: 'thought' | 'link',
  ownerId: string,
): boolean {
  const focus = store.state.focus;
  if (focus === null) return false;
  return ownerType === 'thought'
    ? inNeighbourhood(ownerId)
    : focus.edges.some((edge) => edge.id === ownerId);
}

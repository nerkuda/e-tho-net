/**
 * Pure helpers for the «Отборы» tab of the thought-type editor (задача
 * b8301c16, требование 344b8798 «Редактор типа мысли разнесён по вкладкам»,
 * 0.7.3).
 *
 * The tab itself (`views-tab.ts`) imports the DOM helpers, IPC and the
 * realtime bridge — too heavy for the unit tests that only assert the
 * pure logic (list ordering, reorder plan, default-toggle plan). The
 * helpers here are dependency-free at runtime: only `@etn/shared` for
 * the shape of `ThoughtTypeView`.
 */

/**
 * The shape of a server-side patch that reorders two adjacent views.
 * The renderer applies both patches in parallel and reloads on failure.
 */
export interface ViewPositionSwap {
  /** View that physically moves (▲/▼ target). */
  readonly movedId: string;
  /** The view it swaps places with (the neighbour in the opposite slot). */
  readonly neighbourId: string;
  /** `position` value to push to `movedId`. */
  readonly movedPosition: number;
  /** `position` value to push to `neighbourId` (the slot `movedId` vacated). */
  readonly neighbourPosition: number;
}

/**
 * Stable order by `position` (numeric), with id as a deterministic
 * tiebreaker so views created in the same server transaction keep a
 * predictable order between reloads.
 */
export function sortViewsByPosition<T extends { id: string; position: number }>(
  views: readonly T[],
): T[] {
  return [...views].sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Plans the pair of `position` patches required to move the row at
 * `fromIndex` to `toIndex`. Both indices are interpreted in the
 * already-sorted list (use {@link sortViewsByPosition} first).
 *
 * The plan swaps the moved view's `position` with its neighbour's so the
 * server-side order stays consistent after a single PATCH pair (the server
 * does not auto-renumber siblings on every update).
 *
 * Returns `null` when the move would leave the list unchanged (out of
 * range or a no-op).
 */
export function planReorder(
  sorted: readonly { id: string; position: number }[],
  fromIndex: number,
  toIndex: number,
): ViewPositionSwap | null {
  if (fromIndex === toIndex) return null;
  if (fromIndex < 0 || fromIndex >= sorted.length) return null;
  if (toIndex < 0 || toIndex >= sorted.length) return null;
  const moved = sorted[fromIndex]!;
  const neighbour = sorted[toIndex]!;
  return {
    movedId: moved.id,
    neighbourId: neighbour.id,
    movedPosition: neighbour.position,
    neighbourPosition: moved.position,
  };
}

/**
 * Plans the single PATCH that marks the view as the type's default. The
 * server-side transaction also clears the previous default atomically, so
 * the caller only needs one update — the plan intentionally contains no
 * neighbour reference.
 */
export function planSetDefault(
  views: readonly { id: string; is_default: boolean }[],
  targetId: string,
): { id: string; is_default: true } | null {
  const target = views.find((v) => v.id === targetId);
  if (target === undefined) return null;
  if (target.is_default) return null;
  return { id: targetId, is_default: true };
}

/**
 * Plans the PATCH that revokes the «по умолчанию» mark. The server keeps
 * the same invariant (at most one default) so clearing is a safe single
 * update.
 */
export function planClearDefault(
  views: readonly { id: string; is_default: boolean }[],
  targetId: string,
): { id: string; is_default: false } | null {
  const target = views.find((v) => v.id === targetId);
  if (target === undefined) return null;
  if (!target.is_default) return null;
  return { id: targetId, is_default: false };
}

/**
 * Returns the list of views that belong to the type itself (the
 * `thought_type_id` matches). The IPC `list` call also accepts
 * `includeEffective: true` which adds the ancestor chain under
 * `meta.effective`; the type-editor tab only renders the type's own
 * views, per требование 344b8798 (порядок = только собственные отборы
 * типа, без предков).
 */
export function ownViewsOf<T extends { thought_type_id: string }>(
  views: readonly T[],
  typeId: string,
): T[] {
  return views.filter((v) => v.thought_type_id === typeId);
}

/**
 * Applies server responses to the local view cache after a successful PATCH.
 * Each view whose `id` matches a response is replaced by the response row
 * (carrying the fresh `version` and any field the server echoed back);
 * views without a matching response are kept untouched.
 *
 * Зачем (ошибка a62190d1): без обновления локальной версии следующая
 * правка того же отбора снова пошлёт устаревший `If-Match` → сервер
 * ответит `VERSION_CONFLICT` «Версия отбора изменилась с момента чтения»,
 * хотя менял её сам пользователь. Используется после reorder-а, смены
 * «по умолчанию» и её снятия.
 */
export function applyViewUpdates<T extends { id: string }>(
  list: readonly T[],
  updates: readonly T[],
): T[] {
  if (updates.length === 0) return [...list];
  const byId = new Map<string, T>();
  for (const u of updates) byId.set(u.id, u);
  return list.map((v) => {
    const u = byId.get(v.id);
    return u === undefined ? v : { ...v, ...u };
  });
}

/**
 * Renderer-side milestone event bridge into the client file journal
 * (task 92b89e6f, 08-ui-spec.md §9.7).
 *
 * The renderer marks the KEY UI milestones of a user interaction — a cloud
 * click, the focus landing, the editor opening, the comment/properties tables
 * actually rendering — so a captured journal localises the «click without
 * reaction» / «stuck loading» symptoms to a concrete leg of the pipeline
 * (renderer → IPC → main → REST → server). The names live in the spec;
 * keep this list and the spec in sync.
 *
 * The bridge is strictly fire-and-forget: the main process writes one INFO
 * line per event (only while the journal flag is on) and never replies, so a
 * diagnostic mark must never be able to break or slow the UI path it
 * instruments — hence the soft guard and the swallowed errors.
 */

import type { EtnApi } from '../../main/ipc/contract.js';

/** Milestone names emitted from the renderer (08-ui-spec.md §9.7). */
export type UiEventName =
  | 'ui.cloud.click'
  | 'ui.focus.applied'
  | 'ui.editor.opened'
  | 'ui.editor.comment.loaded'
  | 'ui.editor.props.loaded';

/**
 * Emits one milestone event into the client file journal. Safe to call from
 * any renderer path: no-ops when the preload bridge is absent (unit tests,
 * very early boot) and swallows any transport error.
 */
export function logUiEvent(name: UiEventName, data?: Record<string, unknown>): void {
  try {
    const api = (typeof window === 'undefined' ? undefined : (window as { etn?: EtnApi }).etn);
    api?.logEvent(name, data);
  } catch {
    // Diagnostics must never break the code they instrument.
  }
}

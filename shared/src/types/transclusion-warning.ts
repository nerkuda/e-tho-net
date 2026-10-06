/**
 * Non-fatal warning returned by mutating server operations when the written
 * markdown lost live transclusions that existed before (ТП2 «Трансклюзии
 * комментариев», задача `ed796c43`, требование `822a9149`).
 *
 * A transclusion is a live insert of another thought's permanent comment
 * (ADR `85a7a01e`); the database stores it as an id reference. Once the reader
 * has received the EXPANDED body (references already replaced by the source
 * text) and writes that text back, the live inserts would silently turn into
 * static copies. The server therefore compares the sets of referenced source
 * ids before and after the write and reports every disappeared id here. The
 * write itself is NOT blocked — the warning is advisory.
 */

import type { ThoughtCardWarning } from './thought-card-warning.js';

/** Stable codes for {@link TransclusionLostWarning}. New codes are additive. */
export type TransclusionLostWarningCode = 'TRANSCLUSION_LOST';

/**
 * A write dropped one or more live transclusions. `sources` lists the ids of
 * the referenced thoughts whose references disappeared from the written text;
 * an id that is merely moved or repeated elsewhere is NOT lost (sets are
 * compared), a replaced reference (`A` → `B`) reports `A`.
 */
export interface TransclusionLostWarning {
  code: TransclusionLostWarningCode;
  /** Ids of the transclusion sources whose references disappeared. */
  sources: string[];
}

/** Any non-fatal warning a mutating operation may attach to its result. */
export type MutationWarning = ThoughtCardWarning | TransclusionLostWarning;

/** Type guard narrowing {@link MutationWarning} to a transclusion-loss warning. */
export function isTransclusionLostWarning(
  warning: MutationWarning,
): warning is TransclusionLostWarning {
  return warning.code === 'TRANSCLUSION_LOST';
}

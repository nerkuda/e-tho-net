/**
 * One-time re-render of the cached `body_html` across all networks (task M1).
 *
 * `body_html` is a pure cache of `body_md`; when the rendering pipeline changes
 * (new `MD_RENDER_VERSION`), every stored value is re-rendered once at startup
 * so old comments display with the current renderer before their next edit.
 * The applied version is recorded in the L1 `settings` table — the sweep
 * re-runs automatically whenever the pipeline version bumps again.
 */

import { MD_RENDER_VERSION, renderMarkdown } from '@etn/markdown';

import type { Logger } from '../logger.js';
import { openNetworkDb } from '../db/network-db.js';
import type { SystemDb } from '../db/system-db.js';

/** L1 setting key holding the last applied rendering-pipeline version. */
export const MARKDOWN_RENDER_SETTING = 'md.render_version';

/**
 * Re-render every comment's `body_html` when the pipeline version changed.
 * Never closes network databases — they are process-wide handles
 * (`network-db.ts` registry).
 */
export function sweepCommentHtml(dataDir: string, systemDb: SystemDb, log: Logger): void {
  if (systemDb.getSetting(MARKDOWN_RENDER_SETTING) === MD_RENDER_VERSION) return;
  let reRendered = 0;
  for (const networkId of systemDb.listAllNetworkIds()) {
    try {
      const ndb = openNetworkDb(dataDir, networkId, log);
      // layers:physical-read — пересборка кэша рендера по ВСЕМ строкам всех слоёв, включая тени и надгробия.
      const rows = ndb
        .prepare("SELECT id, body_md FROM comments WHERE body_md <> ''") // layers:physical-read
        .all() as Array<{ id: string; body_md: string }>;
      const update = ndb.prepare('UPDATE comments SET body_html = ? WHERE id = ?');
      ndb.transaction(() => {
        for (const row of rows) {
          update.run(renderMarkdown(row.body_md), row.id);
        }
      });
      reRendered += rows.length;
    } catch (err) {
      log.warn({ err, networkId }, 'markdown sweep: network skipped');
    }
  }
  systemDb.setSetting(MARKDOWN_RENDER_SETTING, MD_RENDER_VERSION);
  log.info({ reRendered, version: MD_RENDER_VERSION }, 'markdown sweep complete');
}

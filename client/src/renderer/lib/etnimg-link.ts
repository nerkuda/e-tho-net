/**
 * Click handling for `etnimg://` attachment links in comment view mode
 * (карточка ETN 33379769).
 *
 * The shared renderer (@etn/markdown) emits `[имя](etnimg://…)` as a real
 * `<a href>`, but the window must never navigate to the etnimg protocol
 * (that would replace the whole UI with the file's bytes). This module
 * installs a delegated document-level click listener — the same pattern as
 * `editor/wiki-link.ts`'s `initWikiLinkNavigation` — that intercepts such
 * clicks, resolves the owning comment's context (the
 * `lib/wiki-create-context.ts` registry via `closest('.md-field')`; the
 * permanent-comment and chronology tabs bind it), finds the attachment by
 * the decoded file path among the owner's `attachments.list` rows and opens
 * it exactly like the «Вложения» tab's double-click
 * (`etn.system.openAttachmentFile` — which also downloads a temp copy when
 * the path only exists on a remote server).
 *
 * Anything unresolved (no comment context — e.g. a link inside a hover
 * preview popup; attachment row missing; malformed URL) is reported with a
 * notice instead of failing silently. Middle-click / «открыть в новой
 * вкладке» never reaches this listener — those go to the main process's
 * `setWindowOpenHandler`, which denies non-external schemes.
 *
 * Deliberately imports only from `lib/*` and `state.ts` (no `editor/*`, no
 * `canvas/*`) — see the dependency-direction note in `lib/hover-preview.ts`;
 * this keeps the module usable from any screen without module cycles. Pure
 * helpers are exposed via {@link etnimgLinkInternals} for unit tests.
 */

import type { Attachment } from '@etn/shared';

import { errText } from './dom.js';
import { etn } from './etn.js';
import { notice } from './notice.js';
import { store } from '../state.js';
import { findWikiCreateContext } from './wiki-create-context.js';

/**
 * `etnimg://<host>/<path…>` URL → absolute file path, the inverse of
 * `editor/markdown-field.ts`'s `etnimgUrl` (mirrors the decoding of the main
 * process's etnimg protocol handler). A single-letter host is a Windows
 * drive (`etnimg://c/pics/a.png` → `c:\pics\a.png`), anything else rebuilds
 * a POSIX absolute path. `null` when the URL is not a parseable etnimg URL
 * or has no path segments.
 */
function decodeEtnimgUrl(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'etnimg:') return null;
  let host: string;
  let pathname: string;
  try {
    host = decodeURIComponent(url.hostname);
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null; // malformed percent-encoding
  }
  const segments = pathname.split('/').filter((s) => s !== '' && s !== '.' && s !== '..');
  if (host === '' || segments.length === 0) return null;
  // Windows drive host ("c") → `c:\…`; anything else → a POSIX absolute path.
  // The URL roundtrip lowercases the drive letter; matching is case-blind
  // for drive paths (see sameFilePath), and openAttachmentFile goes through
  // the OS, which is case-insensitive on Windows.
  return /^[a-zA-Z]$/.test(host)
    ? `${host}:\\${segments.join('\\')}`
    : `/${[host, ...segments].join('/')}`;
}

/**
 * Compares two absolute file paths for the attachment lookup. Windows drive
 * paths compare case-insensitively with normalized separators (the etnimg
 * URL roundtrip lowercases the drive letter, while the server may store
 * `C:\…`); POSIX paths compare exactly.
 */
function sameFilePath(a: string, b: string): boolean {
  const na = a.replace(/\\/g, '/');
  const nb = b.replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(na) && /^[a-zA-Z]:\//.test(nb)) {
    return na.toLowerCase() === nb.toLowerCase();
  }
  return na === nb;
}

/** Finds the owner's file attachment whose path matches the etnimg URL. */
function findAttachmentByPath(attachments: Attachment[], filePath: string): Attachment | null {
  for (const a of attachments) {
    if (a.kind === 'file' && a.file_path !== null && sameFilePath(a.file_path, filePath)) return a;
  }
  return null;
}

/** Opens the attachment an `etnimg://` link points at (see module doc). */
async function openEtnimgLink(anchor: HTMLElement, href: string): Promise<void> {
  const ctx = findWikiCreateContext(anchor);
  if (ctx === null) {
    notice(
      'Не удалось открыть файл: ссылка вне поля комментария — владелец вложения неизвестен.',
      'error',
    );
    return;
  }
  const networkId = store.state.networkId;
  if (networkId === null) {
    notice('Сначала откройте сеть.', 'error');
    return;
  }
  const filePath = decodeEtnimgUrl(href);
  if (filePath === null) {
    notice(`Не удалось разобрать путь во вложении: ${href}`, 'error');
    return;
  }
  let attachments: Attachment[];
  try {
    attachments = await etn.attachments.list(networkId, ctx.ownerType, ctx.ownerId);
  } catch (err) {
    notice(`Не удалось открыть файл вложения: ${errText(err)}`, 'error');
    return;
  }
  const attachment = findAttachmentByPath(attachments, filePath);
  if (attachment === null || attachment.file_path === null) {
    notice('Вложение по этой ссылке не найдено у владельца комментария.', 'error');
    return;
  }
  // Same path as the «Вложения» tab's double-click: the main process opens
  // the OS default app, downloading a server copy when the local file is
  // missing (remote-server attachments).
  try {
    const err = await etn.system.openAttachmentFile(attachment.file_path);
    if (err !== '') notice(`Не удалось открыть: ${err}`, 'error');
  } catch (err) {
    notice(`Не удалось открыть: ${errText(err)}`, 'error');
  }
}

let wired = false;

/** Installs the delegated etnimg-link click handler (call once from main.ts). */
export function initEtnimgLinkNavigation(): void {
  if (wired) return;
  wired = true;
  document.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    const anchor = target?.closest?.('a[href]');
    if (!(anchor instanceof HTMLAnchorElement)) return;
    const href = anchor.getAttribute('href') ?? '';
    if (!/^etnimg:/i.test(href)) return;
    // Never let the window navigate to the etnimg protocol — the file opens
    // through the handler above instead.
    event.preventDefault();
    void openEtnimgLink(anchor, href);
  });
}

/** Test seam: pure helpers. */
export const etnimgLinkInternals = { decodeEtnimgUrl, sameFilePath, findAttachmentByPath };

/**
 * «О программе» dialog (task 4cba7d74, 08-ui-spec.md §8.5): the client
 * version, authorship, licence, project links (changelog, releases) and —
 * task 4ec4a685 — the currently connected server (name, address, version).
 *
 * Purely client-side: opens without a server connection — the client version
 * and runtime info come from the main process over `etn.system.appInfo`
 * (docs/07-client-electron.md §6). The server block is optional: it reuses
 * the already-known active profile (`etn.server.listProfiles`) and the
 * public `GET /version` endpoint (`etn.system.version`, 03-server-api.md
 * §16–17) — no new IPC/server surface. Without a connection (or on a fetch
 * failure) it shows «нет подключения» instead of hiding, same spirit as the
 * optional blocks elsewhere in this dialog. The project links open in the OS
 * browser via `etn.system.openExternal`; failures surface as an error toast.
 */

import { showDialog } from '../lib/dialog.js';
import { button, div, el } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { notice } from '../lib/notice.js';
import { store } from '../state.js';

/** Project repository — mirrors `client/package.json` `homepage`. */
const APP_URL = 'https://github.com/nerkuda/e-tho-net';

/** Author and licence (root `LICENSE`: MIT © 2026). */
const APP_COPYRIGHT = '© 2026 В. Зайцев';
const APP_LICENSE = 'MIT';

/** External links shown in the dialog (08-ui-spec.md §8.2). */
const ABOUT_LINKS: Array<{ label: string; url: string }> = [
  { label: 'Новое в версии', url: `${APP_URL}/blob/main/CHANGELOG.md` },
  { label: 'Собранные релизы', url: `${APP_URL}/releases` },
  { label: 'Текст лицензии', url: `${APP_URL}/blob/main/LICENSE` },
];

/** Opens the «О программе» dialog. */
export function showAboutDialog(): void {
  const body = div('about-body');

  const logo = el('img', 'about-logo');
  logo.src = './logo.svg';
  logo.alt = 'ETN';

  const versionLine = el('p', 'about-version', 'Версия …');
  const techLine = el('p', 'about-tech muted', '');
  techLine.hidden = true;
  const serverLine = el('p', 'about-server muted', '');
  serverLine.hidden = true;

  const linksRow = div('about-links');
  for (const link of ABOUT_LINKS) {
    linksRow.append(button(link.label, () => void openLink(link.url), 'link-btn'));
  }

  body.append(
    logo,
    el('h2', 'about-title', 'ETN'),
    el('p', 'about-tagline muted', 'The Endless Thought Network — self-hosted граф мыслей'),
    versionLine,
    el('p', 'about-meta', `${APP_COPYRIGHT} · Лицензия ${APP_LICENSE}`),
    linksRow,
    techLine,
    serverLine,
  );

  showDialog({
    title: 'О программе',
    body,
    width: 420,
    buttons: [{ label: 'Закрыть', primary: true }],
  });

  void etn.system.appInfo().then((info) => {
    versionLine.textContent = `Версия ${info.version}`;
    techLine.textContent = `Electron ${info.electron} · Chromium ${info.chrome} · Node ${info.node}`;
    techLine.hidden = false;
  });

  void loadServerLine(serverLine);
}

/**
 * Fills the «Сервер» line with the active profile's name/address and the
 * server's own version (reusing `etn.system.version`, no dedicated
 * endpoint). No active profile, or the request fails (server unreachable
 * mid-session) — falls back to «нет подключения» rather than hiding the
 * line, same as the rest of this optional block.
 */
async function loadServerLine(serverLine: HTMLElement): Promise<void> {
  const profileId = store.state.profileId;
  if (profileId === null) {
    serverLine.textContent = 'Сервер: нет подключения';
    serverLine.hidden = false;
    return;
  }
  try {
    const [profiles, version] = await Promise.all([
      etn.server.listProfiles(),
      etn.system.version(),
    ]);
    const active = profiles.find((p) => p.id === profileId);
    const name = active !== undefined ? `${active.label} (${active.baseUrl})` : 'сервер';
    serverLine.textContent = `Сервер: ${name} · версия ${version.version}`;
  } catch {
    serverLine.textContent = 'Сервер: нет подключения';
  }
  serverLine.hidden = false;
}

/** Opens an external link in the OS browser; failures surface as a toast. */
async function openLink(url: string): Promise<void> {
  const err = await etn.system.openExternal(url);
  if (err !== '') notice(`Не удалось открыть: ${err}`, 'error');
}

/**
 * «О программе» dialog (task 4cba7d74, 08-ui-spec.md §8.5): the client
 * version, authorship, licence, project links (changelog, releases) and —
 * task 4ec4a685 — the currently connected server (name, address, version).
 *
 * Layout (задача dd7e490e): две РАВНЫЕ независимые половины — слева всё, что
 * было (логотип, название, слоган, версия, авторство, ссылки, строки окружения
 * и сервера), справа — сторонние компоненты. Левая помещается целиком без
 * прокруток, правая прокручивается по вертикали независимо (роль размера `l` +
 * `fixedHeight`, скролл — у правой колонки). Горизонтальных прокруток нет.
 * Высота — 450px вместо ролевых 680px: модификатор `dialog-about` на боксе
 * подменяет только высоту (см. styles/dialogs.css, токен `--dialog-h-about`).
 *
 * Purely client-side: opens without a server connection — the client version
 * and runtime info come from the main process over `etn.system.appInfo`
 * (docs/07-client-electron.md §6). The server block is optional: it reuses
 * the already-known active profile (`etn.server.listProfiles`) and the
 * public `GET /api/v1/version` endpoint (`etn.system.version`,
 * 03-server-api.md §16–17) — no new IPC/server surface. Without a connection
 * (or on a fetch failure) it shows «нет подключения» instead of hiding, same
 * spirit as the optional blocks elsewhere in this dialog. The project links
 * open in the OS browser via `etn.system.openExternal`; failures surface as
 * an error toast.
 */

import { showDialog } from '../lib/dialog.js';
import { t } from '../lib/i18n.js';
import { button, div, el } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { notice } from '../lib/notice.js';
import { THIRD_PARTY_COMPONENTS, type ThirdPartyComponent } from '../lib/third-party.js';
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
  const left = div('about-left');

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

  left.append(
    logo,
    el('h2', 'about-title', 'ETN'),
    el('p', 'about-tagline muted', 'The Endless Thought Network — self-hosted граф мыслей'),
    versionLine,
    el('p', 'about-meta', `${APP_COPYRIGHT} · Лицензия ${APP_LICENSE}`),
    linksRow,
    techLine,
    serverLine,
  );

  const right = div('about-right');
  right.append(thirdPartyBlock());

  const body = div('about-body');
  body.append(left, right);

  showDialog({
    title: 'О программе',
    body,
    // Две равные половины требуют места: прежняя роль `s` (460px) обрезала даже
    // версию/авторство. `l` (900px шириной) + фиксированная высота: тело не
    // прокручивается, скролл отдан правой колонке, а высота задаётся
    // модификатором `dialog-about` (450px) вместо ролевых 680px — задача
    // dd7e490e.
    size: 'l',
    fixedHeight: true,
    buttons: [{ label: t('actions.close'), primary: true }],
    onMount: (_close, box) => box.classList.add('dialog-about'),
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

/**
 * Блок «Сторонние компоненты» (задача 35b9cc05, ADR 03eb2c61): краткий
 * перечень библиотек из общего каталога `lib/third-party.ts` — того же, по
 * которому генератор `scripts/generate-notices.ts` собирает полный
 * `THIRD-PARTY-NOTICES.txt` в поставке. Живёт в правой половине диалога
 * (задача dd7e490e) и прокручивается в ней независимо от левой.
 */
function thirdPartyBlock(): HTMLElement {
  const block = div('about-third');
  block.append(el('h3', 'about-third-title', t('about.thirdParty')));

  const list = div('about-third-list');
  for (const comp of THIRD_PARTY_COMPONENTS) list.append(thirdPartyRow(comp));
  block.append(list);

  block.append(el('p', 'about-third-hint muted', t('about.thirdPartyHint')));
  return block;
}

/** Строка перечня: имя библиотеки — лицензия — ссылка на сайт. */
function thirdPartyRow(comp: ThirdPartyComponent): HTMLElement {
  const row = div('about-third-row');
  row.append(
    el('span', 'about-third-name', comp.title),
    el('span', 'about-third-license muted', comp.license),
    button(t('about.website'), () => void openLink(comp.url), 'link-btn'),
  );
  return row;
}

/** Opens an external link in the OS browser; failures surface as a toast. */
async function openLink(url: string): Promise<void> {
  const err = await etn.system.openExternal(url);
  if (err !== '') notice(`Не удалось открыть: ${err}`, 'error');
}

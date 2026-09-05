/**
 * Onboarding screen (H2, 08-ui-spec.md §12, 09-scenarios.md A4):
 *
 *  - welcome text;
 *  - list of previously saved server profiles (click → connect;
 *    per-row delete button with confirmation → `server.removeProfile`,
 *    defect e28df893);
 *  - "new connection" form: label (optional), server URL, API-key →
 *    `server.addProfile` (key is encrypted in the main process via
 *    `safeStorage`, the renderer never stores it);
 *  - understandable errors (bad key / unreachable server / version mismatch).
 */

import { restoreSession } from '../app.js';
import { confirmDialog } from '../lib/dialog.js';
import { button, div, el, errText, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { store } from '../state.js';

/**
 * Builds the onboarding screen. The profile list loads asynchronously; form
 * submission validates locally, then delegates to `server.addProfile`.
 */
export function buildOnboarding(): HTMLElement {
  const root = div('screen screen-onboarding');
  const card = div('card onboarding-card');

  card.append(el('h1', 'onboarding-title', 'ETN'));
  card.append(
    el(
      'p',
      'onboarding-sub',
      'Self-hosted граф мыслей. Подключитесь к своему серверу ETN, чтобы начать.',
    ),
  );

  // --- saved profiles -------------------------------------------------------
  const profilesBox = div('profiles');
  const profilesTitle = el('h2', 'profiles-title', 'Сохранённые серверы');
  profilesTitle.hidden = true;
  const profileList = div('profile-list');
  const connectError = el('p', 'onboarding-error');
  connectError.hidden = true;
  profilesBox.append(profilesTitle, profileList, connectError);
  card.append(profilesBox);

  // --- new connection form ---------------------------------------------------
  const formTitle = el('h2', 'form-title', 'Новое подключение');
  const form = div('form-stack');

  const labelInput = el('input', 'text-input');
  labelInput.type = 'text';
  labelInput.placeholder = 'Мой сервер (необязательно)';
  const labelField = div('field');
  labelField.append(el('label', 'field-label', 'Название'), labelInput);

  const urlInput = el('input', 'text-input');
  urlInput.type = 'text';
  urlInput.placeholder = 'http://localhost:3000';
  urlInput.spellcheck = false;
  const urlField = div('field');
  urlField.append(el('label', 'field-label', 'Адрес сервера'), urlInput);

  const keyInput = el('input', 'text-input');
  keyInput.type = 'password';
  keyInput.placeholder = 'etn_…';
  keyInput.spellcheck = false;
  const keyField = div('field');
  keyField.append(el('label', 'field-label', 'API-key'), keyInput);

  const submitRow = div('form-row');
  const submit = button('Подключиться', () => void submitForm(), 'btn primary');
  const formError = span('', 'error-text');
  submitRow.append(submit, formError);
  form.append(labelField, urlField, keyField, submitRow);
  card.append(formTitle, form);

  root.append(card);

  /** Connects a saved profile; on success restores the saved session (bug
   *  be430215): a previously used server reopens its last tab instead of
   *  offering a network re-pick. A first-time connect has no saved tabs and
   *  still lands on the network list. */
  async function connectProfile(profileId: string): Promise<void> {
    connectError.hidden = true;
    submit.disabled = true;
    try {
      const me = await etn.server.connect(profileId);
      store.update({ profileId, me });
      await restoreSession();
    } catch (err) {
      connectError.textContent = errText(err);
      connectError.hidden = false;
    } finally {
      submit.disabled = false;
    }
  }

  /** Renders the saved-profile list (async, guarded against screen switches). */
  async function loadProfiles(): Promise<void> {
    const profiles = await etn.server.listProfiles();
    if (!root.isConnected) return;
    // Defect e28df893: always start from a clean list — repeated calls (after
    // add/delete) must not leave stale rows behind.
    profileList.replaceChildren();
    for (const p of profiles) {
      const item = div('profile-item' + (p.isActive ? ' active' : ''));
      const info = div('profile-info');
      info.append(span(p.label, 'profile-label'), span(p.baseUrl, 'profile-url'));
      const removeBtn = button('Удалить', () => void removeSavedProfile(p), 'btn small danger');
      // The whole row also acts as a "connect" affordance; the delete button
      // must not bubble the click or it would both delete and connect at once.
      removeBtn.addEventListener('click', (ev) => ev.stopPropagation());
      item.append(info, removeBtn);
      item.addEventListener('click', () => {
        void connectProfile(p.id);
      });
      profileList.append(item);
    }
    profilesTitle.hidden = profileList.childElementCount === 0;
  }

  /** Deletes a saved profile after explicit confirmation (defect e28df893). */
  async function removeSavedProfile(p: {
    id: string;
    label: string;
    baseUrl: string;
    isActive: boolean;
  }): Promise<void> {
    const isCurrent = store.state.profileId === p.id;
    const msg = isCurrent
      ? `Удалить сервер «${p.label}» (${p.baseUrl})? Активное подключение будет разорвано, локальные данные (вкладки, черновики, история) — удалены. Действие необратимо.`
      : `Удалить сервер «${p.label}» (${p.baseUrl})? Локальные данные этого профиля будут удалены. Действие необратимо.`;
    const ok = await confirmDialog('Удалить сохранённый сервер', msg, true);
    if (!ok) return;
    // Main disconnects first if the profile is active, then sweeps the row
    // and every per-profile table (ui_state, drafts, tabs, focus_history,
    // visit_history, structures_history) in one transaction.
    await etn.server.removeProfile(p.id);
    if (isCurrent) {
      // Main has already torn down clients; just drop the stale store state
      // and refresh the list. We are already on the onboarding screen, so
      // there is no need (and no point) to call `showScreen('onboarding')` —
      // that would tear down `root` mid-function and orphan the rest of this
      // code path.
      store.update({ profileId: null, me: null });
    }
    await loadProfiles();
  }

  /** Submits the new-connection form. */
  async function submitForm(): Promise<void> {
    formError.textContent = '';
    const baseUrl = urlInput.value.trim();
    const apiKey = keyInput.value.trim();
    if (!/^https?:\/\//i.test(baseUrl)) {
      formError.textContent = 'Введите адрес сервера, например http://localhost:3000';
      return;
    }
    if (apiKey === '') {
      formError.textContent = 'Введите API-key.';
      return;
    }
    submit.disabled = true;
    try {
      const me = await etn.server.addProfile({
        label: labelInput.value.trim() || baseUrl,
        baseUrl,
        apiKey,
      });
      const profiles = await etn.server.listProfiles();
      const active = profiles.find((p) => p.isActive);
      store.update({ profileId: active?.id ?? null, me });
      // New profile → no saved tabs → `restoreSession` shows the network
      // list, same as before (H3 first-connect flow).
      await restoreSession();
    } catch (err) {
      formError.textContent = errText(err);
    } finally {
      submit.disabled = false;
    }
  }

  void loadProfiles();
  return root;
}

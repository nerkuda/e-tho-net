/**
 * Settings dialogs from the user menu (H18, 08-ui-spec.md §9;
 * 11-settings-and-state.md §2.1, §2.4).
 *
 * - «Настройки видимости»: `show_inactive` — L3 server preference per user ×
 *   network (`networks.setPreference`), synced to other clients via
 *   `audience=user` realtime events;
 * - «Размер облачка»: `cloud_width` / `cloud_gap` — L4 local ui_state,
 *   clipped to the system constants (`CLOUD_WIDTH_*`, `CLOUD_GAP_*`).
 */

import {
  CLOUD_GAP_MAX,
  CLOUD_GAP_MIN,
  CLOUD_WIDTH_MAX,
  CLOUD_WIDTH_MIN,
  PREF_KEY,
  UI_STATE_KEY,
} from '@etn/shared';

import { scheduleRefresh, requireNetworkId } from '../app.js';
import { field, showDialog } from '../lib/dialog.js';
import { div, el, errText, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { notice } from '../lib/notice.js';
import { clip } from '../lib/pure.js';
import { store } from '../state.js';

/** «Настройки видимости» dialog: show_inactive toggle. */
export function showVisibilitySettings(): void {
  const networkId = requireNetworkId();
  const label = el('label', 'checkbox-row');
  const checkbox = el('input');
  checkbox.type = 'checkbox';
  checkbox.checked = store.state.showInactive;
  label.append(checkbox, span('Показывать неактуальные мысли и связи в этой сети'));
  const errorLine = span('', 'error-text');
  const body = div('form-stack');
  body.append(
    label,
    el('p', 'muted', 'Настройка общая для всех ваших клиентов в этой сети.'),
    errorLine,
  );

  showDialog({
    title: 'Настройки видимости',
    body,
    buttons: [
      { label: 'Закрыть', primary: true },
      {
        label: 'Сохранить',
        keepOpen: true,
        onClick: () => {
          void (async () => {
            try {
              await etn.networks.setPreference(networkId, PREF_KEY.SHOW_INACTIVE, checkbox.checked);
              store.update({ showInactive: checkbox.checked });
              scheduleRefresh();
              notice('Настройка сохранена.');
            } catch (err) {
              errorLine.textContent = errText(err);
            }
          })();
        },
      },
    ],
  });
}

/** «Размер облачка» dialog: cloud_width / cloud_gap with clipping. */
export function showCloudSizeSettings(): void {
  const networkId = requireNetworkId();

  const widthInput = el('input', 'text-input');
  widthInput.type = 'number';
  widthInput.min = String(CLOUD_WIDTH_MIN);
  widthInput.max = String(CLOUD_WIDTH_MAX);
  widthInput.value = String(store.state.cloudWidth);

  const gapInput = el('input', 'text-input');
  gapInput.type = 'number';
  gapInput.min = String(CLOUD_GAP_MIN);
  gapInput.max = String(CLOUD_GAP_MAX);
  gapInput.value = String(store.state.cloudGap);

  const errorLine = span('', 'error-text');
  const body = div('form-stack');
  body.append(
    field(`Ширина облачка, px (${CLOUD_WIDTH_MIN}–${CLOUD_WIDTH_MAX})`, widthInput),
    field(`Отступ между облачками, px (${CLOUD_GAP_MIN}–${CLOUD_GAP_MAX})`, gapInput),
    el('p', 'muted', 'Настройка хранится только на этом клиенте.'),
    errorLine,
  );

  showDialog({
    title: 'Размер облачка',
    body,
    width: 420,
    buttons: [
      { label: 'Закрыть', primary: true },
      {
        label: 'Сохранить',
        keepOpen: true,
        onClick: () => {
          void (async () => {
            const width = clip(
              Math.round(Number(widthInput.value)),
              CLOUD_WIDTH_MIN,
              CLOUD_WIDTH_MAX,
            );
            const gap = clip(Math.round(Number(gapInput.value)), CLOUD_GAP_MIN, CLOUD_GAP_MAX);
            try {
              await etn.ui.setState(networkId, UI_STATE_KEY.CLOUD_WIDTH, String(width));
              await etn.ui.setState(networkId, UI_STATE_KEY.CLOUD_GAP, String(gap));
              store.update({ cloudWidth: width, cloudGap: gap });
              notice('Размер облачка обновлён.');
            } catch (err) {
              errorLine.textContent = errText(err);
            }
          })();
        },
      },
    ],
  });
}

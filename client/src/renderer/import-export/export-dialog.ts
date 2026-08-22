/**
 * Export dialog (phase P, task P5).
 *
 * Reusable modal that captures the user's intent for a `.etnx` export —
 * which slices of the graph to include and how deep the subtree walk
 * should go. Returns the chosen options via a Promise so callers can
 * dispatch directly to `etn.system.export` (see `selection.ts:runExport`).
 *
 * For non-`.etnx` formats the dialog is unnecessary — `runExport` skips
 * the prompt and uses defaults. This keeps the legacy Markdown/PDF/HTML
 * flow one click long.
 */

import { ETNX_SUBTREE_DEPTH_MAX, type ExportEtnxOptions } from '@etn/shared';

import { div, el } from '../lib/dom.js';
import { showDialog } from '../lib/dialog.js';

/** Inline label helper — wraps a control with a `<label>` whose text is on
 *  the left. Kept here to avoid pulling a util module just for this dialog. */
function wrapLabel(text: string, control: HTMLElement): HTMLElement {
  const wrap = div('export-dialog-row');
  const lab = el('label', 'export-dialog-label');
  lab.textContent = text;
  lab.append(control);
  wrap.append(lab);
  return wrap;
}

interface DialogResult {
  /** `undefined` — the user cancelled. */
  options: ExportEtnxOptions | undefined;
}

/** Open the dialog and resolve with the chosen options or `undefined`. */
export function showExportEtnxDialog(
  thoughtCount: number,
  initial: Partial<ExportEtnxOptions> = {},
): Promise<DialogResult> {
  return new Promise<DialogResult>((resolve) => {
    const state: Required<ExportEtnxOptions> = {
      include_types: initial.include_types ?? true,
      include_attachments: initial.include_attachments ?? true,
      include_chronology: initial.include_chronology ?? true,
      include_subtree: initial.include_subtree ?? false,
      subtree_depth: initial.subtree_depth ?? 1,
    };

    const cbTypes = checkbox('Типы мыслей и связей', state.include_types);
    const cbAtt = checkbox('Вложения (файлы внутри zip)', state.include_attachments);
    const cbChrono = checkbox('Хронологические комментарии', state.include_chronology);
    const cbSubtree = checkbox('Включить подчинённые мысли', state.include_subtree);
    const depthInput = numberInput(
      `Глубина подчинённости (1..${ETNX_SUBTREE_DEPTH_MAX})`,
      state.subtree_depth,
    );
    depthInput.disabled = !state.include_subtree;
    cbSubtree.addEventListener('change', () => {
      depthInput.disabled = !cbSubtree.checked;
    });

    const body = div('export-dialog');
    body.append(
      el('p', 'export-dialog-hint', `Будет экспортировано мыслей: ${thoughtCount}.`),
      cbTypes,
      cbAtt,
      cbChrono,
      cbSubtree,
      depthInput,
    );

    showDialog({
      title: 'Экспорт в .etnx',
      body,
      width: 460,
      buttons: [
        { label: 'Отмена', onClick: () => resolve({ options: undefined }) },
        {
          label: 'Экспортировать',
          primary: true,
          onClick: () => {
            const depth = clampDepth(depthInput.valueAsNumber);
            resolve({
              options: {
                include_types: cbTypes.checked,
                include_attachments: cbAtt.checked,
                include_chronology: cbChrono.checked,
                include_subtree: cbSubtree.checked,
                subtree_depth: depth,
              },
            });
          },
        },
      ],
    });
  });
}

function checkbox(labelText: string, initial: boolean): HTMLInputElement {
  const cb = el('input', 'export-dialog-checkbox') as HTMLInputElement;
  cb.type = 'checkbox';
  cb.checked = initial;
  // Build the label-row container in-place. The caller stores `cb` directly
  // to read `.checked`; the wrapper exists in the DOM only as a layout hint.
  const wrap = wrapLabel(labelText, cb);
  void wrap;
  return cb;
}

function numberInput(labelText: string, initial: number, max: number = ETNX_SUBTREE_DEPTH_MAX): HTMLInputElement {
  const input = el('input', 'export-dialog-number') as HTMLInputElement;
  input.type = 'number';
  input.min = '1';
  input.max = String(max);
  input.step = '1';
  input.value = String(initial);
  const wrap = wrapLabel(labelText, input);
  void wrap;
  return input;
}

function clampDepth(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.max(1, Math.min(ETNX_SUBTREE_DEPTH_MAX, Math.floor(v)));
}

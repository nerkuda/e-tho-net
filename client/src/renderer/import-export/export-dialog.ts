/**
 * Export dialog (phase P, task P5).
 *
 * Reusable modal that captures the user's intent for a `.etnx` export:
 * the output filename, which slices of the graph to include, and how deep
 * the subtree walk should go. Returns the chosen options via a Promise so
 * callers can dispatch directly to `etn.system.export` (see
 * `selection.ts:runExport` and `canvas/context-menu.ts:exportSingleThought`).
 *
 * Layout reuses the existing `.checkbox-row`, `.field-label`, `.text-input`
 * classes from `styles.css` — there are no new CSS classes here, the dialog
 * blends with every other modal in the app.
 */

import {
  ETNX_SUBTREE_DEPTH_MAX,
  type ExportEtnxOptions,
} from '@etn/shared';

import { div, el } from '../lib/dom.js';
import { showDialog } from '../lib/dialog.js';

interface DialogResult {
  /** `undefined` — the user cancelled. */
  options: ExportEtnxOptions | undefined;
  /** Output filename hint (without extension). Defaults to a network+date slug. */
  filename: string | undefined;
}

/** Open the dialog and resolve with the chosen options or `undefined`. */
export function showExportEtnxDialog(
  thoughtCount: number,
  initial: Partial<ExportEtnxOptions> = {},
  defaultFilename: string = defaultExportName(),
): Promise<DialogResult> {
  return new Promise<DialogResult>((resolve) => {
    const includeTypes = makeCheckbox('Включить типы мыслей и связей', initial.include_types ?? true);
    const includeAttachments = makeCheckbox(
      'Включить вложения (файлы внутри архива)',
      initial.include_attachments ?? true,
    );
    const includeChronology = makeCheckbox(
      'Включить хронологические комментарии',
      initial.include_chronology ?? true,
    );
    const includeSubtree = makeCheckbox(
      'Включить подчинённые мысли',
      initial.include_subtree ?? false,
    );
    const depthInput = el('input', 'text-input') as HTMLInputElement;
    depthInput.type = 'number';
    depthInput.min = '1';
    depthInput.max = String(ETNX_SUBTREE_DEPTH_MAX);
    depthInput.step = '1';
    depthInput.value = String(initial.subtree_depth ?? 1);
    depthInput.disabled = !includeSubtree.checked;
    includeSubtree.addEventListener('change', () => {
      depthInput.disabled = !includeSubtree.checked;
    });

    const filenameInput = el('input', 'text-input') as HTMLInputElement;
    filenameInput.type = 'text';
    filenameInput.value = defaultFilename;
    filenameInput.placeholder = defaultFilename;

    const body = div('export-dialog');
    body.append(
      makeHint(`Будет экспортировано мыслей: ${thoughtCount}.`),
      makeField('Имя файла (без расширения)', filenameInput),
      div('form-stack'),
      includeTypes,
      includeAttachments,
      includeChronology,
      includeSubtree,
      makeField(`Глубина подчинённости (1..${ETNX_SUBTREE_DEPTH_MAX})`, depthInput),
    );

    showDialog({
      title: 'Экспорт в .etnx',
      body,
      width: 480,
      buttons: [
        { label: 'Отмена', onClick: () => resolve({ options: undefined, filename: undefined }) },
        {
          label: 'Экспортировать',
          primary: true,
          onClick: () => {
            const depth = clampDepth(depthInput.valueAsNumber);
            const filename = filenameInput.value.trim() || defaultFilename;
            resolve({
              options: {
                include_types: includeTypes.checked,
                include_attachments: includeAttachments.checked,
                include_chronology: includeChronology.checked,
                include_subtree: includeSubtree.checked,
                subtree_depth: depth,
              },
              filename,
            });
          },
        },
      ],
    });
  });
}

/** Build a checkbox row that uses the project's `.checkbox-row` style. */
function makeCheckbox(labelText: string, initial: boolean): HTMLInputElement {
  const cb = el('input') as HTMLInputElement;
  cb.type = 'checkbox';
  cb.checked = initial;
  const row = div('checkbox-row');
  const lab = el('label', 'field-label');
  lab.textContent = labelText;
  row.append(cb, lab);
  return cb;
}

/** `field(label, control)` — label above control, sharing the row. */
function makeField(labelText: string, control: HTMLElement): HTMLElement {
  const wrap = div('form-stack');
  const lab = el('label', 'field-label');
  lab.textContent = labelText;
  wrap.append(lab, control);
  return wrap;
}

/** Inline hint paragraph at the top of the dialog. */
function makeHint(text: string): HTMLElement {
  const p = el('p', 'dialog-text');
  p.textContent = text;
  return p;
}

function clampDepth(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.max(1, Math.min(ETNX_SUBTREE_DEPTH_MAX, Math.floor(v)));
}

/** Default filename: `etnx-YYYY-MM-DD`. The `.etnx` extension is appended
 *  by the download route (or by the browser, which keeps the original
 *  content-disposition name). */
export function defaultExportName(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `etnx-${y}-${m}-${d}`;
}

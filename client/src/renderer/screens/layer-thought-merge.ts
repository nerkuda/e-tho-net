/**
 * Разрешение изменений мыслей слоя из GUI (задача f5c363a3, «Слияние отдельных
 * мыслей в основу из GUI с разрешением конфликтов»).
 *
 * Единая точка входа для обеих команд «слить в основу»:
 *   * контекстное меню мысли на канве (`canvas/context-menu.ts`) — одна мысль;
 *   * меню «Действия» панели выделенных (`selection/selection.ts`) — группа
 *     выбранных мыслей, изменённых в слое.
 *
 * Варианты разрешения:
 *   1. «Отказаться от изменений» — строки мысли удаляются из слоя
 *      (`layers.discardThought`, деструктивно → подтверждение);
 *   2. «Полностью переписать мысль в основе» — версия слоя побеждает целиком
 *      (`layers.mergeThought` режим `overwrite`);
 *   3. «Объединить изменения» — постоянный комментарий объединяется с основой
 *      (`layers.mergeThought` режим `combine`); вариант доступен, только когда у
 *      каждой обрабатываемой мысли постоянный комментарий различается и есть в
 *      основе. Для «не-мыслей» (правки лишь в связях/свойствах/синонимах)
 *      остаются варианты 1–2.
 */

import { BASE_LAYER_ID, type LayerMergeReport } from '@etn/shared';

import { confirmDialog, errorDialog, showDialog } from '../lib/dialog.js';
import { div, span } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { etn } from '../lib/etn.js';
import { notice } from '../lib/notice.js';
import { choiceGroup, radioRow } from '../lib/ui/choice-row.js';
import { isInBaseLayer } from '../lib/layer-base.js';
import { store } from '../state.js';
import { scheduleLayerOverridesRefresh } from './layers.js';

/** Вариант разрешения изменений мысли. */
export type LayerMergeVariant = 'discard' | 'overwrite' | 'combine';

/** Обрабатываемая мысль: id и подпись для диалога. */
export interface LayerMergeSubject {
  id: string;
  title: string;
}

/**
 * Доступные варианты по данным текстового диффа мысли (чистая функция —
 * юнит-тест). «Объединение» возможно только для мысли, постоянный комментарий
 * которой различается и присутствует в основе: у «не-мысли» (правки лишь в
 * связях/свойствах/синонимах) остаётся только «отказаться» / «переписать»,
 * как и у мысли без текста в основе.
 */
export function availableMergeVariants(input: {
  commentChanged: boolean;
  targetCommentPresent: boolean;
}): LayerMergeVariant[] {
  const variants: LayerMergeVariant[] = ['discard', 'overwrite'];
  if (input.commentChanged && input.targetCommentPresent) variants.push('combine');
  return variants;
}

/** Подпись цели слияния по слою сессии. */
function targetTitle(): string {
  const current = store.state.currentLayer;
  if (current === null) return 'Основу';
  const parentId = store.state.layers.find((l) => l.id === current.id)?.parent_id ?? null;
  if (parentId === null || parentId === BASE_LAYER_ID) return 'Основу';
  return store.state.layers.find((l) => l.id === parentId)?.title ?? 'Основу';
}

/** Итог применения выбранного варианта ко всем мыслям. */
interface ApplySummary {
  merged: number;
  discarded: number;
  conflicts: number;
}

/** Применить выбранный вариант ко всем мыслям; вернуть сводку. */
async function applyVariant(
  networkId: string,
  layerId: string,
  subjects: LayerMergeSubject[],
  variant: LayerMergeVariant,
): Promise<ApplySummary> {
  let merged = 0;
  let discarded = 0;
  let conflicts = 0;
  for (const subject of subjects) {
    if (variant === 'discard') {
      await etn.layers.discardThought(networkId, layerId, subject.id);
      discarded += 1;
      continue;
    }
    const report: LayerMergeReport = await etn.layers.mergeThought(
      networkId,
      layerId,
      subject.id,
      variant,
    );
    merged += 1;
    if (report.thought_merge?.comment_merged === true) conflicts += report.thought_merge.comment_conflicts;
  }
  return { merged, discarded, conflicts };
}

/**
 * Открывает диалог разрешения изменений для набора мыслей (одна — из
 * контекстного меню, несколько — из панели выделения). В основе слоя ничего не
 * делает — команда доступна только в слое изменений.
 */
export function openMergeDialog(networkId: string, subjects: LayerMergeSubject[]): void {
  const current = store.state.currentLayer;
  if (isInBaseLayer() || current === null || subjects.length === 0) return;
  const layerId = current.id;
  const target = targetTitle();

  void (async () => {
    // «Объединить» доступно, только если у каждой мысли комментарий изменён и
    // присутствует в основе; ошибка чтения диффа трактуется как «недоступно».
    let combineAvailable = subjects.length > 0;
    for (const subject of subjects) {
      try {
        const diff = await etn.layers.thoughtDiff(networkId, layerId, subject.id);
        const comment = diff.fields.find((f) => f.key === 'comment');
        const variants = availableMergeVariants({
          commentChanged: comment?.changed === true,
          targetCommentPresent: (comment?.target ?? '').trim().length > 0,
        });
        if (!variants.includes('combine')) combineAvailable = false;
      } catch {
        combineAvailable = false;
      }
    }

    const titleOne = subjects.length === 1 ? subjects[0]!.title : null;
    const titleText =
      titleOne !== null
        ? `мысли «${titleOne}»`
        : `${subjects.length} выбранных мыслей, изменённых в слое`;

    const body = div('form-stack');
    const hint = div('layer-hint');
    hint.textContent = `Правки ${titleText} в слое «${current.title}» разрешаются по отношению к «${target}».`;
    body.append(hint);

    const group = choiceGroup();
    const name = 'layer-merge-variant';
    let selected: LayerMergeVariant = 'overwrite';
    const rows: Array<[LayerMergeVariant, string, string]> = [
      [
        'discard',
        'Отказаться от изменений',
        `Все правки в слое будут удалены — вернётся версия «${target}». Отменить нельзя.`,
      ],
      [
        'overwrite',
        'Полностью переписать мысль в основе',
        `Версия слоя переносится целиком, изменения «${target}» по этим мыслям затираются.`,
      ],
    ];
    if (combineAvailable) {
      rows.push([
        'combine',
        'Объединить изменения',
        'Постоянный комментарий объединяется с основой (маркеры конфликтов git-стиля); связи, свойства и синонимы берутся из слоя.',
      ]);
    }
    for (const [value, label, hintText] of rows) {
      const handle = radioRow({ label, value, name, checked: value === selected });
      handle.row.classList.add('merge-variant');
      const hintEl = span('merge-variant-hint');
      hintEl.textContent = hintText;
      handle.row.append(hintEl);
      handle.input.addEventListener('change', () => {
        if (handle.input.checked) selected = value;
      });
      group.append(handle.row);
    }
    body.append(group);

    showDialog({
      title:
        titleOne !== null
          ? `Слить мысль в «${target}»?`
          : `Слить выбранные мысли в «${target}»?`,
      body,
      size: 'm',
      buttons: [
        { label: t('actions.cancel'), onClick: (close) => close() },
        {
          label: 'Выполнить',
          primary: true,
          keepOpen: true,
          onClick: (close) => {
            void (async () => {
              const confirmed =
                selected !== 'discard' ||
                (await confirmDialog(
                  'Отказаться от изменений?',
                  `Все правки ${titleText} в слое будут удалены безвозвратно. Основа не изменится.`,
                  true,
                ));
              if (!confirmed) return;
              try {
                const result = await applyVariant(networkId, layerId, subjects, selected);
                close();
                scheduleLayerOverridesRefresh();
                if (selected === 'discard') {
                  notice(`Изменения ${titleText} удалены из слоя.`);
                } else if (combineAvailable && result.conflicts > 0) {
                  notice(
                    `Слито мыслей: ${result.merged}. Комментарий объединён, конфликтных блоков: ${result.conflicts}.`,
                  );
                } else {
                  notice(`Слито в «${target}»: ${result.merged}.`);
                }
              } catch (err) {
                errorDialog('Не удалось разрешить изменения', err);
              }
            })();
          },
        },
      ],
    });
  })();
}

/** Контекстное меню мысли: одна мысль. */
export function openThoughtMergeDialog(
  networkId: string,
  thoughtId: string,
  thoughtTitle: string,
): void {
  openMergeDialog(networkId, [{ id: thoughtId, title: thoughtTitle }]);
}

/**
 * Universal thought picker/add dialog (H14, 08-ui-spec.md §4; 09-scenarios.md
 * C1, C2; universalized for every thought-picking site, L20).
 *
 * Live duplicate search over `thoughts.findDuplicates` (the synonym-pattern
 * principle of 02-data-model.md §3.2 with an implicit `*` around every typed
 * word: fragments must hit consecutive words of the title or one synonym in
 * the typed order, «дор» → «Доработать!»; `-word` excludes infix
 * occurrences); the
 * anchor thought is excluded from the candidates — a thought cannot link to
 * itself; a whole-query UUID resolves the thought directly via `thoughts.get`
 * (§4.1) into a single exact-match candidate («Мысль с указанным ID
 * отсутствует» when unknown); single and multi
 * modes; `|` synonym parsing per line; multi-line paste auto-switches to
 * multi mode; Enter adds the best match to the list (an exact title/synonym
 * hit reuses the existing thought, otherwise a new one is queued), Ctrl+Enter
 * applies the whole list (Ctrl+Shift+Enter also focuses the first inserted
 * thought, L19). Clicking a found thought in multi mode adds it to the list
 * (existing thoughts are picked as-is — never re-created).
 *
 * The dialog only ACCUMULATES the list and returns it — the caller decides
 * what to do (canvas: create thoughts/links; pickers: use the ids). Options
 * adapt it to a pure picker:
 *   - `allowCreate: false` forbids new thoughts and hides the type field;
 *   - `allowLinkType: false` hides the link-type field;
 *   - `selectedIds` prefills the list (multi mode switches on automatically);
 *   - `searchTypeIds` narrows the live search (link-property type configs).
 *
 * Also handles the drop of files/URLs onto the canvas (08-ui-spec.md §7):
 * the zone drop handlers create thoughts with an attachment.
 */

import { scheduleRefresh, requireNetworkId, setFocus } from '../app.js';
import { t } from '../lib/i18n.js';
import { invalidateRef, setAddDialogOpener } from '../canvas/canvas.js';
// Строки кандидатов-дублей рисует общая выпадашка подсказок (общая сборка
// строки) — собственной разметки списка нет (требование d1cd2095).
import { buildSuggestRow, type SuggestEntry } from '../lib/suggest-dropdown.js';
import { showDialog } from '../lib/dialog.js';
import { footerErrorLine } from '../lib/ui/messages.js';
import { div, el, errText, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { applyCommentTemplateIfEmpty } from '../lib/comment-template.js';
import { ensureLink, throwOnFailures } from '../lib/link-ops.js';
import { notice } from '../lib/notice.js';
import { notifyPropertyValuesRefreshed } from '../lib/property-values-refresh.js';
import { signalPublicationCompositionChanged } from '../lib/live/index.js';
import { parseAddLines, parseTitleWithSynonyms, parseThoughtIdLookupQuery, isNotFoundError } from '../lib/pure.js';
import { buildEntityCombo, loadCrossNetworkCandidates, type LinkPropertyPick } from '../lib/entity-picker.js';
import {
  buildPropertyListRows,
  ensurePropertyLinkTypes,
  type PropertyListRow,
} from '../lib/property-list.js';
import type { DuplicateHit } from '../../main/ipc/contract.js';
import { UI_STATE_KEY, type Thought } from '@etn/shared';
import { store } from '../state.js';
import { uiButton } from '../lib/ui/button.js';
import { fieldTextarea } from '../lib/ui/field.js';
import { radioRow } from '../lib/ui/choice-row.js';
import { fieldRow } from '../lib/ui/field.js';

/** One accumulated list entry: an existing thought or a queued new one. */
export type ThoughtPickItem =
  | {
      kind: 'existing';
      id: string;
      raw: string;
      /**
       * Сеть-владелец выбранной мысли — заполняется только в кросс-сетевом
       * режиме диалога (`crossNetwork`, задача ea04a185). Обычные вызывающие
       * читают только `id` и поле игнорируют.
       */
      networkId?: string;
    }
  | { kind: 'new'; title: string; synonyms: string[]; raw: string };

/**
 * Ширина выпадашек диалога добавления, px (ошибка 5c7f8376): списки типа мысли
 * и свойства связи заметно шире узкого поля и должны совпадать по ширине.
 * Выпадашка общего комбо-пикера позиционируется абсолютно и может быть шире
 * поля. 560px — по фидбэку приёмки (прежние 640 были избыточны).
 */
export const ADD_DIALOG_DROPDOWN_MIN_WIDTH = 560;

/**
 * Выбранное в диалоге СВОЙСТВО-связь — значение четвёртого источника общего
 * комбо-пикера (`lib/entity-picker.ts`, требование cdb6b52f). Реэкспорт:
 * карточка диалога и его потребители адресуют значение одним именем.
 */
export type { LinkPropertyPick } from '../lib/entity-picker.js';

/** Result of {@link pickThoughtsDialog} (null = cancelled). */
export interface ThoughtPickResult {
  items: ThoughtPickItem[];
  /** Type for NEW thoughts (null = none / the field was hidden). */
  thoughtTypeId: string | null;
  /** Link type chosen in the dialog (null = none / the field was hidden). */
  linkTypeId: string | null;
  /** Свойство-связь, выбранное в диалоге (ошибка 1dd08949). `null` — свойство
   *  не выбрано: применяется прежняя бестиповая связь в направлении диалога. */
  linkProperty: LinkPropertyPick | null;
  /** Applied via Shift+Ctrl+Enter — focus the first inserted item (L19). */
  focusFirst: boolean;
}

/** Options of {@link pickThoughtsDialog}. */
export interface ThoughtPickerOptions {
  networkId: string;
  /** Canvas anchor: shows «вверх/вниз к …» and makes the link type meaningful. */
  anchor?: { id: string; direction: 'parent' | 'child' } | null;
  /** Allow queueing new thoughts (default true). `false` hides the type field. */
  allowCreate?: boolean;
  /** Show the link-type field (default true — the canvas add flows). */
  allowLinkType?: boolean;
  /**
   * Показывать поле «Свойство связи» вместо «Тип связи» (ошибка 1dd08949):
   * список — отдельные имена сторон свойств-связей сети (`rows`), выбранное
   * свойство заполняется у добавляемой мысли значением якоря. Строки задаёт
   * вызывающий (он грузит реестр + каталог типов связей — см. `openAddDialog`
   * и `ensurePropertyLinkTypes`); без него поле деградирует в «без свойства».
   */
  linkProperty?: { rows: readonly PropertyListRow[] };
  /** Restrict the live search to these thought types (link-property configs). */
  searchTypeIds?: string[];
  /**
   * Preselect the thought type for NEW thoughts (the type field stays
   * editable). Used by link-property pickers whose definition restricts the
   * target types: the first allowed type is the sensible default for a
   * thought created right from the property editor.
   */
  defaultNewThoughtTypeId?: string | null;
  /** Prefill the list with these thoughts; multi mode switches on. */
  selectedIds?: string[];
  /**
   * Prefill the NAME INPUT as if the text were typed (the
   * create-from-legacy-link flow, карточка ETN 34ffbd75): `имя|алиас` parses
   * into title + synonym on add (08-ui-spec.md §4.3), the live duplicate
   * search runs right away, and the dialog STAYS in single mode — the user
   * may still switch to multi, edit the name or pick a type.
   */
  prefillText?: string;
  /**
   * Anchor display title override: by default the dialog shows the FOCUSED
   * thought's title for the «вверх/вниз к …» suffix, which is wrong whenever
   * the anchor is not the focus (e.g. a comment owner). Pass the real title.
   */
  anchorTitle?: string;
  /** Dialog title override (defaults by `allowCreate`/anchor). */
  title?: string;
  /** Primary button label override (defaults «Добавить»/«Выбрать»). */
  applyLabel?: string;
  /**
   * Кросс-сетевой режим выбора (задача ea04a185): живой поиск кандидатов идёт
   * веером по всем сетям пользователя — охват задан принудительно назначением
   * диалога, переключателя нет. Мысли собственной сети (`excludeNetworkId`) из
   * выдачи исключаются (запрет своей сети, требование 884d14e1 — у каждого
   * item появляется `networkId`), создание новых мыслей недоступно. Так диалог
   * адресует мысль ДРУГОЙ сети. Обычные (без `crossNetwork`) вызовы ищут
   * строго по текущей сети (требование 79755f76, ошибка 81be082f): выбор цели
   * внутрисетевой связи чужой мыслью невалиден.
   */
  crossNetwork?: { excludeNetworkId: string };
}

/** One list entry with its duplicate-check result (internal shape). */
interface AddLine {
  raw: string;
  title: string;
  synonyms: string[];
  /** Candidate id when an exact title/synonym match was found. */
  existingId: string | null;
  /** Strongest candidate match kind (informational). */
  matchKind: 'title' | 'synonym' | 'partial' | null;
  /** Сеть-владелец существующей мысли (кросс-сетевой режим, ea04a185). */
  networkId: string | null;
}

/** The first existing-thought id of a picker result (single-pick helper). */
export function firstPickedThoughtId(result: ThoughtPickResult | null): string | null {
  if (result === null) return null;
  for (const item of result.items) {
    if (item.kind === 'existing') return item.id;
  }
  return null;
}

/** Every existing-thought id of a picker result (multi-pick helper). */
export function pickedThoughtIds(result: ThoughtPickResult | null): string[] {
  if (result === null) return [];
  return result.items.flatMap((item) => (item.kind === 'existing' ? [item.id] : []));
}

/**
 * Maps a thought fetched by id onto the duplicate-hit shape of the candidates
 * list: `matched_on: 'title'` makes it an exact match, so Enter/клик pick the
 * existing thought instead of queueing a new one.
 */
function thoughtToCandidate(thought: Thought): DuplicateHit {
  return {
    id: thought.id,
    title: thought.title,
    synonyms: thought.synonyms,
    matched_on: 'title',
    type_id: thought.type_id,
    icon: thought.icon,
    icon_kind: thought.icon_kind,
    fg_color: thought.fg_color,
    bg_color: thought.bg_color,
    font_bold: thought.font_bold,
    font_italic: thought.font_italic,
    font_underline: thought.font_underline,
    font_strike: thought.font_strike,
    parent_title: null,
  };
}

/**
 * Варианты поля «Свойство связи» строит четвёртый источник общего комбо-пикера
 * (`buildEntityCombo`, `kind: 'link-properties'`, требование cdb6b52f): одна
 * строка на КАЖДОЕ имя стороны свойства-связи (прямое — источник, обратное —
 * назначение) со значком направления, как в общем списке свойств. Пустое
 * значение — свойство не выбрано: связь создаётся бестиповой в направлении
 * диалога.
 */

let mounted = false;
/** Mounts the dialog opener into the canvas drag gestures (called by the workspace). */
export function mountAddDialog(): void {
  if (mounted) return;
  mounted = true;
  setAddDialogOpener((ctx) => void openAddDialog(ctx));
}

/**
 * Opens the universal picker and inserts the picked list into the canvas:
 * existing thoughts get linked to the anchor, new ones are created (with the
 * chosen thought type) and linked; the link type applies to every link.
 *
 * `anchorTitle` is the anchor's OWN name: the dialog's «вверх/вниз к …» suffix
 * names the call owner (08-ui-spec.md §4.1–4.2), which for an ellipse drag is
 * the thought whose ellipse was dragged — passing nothing used to make the
 * suffix name the FOCUSED thought instead (ошибка c8bd4676). Callers that do
 * not know the anchor's name still get the focus fallback of
 * {@link pickThoughtsDialog}.
 */
export async function openAddDialog(ctx: {
  anchorId: string | null;
  anchorTitle?: string;
  direction: 'parent' | 'child';
}): Promise<void> {
  const networkId = requireNetworkId();
  // Свойства-связи для поля «Свойство связи» (ошибка 1dd08949): реестр + имена
  // сторон из каталога типов связей (общий загрузчик списка свойств). Ошибка
  // загрузки — не повод не открыть диалог: поле деградирует в «без свойства».
  let propertyRows: readonly PropertyListRow[] = [];
  try {
    const registry = await etn.propertyRegistry.list(networkId);
    await ensurePropertyLinkTypes(networkId, registry);
    propertyRows = buildPropertyListRows(registry, store.state.linkTypes);
  } catch {
    propertyRows = [];
  }
  const result = await pickThoughtsDialog({
    networkId,
    anchor: ctx.anchorId !== null ? { id: ctx.anchorId, direction: ctx.direction } : null,
    anchorTitle: ctx.anchorTitle,
    allowCreate: true,
    allowLinkType: false,
    linkProperty: { rows: propertyRows },
    applyLabel: 'Добавить',
  });
  if (result === null) return;
  await insertIntoCanvas(networkId, ctx, result);
}

/**
 * Добавляет якорь в набор значения свойства-связи добавляемой мысли (ошибка
 * 1dd08949). Ключ записи — display-имя выбранной стороны; направление ребра
 * сервер выводит из имени сам, поэтому связь ложится в типизированное свойство.
 * Существующие цели набора ЧИТАЮТСЯ и объединяются с якорем: `properties.set`
 * заменяет набор целиком, а добавление связи не должно молча терять уже
 * проставленные значения (паритет с прежним аддитивным `ensureLink`).
 */
async function addLinkPropertyValue(
  networkId: string,
  ownerId: string,
  pick: LinkPropertyPick,
  anchorId: string,
): Promise<void> {
  let existing: string[] = [];
  try {
    const values = await etn.properties.get(networkId, 'thought', ownerId);
    const entry = values.find((v) => 'values' in v && v.property_id === pick.propertyId);
    if (entry !== undefined && 'values' in entry) {
      existing = entry.values.map((it) => it.target_id);
    }
  } catch {
    /* набор не прочитался — пишем только якорь (лучше связь, чем отказ) */
  }
  const targets = existing.includes(anchorId) ? existing : [...existing, anchorId];
  await etn.properties.set(networkId, 'thought', ownerId, pick.key, targets);
  // Своё значение свойства-связи меняет состав публикации: сигнал слоя (до B1)
  // с владельцем и якорем.
  signalPublicationCompositionChanged([ownerId, anchorId]);
}

/** Creates/links every picked item (the old insertAll flow, L19 focus). */
async function insertIntoCanvas(
  networkId: string,
  ctx: { anchorId: string | null; direction: 'parent' | 'child' },
  result: ThoughtPickResult,
): Promise<void> {
  if (result.items.length === 0) return;
  let created = 0;
  let failed = 0;
  let firstAddedId: string | null = null;
  // Выбранное свойство-связь (ошибка 1dd08949) заполняется у ДОБАВЛЯЕМОЙ мысли
  // значением якоря: сервер сам выводит сторону ребра из display-имени ключа,
  // поэтому связь ложится в типизированное свойство, а не «вне типа».
  const prop = result.linkProperty;
  for (const item of result.items) {
    try {
      if (item.kind === 'existing') {
        if (ctx.anchorId !== null) {
          if (prop !== null) {
            await addLinkPropertyValue(networkId, item.id, prop, ctx.anchorId);
          } else {
            // 0.8.1 (6dcd6db7): `POST /links` снят — связь с существующей
            // мыслью создаётся пакетной операцией; уже связанная пара не
            // дублируется (прежний DUPLICATE больше не ошибка).
            const source = ctx.direction === 'child' ? ctx.anchorId : item.id;
            const target = ctx.direction === 'child' ? item.id : ctx.anchorId;
            const res = await ensureLink(networkId, source, target, result.linkTypeId);
            throwOnFailures(res);
          }
        }
        if (firstAddedId === null) firstAddedId = item.id;
      } else {
        const newThought = await etn.thoughts.create(networkId, {
          title: item.title,
          synonyms: item.synonyms,
          type_id: result.thoughtTypeId,
          // Связь через свойство ставится отдельным вызовом ПОСЛЕ создания
          // (create_link знает только тип связи, не свойство).
          create_link:
            ctx.anchorId === null || prop !== null
              ? undefined
              : {
                  // ctx.direction names the role of the NEW item relative to
                  // the anchor ('parent' — new item becomes the anchor's
                  // parent); create_link.direction names the role of the
                  // TARGET (anchor) relative to the new thought — invert.
                  direction: ctx.direction === 'parent' ? 'child' : 'parent',
                  target_thought_id: ctx.anchorId,
                  type_id: result.linkTypeId,
                },
        });
        if (prop !== null && ctx.anchorId !== null) {
          await addLinkPropertyValue(networkId, newThought.id, prop, ctx.anchorId);
        }
        // Шаблон комментария типа (08-ui-spec.md §8.1): применяется к
        // пустому постоянному комментарию сразу после создания мысли.
        if (result.thoughtTypeId !== null) {
          await applyCommentTemplateIfEmpty(networkId, newThought.id, result.thoughtTypeId);
        }
        if (firstAddedId === null) firstAddedId = newThought.id;
      }
      created++;
    } catch {
      failed++;
    }
  }
  if (failed > 0) notice(`Создано/связано: ${created}, ошибок: ${failed}`, 'error');
  else notice(`Готово: ${created}.`);
  // Диалог добавления связи с карты пишет РЕБРО (в т.ч. типизированное, которое
  // видно значением свойства-связи фокуса). Своего realtime-эха у клиента нет,
  // а сверка окрестности замечает не всякую правку: второе ребро другого типа к
  // уже видимому соседу за границей первой порции сектора подпись окрестности
  // не меняет (ошибка da032ee3). Уведомляем таблицу значений свойств прямо у
  // записи; перечитывание идемпотентно.
  if (ctx.anchorId !== null && created > 0) notifyPropertyValuesRefreshed();
  scheduleRefresh();
  if (result.focusFirst && firstAddedId !== null) void setFocus(firstAddedId);
}

/**
 * The universal dialog itself. Accumulates existing/new thoughts in a list
 * (Enter / candidate click adds; multi-line paste batches new lines) and
 * resolves with the whole list on «Добавить»/«Выбрать» or Ctrl+Enter, or with
 * `null` when dismissed (any close path — «Отмена», Esc, ×, backdrop click).
 */
export function pickThoughtsDialog(opts: ThoughtPickerOptions): Promise<ThoughtPickResult | null> {
  const networkId = opts.networkId;
  // Кросс-сетевой режим (задача ea04a185) диктует источник кандидатов и
  // запрещает создание новых мыслей: адресуется только чужая сеть.
  const crossNetwork = opts.crossNetwork;
  const allowCreate = opts.allowCreate !== false && crossNetwork === undefined;
  const allowLinkType = opts.allowLinkType !== false && crossNetwork === undefined;
  const allowLinkProperty = opts.linkProperty !== undefined && crossNetwork === undefined;
  const searchFilter = (opts.searchTypeIds ?? []).filter((id) => id !== '');

  return new Promise((resolve) => {
    let multi = (opts.selectedIds ?? []).length > 0;
    const lines: AddLine[] = [];

    const modeRow = div('add-mode-row');
    const singleOpt = radioRow({ label: 'одна', name: 'add-mode', checked: !multi });
    const multiOpt = radioRow({ label: 'несколько', name: 'add-mode', checked: multi });
    const singleRadio = singleOpt.input;
    const multiRadio = multiOpt.input;
    modeRow.append(singleOpt.row, multiOpt.row);
    singleRadio.addEventListener('change', () => {
      multi = false;
      // Switching «несколько» → «одна» drops the accumulated list (карточка ETN
      // 24ad9b0e): a later single-mode apply (the button/Ctrl+Enter path) must
      // never resurrect lines queued before the switch. `renderLines` repaints
      // the (now hidden) list empty, so switching back to «несколько» starts
      // from a clean slate instead of showing ghosts.
      lines.length = 0;
      renderLines();
      applyMode();
    });
    multiRadio.addEventListener('change', () => {
      multi = true;
      applyMode();
    });

    // Starts hidden unless the prefill switched multi mode on.
    const lineList = div(multi ? 'add-list' : 'add-list hidden');

    const input = fieldTextarea();
    input.rows = 2;
    input.placeholder =
      allowCreate ? 'Введите название или вставьте список…' : 'Введите название для поиска…';

    // Type of the created thought(s) — searchable picker over the catalogue
    // tree (L6/L21): rows carry the type's icon and style; the hierarchy root
    // is not offered (it only lives in «Типы мыслей»). Hidden when creation is
    // forbidden (the picker mode never changes existing thoughts). The
    // `defaultNewThoughtTypeId` option preselects a type (link-property
    // pickers pass the first allowed target type).
    let newThoughtTypeId: string | null = opts.defaultNewThoughtTypeId ?? null;
    const thoughtTypeCombo = buildEntityCombo({
      networkId,
      kind: 'thought-types',
      value: opts.defaultNewThoughtTypeId ?? null,
      placeholder: 'без типа',
      emptyLabel: 'без типа',
      // Однообразная ширина выпадашек диалога (ошибка 5c7f8376): список типов
      // шире узкого поля и не уступает по ширине списку свойства связи.
      dropdownMinWidth: ADD_DIALOG_DROPDOWN_MIN_WIDTH,
      onChange: (typeId) => {
        newThoughtTypeId = typeId;
      },
    });

    // Type of the created link(s), remembered as the last used one. Hidden
    // for pickers that never create links. The hierarchy root is not offered.
    let linkTypeId: string | null = store.state.lastUsedLinkTypeId;
    const linkTypeCombo = buildEntityCombo({
      networkId,
      kind: 'link-types',
      value: linkTypeId,
      placeholder: 'без типа',
      emptyLabel: 'без типа',
      // Та же ширина, что у списка типа мысли (ошибка 5c7f8376).
      dropdownMinWidth: ADD_DIALOG_DROPDOWN_MIN_WIDTH,
      onChange: (typeId) => {
        linkTypeId = typeId;
        store.update({ lastUsedLinkTypeId: typeId });
        void etn.ui
          .setState(networkId, UI_STATE_KEY.LAST_USED_LINK_TYPE_ID, typeId ?? '')
          .catch(() => undefined);
      },
    });

    // Поле «Свойство связи» (ошибка 1dd08949; с версии 0.9.1 — четвёртый
    // источник общего комбо-пикера, требование cdb6b52f): вместо типа связи —
    // СВОЙСТВО-связь отдельными пунктами по именам сторон, тем же полем, что
    // «Тип мысли» (кнопка «…», единый вид), пустое значение — «без свойства».
    // Выбранное имя стороны адресует серверу и свойство, и направление ребра;
    // свойство заполняется у добавляемой мысли значением якоря. Строки (реестр +
    // имена сторон) готовит вызывающий. Тип связи при этом не выбирается вовсе —
    // направление «вверх/вниз» остаётся только для бестиповой связи, когда
    // свойство не выбрано.
    const propertyRows: readonly PropertyListRow[] = allowLinkProperty
      ? opts.linkProperty?.rows ?? []
      : [];
    let linkPropertyPick: LinkPropertyPick | null = null;
    const linkPropertyCombo = buildEntityCombo({
      networkId,
      kind: 'link-properties',
      value: null,
      placeholder: t('linkProperty.empty'),
      emptyLabel: t('linkProperty.empty'),
      pickerTitle: t('linkProperty.pickerTitle'),
      // Однообразная ширина выпадашек диалога (ошибка 5c7f8376).
      dropdownMinWidth: ADD_DIALOG_DROPDOWN_MIN_WIDTH,
      linkPropertyRows: () => propertyRows,
      onChange: () => undefined,
      onChangeEntity: (option) => {
        linkPropertyPick = option?.linkProperty ?? null;
      },
    });

    const candidates = div('add-candidates');
    const errorLine = footerErrorLine();

    const body = div('form-stack');
    const typeRow = div('add-types-row');
    const thoughtTypeField = fieldRow({
      label: 'Тип мысли',
      control: thoughtTypeCombo.root,
      class: 'add-types-field',
    });
    const linkTypeField = fieldRow({
      label: 'Тип связи',
      control: linkTypeCombo.root,
      class: 'add-types-field',
    });
    const linkPropertyFieldWrap = fieldRow({
      label: 'Свойство связи',
      control: linkPropertyCombo.root,
      class: 'add-types-field add-link-property-combo',
    });
    if (allowCreate) typeRow.append(thoughtTypeField);
    if (allowLinkProperty) typeRow.append(linkPropertyFieldWrap);
    else if (allowLinkType) typeRow.append(linkTypeField);
    // Layout (08-ui-spec.md §4.2): mode switch, then the type pickers on one
    // row, then the name input with the found-thoughts list directly beneath
    // it and the accumulated list under both.
    if (typeRow.childElementCount > 0) body.append(typeRow);
    const hint =
      allowCreate
        ? 'Enter — добавить в список, Ctrl+Enter — применить. В режиме «несколько» клик по найденной мысли добавляет её в список.'
        : 'Выбор только из существующих мыслей: Enter или клик по найденной — в список, Ctrl+Enter — применить.';
    const hintLine = el('p', 'muted', hint);
    hintLine.style.margin = '0';
    // Ошибка 81be082f, требование 79755f76: охват строки поиска задан
    // назначением выбора. Обычный диалог (выбор цели внутрисетевой связи —
    // структурные родители/потомки, свойства-связи, добавление с карты) ищет
    // только по текущей сети, переключателя охвата нет. Кросс-выбор —
    // исключительно кросс-режим (ea04a185), охват задан принудительно.
    const searchRow = div('add-search-row');
    searchRow.append(input);
    body.append(modeRow, searchRow, hintLine, candidates, lineList);
    if (crossNetwork !== undefined) {
      const note = el(
        'p',
        'muted',
        'Поиск идёт по всем вашим сетям; мысли текущей сети недоступны — выберите мысль другой сети.',
      );
      note.style.margin = '0';
      body.insertBefore(note, candidates);
    }

    let timer: number | null = null;
    let lastCandidates: DuplicateHit[] = [];
    /** Сеть-владелец каждого показанного кандидата (кросс-сетевой режим). */
    const candidateNetworks = new Map<string, string>();
    // The anchor thought cannot be linked to itself (the server rejects
    // self-links), so it never shows up among the found candidates.
    const anchorId = opts.anchor?.id ?? null;

    /** Обновить карту сетей кандидатов и запомнить выдачу. */
    function acceptCandidates(hits: DuplicateHit[]): void {
      candidateNetworks.clear();
      for (const hit of hits) {
        if (typeof hit.network_id === 'string' && hit.network_id !== '') {
          candidateNetworks.set(hit.id, hit.network_id);
        }
      }
      lastCandidates = hits;
      renderCandidates(hits);
    }

    /**
     * Подпись сети в облачке кандидата кросс-режима (ошибка defcd811):
     * имя из каталога `networkList` в store (имя сети в пользовательском
     * виде), иначе — короткий префикс id. Каталог подгружается
     * `etn.networks.list()` в фоне (`screens/tabs/tab-accessibility.ts`),
     * к моменту открытия диалога он обычно уже есть.
     */
    function networkDisplayName(networkId: string): string {
      const entry = store.state.networkList.find((n) => n.id === networkId);
      if (entry !== undefined && entry.display_name !== '') return entry.display_name;
      return networkId.length >= 8 ? networkId.slice(0, 8) : networkId;
    }

    /** Debounced duplicate search for the current input. */
    function scheduleSearch(): void {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void (async () => {
          const raw = input.value.trim();
          if (raw === '') {
            renderCandidates([]);
            return;
          }
          // A whole-query UUID is a direct id lookup (08-ui-spec.md §4.1): the
          // type filter is ignored, inactive thoughts are found too, and the
          // hit behaves as an exact-title match downstream (Enter picks it).
          // В кросс-сетевом режиме id-адресация бессмысленна: она ответила бы
          // только о текущей сети (запрет своей сети, 884d14e1), поэтому
          // запрос идёт общим веерным поиском по имени.
          const idQuery = crossNetwork === undefined ? parseThoughtIdLookupQuery(raw) : null;
          if (idQuery !== null) {
            try {
              const thought = await etn.thoughts.get(networkId, idQuery);
              if (thought.id === anchorId) {
                // Same protection as the duplicate search: the anchor never
                // shows up among the candidates (no self-links).
                lastCandidates = [];
                candidates.replaceChildren(
                  el('p', 'muted', 'Нельзя связать мысль с самой собой.'),
                );
                return;
              }
              acceptCandidates([thoughtToCandidate(thought)]);
            } catch (err) {
              if (isNotFoundError(err)) {
                lastCandidates = [];
                candidates.replaceChildren(
                  el('p', 'muted', 'Мысль с указанным ID отсутствует.'),
                );
                return;
              }
              errorLine.show(errText(err));
            }
            return;
          }
          const parsed = parseTitleWithSynonyms(raw);
          try {
            // Охват диктует назначение выбора (требование 79755f76, ошибка
            // 81be082f): кросс-режим (ea04a185) — принудительный веер по всем
            // сетям; обычный диалог — только текущая сеть (штатный findDuplicates).
            const hits: DuplicateHit[] =
              crossNetwork !== undefined
                ? await loadCrossNetworkCandidates(networkId, parsed.title, searchFilter)
                : await etn.thoughts.findDuplicates(
                    networkId,
                    parsed.title,
                    parsed.synonyms,
                    searchFilter,
                  );
            acceptCandidates(
              hits.filter(
                (hit) =>
                  hit.id !== anchorId &&
                  (crossNetwork === undefined || hit.network_id !== crossNetwork.excludeNetworkId),
              ),
            );
          } catch (err) {
            errorLine.show(errText(err));
          }
        })();
      }, 200);
    }
    input.addEventListener('input', scheduleSearch);

    /** Handles multi-line pastes: switches to multi mode and parses lines. */
    if (allowCreate) {
      input.addEventListener('paste', () => {
        window.setTimeout(() => {
          const text = input.value;
          if (!text.includes('\n')) return;
          const parsed = parseAddLines(text);
          if (parsed.length <= 1) return;
          multi = true;
          multiRadio.checked = true;
          applyMode();
          for (const line of parsed) addLine(line.raw, line.title, line.synonyms);
          input.value = '';
        }, 0);
      });
    }

    input.addEventListener('keydown', (event) => {
      // ↓ moves into the found-thoughts list (keyboard path of picking a
      // candidate); Tab reaches it as the next tab stop.
      if (event.key === 'ArrowDown') {
        const first = candidates.querySelector<HTMLElement>('.type-combo-item');
        if (first !== null) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
      if (event.key !== 'Enter') return;
      event.preventDefault();
      // Ctrl+Enter applies the whole list (Shift additionally focuses the
      // first inserted item, L19); the dialog-level Ctrl+Enter does the same
      // without Shift via the primary button.
      if (event.ctrlKey) {
        apply(event.shiftKey);
        return;
      }
      const raw = input.value.trim();
      if (raw === '') return;
      if (multi) {
        addLineFromInput(raw);
        input.value = '';
        scheduleSearch();
        return;
      }
      // Single mode: a new thought is queued when allowed — a listed
      // candidate is picked explicitly (click/Enter on its row, 08-ui-spec.md
      // §4.3); otherwise the strongest match is taken.
      finishSingle(lineFromInput(raw, allowCreate ? false : true));
    });

    /** Shows/hides the accumulated-list UI. */
    function applyMode(): void {
      lineList.classList.toggle('hidden', !multi);
    }

    /**
     * Builds the list entry for a typed query. With `preferExact` an exact
     * title/synonym match reuses the existing thought; otherwise (single-mode
     * Enter with creation allowed) a new one is queued — the typed text is
     * the proposed name, and a listed candidate is used only when the user
     * picks it explicitly. When creation is forbidden, the first candidate is
     * taken (pick from found).
     */
    function lineFromInput(raw: string, preferExact: boolean): AddLine | null {
      const parsed = parseTitleWithSynonyms(raw);
      const exact = lastCandidates.find(
        (c) => c.matched_on === 'title' || c.matched_on === 'synonym',
      );
      if (preferExact && exact !== undefined) {
        return {
          raw,
          title: parsed.title,
          synonyms: parsed.synonyms,
          existingId: exact.id,
          matchKind: exact.matched_on,
          networkId: candidateNetworks.get(exact.id) ?? null,
        };
      }
      if (allowCreate) {
        return {
          raw,
          title: parsed.title,
          synonyms: parsed.synonyms,
          existingId: null,
          matchKind: null,
          networkId: null,
        };
      }
      const first = lastCandidates[0];
      if (first === undefined) {
        errorLine.show('Совпадений нет — создание новых мыслей отключено.');
        return null;
      }
      return {
        raw,
        title: parsed.title,
        synonyms: [],
        existingId: first.id,
        matchKind: 'partial',
        networkId: candidateNetworks.get(first.id) ?? null,
      };
    }

    /** Enter in multi mode: appends the typed query to the list. */
    function addLineFromInput(raw: string): void {
      const line = lineFromInput(raw, true);
      if (line !== null) addLine(line.raw, line.title, line.synonyms, line.existingId, line.matchKind);
    }

    /** Adds a list entry with an immediate exact-duplicate check. */
    function addLine(
      raw: string,
      title: string,
      synonyms: string[],
      existingId: string | null = null,
      matchKind: AddLine['matchKind'] = null,
    ): void {
      // The server classifies candidates by match strength; exact title/synonym
      // matches reuse the existing thought, partial matches create a new one.
      const exact = lastCandidates.find(
        (c) => c.matched_on === 'title' || c.matched_on === 'synonym',
      );
      const resolvedId = existingId ?? exact?.id ?? null;
      if (resolvedId !== null && lines.some((l) => l.existingId === resolvedId)) {
        errorLine.show('Эта мысль уже в списке.');
        return;
      }
      lines.push({
        raw,
        title,
        synonyms,
        existingId: resolvedId,
        matchKind: matchKind ?? exact?.matched_on ?? null,
        networkId: resolvedId !== null ? candidateNetworks.get(resolvedId) ?? null : null,
      });
      errorLine.clear();
      renderLines();
    }

    /** Adds an existing thought picked from the candidate list. */
    function addExisting(candidate: DuplicateHit): void {
      if (lines.some((l) => l.existingId === candidate.id)) return;
      lines.push({
        raw: candidate.title,
        title: candidate.title,
        synonyms: [],
        existingId: candidate.id,
        matchKind: 'title',
        networkId: candidate.network_id ?? null,
      });
      errorLine.clear();
      renderLines();
    }

    /** Renders the accumulated list (with the «Очистить» header button). */
    function renderLines(): void {
      lineList.replaceChildren();
      const head = div('add-list-head');
      head.append(span(`Выбрано: ${lines.length}`, 'muted'));
      head.append(
        uiButton({
          label: t('actions.reset'),
          role: 'secondary',
          size: 's',
          title: 'Очистить список',
          onClick: () => {
            lines.length = 0;
            renderLines();
          },
        }),
      );
      lineList.append(head);
      lines.forEach((line, index) => {
        const row = div('add-list-item');
        const status = line.existingId !== null ? span('🟡', 'al-status') : span('🟢', 'al-status');
        status.title =
          line.existingId !== null
            ? 'Существующая мысль — тип мысли не меняется'
            : 'Будет создана новая мысль';
        const title = el('span', 'al-title', line.title === '' ? line.raw : line.title);
        title.title = line.raw;
        row.append(status, title);
        row.append(
          uiButton({
            label: '×',
            role: 'secondary',
            size: 's',
            title: 'Удалить строку',
            onClick: () => {
              lines.splice(index, 1);
              renderLines();
            },
          }),
        );
        lineList.append(row);
      });
    }

    /** Renders the duplicate candidates for the current input. */
    function renderCandidates(list: DuplicateHit[]): void {
      candidates.replaceChildren();
      if (list.length === 0) return;
      candidates.append(el('p', 'muted', t('addDialog.candidatesHeader')));
      for (const candidate of list) {
        // Точность совпадения (точное имя / синоним / частичное) показана
        // подсказкой строки, а не пометкой в ней (08-ui-spec.md §4.2).
        const matchLabel =
          candidate.matched_on === 'title'
            ? t('addDialog.matchExact')
            : candidate.matched_on === 'synonym'
              ? t('addDialog.matchSynonym', candidate.matched_synonym ?? '')
              : t('addDialog.matchPartial');
        // Строка-облачко — общая сборка строки выпадашки (профиль `tree`,
        // ширина — по ширине списка): значок, цвета и начертание мысли; так
        // равные имена легко отличить друг от друга, а длинное имя обрезается
        // многоточием по ширине списка, а не по холстовым 200px (ошибка
        // a42ea662). Жесты выпадашки не подходят — строка это цель выбора,
        // поэтому клик/клавиатуру вешает диалог; строка фокусируема.
        const entry: SuggestEntry = {
          value: candidate.id,
          label: candidate.title,
          thought: candidate,
          tooltip:
            candidate.synonyms.length > 0
              ? `${candidate.title} (${candidate.synonyms.join(', ')}) — ${matchLabel}`
              : `${candidate.title} — ${matchLabel}`,
        };
        // В кросс-сетевом режиме (ea04a185) у чужой мысли родитель внутри её
        // сети мало что говорит пользователю текущей сети; подпись «сеть»
        // снимает неоднозначность одноимённых мыслей в разных сетях
        // (ошибка defcd811). Цвет акцентный — чтобы не путать с локальным
        // «родителем», который остаётся в обычном режиме.
        if (crossNetwork !== undefined && typeof candidate.network_id === 'string' && candidate.network_id !== '') {
          entry.trailing = {
            text: networkDisplayName(candidate.network_id),
            tone: 'accent',
            tooltip: candidate.network_id,
          };
        } else if (candidate.parent_title !== null) {
          // The parent's title instead of the «использовать» button — the whole
          // row is the pick target (08-ui-spec.md §4.2). Full parent name in the
          // tooltip; the visible length is limited by layout.
          entry.trailing = { text: candidate.parent_title, tooltip: candidate.parent_title };
        }
        const row = buildSuggestRow(entry, { cloudProfile: 'tree', focusable: true });
        row.addEventListener('click', () => {
          pickCandidate(candidate);
        });
        row.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' && event.shiftKey) {
            // Shift+Enter composes a compound name: the candidate's full name
            // replaces the input text, a dot is appended and the caret lands
            // right after it (08-ui-spec.md §4.3).
            event.preventDefault();
            input.value = `${candidate.title}.`;
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
            scheduleSearch();
            return;
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            pickCandidate(candidate);
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const next =
              event.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling;
            if (next instanceof HTMLElement && next.classList.contains('type-combo-item')) {
              next.focus();
              next.scrollIntoView({ block: 'nearest' });
            } else if (event.key === 'ArrowUp') {
              // Above the first row the caret returns to the name input.
              input.focus();
            }
          } else if (event.key === 'Escape') {
            event.preventDefault();
            input.focus();
          }
        });
        candidates.append(row);
      }
    }

    /** A candidate was activated (click/Enter): multi adds it to the list,
     *  single resolves the dialog with it right away. */
    function pickCandidate(candidate: DuplicateHit): void {
      if (multi) {
        addExisting(candidate);
        input.value = '';
        scheduleSearch();
        return;
      }
      // Single mode resolves with exactly this one thought (any accumulated
      // prefill is replaced).
      lines.length = 0;
      lines.push({
        raw: candidate.title,
        title: candidate.title,
        synonyms: [],
        existingId: candidate.id,
        matchKind: 'title',
        networkId: candidate.network_id ?? null,
      });
      input.value = '';
      apply(false);
    }

    /** Single-mode Enter: a built line resolves the dialog immediately. */
    function finishSingle(line: AddLine | null): void {
      if (line === null) return;
      lines.length = 0;
      lines.push(line);
      input.value = '';
      apply(false);
    }

    /** Applies the whole list: a leftover query joins it first. */
    function apply(shift: boolean): void {
      const raw = input.value.trim();
      if (raw !== '') {
        const line = lineFromInput(raw, multi ? true : allowCreate ? false : true);
        if (line !== null) lines.push(line);
      }
      if (lines.length === 0) {
        notice('Список мыслей пуст.', 'info');
        return;
      }
      finish({
        items: lines.map((line) =>
          line.existingId !== null
            ? {
                kind: 'existing' as const,
                id: line.existingId,
                raw: line.raw,
                // Только в кросс-сетевом режиме: сеть-владелец выбранной мысли.
                ...(line.networkId !== null ? { networkId: line.networkId } : {}),
              }
            : { kind: 'new' as const, title: line.title, synonyms: line.synonyms, raw: line.raw },
        ),
        thoughtTypeId: allowCreate ? newThoughtTypeId : null,
        linkTypeId: allowLinkType ? linkTypeId : null,
        linkProperty: allowLinkProperty ? linkPropertyPick : null,
        focusFirst: shift,
      });
    }

    /**
     * Единственная точка завершения промиса. Промис обязан резолвиться на
     * ЛЮБОМ пути закрытия диалога (ошибка 5069a508): кнопки завершают его
     * явно, а Esc и × — через `onClose` каркаса. Флаг
     * `settled` не даёт позднему событию `remove` переиграть уже принятое
     * решение.
     */
    let settled = false;
    const finish = (result: ThoughtPickResult | null): void => {
      if (settled) return;
      settled = true;
      resolve(result);
      closeSelf();
    };

    // Prefill the list from `selectedIds` (titles resolved async; raw ids are
    // shown while loading / offline) — multi mode is already on.
    const prefillIds = opts.selectedIds ?? [];
    if (prefillIds.length > 0) {
      void etn.thoughts
        .resolve(networkId, prefillIds)
        .then((refs) => {
          const byId = new Map(refs.map((r) => [r.id, r.title]));
          for (const id of prefillIds) {
            lines.push({
              raw: byId.get(id) ?? id,
              title: byId.get(id) ?? id,
              synonyms: [],
              existingId: id,
              matchKind: 'title',
              networkId: null,
            });
          }
          renderLines();
        })
        .catch(() => {
          for (const id of prefillIds) {
            lines.push({
              raw: id,
              title: id,
              synonyms: [],
              existingId: id,
              matchKind: 'title',
              networkId: null,
            });
          }
          renderLines();
        });
    }

    const anchorTitle =
      opts.anchor !== undefined && opts.anchor !== null
        ? (opts.anchorTitle ?? store.state.focus?.focused.title ?? '…')
        : '';
    const directionText =
      opts.anchor === undefined || opts.anchor === null
        ? ''
        : opts.anchor.direction === 'parent'
          ? `вверх к «${anchorTitle}»`
          : `вниз к «${anchorTitle}»`;
    const title =
      opts.title ??
      (allowCreate
        ? directionText === ''
          ? 'Добавить мысли'
          : `Добавить мысль (${directionText})`
        : 'Выбор мыслей');
    const applyLabel = opts.applyLabel ?? (allowCreate ? 'Добавить' : 'Выбрать');

    const closeSelf = showDialog({
      title,
      body,
      size: 'm',
      // Ошибка выбора/ввода — строкой в панели кнопок, а не в теле:
      // единственное обязательное место ошибки диалога (требование 397c5a56).
      footerError: errorLine,
      buttons: [
        { label: t('actions.cancel'), onClick: () => finish(null) },
        {
          label: applyLabel,
          primary: true,
          keepOpen: true,
          onClick: () => apply(false),
        },
      ],
      // Ctrl+Shift+Enter applies the list and focuses the first inserted item
      // from any field except the found-thoughts list (the field-level handler
      // on `input` already does `preventDefault`, so the dialog handler is a
      // no-op there; the candidate rows also call `preventDefault`, so the
      // shortcut does not fire while the caret sits in the candidate list).
      extraShortcuts: {
        ctrlShiftEnter: () => apply(true),
      },
      // Esc и × — отмена: промис резолвится `null`, ровно
      // как по кнопке «Отмена», иначе `await` вызывающего висит вечно
      // (ошибка 5069a508). При завершении кнопкой `finish` уже выставил
      // `settled`, поэтому позднее событие `remove` ничего не переигрывает.
      onClose: () => finish(null),
      onMount: () => {
        renderLines();
        // Prefill lands in the input as if typed (карточка ETN 34ffbd75): the
        // duplicate search runs right away, the mode radios stay untouched.
        if (opts.prefillText !== undefined && opts.prefillText !== '') {
          input.value = opts.prefillText;
          scheduleSearch();
        }
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      },
    });
  });
}

/**
 * Handles drops of external files/URLs onto canvas zones (08-ui-spec.md §7):
 * a new thought is created per item with an attachment; drops onto the parents
 * zone create parents, onto the children zone — children.
 */
export function wireZoneExternalDrops(zones: Record<'parents' | 'children', HTMLElement>): void {
  for (const dir of ['parents', 'children'] as const) {
    const zone = zones[dir];
    zone.addEventListener('dragover', (event) => {
      event.preventDefault();
      zone.classList.add('drag-over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', (event) => {
      event.preventDefault();
      zone.classList.remove('drag-over');
      void handleExternalDrop(dir === 'parents' ? 'parent' : 'child', event);
    });
  }
}

/** Creates thoughts for dropped files/URLs, each with an attachment. */
async function handleExternalDrop(direction: 'parent' | 'child', event: DragEvent): Promise<void> {
  const networkId = store.state.networkId;
  const focusId = store.state.focus?.focused.id;
  if (networkId === null || focusId === undefined) return;
  // `direction` names the role of the DROPPED (new) thought relative to
  // focus ('parent' — dropped into the parents zone, becomes focus's
  // parent); create_link.direction names the role of the TARGET (focus)
  // relative to the new thought — invert.
  const createLinkDirection = direction === 'parent' ? 'child' : 'parent';

  const urls = (event.dataTransfer?.getData('text/uri-list') ?? '')
    .split(/[\r\n]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const files = event.dataTransfer !== null ? Array.from(event.dataTransfer.files ?? []) : [];

  for (const url of urls) {
    try {
      const thought = await etn.thoughts.create(networkId, {
        title: url,
        create_link: { direction: createLinkDirection, target_thought_id: focusId },
      });
      // A null title lets the server's URL enrichment (L1) fill the site title;
      // the response then carries the title and the favicon (data: URL).
      const attachment = await etn.attachments.add(networkId, 'thought', thought.id, {
        kind: 'url',
        url,
        title: null,
      });
      // Mirror the enriched site title/icon onto the thought so the cloud shows
      // them right away (the enrichment touches the attachment, not the thought).
      const patch: import('@etn/shared').ThoughtUpdateInput = {};
      if (attachment.title !== null && attachment.title !== url) patch.title = attachment.title;
      if (attachment.icon !== null) {
        patch.icon = attachment.icon;
        patch.icon_kind = 'image';
      }
      if (Object.keys(patch).length > 0) {
        await etn.thoughts.update(networkId, thought.id, patch, thought.version);
        invalidateRef(thought.id);
      }
      scheduleRefresh();
    } catch (err) {
      notice(`Не удалось создать мысль: ${errText(err)}`, 'error');
    }
  }
  for (const file of files) {
    try {
      const path = (file as File & { path?: string }).path ?? file.name;
      const thought = await etn.thoughts.create(networkId, {
        title: file.name,
        create_link: { direction: createLinkDirection, target_thought_id: focusId },
      });
      await etn.attachments.add(networkId, 'thought', thought.id, {
        kind: 'file',
        file_path: path,
        file_size: file.size,
        mime_type: file.type || null,
        title: file.name,
      });
      scheduleRefresh();
    } catch (err) {
      notice(`Не удалось создать мысль: ${errText(err)}`, 'error');
    }
  }
}

/**
 * Wiki-links (task M3): `[[имя мысли|синоним]]`.
 *
 * The shared renderer (@etn/markdown) emits view-mode HTML
 * `<span class="wiki-link" data-wiki-target="…">label</span>`; this module adds
 * the editor-side syntax node (so the link gets syntax colours), the `[[`
 * autocomplete against the network's thoughts (server search, prefix match,
 * `scope=names` — titles and synonyms) and a delegated click handler that
 * focuses the linked thought (resolved by name at click time, never at render
 * time — names may change after the HTML is cached).
 */

import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionSource,
} from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import type { MarkdownExtension } from '@lezer/markdown';

import {
  WIKI_LINK_CLASS,
  WIKI_LINK_DATE_ATTR,
  WIKI_LINK_TARGET_ATTR,
  WIKI_LINK_ID_ATTR,
  WIKI_LINK_NETWORK_ATTR,
} from '@etn/markdown';
import type { Thought } from '@etn/shared';

import type { DuplicateHit } from '../../main/ipc/contract.js';
import { focusFromUi, openNetwork, requireNetworkId } from '../app.js';
import { todayLocal } from '../lib/dates.js';
import { div, el, errText } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { otherHolder } from '../lib/lock-cache.js';
import { notice } from '../lib/notice.js';
import { replaceLegacyWikiLinks } from '../lib/pure.js';
import { createThoughtCloud } from '../lib/thought-cloud.js';
import { openPopover, type PopoverAnchor } from '../lib/ui/popover.js';
import { openStructuresThought } from '../screens/structures/structures.js';
import { openPublicationInWorkspace, setActiveView } from '../screens/active-view.js';
import { openChronicleDay, openChronicleThought } from '../screens/chronicle/chronicle.js';
import { findTabForNetwork } from '../screens/tabs/tab-state.js';
import { store } from '../state.js';
import { dateSuggestOptions, isDatePrefix, withThoughtsSection } from './date-suggest.js';
import { markdownInlineExt } from './markdown-inline-ext.js';
import {
  clickDateChip,
  MD_WIDGET_CLASS,
  setDateChipClickHandler,
  setLegacyWikiLinkClickHandler,
} from './md-live.js';
import {
  legacyCandidateWindow,
  LEGACY_CANDIDATE_LIMIT,
  planLegacyFork,
  resolveLegacyWikiCandidates,
  WIKI_LINK_PUB_ATTR,
} from './wiki-link-resolver.js';
import { tryCreateThoughtFromLegacyLink } from './wiki-link-create.js';
import { transclusionSectionCompletions } from './transclusion.js';
import { t } from '../lib/i18n.js';

/** Chars allowed inside an in-progress wiki prefix (no closing/alias/newline). */
const WIKI_PREFIX_RE = /^[^[\]\n|]*$/;

/** Минимум символов имени для автокомплита трансклюзии (элемент 7a479549). */
export const TRANSCLUSION_MIN_PREFIX = 3;

/**
 * Позиция открывающих скобок и набранный префикс; `transclusion` — перед
 * `[[` стоит восклицательный знак (ссылка трансклюзии, элемент интерфейса
 * 7a479549). Возвращает также `transclusion`, только когда он истинен, —
 * форма ответа прежняя для обычных wiki-ссылок. Пустой префикс — валидное
 * состояние датного режима: сразу после `[[` дропдаун показывает «Даты»
 * (сегодня/завтра) и «Мысли» (ADR ef097fad, решение приёмки 0.16.1).
 */
export function wikiPrefixAt(
  before: string,
): { open: number; prefix: string; transclusion?: true } | null {
  const open = before.lastIndexOf('[[');
  if (open === -1) return null;
  const rest = before.slice(open + 2);
  if (!WIKI_PREFIX_RE.test(rest)) return null;
  if (open > 0 && before[open - 1] === '!') return { open, prefix: rest, transclusion: true };
  return { open, prefix: rest };
}

/** Lezer node: `[[…]]` becomes a `WikiLink` span styled as a link. */
const wikiLinkMarkdownExt: MarkdownExtension = {
  defineNodes: [{ name: 'WikiLink', style: tags.link }],
  parseInline: [
    {
      name: 'WikiLink',
      // До правила Link: иначе `[[мысль|алиас]]` разбирается как
      // ссылка-ссылка (LinkReference), и wiki-узел не создаётся.
      before: 'Link',
      parse(cx, next, pos) {
        if (next !== 91 /* [ */ || cx.char(pos + 1) !== 91) return -1;
        // cx.text — только текущий инлайн-блок, позиции — документальные:
        // ищем «]]» в координатах блока, результат переводим обратно.
        const rel = cx.text.indexOf(']]', pos - cx.offset + 2);
        if (rel === -1) return -1;
        const end = cx.offset + rel;
        const content = cx.slice(pos + 2, end);
        if (content === '' || content.includes('\n') || content.includes('\r')) return -1;
        // Узел покрывает обе закрывающие скобки.
        return cx.addElement(cx.elt('WikiLink', pos, end + 2));
      },
    },
  ],
};

/** Language extension for `markdown({ extensions: […] })`. */
export function wikiLinkLanguage(): MarkdownExtension {
  // Точка подключения инлайн-узлов языка редактора: wiki-ссылки (здесь) и
  // конструкции ТП1 (`markdown-inline-ext.ts`, живой просмотр — `md-live.ts`).
  return [wikiLinkMarkdownExt, markdownInlineExt];
}

/** Short cache of search results per prefix (thought lists change rarely). */
const COMPLETION_TTL_MS = 10_000;

/** Loads prefix matches over titles + synonyms from the server search. */
async function loadCompletions(networkId: string, prefix: string): Promise<Completion[]> {
  // Пустой префикс (`[[` только что набрано) — это НЕ поиск: серверный запрос
  // по пустой строке вернул бы 20 произвольных имён, и список не был бы
  // подсказкой. Дропдаун для пустого префикса не открывается вовсе (хвост
  // задачи 5 задачи 173f1540).
  if (prefix === '') return [];
  try {
    const res = await etn.thoughts.search(networkId, { q: prefix, scope: 'names', limit: 20 });
    return res.by_names.map((hit) => ({
      label: hit.title,
      // ID-based wiki-link (фаза R): вставляем `[[#<id>]]`, чтобы ссылка
      // пережила переименование. Имя подтянется view-резолвером.
      type: 'text',
      apply: `#${hit.thought_id}]]`,
    }));
  } catch {
    return [];
  }
}

/**
 * Открытие дня по умолчанию для date-чипа — единый вход `openChronicleDay`.
 * Модульная переменная (а не параметр по умолчанию с прямой ссылкой): тест
 * подменяет её швом и проверяет СВЯЗКУ «обработчик, который ставит
 * инициализация → открытие дня», а не только факт регистрации обработчика.
 */
let defaultDayOpener: (day: string) => Promise<void> = openChronicleDay;

/**
 * Тестовый шов: прямой вызов загрузчика подсказок без CM6-контекста и подмена
 * единого входа «Дневника» для поведенческой проверки связки date-чипа. В
 * рантайме не используется.
 */
export const wikiLinkInternals = {
  loadCompletions,
  /** Подменить открытие дня по умолчанию; `null` — вернуть `openChronicleDay`. */
  setDefaultDayOpener(open: ((day: string) => Promise<void>) | null): void {
    defaultDayOpener = open ?? openChronicleDay;
  },
};

function wikiLinkCompletions(): CompletionSource {
  // Кэш ПО-ИНСТАНСНЫЙ: своё замыкание на каждый вызов `wikiLinkCompletions()`,
  // а вызов — один на редактор (в `wikiLinkAutocompletion()`). Два инстанса
  // редактора (поле-контейнер и вложенный блок, ТП «Живой блок») кэшируют
  // результаты поиска независимо и не видят чужих записей.
  const cache = new Map<string, { expires: number; options: Completion[] }>();
  return async (context) => {
    const at = completionPrefix(context);
    if (at === null) return null;
    const { hit, from } = at;
    // Пустой префикс — подсказок нет (ни мыслей, ни дат).
    if (hit.prefix === '') return null;
    // Трансклюзия: список мыслей открывается не раньше трёх символов имени
    // (элемент интерфейса 7a479549); обычная wiki-ссылка — с первого.
    if (hit.transclusion === true && hit.prefix.length < TRANSCLUSION_MIN_PREFIX) return null;

    // Единый дропдаун (ADR ef097fad): в датном режиме секцию «Даты» сверху
    // отдаёт отдельный источник `dateCompletions`; здесь мысли лишь получают
    // свою секцию НИЖЕ, иначе CM6 поставил бы их выше дат.
    const datesShown = hit.transclusion !== true && isDatePrefix(hit.prefix);

    let cached = cache.get(hit.prefix);
    if (cached === undefined || cached.expires < Date.now()) {
      cached = {
        expires: Date.now() + COMPLETION_TTL_MS,
        options: await loadCompletions(requireNetworkId(), hit.prefix),
      };
      cache.set(hit.prefix, cached);
    }
    const options = withThoughtsSection(cached.options, datesShown);
    if (options.length === 0) return null;
    // Без `validFor`: источник должен вызываться заново на каждый новый
    // символ префикса (кэш по префиксу выше это и обеспечивает). Широкий
    // `validFor` (WIKI_PREFIX_RE совпадает с любым продолжением) заставлял
    // CM6 фильтровать уже полученные `limit: 20` результатов локально, не
    // перезапрашивая сервер, — поэтому `[[новиков` не находил ничего, если
    // при односимвольном префиксе мысль не попала в первые 20
    // (ошибка 6bba224b-9899-4f7e-a37c-ff2067ac0a6c).
    return { from, options };
  };
}

/** Позиция `[[` и набранный префикс для текущего контекста автокомплита. */
function completionPrefix(
  context: CompletionContext,
): { hit: { open: number; prefix: string; transclusion?: true }; from: number } | null {
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);
  const hit = wikiPrefixAt(before);
  if (hit === null) return null;
  return { hit, from: line.from + hit.open + 2 };
}

/**
 * Источник секции «Даты» (0.16.1, элемент f9da2100, ADR ef097fad). Кандидатов
 * отбирает правило `date-suggest` по набранному префиксу, поэтому результат
 * помечен `filter: false`: метки «Сегодня · 14.11.2026» не содержат ни дефиса,
 * ни ISO-цифр, и штатный FuzzyMatcher CM6 отбросил бы ВСЕ пункты дат на вводе
 * `2026-11-02` (проверено прогоном реального FuzzyMatcher). `validFor` вместе
 * с `filter: false` несовместим по контракту CM6 и запрещён сторожем
 * `guard-wiki-link-validfor`.
 */
const dateCompletions: CompletionSource = (context) => {
  const at = completionPrefix(context);
  if (at === null || at.hit.transclusion === true) return null;
  if (!isDatePrefix(at.hit.prefix)) return null;
  const options = dateSuggestOptions(at.hit.prefix, todayLocal());
  if (options.length === 0) return null;
  return { from: at.from, options, filter: false };
};

/** Все источники дропдауна `[[`: «Даты», «Мысли» и разделы трансклюзии. */
export function wikiLinkCompletionSources(): CompletionSource[] {
  // Один автокомплит на wiki-ссылки и трансклюзии (ADR 8c41387c):
  // подсказки мыслей и дат — здесь, разделов источника — в transclusion.ts.
  return [dateCompletions, wikiLinkCompletions(), transclusionSectionCompletions()];
}

/** Autocomplete extension: opens on `[[` + typed prefix, inserts `имя]]`. */
export function wikiLinkAutocompletion(): Extension {
  return autocompletion({
    override: wikiLinkCompletionSources(),
    activateOnTyping: true,
  });
}

/**
 * Opens an already-resolved thought by the current view's rules (M11): on the
 * canvas and other screens — focus; in structures — ALWAYS open in the editor
 * without moving the canvas focus and without touching the active view (same as
 * the history panel and the properties table; ошибка 4c2fe9b0); in the
 * chronicle — open in the editor without moving canvas focus
 * (08-ui-spec.md §17). An inactive thought with «скрывать неактуальное» on is
 * refused with a notice. Shared by wiki-links (name resolved here) and the
 * mentions auto-annotation (L24, id already known — see
 * `mentions-annotate.ts`).
 */
export async function openThoughtByRef(thought: Thought): Promise<void> {
  if (!thought.active && !store.state.showInactive) {
    notice(t('deepLink.notMoguOpenNeaktualnuyuThoughtNeaktualnye'));
    return;
  }

  if (store.state.activeView === 'structures') {
    // «Структуры» открывают мысль в редакторе ВСЕГДА — как панель истории и
    // таблица свойств, независимо от того, есть ли мысль в результатах
    // фильтра (ошибка 4c2fe9b0): фокус холста и активный вид не меняются,
    // диалога «переключиться на карту мыслей?» нет.
    await openStructuresThought(thought.id);
    return;
  }

  if (store.state.activeView === 'chronicle') {
    // The chronicle view opens the thought in the editor without moving the
    // canvas focus (08-ui-spec.md §17).
    await openChronicleThought(thought.id);
    return;
  }

  // Единый UI-вход: отказ показывается тостом и не отклоняет промис
  // (ошибка 1656ef58).
  await focusFromUi(thought.id);
}

// ---------------------------------------------------------------------------
// Развилка клика по легаси-ссылке `[[Имя]]` (0.12.2, задача 8e4e3dc5)
//
// Поведение согласовано пользователем (уточнение 2026-10-11, вечер):
//   ПРОСМОТР — конвертации НЕТ НИКОГДА: ссылка остаётся `[[Имя]]`; работает
//     только ПЕРЕХОД по развилке — одна мысль → открыть её; несколько →
//     поповер → открыть выбранную; ни одной → диалог создания → открыть
//     созданную. Захваченность в просмотре роли не играет (менять текст
//     нечем).
//   ПРАВКА — конвертация пишется ТОЛЬКО в буфер редактора (без перехода),
//     КРОМЕ единственной ЗАХВАЧЕННОЙ цели: её открываем без конвертации.
//   Отказ (поповер/диалог закрыт) — ничего не менять.
// Клик внутри блока трансклюзии (вложенный редактор «сплошным текстом»)
// идёт той же развилкой: в правке конвертация ложится в буфер ВЛОЖЕННОГО
// редактора (единая запись поля сохранит её в ИСТОЧНИК трансклюзии), в
// просмотре — только переход. Вложенный редактор несёт тот же `md-live`, а
// обработчик легаси-виджета зарегистрирован глобально (`initWikiLinkNavigation`).
// ---------------------------------------------------------------------------

/** Куда развилка клика пишет замену легаси-ссылки. */
export interface LegacyForkTarget {
  /** Имя цели легаси-ссылки (пробелы обрезаны, без алиаса). */
  name: string;
  /** Кликнутый элемент — якорь поповера кандидатов. */
  anchorEl: HTMLElement;
  /** Режим ПРАВКИ: вид редактора и диапазон исходника виджета — замена в буфер. */
  edit?: { view: EditorView; from: number; to: number };
}

/**
 * Замена легаси-ссылки ID-формой в БУФЕРЕ редактора (режим правки, в т.ч.
 * вложенный редактор трансклюзии). Диапазон мог устареть — заменяем только
 * если там всё ещё легаси-ссылка.
 */
function convertLegacyLinkInBuffer(
  edit: { view: EditorView; from: number; to: number },
  name: string,
  thoughtId: string,
): void {
  const { view, from, to } = edit;
  const current = view.state.sliceDoc(from, to);
  if (!current.startsWith('[[') || !current.endsWith(']]')) return;
  const { md } = replaceLegacyWikiLinks(current, name, thoughtId);
  const insert = md === current ? `[[#${thoughtId}]]` : md;
  view.dispatch({ changes: { from, to, insert } });
}

/** Открыть уже разрешённую мысль по правилам текущего вида. */
async function openResolvedThought(
  networkId: string,
  thoughtId: string,
  name: string,
): Promise<void> {
  let thought: Thought;
  try {
    thought = await etn.thoughts.get(networkId, thoughtId);
  } catch (err) {
    notice(t('mentions.notSucceededOpen', [name, errText(err)]), 'error');
    return;
  }
  await openThoughtByRef(thought);
}

/**
 * Развилка клика по легаси-ссылке. Возвращает `Promise`, завершающийся после
 * того, как показан поповер (выбор обрабатывается асинхронно) или выполнена
 * конвертация/создание. Отказ ничего не меняет.
 */
export async function runLegacyWikiLinkFork(target: LegacyForkTarget): Promise<void> {
  const networkId = safeCurrentNetworkId();
  if (networkId === null) {
    notice(t('wikiLink.firstOpenNetwork'));
    return;
  }

  let candidates: DuplicateHit[];
  try {
    candidates = await resolveLegacyWikiCandidates(networkId, target.name);
  } catch (err) {
    notice(t('mentions.notSucceededOpen', [target.name, errText(err)]), 'error');
    return;
  }

  const edit = target.edit;
  const viewMode = edit === undefined;
  const singleLocked =
    candidates.length === 1 && otherHolder('thought', candidates[0]!.id) !== null;
  const plan = planLegacyFork(candidates.length, singleLocked, viewMode);

  /** Конвертация в буфер (только правка; в просмотре не вызывается). */
  const doConvert = (thoughtId: string): void => {
    if (edit !== undefined) convertLegacyLinkInBuffer(edit, target.name, thoughtId);
  };

  switch (plan.action) {
    case 'create': {
      // Ветка 3: диалог создания/подбора открывается ВСЕГДА (в просмотре — на
      // любой поверхности, включая статичные без поля markdown; дефект
      // визуальной проверки). Отдельного уведомления «не найдена» больше нет:
      // прежний отказ возникал только из-за отсутствия контекста владельца и
      // был неотличим для пользователя от поломки перехода. После создания: в
      // просмотре — открыть созданную (формат ссылки НЕ меняется), в правке —
      // заменить ссылку в буфере.
      await tryCreateThoughtFromLegacyLink(target.anchorEl, target.name, {
        onCreated: (thoughtId) => {
          if (!plan.navigate) {
            doConvert(thoughtId);
            return;
          }
          // Поздний отказ открытия (после диалога создания) — тостом: это
          // уже отдельная от создания операция.
          void openResolvedThought(networkId, thoughtId, target.name).catch((error) => {
            notice(t('mentions.notSucceededOpen', [target.name, errText(error)]), 'error');
          });
        },
      });
      return;
    }
    case 'open-only': {
      // Единственная ЗАХВАЧЕННАЯ цель: открыть БЕЗ конвертации в обоих
      // режимах (решение пользователя 2026-10-11, вечер).
      await openResolvedThought(networkId, candidates[0]!.id, target.name);
      return;
    }
    case 'convert-open': {
      const only = candidates[0]!;
      if (plan.navigate) {
        // Просмотр: конвертации нет — только переход.
        await openResolvedThought(networkId, only.id, target.name);
      } else {
        // Правка: конвертация в буфере без перехода.
        doConvert(only.id);
      }
      return;
    }
    default:
      // Ветка 2: поповер у места клика → выбор → открыть (просмотр) или
      // конвертировать в буфере (правка).
      showLegacyCandidatesPopover(target, candidates, (thoughtId) => {
        if (plan.navigate) {
          void openResolvedThought(networkId, thoughtId, target.name).catch((error) => {
            notice(t('mentions.notSucceededOpen', [target.name, errText(error)]), 'error');
          });
        } else doConvert(thoughtId);
      });
  }
}

/** Поповер кандидатов: группы «подпись родителя → облачко мысли», ≤10 + пометка. */
function showLegacyCandidatesPopover(
  target: LegacyForkTarget,
  candidates: readonly DuplicateHit[],
  pick: (thoughtId: string) => void,
): void {
  openCandidatePopover({ element: target.anchorEl }, target.name, candidates, pick);
}

/**
 * Поповер выбора среди НЕСКОЛЬКИХ кандидатов (требование `14539728`, задача
 * `026241f2`): группы «подпись родителя → облачко мысли», ≤10 + пометка.
 * ВЫНЕСЕН и экспортирован для ПАКЕТНЫХ путей создания мыслей: принимает
 * произвольный АНКЕР — координату диапазона элемента (`{x, y}`, режим точки)
 * либо DOM-элемент места клика (легаси-развилка). `onCancel` вызывается, если
 * панель закрыта без выбора (отказ) — пакетный путь оставляет элемент без
 * изменений. Второй механики поповера не создаётся: панель — `lib/ui/popover`.
 */
export function openCandidatePopover(
  anchor: PopoverAnchor,
  displayName: string,
  candidates: readonly DuplicateHit[],
  pick: (thoughtId: string) => void,
  onCancel?: () => void,
): void {
  const { shown, truncated } = legacyCandidateWindow(candidates);
  const body = div('legacy-candidates');
  let handle: { close(): void } | null = null;
  let picked = false;
  for (const candidate of shown) {
    // Группа «родитель → облачко»: подпись родительской мысли СВЕРХУ, под ней
    // — своё облачко. Внутригрупповой зазор (2px) меньше межгруппового
    // (`--space-4`), поэтому облачко не «прилипает» к подписи следующей мысли
    // (дефект визуальной проверки, задача 8e4e3dc5).
    const group = div('legacy-candidate-group');
    if (candidate.parent_title !== null && candidate.parent_title !== '') {
      group.append(el('span', 'legacy-candidate-parent', candidate.parent_title));
    }
    group.append(
      createThoughtCloud(
        { ...candidate },
        {
          profile: 'tree',
          width: 'container',
          actions: {
            onClick: (thoughtId) => {
              picked = true;
              handle?.close();
              pick(thoughtId);
            },
          },
        },
      ),
    );
    body.append(group);
  }
  if (truncated) {
    body.append(
      el('p', 'muted', t('wikiLink.pokazanyPervyeUtochniteName', LEGACY_CANDIDATE_LIMIT)),
    );
  }
  handle = openPopover({
    anchor,
    content: { title: t('wikiLink.foundNeskolkoThoughts', displayName), body },
    extraClass: 'legacy-candidates-popover',
    onClose: () => {
      if (!picked) onCancel?.();
    },
  });
}

/**
 * Разрешает ID-ссылку ([[#<id>]] / [[n:<net>#<id>]]) в мысль и открывает её
 * (task R8). Если `targetNetworkId` отличается от текущей, переключает
 * активную сеть через {@link openNetwork} — это меняет `currentNetworkId` в
 * store, после чего `etn.thoughts.get` уже работает в нужной сети. Если
 * сеть недоступна (403/404) — сообщение пользователю.
 *
 * Bug bcdb3dc6: раньше всегда открывалась НОВАЯ вкладка. Теперь сначала
 * ищем среди уже открытых вкладок ту, что смотрит на `targetNetworkId`
 * (последнюю, если их несколько) — `openNetwork` активирует именно её вместо
 * создания новой; новая вкладка появляется только если целевой сети нет ни в
 * одной вкладке. Кросс-сетевой переход всегда переключает экран на «Карта
 * мыслей» — сохранённый вид (ре)активированной вкладки не имеет отношения к
 * «перейти по ссылке», в отличие от навигации внутри одной сети, которая
 * уважает текущий вид ({@link openThoughtByRef}).
 */
export async function openWikiIdTarget(targetNetworkId: string, thoughtId: string): Promise<void> {
  const currentNetworkId = safeCurrentNetworkId();

  if (targetNetworkId !== currentNetworkId) {
    const existingTabId = findTabForNetwork(store.state.tabs, targetNetworkId)?.tab_id;
    try {
      if (existingTabId !== undefined)
        await etn.tabs.activate(existingTabId).catch(() => undefined);
      await openNetwork(targetNetworkId, existingTabId);
    } catch (err) {
      notice(t('wikiLink.networkUnavailableLinkRefThoughtOtherNetwork', errText(err)), 'error');
      return;
    }
    setActiveView('map');
  }

  let thought: Thought;
  try {
    thought = await etn.thoughts.get(targetNetworkId, thoughtId);
  } catch (err) {
    notice(t('deepLink.thoughtDeletedUnavailable', errText(err)), 'error');
    return;
  }

  await openThoughtByRef(thought);
}

/**
 * Wrapper around `requireNetworkId` that catches the synchronous throw
 * (no active network) and returns null. The click handler can degrade
 * gracefully instead of crashing when the user is on the network list.
 */
function safeCurrentNetworkId(): string | null {
  try {
    return requireNetworkId();
  } catch {
    return null;
  }
}

let navigationWired = false;

/**
 * Минимальный контракт узла-ссылки для {@link shouldNavigateWikiLink}: нужны
 * только связность, класс и ближайший редактор. Структурный тип позволяет
 * юнит-тесту подставить простой объект вместо DOM-элемента.
 */
export interface WikiLinkClickTarget {
  isConnected: boolean;
  classList: { contains(cls: string): boolean };
  closest(selector: string): unknown;
}

/**
 * Должен ли клик по спану wiki-ссылки выполнить переход к цели (ошибка
 * ab8b6da8). Внутри редактора live-preview виджет (класс `md-widget`) при клике
 * раскрывает исходник блока (M6), поэтому переход для него пропускаем; снятый
 * со страницы виджет (клик уже раскрыл блок) тоже не переходит. ID-форма в
 * редакторе показывается виджетом имени БЕЗ `md-widget` (`wiki-id-plugin`) и
 * переходит по клику так же, как спан просмотра — требование d574d116 и элемент
 * интерфейса «Редактор постоянного комментария»: «Клик по ссылке открывает
 * мысль». Экспортируется ради юнит-тестов.
 */
export function shouldNavigateWikiLink(link: WikiLinkClickTarget): boolean {
  if (!link.isConnected) return false;
  return !(link.closest('.cm-editor') !== null && link.classList.contains(MD_WIDGET_CLASS));
}

/**
 * Открыть день в «Дневнике» из date-чипа (0.16.1, требование 31fe2cc9).
 * Обработчик по умолчанию для единого входа `clickDateChip` (`md-live.ts`):
 * его вызывают и чип редактора (`mousedown`-ветка), и чип просмотра
 * (делегированный `click`). `open` — шов для проверки связки без живого
 * «Дневника» (по умолчанию — единый вход `openChronicleDay`).
 */
export function openDayFromChip(
  date: string,
  open: (day: string) => Promise<void> = defaultDayOpener,
): void {
  void open(date).catch((error) => {
    notice(t('mentions.notSucceededOpen', [date, errText(error)]), 'error');
  });
}

/**
 * Тестовый шов: снять признак «навигация подключена» (`initWikiLinkNavigation`
 * идемпотентен). Нужен поведенческой проверке связки «клик по чипу → день»:
 * она обязана увидеть обработчик, который ставит САМА инициализация, а не
 * читать исходник регуляркой. В рантайме не вызывается.
 */
export function resetWikiLinkNavigationForTests(): void {
  navigationWired = false;
}

/** Installs the delegated view-mode click handler (call once from main.ts). */
export function initWikiLinkNavigation(): void {
  if (navigationWired) return;
  navigationWired = true;

  // Легаси-виджет в редакторе перехватывается на `mousedown` (виджет снят к
  // моменту `click`): клик уходит в развилку, а не раскрывает исходник.
  setLegacyWikiLinkClickHandler((widget, view) => {
    const name = widget.dataset.wikiTarget ?? '';
    if (name === '') return;
    const from = Number(widget.dataset.mdFrom);
    const to = Number(widget.dataset.mdTo);
    const edit =
      Number.isFinite(from) && Number.isFinite(to) && to > from ? { view, from, to } : undefined;
    void runLegacyWikiLinkFork({
      name,
      anchorEl: widget,
      ...(edit !== undefined ? { edit } : {}),
    }).catch((error) => {
      notice(t('mentions.notSucceededOpen', [name, errText(error)]), 'error');
    });
  });

  // Date-чип в редакторе (0.16.1, требование 31fe2cc9): левый клик открывает
  // день в «Дневнике». Перехват на `mousedown` — по той же причине, что и у
  // легаси-ссылки: к моменту `click` виджет уже снят декорациями.
  setDateChipClickHandler(openDayFromChip);

  document.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    const link = target?.closest?.(`.${WIKI_LINK_CLASS}`);
    if (!(link instanceof HTMLElement)) return;
    if (!shouldNavigateWikiLink(link)) return;

    // Date-чип (0.16.1, требование 31fe2cc9): клик открывает день в
    // «Дневнике». Проверяется ДО имени мысли — date-ссылка приоритетнее мысли
    // с таким именем (ADR fa50de55), а data-wiki-target у чипа нет вовсе.
    // Идём через общий вход `clickDateChip` (тот же обработчик дня, что у
    // mousedown в редакторе) — так клик в просмотре и в правке не расходятся.
    const date = link.getAttribute(WIKI_LINK_DATE_ATTR);
    if (date !== null && date !== '') {
      clickDateChip(date);
      return;
    }

    // Pub-ссылка (0.11.1, задача 3275fd8d, требование 7f583ef9): резолвер
    // пометил серверную legacy-форму атрибутом `data-wiki-pub` — открываем
    // публикацию на её экране (deep-link сюда же).
    const publicationId = link.getAttribute(WIKI_LINK_PUB_ATTR);
    if (publicationId !== null && publicationId !== '') {
      void openPublicationInWorkspace(publicationId);
      return;
    }

    // ID-based form (task R8): прямой lookup по UUID, без FTS-поиска.
    // Кросс-сеть — сначала переключаем активную сеть через openNetwork.
    const id = link.getAttribute(WIKI_LINK_ID_ATTR);
    if (id !== null && id !== '') {
      const targetNetworkId = link.getAttribute(WIKI_LINK_NETWORK_ATTR) ?? safeCurrentNetworkId();
      if (targetNetworkId === null) {
        notice(t('wikiLink.firstOpenNetwork'));
        return;
      }
      void openWikiIdTarget(targetNetworkId, id).catch((error) => {
        notice(t('deepLink.notSucceededOpenThought', errText(error)), 'error');
      });
      return;
    }

    // Legacy name-based form (M3, обновлено задачей 8e4e3dc5): резолв имени →
    // конвертация в id-формат → открытие (развилка 4 веток). Не найдено —
    // флоу создания мысли в этой же развилке.
    const name = link.getAttribute(WIKI_LINK_TARGET_ATTR);
    if (name === null || name === '') return;
    void runLegacyWikiLinkFork({ name, anchorEl: link }).catch((error) => {
      notice(t('mentions.notSucceededOpen', [name, errText(error)]), 'error');
    });
  });
}

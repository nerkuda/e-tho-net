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

import { autocompletion, type Completion, type CompletionSource } from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import type { MarkdownExtension } from '@lezer/markdown';

import { WIKI_LINK_CLASS, WIKI_LINK_TARGET_ATTR, WIKI_LINK_ID_ATTR, WIKI_LINK_NETWORK_ATTR } from '@etn/markdown';
import type { Thought } from '@etn/shared';

import type { DuplicateHit } from '../../main/ipc/contract.js';
import { openNetwork, requireNetworkId, setFocus } from '../app.js';
import { showDialog } from '../lib/dialog.js';
import { div, el, errText } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { otherHolder } from '../lib/lock-cache.js';
import { notice } from '../lib/notice.js';
import { replaceLegacyWikiLinks } from '../lib/pure.js';
import { createThoughtCloud } from '../lib/thought-cloud.js';
import { openPopover } from '../lib/ui/popover.js';
import { findWikiCreateContext } from '../lib/wiki-create-context.js';
import { isThoughtInResults, openStructuresThought } from '../screens/structures/structures.js';
import { focusThoughtOnMap, openPublicationInWorkspace, setActiveView } from '../screens/active-view.js';
import { openChronicleThought } from '../screens/chronicle/chronicle.js';
import { findTabForNetwork } from '../screens/tabs/tab-state.js';
import { store } from '../state.js';
import { markdownInlineExt } from './markdown-inline-ext.js';
import { MD_WIDGET_CLASS, setLegacyWikiLinkClickHandler } from './md-live.js';
import {
  decideLegacyFork,
  legacyCandidateWindow,
  LEGACY_CANDIDATE_LIMIT,
  resolveLegacyWikiCandidates,
  searchLegacyWikiTarget,
  WIKI_LINK_PUB_ATTR,
} from './wiki-link-resolver.js';
import { replaceLegacyLinksInComment, tryCreateThoughtFromLegacyLink } from './wiki-link-create.js';
import { transclusionSectionCompletions } from './transclusion.js';

/** Chars allowed inside an in-progress wiki prefix (no closing/alias/newline). */
const WIKI_PREFIX_RE = /^[^[\]\n|]*$/;

/** Минимум символов имени для автокомплита трансклюзии (элемент 7a479549). */
export const TRANSCLUSION_MIN_PREFIX = 3;

/**
 * Позиция открывающих скобок и набранный префикс; `transclusion` — перед
 * `[[` стоит восклицательный знак (ссылка трансклюзии, элемент интерфейса
 * 7a479549). Возвращает также `transclusion`, только когда он истинен, —
 * форма ответа прежняя для обычных wiki-ссылок.
 */
export function wikiPrefixAt(
  before: string,
): { open: number; prefix: string; transclusion?: true } | null {
  const open = before.lastIndexOf('[[');
  if (open === -1) return null;
  const rest = before.slice(open + 2);
  if (rest === '' || !WIKI_PREFIX_RE.test(rest)) return null;
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

function wikiLinkCompletions(): CompletionSource {
  // Кэш ПО-ИНСТАНСНЫЙ: своё замыкание на каждый вызов `wikiLinkCompletions()`,
  // а вызов — один на редактор (в `wikiLinkAutocompletion()`). Два инстанса
  // редактора (поле-контейнер и вложенный блок, ТП «Живой блок») кэшируют
  // результаты поиска независимо и не видят чужих записей.
  const cache = new Map<string, { expires: number; options: Completion[] }>();
  return async (context) => {
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    const hit = wikiPrefixAt(before);
    if (hit === null) return null;
    // Трансклюзия: список мыслей открывается не раньше трёх символов имени
    // (элемент интерфейса 7a479549); обычная wiki-ссылка — с первого.
    if (hit.transclusion === true && hit.prefix.length < TRANSCLUSION_MIN_PREFIX) return null;

    let cached = cache.get(hit.prefix);
    if (cached === undefined || cached.expires < Date.now()) {
      cached = {
        expires: Date.now() + COMPLETION_TTL_MS,
        options: await loadCompletions(requireNetworkId(), hit.prefix),
      };
      cache.set(hit.prefix, cached);
    }
    if (cached.options.length === 0) return null;
    // Без `validFor`: источник должен вызываться заново на каждый новый
    // символ префикса (кэш по префиксу выше это и обеспечивает). Широкий
    // `validFor` (WIKI_PREFIX_RE совпадает с любым продолжением) заставлял
    // CM6 фильтровать уже полученные `limit: 20` результатов локально, не
    // перезапрашивая сервер, — поэтому `[[новиков` не находил ничего, если
    // при односимвольном префиксе мысль не попала в первые 20
    // (ошибка 6bba224b-9899-4f7e-a37c-ff2067ac0a6c).
    return {
      from: line.from + hit.open + 2,
      options: cached.options,
    };
  };
}

/** Autocomplete extension: opens on `[[` + typed prefix, inserts `имя]]`. */
export function wikiLinkAutocompletion(): Extension {
  return autocompletion({
    // Один автокомплит на wiki-ссылки и трансклюзии (ADR 8c41387c):
    // подсказки мыслей — здесь, разделов источника — в transclusion.ts.
    override: [wikiLinkCompletions(), transclusionSectionCompletions()],
    activateOnTyping: true,
  });
}

/**
 * Диалог «переключиться на карту мыслей?» (M11): мысль не отображается в
 * текущих результатах структуры. Резолвится `true` по кнопке «Да» и `false`
 * при отказе — включая закрытие каркаса штатным путём («Нет», Esc, ×).
 * Экспортирован для юнит-тестов.
 */
export function confirmSwitchToMap(): Promise<boolean> {
  return new Promise((resolve) => {
    /**
     * Единственная точка завершения промиса. Отказ — ЛЮБОЙ путь закрытия
     * каркаса (ошибка aff5a96c): кнопки завершают его явно, а Esc и × —
     * через `onClose`. Флаг `settled` не даёт позднему событию
     * `remove` переиграть уже принятое решение.
     */
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    showDialog({
      title: 'Мысль не отображается',
      size: 's',
      body: el(
        'p',
        'dialog-text',
        'Эта мысль не отображается в структуре мыслей. Переключиться на карту мыслей?',
      ),
      buttons: [
        { label: 'Нет', onClick: () => finish(false) },
        { label: 'Да', primary: true, onClick: () => finish(true) },
      ],
      // Esc и × — отказ: контракт «`false` on cancel»,
      // ровно как по кнопке «Нет» (ошибка aff5a96c).
      onClose: () => finish(false),
    });
  });
}

/**
 * Opens an already-resolved thought by the current view's rules (M11): on the
 * canvas — focus; in structures — activation among displayed thoughts, else a
 * "switch to the map?" dialog; in the chronicle — open in the editor without
 * moving canvas focus (08-ui-spec.md §17). An inactive thought with «скрывать
 * неактуальное» on is refused with a notice. Shared by wiki-links (name
 * resolved here) and the mentions auto-annotation (L24, id already known —
 * see `mentions-annotate.ts`).
 */
export async function openThoughtByRef(thought: Thought): Promise<void> {
  if (!thought.active && !store.state.showInactive) {
    notice('Не могу открыть неактуальную мысль — неактуальные мысли не отображаются.', 'error');
    return;
  }

  if (store.state.activeView === 'structures') {
    if (isThoughtInResults(thought.id)) {
      await openStructuresThought(thought.id);
      return;
    }
    if (await confirmSwitchToMap()) {
      // Тот же путь, что у команды «В фокус»: показать карту и сфокусировать
      // мысль (общий помощник, ошибка 562356a9).
      await focusThoughtOnMap(thought.id);
    }
    return;
  }

  if (store.state.activeView === 'chronicle') {
    // The chronicle view opens the thought in the editor without moving the
    // canvas focus (08-ui-spec.md §17).
    await openChronicleThought(thought.id);
    return;
  }

  await setFocus(thought.id);
}

/**
 * Разрешает wiki-цель в мысль и открывает её по правилам режима (M11) через
 * {@link openThoughtByRef}. Когда цель не находится и `linkEl` (кликнутый
 * span) лежит в поле комментария с контекстом (карточка ETN 34ffbd75),
 * запускается флоу создания отсутствующей мысли — диалог добавления с
 * предзаполненным именем и последующей заменой ссылок; иначе — прежний
 * notice «не найдена».
 */
export async function openWikiTarget(name: string, linkEl?: HTMLElement): Promise<void> {
  const networkId = requireNetworkId();
  let thoughtId: string | null = null;
  try {
    const hit = await searchLegacyWikiTarget(networkId, name);
    thoughtId = hit?.thoughtId ?? null;
  } catch (err) {
    notice(`Не удалось открыть «${name}»: ${errText(err)}`, 'error');
    return;
  }
  if (thoughtId === null) {
    // Мысли нет: в комментарии (md-field с контекстом) — предложить создать
    // её прямо отсюда; вне такого контекста — прежнее поведение.
    if (linkEl !== undefined && (await tryCreateThoughtFromLegacyLink(linkEl, name))) return;
    notice(`Мысль «${name}» не найдена.`, 'error');
    return;
  }

  let thought: Thought;
  try {
    thought = await etn.thoughts.get(networkId, thoughtId);
  } catch (err) {
    notice(`Не удалось открыть «${name}»: ${errText(err)}`, 'error');
    return;
  }

  await openThoughtByRef(thought);
}

// ---------------------------------------------------------------------------
// Развилка клика по легаси-ссылке `[[Имя]]` (0.12.2, задача 8e4e3dc5)
//
// Поведение согласовано пользователем 2026-10-11 (карточка задачи + хроно
// «Предполёт и итоговый DoD»):
//   1. ровно одна актуальная мысль с именем и цель не захвачена — заменить
//      ссылку на `[[#<id>]]` и открыть мысль;
//   2. несколько — поповер у места клика (облачка, ≤10 + пометка родителя),
//      выбор — заменить и открыть;
//   3. ни одной — диалог создания (имя предзаполнено), после создания —
//      заменить и остаться в контексте;
//   4. отказ (поповер/диалог закрыт) — ничего не менять.
// Захваченная единственная цель — открыть БЕЗ конвертации.
// В ПРОСМОТРЕ замена пишется в сохранённый `body_md` комментария (через
// `replaceLegacyLinksInComment`) и происходит переход к мысли; в ПРАВКЕ замена
// идёт ТОЛЬКО в буфер редактора БЕЗ перехода (иначе поле пересобралось бы и
// потеряло несохранённые правки — уточнение DoD «грязный буфер в правке»).
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

/** Конвертер `[[Имя|алиас]] → [[#<id>|алиас]]` под режим (буфер / body_md). */
function legacyForkConverter(
  networkId: string,
  target: LegacyForkTarget,
): (thoughtId: string) => Promise<void> {
  const edit = target.edit;
  if (edit !== undefined) {
    return async (thoughtId) => {
      const { view, from, to } = edit;
      const current = view.state.sliceDoc(from, to);
      // Диапазон мог устареть (правка документа между mousedown и выбором) —
      // заменяем только если там всё ещё легаси-ссылка.
      if (!current.startsWith('[[') || !current.endsWith(']]')) return;
      const { md } = replaceLegacyWikiLinks(current, target.name, thoughtId);
      const insert = md === current ? `[[#${thoughtId}]]` : md;
      view.dispatch({ changes: { from, to, insert } });
    };
  }
  return async (thoughtId) => {
    const ctx = findWikiCreateContext(target.anchorEl);
    if (ctx === null) return; // вне поля комментария — писать в body_md некуда
    await replaceLegacyLinksInComment(networkId, ctx, target.name, thoughtId);
  };
}

/** Открыть уже разрешённую мысль по правилам текущего вида. */
async function openResolvedThought(networkId: string, thoughtId: string, name: string): Promise<void> {
  let thought: Thought;
  try {
    thought = await etn.thoughts.get(networkId, thoughtId);
  } catch (err) {
    notice(`Не удалось открыть «${name}»: ${errText(err)}`, 'error');
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
    notice('Сначала откройте сеть.', 'error');
    return;
  }

  let candidates: DuplicateHit[];
  try {
    candidates = await resolveLegacyWikiCandidates(networkId, target.name);
  } catch (err) {
    notice(`Не удалось открыть «${target.name}»: ${errText(err)}`, 'error');
    return;
  }

  const convert = legacyForkConverter(networkId, target);
  // Режим ПРАВКИ развилка НЕ навигирует: переход пересобрал бы поле и потерял
  // несохранённые правки (уточнение DoD «грязный буфер в правке»). В просмотре
  // переход выполняет `openThoughtByRef` по правилам вида.
  const navigate = target.edit === undefined;
  const singleLocked =
    candidates.length === 1 && otherHolder('thought', candidates[0]!.id) !== null;

  switch (decideLegacyFork(candidates.length, singleLocked)) {
    case 'create': {
      // Ветка 3: диалог создания. Вне поля комментария флоу не срабатывает —
      // прежнее поведение (уведомление «не найдена»).
      const handled = await tryCreateThoughtFromLegacyLink(target.anchorEl, target.name, { convert });
      if (!handled) notice(`Мысль «${target.name}» не найдена.`, 'error');
      return;
    }
    case 'open-only': {
      // Захвачена другим пользователем — открыть без конвертации (решение
      // пользователя 2026-10-11; ссылку не трогаем). В правке остаёмся в поле.
      if (navigate) await openResolvedThought(networkId, candidates[0]!.id, target.name);
      return;
    }
    case 'convert-open': {
      const only = candidates[0]!;
      await convert(only.id);
      if (navigate) await openResolvedThought(networkId, only.id, target.name);
      return;
    }
    default:
      // Ветка 2: поповер у места клика.
      showLegacyCandidatesPopover(target, candidates, (thoughtId) => {
        void (async () => {
          await convert(thoughtId);
          if (navigate) await openResolvedThought(networkId, thoughtId, target.name);
        })();
      });
  }
}

/** Поповер кандидатов: облачка мысли + подсказка родителя, ≤10 + пометка. */
function showLegacyCandidatesPopover(
  target: LegacyForkTarget,
  candidates: readonly DuplicateHit[],
  pick: (thoughtId: string) => void,
): void {
  const { shown, truncated } = legacyCandidateWindow(candidates);
  const body = div('legacy-candidates');
  let handle: { close(): void } | null = null;
  for (const candidate of shown) {
    const row = div('legacy-candidate-row');
    row.append(
      createThoughtCloud(
        { ...candidate },
        {
          profile: 'tree',
          width: 'container',
          actions: {
            onClick: (thoughtId) => {
              handle?.close();
              pick(thoughtId);
            },
          },
        },
      ),
    );
    if (candidate.parent_title !== null && candidate.parent_title !== '') {
      row.append(el('span', 'legacy-candidate-parent', candidate.parent_title));
    }
    body.append(row);
  }
  if (truncated) {
    body.append(el('p', 'muted', `Показаны первые ${LEGACY_CANDIDATE_LIMIT}, уточните имя.`));
  }
  handle = openPopover({
    anchor: { element: target.anchorEl },
    content: { title: `Найдено несколько мыслей: «${target.name}»`, body },
    extraClass: 'legacy-candidates-popover',
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
      if (existingTabId !== undefined) await etn.tabs.activate(existingTabId).catch(() => undefined);
      await openNetwork(targetNetworkId, existingTabId);
    } catch (err) {
      notice(
        `Сеть недоступна: ${errText(err)}. Ссылка на мысль в другой сети не может быть открыта.`,
        'error',
      );
      return;
    }
    setActiveView('map');
  }

  let thought: Thought;
  try {
    thought = await etn.thoughts.get(targetNetworkId, thoughtId);
  } catch (err) {
    notice(`Мысль удалена или недоступна: ${errText(err)}`, 'error');
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
    });
  });

  document.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    const link = target?.closest?.(`.${WIKI_LINK_CLASS}`);
    if (!(link instanceof HTMLElement)) return;
    if (!shouldNavigateWikiLink(link)) return;

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
        notice('Сначала откройте сеть.', 'error');
        return;
      }
      void openWikiIdTarget(targetNetworkId, id);
      return;
    }

    // Legacy name-based form (M3, обновлено задачей 8e4e3dc5): резолв имени →
    // конвертация в id-формат → открытие (развилка 4 веток). Не найдено —
    // флоу создания мысли в этой же развилке.
    const name = link.getAttribute(WIKI_LINK_TARGET_ATTR);
    if (name === null || name === '') return;
    void runLegacyWikiLinkFork({ name, anchorEl: link });
  });
}

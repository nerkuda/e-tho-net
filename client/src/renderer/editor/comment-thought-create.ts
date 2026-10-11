/**
 * Команды «Создать мысль из раздела», «Создать мысль из выделенного» и
 * «Разделить выделение на мысли» (0.12.1, задачи 5f854e7a и 578c8525, ТП3
 * «Манипуляции с выделением в комментарии»; элемент интерфейса `2a21c27e`;
 * проработка 0.12.2 — задачи T1 `785c7fac` и T2 `026241f2`).
 *
 * Модуль владеет телами трёх команд поля комментария:
 *  - «из раздела» — каретка (или выделение) стоит в разделе: заголовок
 *    становится названием новой мысли, тело — текстом раздела без заголовка;
 *    перед созданием выполняется ПРЕДВАРИТЕЛЬНЫЙ дедуп по названию/синониму
 *    (требование `14539728`), ровно одно совпадение → используется существующая;
 *  - «из выделенного» — разветвляется (требование `a2`/`dc24a8b1`):
 *    одиночное выделение ВНЕ списков и заголовков раздела открывает
 *    СУЩЕСТВУЮЩИЙ диалог поиска/создания с предзаполнением (случаи 1–2);
 *    пакетное выделение (список/раздел или смешанное) идёт ПАКЕТНЫМ путём по
 *    единицам разбора (диалог не открывается);
 *  - «разделить выделение на мысли» — те же пакетные правила ко ВСЕМ единицам
 *    разбора, диалога и предпросмотра нет.
 *
 * Пакетный путь (требования `45b53e11`, `14539728`, `59ec432f`, `23c11231`):
 *  - единицы — единого уровня разбора `parseSelectionUnits` (`@etn/markdown`);
 *  - имя — первая значимая строка единицы, обрезанная до 250 (`f64f5893`),
 *    для единицы-блока кода — первая непустая строка блока КАК ЕСТЬ (`f5695a1e`);
 *  - тело — по виду единицы: список (`45b53e11`) — при строке > 250 (весь текст)
 *    И/ИЛИ при подчинённых (вложенные строки как текст с маркерами); абзац —
 *    остаток после заголовочной строки; раздел — текст без строки заголовка;
 *    блок кода — весь блок; строка ≤ 250 без подчинённых — без тела;
 *  - ВЛОЖЕННЫЕ элементы списка отдельных мыслей НЕ создают — их текст (с
 *    маркерами) входит в ТЕЛО мысли-элемента (решение пользователя, walkthrough
 *    2026-10-12; требование `fe023652`); подразделы остаются под-мыслями
 *    («подчинённые разделы — текст» — тот же walkthrough);
 *  - дедуп — по ТОЧНОМУ названию/синониму (с wildcard) РЕЗОЛВОМ кандидатов
 *    `8e4e3dc5` (`resolveLegacyWikiCandidates`): ровно одно совпадение →
 *    существующая без вопроса; несколько → поповер У ЭЛЕМЕНТА (анкер-координата
 *    диапазона), отказ → элемент без изменений; не найдено → создаётся;
 *  - вставка на месте — по развилке `23c11231`: существующая/новая без тела →
 *    ссылка `[[#<id>]]`, новая с телом → трансклюзия (форма — `formatTransclusionRef`); для
 *    существующей заменяется ЛИТЕРАЛЬНО совпавшая с заголовком часть (`ee64ce46`),
 *    иначе ссылка встаёт в НАЧАЛО единицы.
 *
 * Разбор выделения — существующей `parseSelectionUnits` (`@etn/markdown`);
 * второй парсер не создаётся (ADR `01ec1467`, сторож
 * `guard-markdown-single-renderer`, `guard-selection-single-parser`). Форма
 * трансклюзии — `formatTransclusionRef` того же пакета; ссылка — `thoughtLinkRef`.
 *
 * Сеть и запись спрятаны за портом {@link CommentThoughtCreatePort}: юнит-тесты
 * подменяют его и проверяют план/название/тело/родителя/дедуп/вставку без
 * сервера и DOM.
 */

import { formatTransclusionRef, parseSelectionUnits, type MarkdownUnit } from '@etn/markdown';
import type { ThoughtCreateInput } from '@etn/shared';

import type { DuplicateHit } from '../../main/ipc/contract.js';
import { requireNetworkId } from '../app.js';
import { errText } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { t } from '../lib/i18n.js';
import { notice } from '../lib/notice.js';
import {
  registerCommentCommand,
  type CommentCommandContext,
  type CommentOwnerRef,
} from './comment-commands.js';
import { relocatedSelection } from './comment-format-ops.js';
import { thoughtLinkRef } from './comment-thought-insert.js';
import type { MdEditor, MdEditorSnapshot } from './md-editor.js';

/** Идентификатор команды «Создать мысль из раздела». */
export const CREATE_FROM_SECTION_COMMAND = 'comment.createFromSection';

/** Идентификатор команды «Создать мысль из выделенного». */
export const CREATE_FROM_SELECTION_COMMAND = 'comment.createFromSelection';

/**
 * Идентификатор команды «Разделить выделение на мысли» (задача 578c8525).
 * Идентификатор `comment.split` был заведён ТП1 как точка расширения — здесь
 * регистрируется её тело.
 */
export const SPLIT_SELECTION_COMMAND = 'comment.split';

/** Максимальная длина названия новой мысли (требование `f64f5893`). */
export const TITLE_MAX_LENGTH = 250;

/**
 * Минимальное число единиц разбора, при котором доступна команда «Разделить
 * выделение на мысли» (ТП3, элемент интерфейса `2a21c27e`).
 */
export const SPLIT_MIN_UNITS = 2;

/* ------------------------------------------------------------------ *
 * Порт создания мысли (тестовый шов).
 * ------------------------------------------------------------------ */

/** Запрос создания мысли-ребёнка с постоянным комментарием. */
export interface CommentThoughtCreateRequest {
  parentId: string;
  title: string;
  bodyMd: string;
}

/** Созданная мысль (нужен только id для трансклюзии). */
export interface CommentThoughtCreated {
  id: string;
}

/** Минимальный срез результата диалога поиска/создания, нужный случаям 1–2. */
export interface CommentThoughtPickItem {
  /** Существующая мысль либо новая (с заголовком и синонимами). */
  kind: 'existing' | 'new';
  /** id существующей мысли. */
  id?: string;
  /** Заголовок новой мысли (может быть отредактирован в диалоге). */
  title?: string;
  /** Синонимы новой мысли (разбор `имя|алиас` диалогом). */
  synonyms?: string[];
}

/** Результат диалога поиска/создания (`null` — отменено). */
export interface CommentThoughtPick {
  items: CommentThoughtPickItem[];
}

/** Анкер поповера кандидатов — координата диапазона элемента в окне. */
export interface CommentThoughtAnchor {
  x: number;
  y: number;
}

/**
 * Сеть, диалог, дедуп и запись для команд создания мыслей. Разделено на
 * «определить родителя», «открыть диалог», «подобрать кандидатов», «показать
 * поповер» и «создать» — так тесты проверяют и разрешение владельца-связи, и
 * сам процесс, не поднимая сервер и DOM-поповер.
 */
export interface CommentThoughtCreatePort {
  /** Мысль-родитель для владельца комментария; `null` — родитель не найден. */
  resolveParent(owner: CommentOwnerRef): Promise<string | null>;
  /** Создаёт мысль-ребёнка одной операцией «мысль + постоянный комментарий». */
  create(request: CommentThoughtCreateRequest): Promise<CommentThoughtCreated>;
  /**
   * Открывает существующий диалог поиска/создания с предзаполненным полем
   * (случаи 1–2); `null` — отменено. Тип новой мысли (`thoughtTypeId`) не
   * используется — тип не задаётся (требование `dc24a8b1`).
   */
  pick(input: {
    anchorId: string;
    anchorTitle: string;
    prefillText: string;
  }): Promise<CommentThoughtPick | null>;
  /** Канонический заголовок мысли — для частичной замены (требование `ee64ce46`). */
  thoughtTitle(id: string): Promise<string>;
  /**
   * ТОЧНЫЕ актуальные кандидаты по названию/синониму заголовка (резолв
   * `8e4e3dc5` — `resolveLegacyWikiCandidates`, требование `14539728`):
   * классификация `title`/`synonym` (с wildcard), `partial` отбрасывается.
   */
  candidates(title: string): Promise<DuplicateHit[]>;
  /**
   * Поповер выбора среди НЕСКОЛЬКИХ кандидатов у анкер-координаты диапазона
   * элемента (требование `14539728`); `null` — отказ (элемент без изменений).
   */
  choose(
    anchor: CommentThoughtAnchor,
    displayName: string,
    candidates: readonly DuplicateHit[],
  ): Promise<string | null>;
}

let createPort: CommentThoughtCreatePort | null = null;

/** Подменяет порт создания (тестовый шов); `null` — системный REST-порт. */
export function setCommentThoughtCreatePort(port: CommentThoughtCreatePort | null): void {
  createPort = port;
}

/** Действующий порт создания мыслей. */
export function commentThoughtCreatePort(): CommentThoughtCreatePort {
  return createPort ?? restCreatePort();
}

/**
 * Вход REST-создания мысли по запросу порта: постоянный комментарий добавляется,
 * только если тело непустое. Сервер отклоняет пустой `comment.body_md`
 * (требование `26f0aa52`), а отсутствие поля `comment` — валидно; поэтому
 * единица без собственного тела даёт мысль без тела.
 */
export function buildCommentThoughtCreateInput(
  request: CommentThoughtCreateRequest,
): ThoughtCreateInput {
  return {
    title: request.title,
    // Семантика REST (03-server-api.md §6.3): 'parent' — target становится
    // родителем новой мысли; позиция среди детей — по умолчанию в конец.
    create_link: { direction: 'parent', target_thought_id: request.parentId },
    ...(request.bodyMd === '' ? {} : { comment: { body_md: request.bodyMd } }),
  };
}

/**
 * Системный порт: родитель — сама мысль-владелец (для комментария связи —
 * её источник, как в `wiki-link-create.ts`); создание — REST `POST /thoughts`
 * со связью-родителем `direction: 'parent'` (новая мысль встаёт ПОД текущей).
 * Дедуп переиспользует резолв кандидатов `8e4e3dc5`; поповер — общий компонент
 * `lib/ui/popover` через экспорт `openCandidatePopover` (`wiki-link.ts`).
 */
function restCreatePort(): CommentThoughtCreatePort {
  return {
    async resolveParent(owner) {
      if (owner.ownerType === 'thought') return owner.ownerId;
      const link = await etn.links.get(requireNetworkId(), owner.ownerId);
      return link.source_id;
    },
    async create(request) {
      const created = await etn.thoughts.create(
        requireNetworkId(),
        buildCommentThoughtCreateInput(request),
      );
      return { id: created.id };
    },
    async pick({ anchorId, anchorTitle, prefillText }) {
      // Динамический импорт: `add-dialog` тянет canvas→editor→comments→
      // markdown-field, статическая связь замкнула бы цикл модулей.
      const { pickThoughtsDialog } = await import('../canvas/add-dialog.js');
      const result = await pickThoughtsDialog({
        networkId: requireNetworkId(),
        anchor: { id: anchorId, direction: 'child' },
        anchorTitle,
        allowCreate: true,
        allowLinkType: false,
        prefillText,
      });
      if (result === null) return null;
      return {
        items: result.items.map((item) =>
          item.kind === 'existing'
            ? { kind: 'existing' as const, id: item.id }
            : { kind: 'new' as const, title: item.title, synonyms: item.synonyms },
        ),
      };
    },
    async thoughtTitle(id) {
      return (await etn.thoughts.get(requireNetworkId(), id)).title;
    },
    async candidates(title) {
      const { resolveLegacyWikiCandidates } = await import('./wiki-link-resolver.js');
      return resolveLegacyWikiCandidates(requireNetworkId(), title);
    },
    async choose(anchor, displayName, candidates) {
      const { openCandidatePopover } = await import('./wiki-link.js');
      return new Promise<string | null>((resolve) => {
        openCandidatePopover(anchor, displayName, candidates, resolve, () => resolve(null));
      });
    },
  };
}

/* ------------------------------------------------------------------ *
 * План: что и на что заменить (чистые функции — основа юнит-тестов).
 * ------------------------------------------------------------------ */

/** Найденная цель команды: диапазон замены и атрибуты новой мысли. */
export interface CommentThoughtPlan {
  /** Начало заменяемого фрагмента в тексте редактора (включительно). */
  start: number;
  /** Конец заменяемого фрагмента в тексте редактора (исключительно). */
  end: number;
  /** Название новой мысли (первая значимая строка, ≤250). */
  title: string;
  /** Тело новой мысли — постоянный комментарий. */
  bodyMd: string;
}

/** Маркер ограждения блока кода (строка целиком — не имя мысли). */
const FENCE_RE = /^(?:```|~~~)/;
/** Цитата (`>`), маркер списка (`-`, `*`, `+`, `1.`, `1)`), чекбокс, заголовок. */
const QUOTE_RE = /^>+/;
const LIST_RE = /^(?:[-*+]|\d{1,9}[.)])(?=\s|$)/;
const TASK_RE = /^\[[ xX]\](?=\s|$)/;
const HEADING_RE = /^#{1,6}(?=\s|$)/;
/** Строка — ATX-заголовок (с учётом ведущих цитатных `>`). */
const HEADING_LINE_RE = /^(?:>[ \t]?)*[ \t]*#{1,6}(?=\s|$)/;

/** Снимает с начала строки маркеры блочной разметки, оставляя содержимое. */
function stripBlockPrefixes(line: string): string {
  const heading = HEADING_LINE_RE.test(line.trim());
  let rest = line.trim();
  for (;;) {
    const before = rest;
    rest = rest
      .replace(QUOTE_RE, '')
      .replace(LIST_RE, '')
      .replace(TASK_RE, '')
      .replace(HEADING_RE, '')
      .trimStart();
    if (rest === before) break;
  }
  // Закрывающая последовательность `#` ATX-заголовка (`## Раздел ##` → `Раздел`).
  if (heading) rest = rest.replace(/[ \t]+#+[ \t]*$/, '').trimEnd();
  return rest;
}

/**
 * Первая значимая строка текста единицы (требование `f64f5893`): первая
 * непустая строка, не состоящая только из маркеров разметки; у заголовка —
 * его текст без `#`; строки-ограждения блока кода пропускаются, берётся первая
 * непустая строка содержимого. Пусто, если значимой строки нет.
 */
export function firstSignificantLine(text: string): string {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    if (FENCE_RE.test(line)) continue;
    const content = stripBlockPrefixes(line);
    if (content === '') continue;
    return content;
  }
  return '';
}

/**
 * Обрезает название до `max` символов, не разрывая сущности markdown
 * (закрывающая `]]` wiki-ссылки/трансклюзии остаётся в обрезке; требование
 * `f64f5893`). Хвостовые пробелы снимаются.
 */
export function truncateMarkdownTitle(title: string, max: number = TITLE_MAX_LENGTH): string {
  if (title.length <= max) return title;
  let cut = max;
  const open = title.lastIndexOf('[[', cut);
  if (open !== -1) {
    const close = title.indexOf(']]', open + 2);
    if (close === -1 || close + 2 > cut) cut = open;
  }
  const shortened = title.slice(0, cut).replace(/\s+$/, '');
  return shortened === '' ? title.slice(0, max) : shortened;
}

/** Название новой мысли по правилу `f64f5893` (первая значимая строка, ≤250). */
export function thoughtTitle(text: string): string {
  return truncateMarkdownTitle(firstSignificantLine(text));
}

/** Первая непустая строка текста (без снятия маркеров разметки); `null` — нет. */
function firstNonEmptyLine(text: string): string | null {
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() !== '') return raw;
  }
  return null;
}

/** Единица — блок кода: первая непустая строка открывает ограждение. */
function isCodeUnit(text: string): boolean {
  const first = firstNonEmptyLine(text);
  return first !== null && FENCE_RE.test(first.trim());
}

/**
 * Название единицы-блока кода (требование `f5695a1e` п.9): первая непустая
 * строка содержимого КАК ЕСТЬ — строки-ограждения пропускаются, символы `#` и
 * подобные внутри кода НЕ снимаются. Ограничена 250 символами (`f64f5893`).
 */
export function codeUnitTitle(text: string): string {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    if (FENCE_RE.test(line)) continue;
    return truncateMarkdownTitle(line);
  }
  return '';
}

/**
 * Тело единицы-раздела без строки заголовка (ведущие пустые строки сняты):
 * заголовок уходит в название, тело становится постоянным комментарием.
 */
export function sectionBody(text: string): string {
  const nl = text.indexOf('\n');
  if (nl === -1) return '';
  return text.slice(nl + 1).replace(/^(?:[ \t]*\r?\n)+/, '').replace(/[ \t]+$/, '');
}

/**
 * Тело единицы-абзаца/строки (требование `59ec432f`): остаток после
 * заголовочной (первой физической) строки; если эта строка длиннее 250 —
 * тело равно всему тексту единицы. Одиночная строка ≤ 250 даёт пустое тело.
 */
export function paragraphBody(text: string): string {
  const nl = text.indexOf('\n');
  const first = (nl === -1 ? text : text.slice(0, nl)).replace(/\r$/, '');
  if (first.length > TITLE_MAX_LENGTH) return text;
  return restAfterFirstLine(text);
}

/**
 * Тело длинного выделения — остаток после первой строки: ведущие пустые строки
 * и хвостовые пробелы снимаются (та же механика, что у {@link sectionBody}).
 */
function restAfterFirstLine(text: string): string {
  const nl = text.indexOf('\n');
  if (nl === -1) return '';
  return text
    .slice(nl + 1)
    .replace(/^(?:[ \t]*\r?\n)+/, '')
    .replace(/[ \t]+$/, '');
}

/**
 * Единица-раздел, содержащая позицию `pos` (по всему тексту документа):
 * самая глубокая из разделов, в чей диапазон `[start, end]` попадает позиция;
 * `null` — позиция вне разделов (например, до первого заголовка).
 *
 * Хвостовые пустые строки в конце документа `parseSelectionUnits` обрезает
 * (диапазон раздела не включает завершающий перевод строки), поэтому каретка на
 * обычном завершающем `\n` выпадала из всех диапазонов и команда молча
 * отключалась. Такую позицию относим к последнему разделу (ошибка `10aa8cd7`).
 */
export function findSectionUnitAt(text: string, pos: number): MarkdownUnit | null {
  const units = parseSelectionUnits(text);
  const found = searchSection(units, pos);
  if (found !== null) return found;
  const tail = /[ \t\r\n]*$/.exec(text)?.[0] ?? '';
  const regionEnd = text.length - tail.length;
  if (pos >= regionEnd && pos <= text.length) return lastSection(units);
  return null;
}

function searchSection(units: readonly MarkdownUnit[], pos: number): MarkdownUnit | null {
  for (const unit of units) {
    if (pos < unit.start || pos > unit.end) continue;
    const nested = searchSection(unit.children, pos);
    if (nested !== null) return nested;
    return unit.kind === 'section' ? unit : null;
  }
  return null;
}

/** Последний (самый вложенный из последних) раздел леса; `null` — разделов нет. */
function lastSection(units: readonly MarkdownUnit[]): MarkdownUnit | null {
  for (let i = units.length - 1; i >= 0; i--) {
    const unit = units[i]!;
    if (unit.kind !== 'section') continue;
    return lastSection(unit.children) ?? unit;
  }
  return null;
}

/**
 * План команды «Создать мысль из раздела»: раздел, где стоит каретка, либо
 * раздел, содержащий всё выделение. `null` — позиция вне раздела. Тело —
 * {@link sectionUnitBody}: собственный текст раздела без строки заголовка плюс
 * ТЕКСТ подчинённых разделов (требование `f5695a1e` п.2, walkthrough 2026-10-12).
 */
export function planFromSection(snap: MdEditorSnapshot): CommentThoughtPlan | null {
  const unit = findSectionUnitAt(snap.text, snap.from);
  if (unit === null) return null;
  if (snap.from !== snap.to && snap.to > unit.end) return null;
  const title = thoughtTitle(unit.text);
  if (title === '') return null;
  return {
    start: unit.start,
    end: subtreeEnd(unit),
    title,
    bodyMd: sectionUnitBody(unit, snap.text),
  };
}

/**
 * План команды «Создать мысль из выделенного»: одна мысль из всего выделения.
 * `null` — выделения нет, оно пустое, либо в нём нет значимой строки для
 * названия (выделение из одних пробелов/маркеров разметки).
 *
 * Выделение без значимой строки команда осознанно не создаёт: название мысли
 * обязательно (правило `f64f5893` — первая значимая строка), а придумывать
 * запасное имя вне правил нельзя. Требование `93c0eb7d` уточнено: «при любом
 * непустом выделении, из которого строится название» (ошибка `10aa8cd7`).
 */
export function planFromSelection(snap: MdEditorSnapshot): CommentThoughtPlan | null {
  if (snap.from === snap.to) return null;
  const selected = snap.text.slice(snap.from, snap.to);
  if (selected.trim() === '') return null;
  const title = thoughtTitle(selected);
  if (title === '') return null;
  return { start: snap.from, end: snap.to, title, bodyMd: selected };
}

/* ------------------------------------------------------------------ *
 * Пакетный план: единицы разбора → мысли (задачи T2 026241f2 / 59ec432f).
 * ------------------------------------------------------------------ */

/**
 * Узел пакетного плана: одна единица разбора → будущая мысль.
 *
 * `start`/`end` — диапазон СОБСТВЕННОГО содержимого единицы в тексте редактора
 * `[start, end)` (для существующей мысли ссылкой заменяется совпавшая часть
 * внутри него, остальное остаётся); `fullStart`/`fullEnd` — диапазон всей
 * единицы, включая вложенное содержимое, которое уходит в ТЕЛО (для новой
 * мысли с телом весь диапазон заменяется трансклюзией, чтобы вложенный текст не
 * остался в комментарии дважды). Под-мыслей НЕ создаётся (`children` оставлено
 * для совместимости обхода — всегда пусто): вложенные элементы списка и
 * подчинённые разделы входят в тело ТЕКСТОМ (`45b53e11`, `f5695a1e` п.2,
 * walkthrough 2026-10-12).
 */
export interface SplitSelectionNode {
  /** Начало собственного диапазона единицы (включительно). */
  start: number;
  /** Конец собственного диапазона единицы (исключительно). */
  end: number;
  /** Начало диапазона замены единицы целиком (включительно). */
  fullStart: number;
  /** Конец диапазона замены единицы целиком (исключительно). */
  fullEnd: number;
  /** Название новой мысли (первая значимая строка, ≤250). */
  title: string;
  /** Тело новой мысли: `''` — без тела (вставка — ссылка). */
  bodyMd: string;
  /** Вложенные единицы — под-мысли (не создаются; всегда пусто). */
  children: SplitSelectionNode[];
}

/** Конец диапазона единицы с учётом всех вложенных единиц. */
function subtreeEnd(unit: MarkdownUnit): number {
  let end = unit.end;
  for (const child of unit.children) end = Math.max(end, subtreeEnd(child));
  return end;
}

/** Число единиц разбора в дереве (рекурсивно) — порог доступности «Разделить». */
function countUnits(units: readonly MarkdownUnit[]): number {
  let total = 0;
  for (const unit of units) total += 1 + countUnits(unit.children);
  return total;
}

/**
 * Вложенный текст единицы с маркерами/заголовками — сырой текст от первого
 * подчинённого элемента до конца поддерева (пробелы/пустые строки между
 * вложенными сохраняются: структура читается в комментарии). Подчинённые
 * разделы входят как есть — включая строку их заголовка (`### …`).
 */
function nestedUnitText(unit: MarkdownUnit, source: string): string {
  if (unit.children.length === 0) return '';
  let end = 0;
  for (const child of unit.children) end = Math.max(end, subtreeEnd(child));
  return source.slice(unit.children[0]!.start, end).replace(/[ \t]+$/, '');
}

/**
 * Тело мысли-элемента списка (требование `45b53e11`): при строке > 250 (весь
 * текст единицы) И/ИЛИ при подчинённых (вложенные строки как текст с маркерами).
 * Комбинированный случай — весь текст строки + вложенные. Строка ≤ 250 без
 * подчинённых — без тела. Вложенные элементы под-мыслей НЕ создают.
 */
export function listItemBody(unit: MarkdownUnit, source: string): string {
  const own = unit.text;
  const nested = nestedUnitText(unit, source);
  const ownLong = own.includes('\n') || own.length > TITLE_MAX_LENGTH;
  const parts: string[] = [];
  if (ownLong) parts.push(own);
  if (nested !== '') parts.push(nested);
  return parts.join('\n').replace(/[ \t]+$/, '');
}

/**
 * Тело мысли-раздела (требования `f5695a1e` п.2, `f64f5893`, walkthrough
 * 2026-10-12): текст раздела БЕЗ строки заголовка, а подчинённые разделы
 * (подразделы) и их содержимое — ТЕКСТОМ (включая строку заголовка `### …`),
 * не отдельными мыслями. Пусто, если у раздела нет собственного текста и
 * подразделов.
 */
export function sectionUnitBody(unit: MarkdownUnit, source: string): string {
  const own = sectionBody(unit.text);
  const nested = nestedUnitText(unit, source);
  const parts: string[] = [];
  if (own !== '') parts.push(own);
  if (nested !== '') parts.push(nested);
  return parts.join('\n');
}

/**
 * Строит список узлов пакетного плана из ВЕРХНЕУРОВНЕВЫХ единиц разбора, смещая
 * диапазоны на `offset` (начало выделения). Единица без значимой строки своей
 * мысли не даёт (пропускается). Вложенные единицы (подчинённые элементы списка,
 * подразделы) НЕ становятся под-мыслями — их текст входит в тело; под-мыслей
 * не создаётся вовсе.
 */
function buildUnitNodes(
  units: readonly MarkdownUnit[],
  source: string,
  offset: number,
): SplitSelectionNode[] {
  const nodes: SplitSelectionNode[] = [];
  for (const unit of units) {
    if (unit.kind === 'list') {
      const title = thoughtTitle(unit.text);
      if (title === '') continue;
      const start = unit.start + offset;
      nodes.push({
        start,
        end: unit.end + offset,
        fullStart: start,
        fullEnd: subtreeEnd(unit) + offset,
        title,
        bodyMd: listItemBody(unit, source),
        children: [],
      });
      continue;
    }
    if (unit.kind === 'section') {
      const title = thoughtTitle(unit.text);
      if (title === '') continue;
      const start = unit.start + offset;
      nodes.push({
        start,
        end: unit.end + offset,
        fullStart: start,
        fullEnd: subtreeEnd(unit) + offset,
        title,
        bodyMd: sectionUnitBody(unit, source),
        children: [],
      });
      continue;
    }
    // Абзац, строка или блок кода.
    const code = isCodeUnit(unit.text);
    const title = code ? codeUnitTitle(unit.text) : thoughtTitle(unit.text);
    if (title === '') continue;
    const start = unit.start + offset;
    nodes.push({
      start,
      end: unit.end + offset,
      fullStart: start,
      fullEnd: unit.end + offset,
      title,
      bodyMd: code ? unit.text : paragraphBody(unit.text),
      children: [],
    });
  }
  return nodes;
}

/**
 * План команды «Разделить выделение на мысли»: список мыслей (верхнеуровневые
 * единицы разбора). `null` — выделения нет, оно пустое или содержит менее
 * {@link SPLIT_MIN_UNITS} единиц РАЗБОРА (команда недоступна, ТП3). Порог
 * считается по единицам разбора (включая вложенные: подчинённые разделы,
 * элементы списка) — выделение `## A` + `### B` команду активирует, давая ОДНУ
 * мысль с текстом подраздела в теле (требование `f5695a1e` п.2).
 *
 * Разбор — только `parseSelectionUnits` из `@etn/markdown`; собственной нарезки
 * модуль не содержит (ADR `01ec1467`, сторож `guard-selection-single-parser`).
 */
export function planSplitSelection(snap: MdEditorSnapshot): SplitSelectionNode[] | null {
  if (snap.from === snap.to) return null;
  const selected = snap.text.slice(snap.from, snap.to);
  if (selected.trim() === '') return null;
  const units = parseSelectionUnits(selected);
  if (countUnits(units) < SPLIT_MIN_UNITS) return null;
  const nodes = buildUnitNodes(units, selected, snap.from);
  return nodes.length === 0 ? null : nodes;
}

/**
 * План ПАКЕТНОГО пути команды «Создать мысль из выделенного» (диалог не
 * открывается): `null` — выделение не пакетное (одиночное вне списков/разделов),
 * пустое или без единиц с названием.
 */
export function planBatchSelection(snap: MdEditorSnapshot): SplitSelectionNode[] | null {
  if (snap.from === snap.to) return null;
  const selected = snap.text.slice(snap.from, snap.to);
  if (selected.trim() === '' || !selectionUsesBatchPath(selected)) return null;
  const nodes = buildUnitNodes(parseSelectionUnits(selected), selected, snap.from);
  return nodes.length === 0 ? null : nodes;
}

/* ------------------------------------------------------------------ *
 * Случаи 1–2 «Создать мысль из выделенного» (задача 785c7fac, 0.12.2).
 * ------------------------------------------------------------------ */

/**
 * План одиночного выделения для команды «Создать мысль из выделенного»
 * (требование `dc24a8b1`): предзаполнение диалога, разбиение на имя/тело и
 * признак пакетного пути. Диалог открывается только для одиночного выделения
 * ВНЕ списков и заголовков раздела; прочее идёт пакетным путём.
 */
export interface SelectionDialogPlan {
  /** Начало выделения в тексте редактора (включительно). */
  from: number;
  /** Конец выделения в тексте редактора (исключительно). */
  to: number;
  /** Точный текст выделения. */
  selected: string;
  /**
   * `true` — короткое выделение (случай 1): единственная строка ≤ 250 без
   * переносов (ровно 250 — короткое). Новая мысль получает ТОЛЬКО заголовок.
   */
  short: boolean;
  /** Текст предзаполнения поля диалога (обрезка до 250 для длинного). */
  prefill: string;
  /** Тело новой мысли: `''` — без тела (короткое выделение). */
  bodyMd: string;
  /** `true` — выделение пакетное (список/раздел): диалог не открывается. */
  batch: boolean;
}

/**
 * Пакетный ли путь у выделения: первый или любой верхнеуровневый элемент —
 * список либо раздел (заголовок). Такие выделения диалог не открывают
 * (элемент интерфейса `2a21c27e`, требование `dc24a8b1`).
 */
export function selectionUsesBatchPath(selected: string): boolean {
  return parseSelectionUnits(selected).some(
    (unit) => unit.kind === 'list' || unit.kind === 'section',
  );
}

/**
 * План команды «Создать мысль из выделенного» (случаи 1–2): `null` — выделения
 * нет, оно пустое либо без значимой строки для названия (команда недоступна).
 *
 * Короткое (единственная строка ≤ 250 без переносов) — предзаполнение равно
 * выделению, новая мысль без тела. Длинное (> 250 или с переносом) — заголовок
 * и предзаполнение из первой строки (≤ 250); тело — остаток после первого
 * переноса, а если первая строка длиннее 250 — всё выделение.
 */
export function planSelectionCommand(snap: MdEditorSnapshot): SelectionDialogPlan | null {
  if (snap.from === snap.to) return null;
  const selected = snap.text.slice(snap.from, snap.to);
  if (selected.trim() === '') return null;
  if (thoughtTitle(selected) === '') return null;
  const base = { from: snap.from, to: snap.to, selected };
  if (selectionUsesBatchPath(selected)) {
    return { ...base, short: false, prefill: '', bodyMd: '', batch: true };
  }
  const nl = selected.indexOf('\n');
  const firstLine = (nl === -1 ? selected : selected.slice(0, nl)).replace(/\r$/, '');
  const prefill = truncateMarkdownTitle(firstLine);
  if (nl === -1 && selected.length <= TITLE_MAX_LENGTH) {
    return { ...base, short: true, prefill: selected, bodyMd: '', batch: false };
  }
  const bodyMd =
    firstLine.length > TITLE_MAX_LENGTH ? selected : restAfterFirstLine(selected);
  return { ...base, short: false, prefill, bodyMd, batch: false };
}

/**
 * Разрешённая ссылка/трансклюзия: готовая конструкция и признак «заменяет всё
 * выделение» (новая мысль) либо «заголовок для частичной замены» (существующая).
 */
export interface SelectionThoughtRef {
  /** Готовая вставка: ссылка `[[#<id>]]` либо трансклюзия мысли. */
  ref: string;
  /** Заголовок существующей мысли — для частичной замены; `null` — новая. */
  title: string | null;
  /** `true` — вставка заменяет всю единицу (новая мысль). */
  whole: boolean;
}

/** Правка редактора: набор изменений и новый курсор. */
export interface SelectionEdit {
  changes: Array<{ from: number; to: number; insert: string }>;
  anchor: number;
}

/** Индекс первого вхождения `needle` в `haystack` без учёта регистра; −1 — нет. */
function indexOfInsensitive(haystack: string, needle: string): number {
  return haystack.toLowerCase().indexOf(needle.toLowerCase());
}

/**
 * Собирает правки ОДНОЙ единицы (требования `ee64ce46`, `d4f3d8a0`):
 * - если есть новая мысль (`whole`) — вся единица заменяется конструкцией
 *   (с телом → трансклюзия, без тела → ссылка);
 * - иначе для существующей мысли ссылкой заменяется ЛИТЕРАЛЬНО совпавшая
 *   с её заголовком часть текста единицы (регистронезависимо, по `trim`), а без
 *   совпадения — ссылка вставляется в НАЧАЛО, текст не меняется.
 */
export function buildSelectionEdits(
  selected: string,
  offset: number,
  refs: readonly SelectionThoughtRef[],
): SelectionEdit {
  if (refs.some((item) => item.whole)) {
    const insert = refs.map((item) => item.ref).join('\n');
    return {
      changes: [{ from: offset, to: offset + selected.length, insert }],
      anchor: offset + insert.length,
    };
  }
  const changes: SelectionEdit['changes'] = [];
  const used: Array<[number, number]> = [];
  const atStart: string[] = [];
  for (const item of refs) {
    const title = (item.title ?? '').trim();
    const index = title === '' ? -1 : indexOfInsensitive(selected, title);
    const overlaps = used.some(([a, b]) => index < b && index + title.length > a);
    if (index >= 0 && !overlaps) {
      changes.push({ from: offset + index, to: offset + index + title.length, insert: item.ref });
      used.push([index, index + title.length]);
    } else {
      atStart.push(item.ref);
    }
  }
  if (atStart.length > 0) {
    changes.unshift({ from: offset, to: offset, insert: atStart.join('\n') });
  }
  if (changes.length === 0) return { changes: [], anchor: offset };
  return { changes, anchor: changes[0]!.from + changes[0]!.insert.length };
}

/* ------------------------------------------------------------------ *
 * Тела команд.
 * ------------------------------------------------------------------ */

/** Строитель плана команды по снимку редактора (`из раздела`/`из выделенного`). */
export type CommentThoughtPlanBuilder = (
  snap: MdEditorSnapshot,
) => CommentThoughtPlan | null;

/** Собирает узлы леса в порядке документа (pre-order). */
function flattenSplit(nodes: readonly SplitSelectionNode[]): SplitSelectionNode[] {
  const flat: SplitSelectionNode[] = [];
  const walk = (list: readonly SplitSelectionNode[]): void => {
    for (const node of list) {
      flat.push(node);
      walk(node.children);
    }
  };
  walk(nodes);
  return flat;
}

/** Совпадает ли лес единиц до и после ожидания (структура, названия, тела). */
function sameSplitShape(
  a: readonly SplitSelectionNode[],
  b: readonly SplitSelectionNode[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.title !== y.title || x.bodyMd !== y.bodyMd) return false;
    if (!sameSplitShape(x.children, y.children)) return false;
  }
  return true;
}

/** План раздела → один узел пакетного плана. */
function sectionNodeFromPlan(plan: CommentThoughtPlan): SplitSelectionNode {
  return {
    start: plan.start,
    end: plan.end,
    fullStart: plan.start,
    fullEnd: plan.end,
    title: plan.title,
    bodyMd: plan.bodyMd,
    children: [],
  };
}

/** Заголовок существующей мысли → ссылка для частичной замены. */
async function existingRef(
  port: CommentThoughtCreatePort,
  id: string,
): Promise<SelectionThoughtRef> {
  return { ref: thoughtLinkRef(id, ''), title: await port.thoughtTitle(id), whole: false };
}

/** Создаёт новую мысль по узлу; форма вставки — по непустоте ТЕЛА (`23c11231`). */
async function createUnitRef(
  port: CommentThoughtCreatePort,
  parentId: string,
  node: SplitSelectionNode,
): Promise<{ ref: SelectionThoughtRef; id: string }> {
  const created = await port.create({ parentId, title: node.title, bodyMd: node.bodyMd });
  return {
    id: created.id,
    ref: {
      ref: node.bodyMd === '' ? thoughtLinkRef(created.id, '') : formatTransclusionRef(created.id),
      title: null,
      whole: true,
    },
  };
}

/**
 * Общий движок пакетного пути (список, «Разделить», «Создать мысль из
 * раздела»): по каждой единице — дедуп `14539728` (одно совпадение →
 * существующая, несколько → поповер у элемента, отказ → по `refuseCreates`),
 * иначе создание; затем вставка по `23c11231`/`ee64ce46`. Позиции сняты ДО
 * сетевых `await` — после них план перепрокладывается по актуальному документу
 * ({@link relocatedSelection}, ошибка `da5e74b0`); расхождение контекста
 * отменяет правку.
 *
 * @param rebuild — перестроение плана по актуальному снимку (для перепрокладки);
 * @param refuseCreates — при отказе от поповера создавать новую мысль (`false`
 *   — «Создать мысль из раздела»: отказ → прежнее поведение без дедупа) или
 *   оставить элемент без изменений (`true` — список и «Разделить»).
 */
async function runPlanUnits(
  editor: MdEditor,
  nodes: readonly SplitSelectionNode[],
  owner: CommentOwnerRef,
  rebuild: (snap: MdEditorSnapshot) => SplitSelectionNode[] | null,
  refuseCreates: boolean,
): Promise<void> {
  const port = commentThoughtCreatePort();
  const before = editor.snapshot();
  try {
    const parentId = await port.resolveParent(owner);
    if (parentId === null) {
      notice(`${t('comment.create.error')}: ${t('comment.create.noParent')}`, 'error');
      return;
    }

    const refs: Array<SelectionThoughtRef | null> = [];

    // Замыкание «отказ»: сама единица и всё её поддерево остаются без правок,
    // но позиции в плоском списке сохраняются (сверка с перепрокладкой).
    const pushSkipped = (node: SplitSelectionNode): void => {
      refs.push(null);
      for (const child of node.children) pushSkipped(child);
    };

    // Обход в порядке документа: подраздел создаётся под родительской мыслью
    // (её id — существующий или только что созданный), прочее — под текущей.
    const walk = async (
      list: readonly SplitSelectionNode[],
      parent: string,
    ): Promise<void> => {
      for (const node of list) {
        const candidates = await port.candidates(node.title);
        if (candidates.length === 1) {
          refs.push(await existingRef(port, candidates[0]!.id));
          await walk(node.children, candidates[0]!.id);
          continue;
        }
        if (candidates.length > 1) {
          const anchor = editor.pointAt?.(node.start) ?? { x: 0, y: 0 };
          const chosen = await port.choose(anchor, node.title, candidates);
          if (chosen !== null) {
            refs.push(await existingRef(port, chosen));
            await walk(node.children, chosen);
          } else if (refuseCreates) {
            pushSkipped(node); // отказ — элемент (и вложенные) без изменений
          } else {
            const created = await createUnitRef(port, parent, node);
            refs.push(created.ref);
            await walk(node.children, created.id);
          }
          continue;
        }
        const created = await createUnitRef(port, parent, node);
        refs.push(created.ref);
        await walk(node.children, created.id);
      }
    };
    await walk(nodes, parentId);

    // Позиции плана сняты ДО сетевых await — перепрокладываем по актуальному
    // документу; расхождение контекста отменяет правку (`da5e74b0`).
    const after = editor.snapshot();
    const sel =
      relocatedSelection(before, after) ??
      (after.text === before.text ? { from: before.from, to: before.to } : null);
    if (sel === null) return;
    const next = rebuild({ text: after.text, from: sel.from, to: sel.to });
    if (next === null || !sameSplitShape(nodes, next)) return;
    const flatAfter = flattenSplit(next);
    if (flatAfter.length !== refs.length) return;

    const changes: Array<{ from: number; to: number; insert: string }> = [];
    for (let i = 0; i < flatAfter.length; i++) {
      const ref = refs[i]!;
      if (ref === null) continue;
      const node = flatAfter[i]!;
      const from = ref.whole ? node.fullStart : node.start;
      const to = ref.whole ? node.fullEnd : node.end;
      const edit = buildSelectionEdits(after.text.slice(from, to), from, [ref]);
      changes.push(...edit.changes);
    }
    if (changes.length === 0) return;
    changes.sort((a, b) => a.from - b.from);
    const first = changes[0]!;
    editor.applyEdit({
      changes,
      selection: { anchor: first.from + first.insert.length },
    });
  } catch (err) {
    notice(`${t('comment.create.error')}: ${errText(err)}`, 'error');
  }
}

/* ------------------------------------------------------------------ *
 * Тело команды «Создать мысль из раздела» (дедуп S8, требование 14539728).
 * ------------------------------------------------------------------ */

/**
 * Ход команды «Создать мысль из раздела»: предварительный дедуп по
 * названию/синониму (одно → существующая, несколько → поповер, отказ → прежнее
 * поведение без дедупа), затем вставка по развилке `23c11231`.
 */
function runCreate(ctx: CommentCommandContext, build: CommentThoughtPlanBuilder): boolean {
  const plan = build(ctx.editor.snapshot());
  if (plan === null) return false;
  const owner = ctx.getCommentOwner();
  if (owner === null) return false;
  const node = sectionNodeFromPlan(plan);
  void runPlanUnits(
    ctx.editor,
    [node],
    owner,
    (snap) => {
      const next = build(snap);
      return next === null ? null : [sectionNodeFromPlan(next)];
    },
    false,
  );
  return true;
}

/* ------------------------------------------------------------------ *
 * Тело команды «Создать мысль из выделенного» (T1 случаи 1–2 + T2 пакет).
 * ------------------------------------------------------------------ */

/**
 * Открывает диалог поиска/создания по плану случая 1–2, создаёт новые мысли,
 * а затем правит выделение по {@link buildSelectionEdits}. Позиции выделения
 * сняты до сетевых `await` — после них план перепрокладывается по актуальному
 * документу ({@link relocatedSelection}); расхождение контекста отменяет правку
 * (ошибка `da5e74b0`). Отмена диалога и отсутствие владельца текст не меняют.
 */
async function runSelectionDialog(
  editor: MdEditor,
  plan: SelectionDialogPlan,
  owner: CommentOwnerRef,
): Promise<void> {
  const port = commentThoughtCreatePort();
  const before = editor.snapshot();
  try {
    const parentId = await port.resolveParent(owner);
    if (parentId === null) {
      notice(`${t('comment.create.error')}: ${t('comment.create.noParent')}`, 'error');
      return;
    }
    const parentTitle = await port.thoughtTitle(parentId);
    const result = await port.pick({
      anchorId: parentId,
      anchorTitle: parentTitle,
      prefillText: plan.prefill,
    });
    if (result === null) return; // отказ от диалога — текст не меняется

    const refs: SelectionThoughtRef[] = [];
    for (const item of result.items) {
      if (item.kind === 'existing' && item.id !== undefined) {
        refs.push(await existingRef(port, item.id));
        continue;
      }
      // Новая мысль: заголовок и синонимы из диалога (поле могло быть
      // отредактировано), тело — по правилу случая, тип НЕ задаётся (Н1).
      const created = await port.create({
        parentId,
        title: item.title ?? plan.prefill,
        bodyMd: plan.bodyMd,
      });
      // Форма вставки — по ФАКТИЧЕСКОЙ непустоте тела (требования `23c11231`,
      // `d4f3d8a0`), а не по «короткости» случая.
      refs.push({
        ref: plan.bodyMd === '' ? thoughtLinkRef(created.id, '') : formatTransclusionRef(created.id),
        title: null,
        whole: true,
      });
    }
    if (refs.length === 0) return;

    const after = editor.snapshot();
    // Диалог уводит фокус из поля — CM6-выделение могло свернуться, и тогда
    // `relocatedSelection` вернёт null при НЕизменённом тексте. Текст тот же ⇒
    // офсеты, снятые до диалога, по-прежнему верны; берём их как запасной путь.
    const sel =
      relocatedSelection(before, after) ??
      (after.text === before.text ? { from: before.from, to: before.to } : null);
    if (sel === null) return; // документ изменился — правку не применяем
    const selected = after.text.slice(sel.from, sel.to);
    const edit = buildSelectionEdits(selected, sel.from, refs);
    if (edit.changes.length === 0) return;
    editor.applyEdit({ changes: edit.changes, selection: { anchor: edit.anchor } });
  } catch (err) {
    notice(`${t('comment.create.error')}: ${errText(err)}`, 'error');
  }
}

/**
 * Ход команды «Создать мысль из выделенного»: одиночное выделение вне списков и
 * заголовков идёт через диалог (случаи 1–2); пакетное (список/раздел/смешанное)
 * — пакетным путём по единицам (T2).
 */
function runSelectionCommand(ctx: CommentCommandContext): boolean {
  const snap = ctx.editor.snapshot();
  const plan = planSelectionCommand(snap);
  if (plan === null) return false;
  const owner = ctx.getCommentOwner();
  if (owner === null) return false;
  if (plan.batch) {
    const nodes = planBatchSelection(snap);
    if (nodes === null) return false;
    void runPlanUnits(ctx.editor, nodes, owner, planBatchSelection, true);
    return true;
  }
  void runSelectionDialog(ctx.editor, plan, owner);
  return true;
}

/* ------------------------------------------------------------------ *
 * Тело команды «Разделить выделение на мысли» (задача T2 026241f2).
 * ------------------------------------------------------------------ */

/** Ход команды «Разделить выделение на мысли»: план → владелец → создание. */
function runSplit(ctx: CommentCommandContext): boolean {
  const nodes = planSplitSelection(ctx.editor.snapshot());
  if (nodes === null) return false;
  const owner = ctx.getCommentOwner();
  if (owner === null) return false;
  void runPlanUnits(ctx.editor, nodes, owner, planSplitSelection, true);
  return true;
}

/**
 * Регистрирует тела обеих команд (идемпотентно — повторный вызов заменяет
 * записи реестра). Вызывается при установке набора команд поля. Идентификаторы
 * заданы литералами, а не экспортированными константами: модуль может быть
 * установлен из циклически импортируемого `comment-format.ts` до инициализации
 * своих констант.
 */
export function installCommentThoughtCreateCommands(): void {
  registerCommentCommand('comment.createFromSection', {
    run: (ctx) => runCreate(ctx, planFromSection),
    state: (snap) => ({ disabled: planFromSection(snap) === null }),
  });
  registerCommentCommand('comment.createFromSelection', {
    run: (ctx) => runSelectionCommand(ctx),
    state: (snap) => ({ disabled: planSelectionCommand(snap) === null }),
  });
  registerCommentCommand('comment.split', {
    run: (ctx) => runSplit(ctx),
    state: (snap) => ({ disabled: planSplitSelection(snap) === null }),
  });
}

// Самоустановка при загрузке модуля: команды доступны полю без явного вызова
// со стороны ТП1 (модуль подключается боковым импортом из `comment-format.ts`).
installCommentThoughtCreateCommands();

/**
 * Блок «Связи дня» в дне ленты «Дневника» (0.16.1, задача `710b68aa`;
 * требование `1fb1047d`, элемент интерфейса `8ecc30cd`).
 *
 * **Состав.** Датовые факты (мысль + подпись свойства-даты) и date-ссылки из
 * ДРУГИХ записей и постоянных комментариев (облачко владельца + сниппет
 * источника + время/дата записи-источника). Строки-задачи сюда не попадают —
 * их даты показывает панель «Задачи» (исключение дублей делает сервер).
 *
 * **Порядок.** Факты (по алфавиту — серверный порядок), затем ссылки (по
 * времени цели); группировки внутри блока нет.
 *
 * **Клики.** Облачко факта — карточка мысли; подпись свойства факта — та же
 * мысль на вкладке «Свойства» с выделением строки этого свойства (задача
 * 3054fe86); облачко/сниппет постоянного комментария — карточка владельца;
 * сниппет записи и дата записи-источника — переход к её дню. Пустой блок не
 * показывается.
 *
 * Модуль не ходит в сеть: данные приходят из `etn.chronicle.dayLinks`, действия
 * — от экрана (`DayLinksActions`), поэтому правила блока проверяются DOM-тестом.
 */

import type { DayFact, DayLink, DayLinkSource, DayLinksResult, SortOrder } from '@etn/shared';

import { div, el, span, button } from '../../lib/dom.js';
import { t } from '../../lib/i18n.js';
import { reconcileKeyed } from '../../lib/ui/keyed-list.js';
import { createThoughtCloud } from '../../lib/thought-cloud.js';
import { compareDays, formatDayLabel, localDay, type DiaryDay } from './diary.js';

/** Класс контейнера датовых фактов (первый ребёнок блока). */
const FACTS_SLOT = 'diary-day-links-facts';
/** Класс контейнера date-ссылок (второй ребёнок блока). */
const LINKS_SLOT = 'diary-day-links-list';

/** Данные блока одного дня. */
export interface DayLinksData {
  facts: readonly DayFact[];
  links: readonly DayLink[];
}

/** Действия блока: всё, что требует навигации/сети. */
export interface DayLinksActions {
  /** Открыть карточку мысли (факт или владелец ссылки). */
  openThought(id: string): void;
  /**
   * Открыть мысль датового факта сразу на вкладке «Свойства» и показать строку
   * свойства (задача 3054fe86): клик по подписи свойства ведёт к значению.
   */
  openThoughtProperty(id: string, propertyId: string): void;
  /** Открыть владельца источника (мысль/связь/публикация). */
  openSource(source: DayLinkSource): void;
  /** Перейти к дню записи-источника. */
  openSourceDay(day: string): void;
}

/** Пустой блок дня (создаётся вместе с секцией дня, до загрузки данных). */
export function buildDayLinksBlock(): HTMLElement {
  const block = div('diary-day-links');
  block.hidden = true;
  return block;
}

/** Сгруппировать ответ сервера по календарным дням. */
export function groupDayLinks(result: DayLinksResult): Map<string, DayLinksData> {
  const days = new Map<string, { facts: DayFact[]; links: DayLink[] }>();
  const take = (day: string): { facts: DayFact[]; links: DayLink[] } => {
    const existing = days.get(day);
    if (existing !== undefined) return existing;
    const created = { facts: [] as DayFact[], links: [] as DayLink[] };
    days.set(day, created);
    return created;
  };
  for (const fact of result.facts) take(fact.day).facts.push(fact);
  for (const link of result.links) take(link.day).links.push(link);
  return days;
}

/**
 * Дни ленты = дни записей + дни, у которых есть ТОЛЬКО «связи дня» (0.16.1,
 * требование 1fb1047d). День без своих записей, но со связями, обязан стать
 * секцией дня (заголовок + блок связей) — замечание финальной приёмки 399c25d5.
 * Слияние идёт в границах применённого периода и в его направлении
 * (`compareDays`), поэтому порядок ленты не зависит от источника дня.
 */
export function withLinkDays(
  days: readonly DiaryDay[],
  links: ReadonlyMap<string, DayLinksData>,
  opts: { from: string; to: string; order: SortOrder },
): DiaryDay[] {
  const merged = [...days];
  const known = new Set(days.map((day) => day.day));
  for (const day of links.keys()) {
    if (known.has(day)) continue;
    if (opts.from !== '' && day < opts.from) continue;
    if (opts.to !== '' && day > opts.to) continue;
    known.add(day);
    merged.push({ day, rows: [] });
  }
  if (merged.length === days.length) return merged;
  return merged.sort((a, b) => compareDays(a.day, b.day, opts.order));
}

/**
 * Отрисовать блок дня (или спрятать его, когда данных нет). Состав строк
 * обновляется keyed-сверкой (`reconcileKeyed`) в постоянных контейнерах блока:
 * неизменённые строки сохраняют узлы, поэтому hover/фокус и позиция прокрутки
 * ленты не сбрасываются.
 */
export function renderDayLinks(
  block: HTMLElement,
  data: DayLinksData | undefined,
  actions: DayLinksActions,
): void {
  const factsData = data?.facts ?? [];
  const linksData = data?.links ?? [];
  const hasFacts = factsData.length > 0;
  const hasLinks = linksData.length > 0;
  block.hidden = !hasFacts && !hasLinks;

  const facts = slot(block, FACTS_SLOT, 0);
  const links = slot(block, LINKS_SLOT, 1);
  facts.hidden = !hasFacts;
  links.hidden = !hasLinks;

  reconcileKeyed(facts, factsData, {
    key: factKey,
    build: (fact) => fillFactRow(div('diary-day-link diary-day-link-fact'), fact, actions),
    update: (row, fact) => {
      fillFactRow(row as HTMLElement, fact, actions);
    },
  });
  reconcileKeyed(links, linksData, {
    key: linkKey,
    build: (link) => fillLinkRow(div('diary-day-link diary-day-link-ref'), link, actions),
    update: (row, link) => {
      fillLinkRow(row as HTMLElement, link, actions);
    },
  });
}

/**
 * Постоянный контейнер блока по классу: создаётся один раз и дальше только
 * наполняется сверкой — identity контейнера переживает перерисовки дня.
 * `order` держит порядок «факты, затем ссылки» даже при первом показе дня.
 */
function slot(block: HTMLElement, className: string, order: number): HTMLElement {
  for (const child of Array.from(block.children)) {
    if (child.classList.contains(className)) return child as HTMLElement;
  }
  const created = div(className);
  block.insertBefore(created, (block.children[order] as HTMLElement | undefined) ?? null);
  return created;
}

/** Ключ строки факта: день + мысль + свойство-дата. */
function factKey(fact: DayFact): string {
  return `fact:${fact.day}:${fact.thought_id}:${fact.property_id}`;
}

/** Ключ строки ссылки: день + источник (комментарий и номер строки). */
function linkKey(link: DayLink): string {
  return `link:${link.day}:${link.source.comment_id}:${link.source.line_no}`;
}

/**
 * Наполнить строку датового факта: облачко мысли + подпись свойства. Строка
 * пересобирается целиком — её состав фиксирован, коллекция строк живёт в
 * контейнере и обновляется сверкой.
 *
 * Подпись свойства — кнопка словаря (`link-btn`): мышь и Enter/Space ведут в ту
 * же мысль, но на вкладку «Свойства» к строке этого свойства (задача 3054fe86).
 * Облачко по-прежнему открывает карточку без смены вкладки.
 */
function fillFactRow(row: HTMLElement, fact: DayFact, actions: DayLinksActions): HTMLElement {
  const chip = createThoughtCloud(
    { id: fact.thought_id, title: fact.title },
    {
      profile: 'chip',
      width: 'container',
      actions: { onClick: (id) => actions.openThought(id) },
    },
  );
  const caption = button(
    fact.property_name,
    () => actions.openThoughtProperty(fact.thought_id, fact.property_id),
    'link-btn diary-day-link-caption',
  );
  row.replaceChildren(chip, caption);
  return row;
}

/** Наполнить строку date-ссылки: облачко владельца, время, сниппет, дата источника. */
function fillLinkRow(row: HTMLElement, link: DayLink, actions: DayLinksActions): HTMLElement {
  const source = link.source;
  row.replaceChildren(ownerChip(source, actions));
  if (link.time !== null) {
    row.append(span(link.time, 'diary-day-link-time'));
  }
  const snippet = span(source.text, 'muted diary-day-link-snippet');
  snippet.title = source.text;
  snippet.addEventListener('click', () => {
    // Постоянный комментарий открывает карточку владельца, запись — свой день.
    if (source.kind === 'permanent' || source.source_from === null) actions.openSource(source);
    else actions.openSourceDay(localDay(source.source_from));
  });
  row.append(snippet);
  if (source.kind === 'chronological' && source.source_from !== null) {
    const day = localDay(source.source_from);
    const date = span(formatDayLabel(day), 'diary-day-link-source-date');
    date.addEventListener('click', () => actions.openSourceDay(day));
    row.append(date);
  }
  return row;
}

/**
 * Облачко владельца источника: у мысли — общее облачко (карточка мысли), у
 * связи/публикации — текстовый чип с подписью, ведущий в карточку владельца.
 */
function ownerChip(source: DayLinkSource, actions: DayLinksActions): HTMLElement {
  if (source.owner_type === 'thought') {
    return createThoughtCloud(
      { id: source.owner_id, title: source.owner_title },
      {
        profile: 'chip',
        width: 'container',
        actions: { onClick: (id) => actions.openThought(id) },
      },
    );
  }
  const icon = source.owner_type === 'link' ? '🔗' : '📄';
  const chip = el('span', 'chron-chip link diary-day-link-owner');
  chip.append(span(icon, 'chip-icon'), span(source.owner_title, 'chip-title'));
  chip.addEventListener('click', () => actions.openSource(source));
  chip.title = t('diary.dayLinksOwner');
  return chip;
}

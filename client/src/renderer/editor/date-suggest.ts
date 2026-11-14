/**
 * Автокомплит дат в едином дропдауне `[[` (0.16.1, ТП «Даты, задачи и
 * напоминания»; элемент интерфейса f9da2100, ADR ef097fad «единый дропдаун
 * автокомплита», требование 31fe2cc9/1389b057).
 *
 * Правило ADR: один дропдаун на триггер `[[`. Ввод из цифр/точек/дефисов даёт
 * секцию «Даты» СВЕРХУ (сегодня, завтра, введённая дата с ISO-валидацией), ниже
 * — секция «Мысли» (живой поиск, он живёт в `wiki-link.ts`). Буквенный ввод
 * секцию «Даты» не показывает вовсе. Отдельного триггера для дат нет.
 *
 * Модуль чистый (только словарь и календарные помощники): параметры
 * автокомплита строятся здесь, а CodeMirror-источник в `wiki-link.ts` лишь
 * подмешивает их к результатам поиска мыслей. Поэтому контракт «что видно по
 * вводу» проверяется юнит-тестом без DOM.
 */

import type { Completion, CompletionSection } from '@codemirror/autocomplete';

import { formatDateLinkLabel, parseDateLinkTarget } from '@etn/markdown';

import { t } from '../lib/i18n.js';
import { addDays, isValidLocalDay } from '../lib/dates.js';

/** Префикс, который считается «датовым»: цифры, точки (dd.mm.yyyy) и дефисы (ISO). */
const DATE_PREFIX_RE = /^[\d.-]*$/;

/**
 * Похож ли набранный префикс на дату. Пустая строка — тоже «да»: дропдаун
 * открывается сразу после `[[` и предлагает сегодня/завтра. Буквы и прочие
 * символы дат не показывают (явный запрет ADR).
 */
export function isDatePrefix(prefix: string): boolean {
  return DATE_PREFIX_RE.test(prefix);
}

/** Секция «Даты» (сверху) — ранги меньше, чем у «Мыслей». */
export function datesSection(): CompletionSection {
  return { name: t('wikiLink.dateSuggest.dates'), rank: 0 };
}

/** Секция «Мысли» (ниже дат). */
export function thoughtsSection(): CompletionSection {
  return { name: t('wikiLink.dateSuggest.thoughts'), rank: 1 };
}

/**
 * Префикс → ISO-дата. Понимает полный ISO (`2026-11-02`) и локальную запись
 * `dd.mm.yyyy` (в т.ч. `d.m.yyyy`); неполная или несуществующая дата — `null`
 * (введённая дата тогда просто не предлагается, автоподстановок «на глаз» нет).
 */
export function typedDateIso(prefix: string): string | null {
  const text = prefix.trim();
  if (text === '') return null;

  const iso = parseDateLinkTarget(text);
  if (iso !== null && iso.time === null) return iso.date;

  const dotted = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(text);
  if (dotted === null) return null;
  const day = dotted[1]!.padStart(2, '0');
  const month = dotted[2]!.padStart(2, '0');
  const candidate = `${dotted[3]}-${month}-${day}`;
  return isValidLocalDay(candidate) ? candidate : null;
}

/** Короткая подпись даты для строки дропдауна (`dd.MM.yyyy`). */
function prettyDate(iso: string): string {
  return formatDateLinkLabel({ date: iso, time: null });
}

/** Один пункт секции «Даты»; `apply` вставляет полную ISO-форму и закрывает скобки. */
function dateItem(label: string, iso: string): Completion {
  return {
    label: `${label} · ${prettyDate(iso)}`,
    detail: t('wikiLink.dateSuggest.formatHint', [prettyDate(iso), iso]),
    type: 'keyword',
    apply: `${iso}]]`,
    section: datesSection(),
  };
}

/**
 * Пункты секции «Даты» для набранного префикса: сегодня, завтра и введённая
 * дата (если она валидна). Не «датовый» префикс — пустой массив (только мысли).
 */
export function dateSuggestOptions(prefix: string, today: string): Completion[] {
  if (!isDatePrefix(prefix)) return [];
  const options = [
    dateItem(t('wikiLink.dateSuggest.today'), today),
    dateItem(t('wikiLink.dateSuggest.tomorrow'), addDays(today, 1)),
  ];
  const typed = typedDateIso(prefix);
  if (typed !== null) options.push(dateItem(t('wikiLink.dateSuggest.typed'), typed));
  return options;
}

/**
 * Добавить пунктам мыслей секцию «Мысли», когда в дропдауне есть «Даты»:
 * иначе CodeMirror показал бы мысли над секцией (опции без секции идут выше).
 * При буквенном вводе секций нет — заголовок «Мысли» над единственным списком
 * был бы шумом.
 */
export function withThoughtsSection(
  options: readonly Completion[],
  datesShown: boolean,
): Completion[] {
  if (!datesShown) return [...options];
  const section = thoughtsSection();
  return options.map((option) => ({ ...option, section }));
}

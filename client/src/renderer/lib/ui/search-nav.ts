/**
 * Мост «поле поиска → клавиатурная навигация списка» (`lib/ui`).
 *
 * **Зачем.** У списочных диалогов и пикеров поиск — ПЕРВАЯ строка (требование
 * 11ddd910): пользователь набирает запрос и дальше ждёт, что ↑/↓ поведут
 * выделение, а Enter выберет. Фокус при этом стоит в поле, а навигация списка
 * (ядро `./nav-core.ts` в фасадах `./table.ts` / `./tree.ts`) срабатывает только
 * на фокусе самого списка — стрелки и Enter в поле поиска молча пропадали
 * (ошибка 58981cf5: «в пикере свойств нет клавиатурной навигации»).
 *
 * **Что здесь.** Только ПЕРЕДАЧА нажатий: ↑/↓/Enter из поля поиска уходят в
 * штатный обработчик списка ({@link SearchNavTarget.handleKey}) без второго
 * разбора клавиш и без собственных правил границ/активации — они остаются в
 * `nav-core`/фасаде (стандарт b6b2821d, ADR fadf99e0). Фокус остаётся в поле
 * поиска: набор запроса продолжается, а выделение и прокрутка списка видны.
 * Escape и прочие клавиши не перехватываются — ими распоряжаются поле и
 * каркас диалога.
 *
 * **←/→ и Ctrl+↑/↓ (решение задачи 15236418, для карточки компонента).**
 * ←/→ НЕ передаются: в поле поиска это клавиши каретки, и перехват ломал бы
 * набор/правку запроса (переход по колонкам доступен после ↓ — фокус
 * переходит в список клавиатурой, а выделение уже стоит на первой строке).
 * Ctrl+↑/↓ передаются: в однострочном поле они не управляют кареткой, а
 * свёрнутость полки/узла нужна и во время набора (библиотека публикаций).
 * Модификаторы идут в штатный `handleKey` фасада, поэтому `Ctrl+↓` не читается
 * как обычное «вниз».
 *
 * **Механика.** Контекст сочетаний объявляется один раз на модуль (повторное
 * объявление того же id идемпотентно — реестр `lib/keymap.ts` не растёт с
 * каждым открытием диалога); конкретная цель нажатия ищется по `event.target`
 * в наборе активных мостов. Контекст кладётся на вершину стека на `focusin`
 * поля и снимается на `focusout` — перехват идёт через общеклиентский
 * диспетчер (ADR b420b08c): локальных слушателей keydown в клиенте нет.
 *
 * Собственных обработчиков стрелок в экранах это не разрешает: мост — часть
 * общего механизма списков, его наличие проверяет сторож `guard-list-nav`.
 */

import { defineKeyContext, pushKeyContext } from '../keymap.js';
import type { NavKeyModifiers } from './nav-core.js';

/** Идентификатор контекста моста — один на клиент. */
export const SEARCH_NAV_CONTEXT_ID = 'list-search-nav';

/**
 * Клавиши, передаваемые списку: выделение, выбор и свёрнутость узла.
 * ←/→ сюда НЕ входят — в поле поиска они принадлежат каретке (см. выше).
 */
export const SEARCH_NAV_KEYS = ['ArrowDown', 'ArrowUp', 'Enter', 'Ctrl+ArrowDown', 'Ctrl+ArrowUp'] as const;

/** Цель моста — список, который обработает нажатие своим штатным механизмом. */
export interface SearchNavTarget {
  /**
   * Обработать клавишу так же, как при фокусе на списке (↑/↓ двигают текущую
   * строку с прокруткой, Enter активирует её, Ctrl+↑/↓ сворачивают узел).
   * `modifiers` — модификаторы исходного нажатия: без них `Ctrl+↓` в фасаде
   * не отличить от обычного «вниз». `false` — клавиша списку не принадлежит.
   */
  handleKey: (key: string, modifiers?: NavKeyModifiers) => boolean;
}

/** Активные мосты: поле поиска → цель навигации. */
const targets = new WeakMap<object, SearchNavTarget>();

/** Обработчик контекста: нажатие адресуется полю-источнику события. */
function handleSearchNav(event: KeyboardEvent): boolean {
  const source = event.target as unknown;
  if (source === null || typeof source !== 'object') return false;
  const target = targets.get(source);
  if (target === undefined) return false;
  // Событие само несёт модификаторы нажатия — отдаём его как
  // `NavKeyModifiers`: они не разбираются повторно (иначе `Ctrl+↓` пришёл бы в
  // фасад обычной «вниз»).
  return target.handleKey(event.key, event);
}

/** Привязки контекста: объявление идемпотентно (повторная запись того же id). */
function ensureContext(): void {
  defineKeyContext({
    id: SEARCH_NAV_CONTEXT_ID,
    bindings: [
      { command: 'listSearch.down', chord: 'ArrowDown', run: handleSearchNav },
      { command: 'listSearch.up', chord: 'ArrowUp', run: handleSearchNav },
      // Только «голый» Enter: Ctrl/Alt/Meta/Shift+Enter остаются каркасу
      // диалога и полю (подтверждение, вставка) — модификаторные привязки
      // здесь не размножаем (`lib/keymap-chords.ts`).
      { command: 'listSearch.enter', chord: 'Enter', run: handleSearchNav },
      // Свёрнутость узла/полки доступна прямо из поиска (задача 15236418):
      // Ctrl-стрелки в поле не управляют кареткой.
      { command: 'listSearch.collapse', chord: 'Ctrl+ArrowUp', run: handleSearchNav },
      { command: 'listSearch.expand', chord: 'Ctrl+ArrowDown', run: handleSearchNav },
    ],
  });
}

/**
 * Связывает поле поиска со списком: пока фокус в поле, ↑/↓/Enter исполняет
 * штатный обработчик списка. Возвращает функцию снятия моста (снимает также
 * контекст со стека, если поле было в фокусе).
 */
export function bindSearchNav(
  search: HTMLInputElement,
  target: SearchNavTarget,
): () => void {
  ensureContext();
  targets.set(search, target);

  let releaseContext: (() => void) | null = null;
  const onFocusIn = (): void => {
    releaseContext ??= pushKeyContext(SEARCH_NAV_CONTEXT_ID);
  };
  const onFocusOut = (): void => {
    releaseContext?.();
    releaseContext = null;
  };
  search.addEventListener('focusin', onFocusIn as EventListener);
  search.addEventListener('focusout', onFocusOut as EventListener);

  return () => {
    targets.delete(search);
    releaseContext?.();
    releaseContext = null;
    search.removeEventListener('focusin', onFocusIn as EventListener);
    search.removeEventListener('focusout', onFocusOut as EventListener);
  };
}

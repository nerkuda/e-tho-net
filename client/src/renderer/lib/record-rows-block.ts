/**
 * Подблок строк-записей группы «Упоминания» (0.15.4, тех.проект 43329662,
 * задача ae72e47e, требования 012b2dc6 и ce121e09).
 *
 * **Зачем.** Вкладка «Упоминания» (`editor/links-tab.ts`) получает от сервера
 * union `(MentionHit | RecordHit)[]`: владельческие строки постоянных
 * комментариев и строки дневниковых записей. Строку записи рисует ОБЩАЯ
 * компонента `lib/record-row.ts` (элемент 554e3129, ADR 8f0e9412, коллекция
 * эталонов cf36bf55) — тем же видом, что в группе поиска «Найдено в
 * хронологии». Этот модуль собирает строки ПОДБЛОКОМ после владельческих и
 * берёт на себя правила вкладки, чтобы они не разъехались между её двумя
 * группами («Ссылки на мысль» и «Упоминания в текстах»).
 *
 * **Правила.**
 *  - ВИДИМОСТЬ — по `active` ПЕРВИЧНОЙ привязки: у `RecordHit` своего `active`
 *    нет (требование 012b2dc6, уточнение итерации 2), поэтому ищем в `targets`
 *    привязку с `owner_type`/`owner_id` строки и берём её актуальность.
 *    Fallback: привязки нет в `targets` (цель не разрешилась — физически
 *    удалена, нет в `thoughts_v`/`links_v`, веерный резолв чужой сети) →
 *    строка считается АКТУАЛЬНОЙ: скрытие по неразрешённой привязке теряло бы
 *    запись (уточнение итерации 8 аудита).
 *  - ПОМЕТКА КОРЗИНЫ здесь не проверяется: маркировка привязки не убирает её из
 *    `targets` (миграция 024), видимость помеченных — дело чипов-мыслей
 *    (`show_trash`, сужение K4 в `lib/record-targets.ts`).
 *  - НЕАКТИВНАЯ строка при включённой настройке «показывать неактуальные»
 *    остаётся в списке, но приглушается (`.dim`) — как владельческие строки.
 *  - ПОТОЛОК рендера — клиентский N на группу с подписью «Показано N из M»
 *    (`planRecordCap`, ключ `records.more`): M — число строк-записей в ответе,
 *    сервер отдаёт все строки (механизм НЕ серверный).
 *  - ВРЕМЯ ЖИЗНИ — рукоятки строк (`RecordRowHandle.destroy`) снимаются вместе
 *    с подблоком: `ResizeObserver` полос не переживает перерисовку группы.
 *
 * Счётчик группы считает владельческие строки и {@link RecordRowsBlock.visibleCount}
 * этого блока — это РАЗНЫЕ величины (счётчик — все найденные строки обоих
 * видов, подпись потолка — только строки-записи), складывает их вызывающая
 * сторона.
 */

import type { RecordHit } from '@etn/shared';

import { div, el } from './dom.js';
import { planRecordCap } from './chip-overflow.js';
import {
  createRecordRow,
  recordRowFromRecordHit,
  type RecordRowHandle,
  type RecordRowModel,
} from './record-row.js';
import type { RecordTargetRef } from './record-targets.js';

/** Опции подблока строк-записей группы «Упоминания». */
export interface RecordRowsBlockOptions {
  /** Сеть записи: сниппет-конвейер `[[#id]]` → имя разрешает id в ней. */
  networkId: string;
  /** Строки-записи группы в порядке сервера (`valid_from` по убыванию). */
  hits: readonly RecordHit[];
  /** HOME сети — фильтр чипов (`lib/home.ts`); `null` — не разрешён. */
  homeId: string | null;
  /** Настройка «показывать неактуальные» (скрывает/приглушает неактивные). */
  showInactive: boolean;
  /** Настройка «корзина» для чипов-мыслей (сужение K4). */
  showTrash: boolean;
  /** Клик по привязке строки либо по её владельцу (требование ce121e09). */
  onOpen: (target: RecordTargetRef, model: RecordRowModel) => void;
}

/** Смонтированный подблок строк-записей. */
export interface RecordRowsBlock {
  /** Контейнер подблока (`.mentions-records`); пуст, если видимых строк нет. */
  el: HTMLElement;
  /** Видимых строк-записей — слагаемое счётчика группы. */
  visibleCount: number;
  /** Всего строк-записей в ответе (M подписи потолка). */
  total: number;
  /** Снять обвязку переполнения всех строк и очистить подблок. */
  destroy(): void;
}

/**
 * Актуальность строки-записи по её ПЕРВИЧНОЙ привязке (требование 012b2dc6,
 * уточнение итерации 2). Отдельного `active` у строки нет — ищем привязку с
 * `owner_type`/`owner_id` строки в полном наборе `targets`.
 *
 * Fallback: привязка НЕ найдена — строка считается актуальной (цель не
 * разрешилась; скрытие теряло бы запись, уточнение итерации 8 аудита).
 */
export function recordRowActive(hit: RecordHit): boolean {
  const owner = hit.targets.find((target) =>
    target.kind === 'thought'
      ? hit.owner_type === 'thought' && target.thought.id === hit.owner_id
      : hit.owner_type === 'link' && target.link.id === hit.owner_id,
  );
  if (owner === undefined) return true;
  return owner.kind === 'thought' ? owner.thought.active : owner.link.active;
}

/** Строки-записи группы, видимые по настройкам вкладки (порядок сервера). */
export function visibleRecordRows(hits: readonly RecordHit[], showInactive: boolean): RecordHit[] {
  return hits.filter((hit) => recordRowActive(hit) || showInactive);
}

/**
 * Собирает подблок строк-записей группы: общие строки `lib/record-row.ts` с
 * видами `.mention-item` (строка списка вкладки), потолком и подписью.
 */
export function mountRecordRowsBlock(options: RecordRowsBlockOptions): RecordRowsBlock {
  const root = div('mentions-records');
  const visible = visibleRecordRows(options.hits, options.showInactive);
  const plan = planRecordCap(visible);
  const handles: RecordRowHandle[] = [];

  for (const hit of plan.shown) {
    const model = recordRowFromRecordHit(hit);
    const row = createRecordRow(model, {
      networkId: options.networkId,
      // Чипы привязок — тот же общий предикат и те же настройки клиента, что в
      // поиске (HOME скрыт, K4 для корзины).
      visibility: {
        homeId: options.homeId,
        showInactive: options.showInactive,
        showTrash: options.showTrash,
      },
      onOpen: options.onOpen,
    });
    // Вид строки списка вкладки: отступы, разделитель, наведение и `.dim` —
    // правила `.mention-item` (раскладку самой строки даёт `.record-row`).
    row.el.classList.add('mention-item');
    // Неактивная первичная привязка при включённой настройке — приглушаем, как
    // владельческие строки вкладки.
    if (!recordRowActive(hit)) row.el.classList.add('dim');
    handles.push(row);
    root.append(row.el);
  }

  if (plan.caption !== null) {
    // Вид подписи — как у среза группы «Публикации» (визуальный паттерн
    // `publications.mentions.more`): тот же `p.muted`, своего класса нет.
    root.append(el('p', 'muted', plan.caption));
  }

  return {
    el: root,
    visibleCount: visible.length,
    total: plan.total,
    destroy(): void {
      for (const handle of handles) handle.destroy();
      handles.length = 0;
      root.replaceChildren();
    },
  };
}

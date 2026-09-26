/**
 * Keyset-пагинация списка результатов экрана «Структуры» (требование
 * 3f2fdc41, ADR 5f6cb775).
 *
 * Первая страница нового отбора читается с `offset: 0` и без курсора; каждая
 * следующая — по `next_cursor` из предыдущего ответа. `offset` не растёт:
 * продолжение адресуется ключом сортировки (`ORDER BY` + `id`), а не пропуском
 * строк, поэтому глубокие страницы не деградируют.
 *
 * Вынесено из `structures.ts` отдельным чистым модулем: тот импортирует весь
 * DOM-слой экрана и в node:test не поднимается, а правило «продолжение — по
 * курсору, offset всегда 0» обязано проверяться прогоном.
 */

/** Адрес одного запроса страницы списка. */
export interface StructuresPageAddress {
  /** Всегда 0: продолжение задаёт курсор, а не пропуск строк. */
  offset: number;
  /** Курсор продолжения; у первой страницы отсутствует. */
  cursor?: string;
}

/**
 * Состояние листания одного списка: хранит `next_cursor` последнего ответа.
 * `reset()` начинает новую первую страницу (смена фильтра/сортировки),
 * `accept()` запоминает курсор из ответа, `hasMore` управляет кнопкой
 * «Показать ещё», `address()` собирает адрес следующего запроса.
 */
export class StructuresPager {
  private nextCursor: string | null = null;

  /** Начать новую первую страницу — прежний курсор отбрасывается. */
  reset(): void {
    this.nextCursor = null;
  }

  /** Запомнить `next_cursor` ответа (`null`/`undefined` — страниц больше нет). */
  accept(nextCursor: string | null | undefined): void {
    this.nextCursor = nextCursor ?? null;
  }

  /** Есть ли следующая страница (условие показа «Показать ещё»). */
  get hasMore(): boolean {
    return this.nextCursor !== null;
  }

  /**
   * Адрес следующего запроса. `reset` — свежая первая страница без курсора;
   * иначе продолжение читается по курсору, а `offset` остаётся нулевым.
   */
  address(reset: boolean): StructuresPageAddress {
    if (reset || this.nextCursor === null) return { offset: 0 };
    return { offset: 0, cursor: this.nextCursor };
  }
}

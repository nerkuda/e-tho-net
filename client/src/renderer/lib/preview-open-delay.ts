/**
 * Единая задержка открытия Ctrl+предпросмотров (ошибка 34e61b47).
 *
 * **Зачем отдельный модуль.** Ctrl+наведение обслуживают два независимых
 * механизма: движок попапов `lib/hover-preview.ts` и «лупа»
 * `lib/image-zoom.ts`. До этой правки у движка была своя задержка 200 мс, а
 * лупа показывалась вообще мгновенно — пользователь не успевал сделать
 * Ctrl+click по тому же элементу: попап открывался раньше нажатия и накрывал
 * триггер. Теперь значение ОДНО и общее: оба модуля импортируют
 * {@link CTRL_PREVIEW_OPEN_DELAY_MS} и планируют показ через
 * {@link createDelayedOpen}, а второго числа-задержки открытия для этих путей
 * в коде нет (за этим следит сторож `guard-ctrl-preview-open-delay.test.ts`).
 *
 * **Почему 500 мс.** 200 мс попадали внутрь промежутка «курсор прибыл с Ctrl →
 * осознанное нажатие кнопки»: попап успевал открыться и перехватить Ctrl+click.
 * 500 мс — вдвое с лишним больше этого окна (осознанный Ctrl+click укладывается
 * заметно быстрее), при этом предпросмотр остаётся отзывчивым. Значение — один
 * knob, подстраивается только здесь.
 *
 * **Направление зависимостей.** Модуль нейтральный: трогает лишь таймеры, не
 * DOM и не экраны. Его импорт не создаёт цикла — `hover-preview.ts` и
 * `image-zoom.ts` тянут его, обратных рёбер нет.
 */

/**
 * Пауза перед показом предпросмотра, открытого Ctrl+наведением, мс. Единая для
 * движка попапов (`hover-preview.ts`) и «лупы» (`image-zoom.ts`).
 */
export const CTRL_PREVIEW_OPEN_DELAY_MS = 500;

/** Пара «запустить отложенный показ» / «отменить, пока не сработал». */
export interface DelayedOpen<Subject> {
  /**
   * Запланировать показ `subject` по истечении {@link CTRL_PREVIEW_OPEN_DELAY_MS}.
   * Повторный вызов для ТОГО ЖЕ субъекта — no-op (не перезапускает таймер),
   * для другого — заменяет прежний (отменяет его таймер).
   */
  schedule(subject: Subject): void;
  /** Отменить ещё не сработавший показ. Уже показанное не трогает. */
  cancel(): void;
  /** Субъект, ожидающий показа, либо `null` — для тестов и диагностики. */
  readonly pending: Subject | null;
}

/**
 * Планировщик отложенного показа с общей задержкой. Таймер — `window.setTimeout`
 * (рендерер), как у соседних модулей (`realtime-batch.ts`); `window` читается в
 * момент вызова, поэтому импорт модуля не имеет побочных эффектов.
 */
export function createDelayedOpen<Subject>(
  onOpen: (subject: Subject) => void,
): DelayedOpen<Subject> {
  let pending: Subject | null = null;
  let timer: number | null = null;

  const cancel = (): void => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    pending = null;
  };

  return {
    schedule(subject) {
      if (timer !== null && pending === subject) return; // уже запланирован
      cancel();
      pending = subject;
      timer = window.setTimeout(() => {
        timer = null;
        const target = pending;
        pending = null;
        if (target !== null) onOpen(target);
      }, CTRL_PREVIEW_OPEN_DELAY_MS);
    },
    cancel,
    get pending() {
      return pending;
    },
  };
}

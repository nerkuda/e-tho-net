/**
 * Модификаторные варианты сочетания для привязок `lib/keymap.ts`.
 *
 * Прежние локальные обработчики полей срабатывали на `event.key === '<клавиша>'`
 * независимо от модификаторов (задача fd3d84f4, блокер приёмки: после перевода
 * полей на диспетчер сочетаний модификаторные Enter перестали срабатывать).
 * Диспетчер сопоставляет НАБОР модификаторов точно (см. `chordCandidates` в
 * `lib/keymap.ts`), поэтому модификатор-независимое нажатие выражается набором
 * привязок — по одной на каждое подмножество модификаторов. Механизм диспетчера
 * при этом не меняется (ADR b420b08c).
 *
 * Например, `modifierChordVariants('Enter')` даёт `Enter`, `Ctrl+Enter`,
 * `Alt+Enter`, `Shift+Enter`, `Meta+Enter` и все их сочетания.
 */

/** Модификаторы, различаемые диспетчером; порядок — канонический. */
export const KEY_MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;

export type KeyModifier = (typeof KEY_MODIFIERS)[number];

/**
 * Все сочетания «набор модификаторов + `key`» для подмножеств `modifiers`.
 * Первым идёт само `key` без модификаторов — оно и становится сочетанием по
 * умолчанию для команды (`effectiveChord` берёт первую привязку).
 */
export function modifierChordVariants(
  key: string,
  modifiers: readonly KeyModifier[] = KEY_MODIFIERS,
): string[] {
  const active = KEY_MODIFIERS.filter((modifier) => modifiers.includes(modifier));
  const chords: string[] = [];
  for (let mask = 0; mask < 1 << active.length; mask += 1) {
    const pressed = active.filter((_, index) => (mask & (1 << index)) !== 0);
    chords.push(pressed.length === 0 ? key : `${pressed.join('+')}+${key}`);
  }
  return chords;
}

/**
 * Доразбор CodeMirror 6 без `EditorView` — модель parse-worker'а (ошибка
 * `8c890ee7`).
 *
 * **Зачем.** Начальный разбор `LanguageState.init` обрезан по вьюпорту
 * ({@link MAX_HEADLESS_PARSE_LENGTH} символов, `Work.InitViewport`). В живом
 * редакторе документ доразбирает `parseWorker` (ViewPlugin) и диспатчит
 * результат транзакцией `{ effects: Language.setState.of(...) }` — без
 * `docChanged` и без `selection`. В headless-тесте view нет, поэтому такую
 * транзакцию приходится строить вручную: `ensureSyntaxTree` доводит разбор
 * (он работает на состоянии — так же поступает библиотечный `forceParsing`),
 * а затем собирается ровно та транзакция, которую диспатчит воркер.
 *
 * **Почему helper, а не тест.** Обрезка дерева на документе длиннее вьюпорта —
 * не гонка, а дизайн, поэтому `createParsedState` (`tests/editor-parse.ts`) на
 * таком документе обязан падать. Осознанное создание обрезанного состояния
 * изолировано здесь: сторож `guard-editor-parse-complete.test.ts` сканирует
 * только `*.test.ts`, и «сырое» `EditorState.create(` в тест не протекает.
 */

import { Language, ensureSyntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import {
  EditorState,
  type Extension,
  type StateEffectType,
  type StateField,
} from '@codemirror/state';

import { MAX_HEADLESS_PARSE_LENGTH } from './editor-parse.js';

/**
 * Внутренние члены `LanguageState`: в `.d.ts` не объявлены, но в рантайме это
 * обычный класс с полями `tree`/`context` (см. `@codemirror/language/dist`).
 */
interface LanguageStateLike {
  readonly tree: unknown;
  readonly context: { readonly tree: unknown };
}

/**
 * Внутренние статические члены класса `Language`: `state` (StateField дерева) и
 * `setState` (эффект доразбора) в типах библиотеки не объявлены — их
 * использует только `parseWorker` внутри `@codemirror/language`.
 */
const languageRuntime = Language as unknown as {
  state: StateField<LanguageStateLike>;
  setState: StateEffectType<LanguageStateLike>;
};

/**
 * Сколько миллисекунд разрешено потратить на доразбор тестового документа.
 * Документ теста — единицы тысяч символов, разбор занимает микросекунды;
 * запас нужен только чтобы не зависеть от вытеснения процесса.
 */
const PARSE_TIMEOUT_MS = 5000;

/**
 * Создаёт состояние документа ДЛИННЕЕ вьюпорта начального разбора. Дерево
 * такого состояния обрезано всегда: `LanguageState.init` останавливает разбор
 * на `Work.InitViewport`, поэтому полнота проверяется, а не предполагается.
 */
export function createTruncatedDocumentState(doc: string, extensions: Extension[]): EditorState {
  if (doc.length <= MAX_HEADLESS_PARSE_LENGTH) {
    throw new Error(
      `Модель доразбора: документ (${doc.length} символов) короче вьюпорта ` +
        `${MAX_HEADLESS_PARSE_LENGTH} — начальный разбор не обрезан, тест ничего не проверит.`,
    );
  }
  const state = EditorState.create({ doc, extensions });
  if (syntaxTreeAvailable(state, state.doc.length)) {
    throw new Error(
      'Модель доразбора: дерево длинного документа оказалось полным — ' +
        'обрезка по вьюпорту перестала работать (@codemirror/language обновлён?).',
    );
  }
  return state;
}

/**
 * Применяет транзакцию parse-worker'а к обрезанному состоянию: доводит разбор
 * до конца документа и диспатчит `Language.setState` БЕЗ правки и выделения.
 * Возвращённое состояние — ровно то, что увидели бы поля редактора после
 * доразбора.
 */
export function dispatchBackgroundParse(state: EditorState): EditorState {
  if (syntaxTreeAvailable(state, state.doc.length)) return state;
  const field = state.field(languageRuntime.state);
  const tree = ensureSyntaxTree(state, state.doc.length, PARSE_TIMEOUT_MS);
  if (tree === null || !syntaxTreeAvailable(state, state.doc.length)) {
    throw new Error(
      'Модель доразбора: разбор не доведён до конца документа за ' +
        `${PARSE_TIMEOUT_MS} мс — тест прочитал бы обрезанное дерево.`,
    );
  }
  // parseWorker после `takeTree()` делает
  // `new LanguageState(field.context)` и диспатчит эффект. Конструктор не
  // экспортирован типами, но доступен у значения поля.
  const LanguageStateCtor = (
    field as unknown as {
      constructor: new (context: LanguageStateLike['context']) => LanguageStateLike;
    }
  ).constructor;
  const parsed = new LanguageStateCtor(field.context);
  return state.update({ effects: languageRuntime.setState.of(parsed) }).state;
}

/**
 * Сторож контракта автодополнения wiki-ссылок (ошибка
 * 6bba224b-9899-4f7e-a37c-ff2067ac0a6c, ветка releases/0.12.1).
 *
 * `wikiLinkCompletions` (`client/src/renderer/editor/wiki-link.ts`) не должен
 * возвращать `validFor`. Пока результат нёс широкий `validFor: WIKI_PREFIX_RE`
 * (шаблон совпадает с любым продолжением префикса), CodeMirror по семантике
 * `ActiveResult.updateFor`/`checkValid` НЕ перезапрашивал источник при наборе
 * — уже полученные `limit: 20` результатов лишь фильтровались локально. Из-за
 * этого `[[новиков`/`[[мои школы` не находили мысль, если при односимвольном
 * префиксе она не попала в первые 20 (а `[[справочники` находил).
 *
 * Кэш по префиксу на 10 с внутри источника сохраняется — он и обеспечивает
 * дешёвый повторный запрос на каждый новый символ. Поэтому `validFor` в этом
 * источнике запрещён как свойство возвращаемого результата; комментарии,
 * объясняющие запрет, сторожем не считаются нарушением (регулярка ищет
 * свойство строки объекта: ведущие пробелы, `validFor`, двоеточие).
 *
 * Реальный тест перезапросности без DOM невозможен (`CompletionSource`
 * требует EditorView/CompletionContext), поэтому контракт зафиксирован
 * сторожем исходника — это осознанное решение (см. отчёт по ошибке).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { assertGuardClean, type GuardRule } from './guard-helpers.js';

const RENDERER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'renderer',
);

const WIKI_LINK = 'editor/wiki-link.ts';

const RULES: GuardRule[] = [
  {
    name: 'no-wiki-link-validfor',
    description:
      'результат автодополнения wiki-ссылки не должен нести `validFor` — иначе CM6 ' +
      'перестаёт перезапрашивать сервер по мере роста префикса (ошибка 6bba224b)',
    pattern: /^\s*validFor\s*:/,
    include: (rel) => rel === WIKI_LINK,
  },
];

describe('guard: wiki-link autocomplete contract', () => {
  it('wikiLinkCompletions does not return validFor', () => {
    assertGuardClean(RENDERER_ROOT, RULES);
  });
});

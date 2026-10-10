/**
 * Сторож единого markdown-рендерера и новых конструкций (требование 673fa25f,
 * задача ff1fa07c, ТП1 «Команды редактирования комментария»).
 *
 * Правило. Markdown разбирается и рендерится ТОЛЬКО единым рендерером
 * `@etn/markdown` (карточка компонента ee5d1067: «Менять рендеринг — только
 * здесь»). И сервер (кеш `body_html`, HTML-экспорт), и клиент (live-preview,
 * просмотр) обязаны получать HTML через `renderMarkdown` / публикационные
 * функции пакета. Новые конструкции ТП1 — task-списки (`- [ ]` / `- [x]`),
 * выделение `==…==`, подчёркивание `<u>…</u>`, скрытие HTML-комментариев
 * (`<!-- … -->`) — не заводят собственных парсеров и рендеров вне пакета.
 *
 * Сторож краснеет на:
 *   1. **втором markdown-парсере** — импорт альтернативного пакета
 *      (`marked`, `showdown`, `micromark`, `remark`, `commonmark`, …);
 *   2. **собственном `markdown-it` вне `markdown/`** — импорт/`require` пакета
 *      в клиенте, сервере или `shared`;
 *   3. **собственном рендере новых конструкций вне пакета** — HTML-подписи
 *      единого рендерера (`contains-task-list`, `task-list-item-checkbox`) и
 *      рукописные `replace`-преобразования `==…==`→`<mark>`,
 *      `<u>…</u>`→`<u>`, `<!--…-->`→пусто;
 *   4. **собственной функции-рендерере** (`renderMarkdown`/`parseMarkdown`/
 *      `markdownToHtml`/`mdToHtml`) вне пакета;
 *   5. **собственном разборе/развёртке трансклюзий `![[…]]`** вне пакета —
 *      правило-задел ТП2. Сейчас трансклюзий в коде нет, поэтому проверка
 *      зелёная; когда ТП2 добавит в `@etn/markdown` экспортируемую функцию
 *      развёртки с инжектируемым резолвером, санкционированные вызовы ЭТОЙ
 *      функции в сервере/клиенте нарушением не считаются — расширь `allow`
 *      точечно, а запрет на собственный разбор `![[…]]` сохрани.
 *
 * Поведенческий блок ниже прогоняет через единый рендерер сами новые
 * конструкции — поддержка не должна пропасть молча.
 *
 * Правила покрывают и серверные исходники (`server/src/**`): единый рендерер
 * общий у сервера и клиента, поэтому сторож, живущий в клиентском прогоне,
 * следит и за серверной стороной (по образцу
 * `guard-rest-response-contracts.test.ts`).
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { renderMarkdown } from '@etn/markdown';

import { assertGuardClean, type GuardRule, type GuardScanOptions } from './guard-helpers.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

/** Каталоги исходников, к которым применяются правила. */
const SRC_PREFIXES = ['client/src/', 'server/src/', 'shared/src/', 'markdown/src/'];

/** Файл лежит в исходниках одного из пакетов. */
const inSrc = (rel: string): boolean => SRC_PREFIXES.some((p) => rel.startsWith(p));

/**
 * Файл принадлежит пакету единого рендерера — здесь запрещённые приёмы
 * разрешены: это и есть дом markdown-парсинга и рендеринга.
 */
const inMarkdownPackage = (rel: string): boolean => rel.startsWith('markdown/');

/** Крупные не-исходные каталоги: не читать их содержимое вовсе. */
const SCAN_OPTIONS: GuardScanOptions = {
  exclude: [
    'client/tests',
    'server/tests',
    'markdown/tests',
    'client/scripts',
    'docs',
    '.tmp',
    'tmp',
    '.zcode',
    '.github',
  ],
};

// ---------------------------------------------------------------------------
// Статические запреты: разбор и рендер markdown — только в @etn/markdown
// ---------------------------------------------------------------------------

/** 1. Собственный `markdown-it` вне пакета. */
const RULE_MARKDOWN_IT: GuardRule = {
  name: 'markdown-it-outside-package',
  description:
    'второй markdown-it вне @etn/markdown: markdown парсит только единый рендерер (импорт/require пакета вне markdown/)',
  pattern: /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]markdown-it['"]/,
  include: inSrc,
  allow: (rel) => inMarkdownPackage(rel),
};

/** 2. Альтернативный markdown-парсер — запрещён везде. */
const RULE_ALTERNATE_PARSER: GuardRule = {
  name: 'alternate-markdown-parser',
  description:
    'альтернативный markdown-парсер (marked/showdown/micromark/remark/commonmark/…): markdown разбирает только @etn/markdown',
  pattern:
    /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"](?:marked|markdown|showdown|micromark|commonmark|remark|remark-parse|remark-gfm|snarkdown|tiny-markdown)['"]/,
  include: inSrc,
};

/**
 * 3. Собственный рендер новых конструкций ТП1 вне пакета.
 *
 * HTML-подписи task-списка единого рендерера — классы `contains-task-list` /
 * `task-list-item-checkbox` — вне пакета не встречаются (стили в `.css` —
 * оформление результата, а не рендер, и в исходники не входят).
 */
const RULE_TASK_LIST_HTML: GuardRule = {
  name: 'task-list-html-outside-package',
  description:
    'task-список рендерит только @etn/markdown: классы contains-task-list/task-list-item-checkbox вне markdown/ — свой рендер',
  pattern: /contains-task-list|task-list-item-checkbox/,
  include: inSrc,
  allow: (rel) => inMarkdownPackage(rel),
};

/**
 * Собственные `replace`-преобразования новых конструкций в HTML: пара
 * «регэксп, распознающий синтаксис» + «строка-замена с HTML рендерера».
 * Редактор команд форматирования правит markdown-исходник (`==`, `<u>`,
 * `<!-- -->` как текст) и под эти правила не попадает — он не эмитит HTML.
 */
const RULE_OWN_MARK_RENDER: GuardRule = {
  name: 'own-mark-render-outside-package',
  description:
    'свой рендер `==…==` в <mark> вне @etn/markdown: регэксп с `==` и заменой на <mark>',
  filePattern: /\.replace(?:All)?\s*\(\s*\/[^/\n]*==[^/\n]*\/[a-z]*\s*,\s*['"][^'"]*<mark>/,
  include: inSrc,
  allow: (rel) => inMarkdownPackage(rel),
};

const RULE_OWN_UNDERLINE_RENDER: GuardRule = {
  name: 'own-underline-render-outside-package',
  description:
    'свой рендер `<u>…</u>` вне @etn/markdown: регэксп с <u> и заменой на <u>',
  filePattern: /\.replace(?:All)?\(\s*\/[^\n]*<u>[^\n]*<u>/,
  include: inSrc,
  allow: (rel) => inMarkdownPackage(rel),
};

const RULE_OWN_COMMENT_STRIP: GuardRule = {
  name: 'own-html-comment-strip-outside-package',
  description:
    'своё скрытие HTML-комментариев вне @etn/markdown: регэксп с `<!--` и заменой в пустую строку',
  filePattern: /\.replace(?:All)?\s*\(\s*\/[^/\n]*<!--[^/\n]*\/[a-z]*\s*,\s*['"]['"]/,
  include: inSrc,
  allow: (rel) => inMarkdownPackage(rel),
};

/** 4. Собственная функция-рендерер markdown вне пакета. */
const RULE_OWN_RENDER_FUNCTION: GuardRule = {
  name: 'own-render-function-outside-package',
  description:
    'собственная функция-рендерер markdown (renderMarkdown/parseMarkdown/markdownToHtml/mdToHtml) вне @etn/markdown',
  pattern:
    /(?:function\s+(?:renderMarkdown|parseMarkdown|markdownToHtml|mdToHtml)\b|(?:const|let|var)\s+(?:renderMarkdown|parseMarkdown|markdownToHtml|mdToHtml)\s*[=:])/,
  include: inSrc,
  allow: (rel) => inMarkdownPackage(rel) || delegatesToPackageRenderer(rel),
};

/** Кэш «файл тянет HTML через рендерер пакета» — для правила 4. */
const delegationCache = new Map<string, boolean>();

/**
 * Тонкая обёртка над единым рендерером — НЕ собственный рендерер: файл
 * импортирует из `@etn/markdown` и вызывает экспортируемую функцию рендера
 * (например `export-service.markdownToHtml` оборачивает `renderMarkdown` в
 * HTML-страницу экспорта). Такие обёртки правилом 4 не краснятся; всё, что
 * не делегирует в пакет, — краснится.
 */
function delegatesToPackageRenderer(rel: string): boolean {
  const cached = delegationCache.get(rel);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    const content = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    ok =
      /from\s+['"]@etn\/markdown['"]/.test(content) &&
      /\b(?:renderMarkdown|renderPublicationFragment|renderPublicationMarkdownFragment)\b/.test(
        content,
      );
  } catch {
    ok = false;
  }
  delegationCache.set(rel, ok);
  return ok;
}

/**
 * 5. Разбор/развёртка трансклюзий `![[…]]` вне пакета (задел ТП2).
 * Сейчас трансклюзий нет — проверка зелёная; см. шапку файла о точке
 * расширения при появлении экспортируемой функции развёртки.
 */
const RULE_OWN_TRANSCLUSION: GuardRule = {
  name: 'own-transclusion-outside-package',
  description:
    'разбор/развёртка трансклюзий `![[…]]` — только в @etn/markdown (задел ТП2)',
  pattern: /(?<![?\w])!\\?\[\\?\[/,
  include: inSrc,
  allow: (rel) => inMarkdownPackage(rel),
};

describe('сторож: единый markdown-рендерер (673fa25f, ff1fa07c)', () => {
  it('второй markdown-it подключён только внутри @etn/markdown', () => {
    assertGuardClean(REPO_ROOT, [RULE_MARKDOWN_IT], SCAN_OPTIONS);
  });

  it('альтернативный markdown-парсер не подключён нигде', () => {
    assertGuardClean(REPO_ROOT, [RULE_ALTERNATE_PARSER], SCAN_OPTIONS);
  });

  it('новые конструкции рендерит только @etn/markdown (нет своего HTML и своей функции)', () => {
    assertGuardClean(
      REPO_ROOT,
      [
        RULE_TASK_LIST_HTML,
        RULE_OWN_MARK_RENDER,
        RULE_OWN_UNDERLINE_RENDER,
        RULE_OWN_COMMENT_STRIP,
        RULE_OWN_RENDER_FUNCTION,
      ],
      SCAN_OPTIONS,
    );
  });

  it('разбор/развёртка трансклюзий `![[…]]` — только в @etn/markdown', () => {
    assertGuardClean(REPO_ROOT, [RULE_OWN_TRANSCLUSION], SCAN_OPTIONS);
  });
});

// ---------------------------------------------------------------------------
// Поведенческая проверка: новые конструкции обслуживает единый рендерер
// ---------------------------------------------------------------------------

describe('сторож: единый рендерер покрывает новые конструкции ТП1', () => {
  it('task-списки `- [ ]` / `- [x]` — классы и чекбокс', () => {
    const html = renderMarkdown('- [ ] снятый\n- [x] отмеченный');
    assert.match(html, /class="contains-task-list"/, 'список задач получает класс contains-task-list');
    assert.match(html, /class="task-list-item"/, 'пункт задачи получает класс task-list-item');
    assert.ok(
      html.includes('class="task-list-item-checkbox" type="checkbox" disabled'),
      'снятый чекбокс отрисовывается рендерером',
    );
    assert.ok(html.includes('checked>'), 'отмеченный чекбокс отрисовывается рендерером');
  });

  it('выделение `==…==` рендерится как <mark>, подчёркивание `<u>` — как <u>', () => {
    assert.match(renderMarkdown('==выделение=='), /<mark>выделение<\/mark>/);
    assert.match(renderMarkdown('<u>подчёркнутый</u>'), /<u>подчёркнутый<\/u>/);
  });

  it('HTML-комментарии `<!-- … -->` скрыты в выводе рендерера', () => {
    const html = renderMarkdown('до <!-- скрыть --> после');
    assert.ok(!html.includes('<!--'), 'комментарий не должен попадать в HTML');
    assert.ok(html.includes('до') && html.includes('после'), 'окружающий текст сохраняется');
  });
});

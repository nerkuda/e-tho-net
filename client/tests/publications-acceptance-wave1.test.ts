/**
 * Замечания визуальной приёмки 0.11.1, волна 1 (задача 5de0332d): публикации и
 * рендер комментария — якоря реализации по каждому из 8 пунктов.
 *
 * Живые DOM-пробы каждого пункта снимаются на стенде (инструкция в карточке
 * 9eddf9c0) и фиксируются в хроно-отчёте задачи; здесь — дешёвые и устойчивые
 * проверки исходников, чтобы пункт нельзя было молча откатить. Поведенческие
 * части, вынесенные в чистые функции (рендерер markdown — п.3), покрыты
 * отдельными юнит-тестами в `@etn/markdown`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');
const REPO_ROOT = path.resolve(CLIENT_ROOT, '..');

function read(rel: string): string {
  return fs.readFileSync(path.join(RENDERER_ROOT, rel), 'utf8');
}

/** Тело функции от заголовка до закрывающей скобки баланса. */
function functionBody(source: string, header: string): string {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `в исходнике нет «${header}»`);
  const open = source.indexOf('{', start);
  assert.notEqual(open, -1, `у «${header}» нет тела`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start);
}

const WS = read('screens/publications/workspace.ts');
const PUBL = read('screens/publications/publications.ts');
const CARD = read('editor/publication-card.ts');
const EDITOR = read('editor/editor.ts');
const CSS = fs.readFileSync(
  path.join(RENDERER_ROOT, 'styles', 'screens', 'publications.css'),
  'utf8',
);
const RENDERER = fs.readFileSync(path.join(REPO_ROOT, 'markdown', 'src', 'renderer.ts'), 'utf8');
const MD_INDEX = fs.readFileSync(path.join(REPO_ROOT, 'markdown', 'src', 'index.ts'), 'utf8');

describe('5de0332d п.1: оглавление назначает раздел текущим (блокировка scroll-sync)', () => {
  it('scrollToAnchor взводит блокировку ДО изменения scrollTop', () => {
    const body = functionBody(WS, 'function scrollToAnchor(');
    const lockAt = body.indexOf('lockScrollSync()');
    const scrollAt = body.indexOf('docHost.scrollTop');
    assert.ok(lockAt >= 0, 'есть взвод блокировки');
    assert.ok(scrollAt >= 0 && lockAt < scrollAt, 'блокировка до изменения scrollTop');
  });

  it('событие прокрутки под блокировкой не пересчитывает current', () => {
    const body = functionBody(WS, 'const onDocScroll');
    assert.ok(body.includes('scrollSyncLocked'), 'onDocScroll учитывает блокировку');
    const guard = body.indexOf('if (scrollSyncLocked)');
    const update = body.indexOf('updateCurrentSection()');
    assert.ok(guard >= 0 && update > guard, 'updateCurrentSection только вне блокировки');
  });
});

describe('5de0332d п.2: dblclick открывает комментарий и при карточке публикации', () => {
  it('вход в карточку публикации гасит кэш отрисованной сущности и renderCtx', () => {
    const pubBranch = functionBody(EDITOR, 'if (pubTarget !== null && pubTarget.kind === ');
    assert.ok(pubBranch.includes('liveRenderedKey = null'), 'гасится гейт store-подписки');
    assert.ok(pubBranch.includes('renderCtx = null'), 'гасится контекст последней отрисовки');
  });

  it('путь пользователя: текст документа зовёт openThoughtCommentEditor', () => {
    assert.match(WS, /openThoughtCommentEditor\(block\.thoughtId/);
    assert.match(
      WS,
      /closest\('p, li, blockquote, h1, h2, h3, h4, h5, h6'\)/,
      'берётся кликнутый абзац для поиска позиции',
    );
  });
});

describe('5de0332d п.3: рендерер markdown — одиночный перенос = разрыв', () => {
  it('единый рендерер включён в режиме breaks: true', () => {
    assert.match(RENDERER, /breaks:\s*true/, 'одиночный \\n даёт <br> как в редакторе');
  });

  it('версия конвейера поднята — кеш body_html перерисуется', () => {
    assert.match(MD_INDEX, /MD_RENDER_VERSION = 'markdown-it\/7'/, 'версия рендера поднята');
  });
});

describe('5de0332d п.4: заголовки документа выровнены, уровни — шрифтом', () => {
  it('у каждого заголовка есть жёлоб каретки (плейсхолдер у листовых разделов)', () => {
    const build = functionBody(WS, 'function buildBlock(');
    assert.ok(build.includes('pub-doc-caret-empty'), 'плейсхолдер каретки у раздела без содержимого');
  });

  it('грип и каретка абсолютны, текст — с постоянным отступом', () => {
    const heading = functionBody(CSS, '.pub-doc-heading {');
    assert.match(heading, /position:\s*relative/, 'заголовок — якорь жёлоба');
    assert.match(heading, /padding-left:\s*calc\(/, 'постоянный жёлоб, не зависящий от каретки');
    assert.match(CSS, /\.pub-doc-heading > \.pub-doc-caret\s*\{[^}]*position:\s*absolute/s, 'каретка вне потока');
  });
});

describe('5de0332d п.5: Ctrl+Shift+↑/↓ сдвигает блок документа', () => {
  it('есть модификаторный хоткей и он вызывает moveBlock', () => {
    const body = functionBody(WS, 'const onDocKeydown');
    assert.ok(body.includes('ev.ctrlKey') && body.includes('ev.shiftKey'), 'только Ctrl+Shift');
    assert.ok(body.includes("'ArrowUp'") && body.includes("'ArrowDown'"), 'стрелки вверх/вниз');
    assert.ok(body.includes('moveBlock('), 'сдвиг общим механизмом');
  });

  it('слушатель в фазе перехвата — не уступает навигации списка', () => {
    assert.match(
      WS,
      /docHost\.addEventListener\('keydown', onDocKeydown, \{ capture: true \}\)/,
      'capture-фаза перехватывает стрелки до nav-core',
    );
  });
});

describe('5de0332d п.6: титульный лист', () => {
  it('заголовок в 2 раза крупнее и по центру', () => {
    assert.match(
      CSS,
      /\.pub-doc\.comment-view \.pub-doc-title\s*\{[^}]*font-size:\s*calc\(var\(--font-size-3xl\) \* 2\)[^}]*text-align:\s*center/s,
      'название ×2 и по центру',
    );
  });

  it('подзаголовок в 2 раза крупнее, на 3 строки ниже, по правому краю', () => {
    assert.match(
      CSS,
      /\.pub-doc\.comment-view \.pub-doc-subtitle\s*\{[^}]*font-size:\s*calc\(var\(--font-size-l\) \* 2\)[^}]*text-align:\s*right[^}]*margin-top:\s*calc\(3 /s,
      'подзаголовок ×2, вправо, на 3 строки ниже',
    );
  });
});

describe('5de0332d п.7: переключение публикаций без пересоздания узла карточки', () => {
  it('переадресация переиспользует корень и не добавляет новый узел в панель', () => {
    const body = functionBody(CARD, 'function retargetPublicationCard(');
    assert.ok(body.includes('instance?.root'), 'берётся тот же корень карточки');
    assert.ok(body.includes('root.append(fresh.firstChild'), 'содержимое перестраивается ВНУТРИ корня');
    assert.ok(!body.includes('scrollBox.append'), 'новый узел в панель не добавляется');
  });

  it('showPublicationTarget при смене id идёт в переадресацию', () => {
    const body = functionBody(CARD, 'export function showPublicationTarget(');
    assert.ok(body.includes('retargetPublicationCard(publicationId)'), 'смена id — переадресация');
  });

  it('редактор очищает хост только при входе в карточку, не при переключении', () => {
    assert.match(EDITOR, /const entering = lastPublicationSignature === ''/, 'вход отличается от переключения');
    assert.match(EDITOR, /if \(entering\) emptyChildren\(scrollBox\)/, 'emptyChildren только при входе');
  });
});

describe('5de0332d п.8: фильтр по конкретной полке — плоский вид без остальных полок', () => {
  it('вид «полки»: фильтр рисует один плоский блок', () => {
    const body = functionBody(PUBL, 'function renderShelves(');
    assert.ok(body.includes('viewState.shelfFilter !== null'), 'учтён фильтр полки');
    assert.ok(body.includes('flat: true'), 'плоский блок без группировки');
  });

  it('вид «список»: фильтр тоже рисует один плоский блок', () => {
    const body = functionBody(PUBL, 'function renderList(');
    assert.ok(body.includes('viewState.shelfFilter !== null'), 'учтён фильтр полки');
    assert.ok(body.includes('flat: true'), 'плоский блок без группировки');
  });

  it('плоский блок не рисует шапку-название и пустое состояние', () => {
    const shelf = functionBody(PUBL, 'function buildShelfBlock(');
    const flatAt = shelf.indexOf('block.flat === true');
    const headAt = shelf.indexOf('buildGroupHead(');
    assert.ok(flatAt >= 0 && headAt > flatAt, 'плоская ветка возвращает узел до построения шапки');
    const list = functionBody(PUBL, 'function buildListGroup(');
    const listFlatAt = list.indexOf('group.flat === true');
    const listHeadAt = list.indexOf('buildGroupHead(');
    assert.ok(listFlatAt >= 0 && listHeadAt > listFlatAt, 'плоский список — без шапки');
  });
});

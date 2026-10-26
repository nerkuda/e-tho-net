/**
 * Сторож обнаружимости действий (задача e45ca252, стандарт 1b5f6200 «Функция
 * не живёт только на hover и только на хоткее», стандарт «Правило без
 * теста-сторожа не считается введённым»).
 *
 * Правило: у функции интерфейса есть видимая точка входа — она не достигается
 * ТОЛЬКО наведением мыши и не живёт ТОЛЬКО на горячей клавише. Сторож ловит три
 * машинно-проверяемых нарушения:
 *
 * 1. **Hover-only показ действия (CSS).** Правило `:hover`/`:focus-within`
 *    включает (`display`/`visibility`/`pointer-events`/`opacity`) элемент,
 *    который в покое спрятан, и у него нет парного `:focus`/`:focus-visible`
 *    пути — значит, действие видно только мыши. Ненаведённое покоящееся
 *    `opacity: 0.6` под правило не попадает: спрятанным считается `display:
 *    none`/`visibility: hidden`/`opacity: 0`/`pointer-events: none`.
 * 2. **Hover-only поведение компонента (`lib/ui`).** Компонент словаря не
 *    вешает функцию на `mouseenter`/`mouseover` — это делает её недостижимой
 *    без мыши (тач, клавиатура).
 * 3. **Хоткей без мышиного пути (`lib/ui`).** Модуль словаря, который сам
 *    вешает DOM-слушатели (`addEventListener(`) и обрабатывает горячую клавишу
 *    (`ctrlKey`/`metaKey`), обязан иметь и мышиный путь
 *    (`pointerdown`/`mousedown`/`click`) в том же модуле — горячая клавиша
 *    лишь ускоритель, не единственный путь.
 *
 *    Чистые модули правил (`lib/ui/nav-core.ts` и подобные), которые не вешают
 *    слушателей, а только раскладывают клавишу в действие и считают индекс,
 *    осознанно пропускаются: хоткея в них нет — есть таблица соответствий.
 *    **Граница проверки.** Условие «вешает слушатели» — не лазейка для снятия
 *    `addEventListener`, а граница области: модуль, который перестал вешать
 *    слушатели, выходит из-под проверки молча. Поэтому снятие слушателя из
 *    модуля, который раньше им пользовался, требует ревью: хоткей без
 *    слушателя — либо мёртвый код (удаляй вместе с клавишей), либо переезд
 *    обработки в другой модуль (проверяй новый). Сторож этого не поймает — он
 *    проверяет только модули, которые сами объявляют DOM-слушатели.
 *
 * Карта хоткеев всего клиента (08-ui-spec) — вне словаря и проверяется
 * выборочно при переводе экрана (см. отчёт задачи e45ca252).
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assembledStylesFile } from './renderer-css.js';
import { ShimElement } from './dom-shim.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');
const UI_ROOT = path.join(RENDERER_ROOT, 'lib', 'ui');

/**
 * Нарушения правила «хоткей без мышиного пути» в наборе модулей.
 *
 * Проверяются модули, которые САМИ вешают DOM-слушатели (`addEventListener(`):
 * у них обработка горячей клавиши (`ctrlKey`/`metaKey`) обязана иметь
 * клавиатурно-независимый путь (`pointerdown`/`mousedown`/`click`/`dblclick`).
 * Чистые модули правил (`nav-core.ts` и подобные) осознанно пропускаются —
 * граница области описана в шапке файла. Функция отделена от обхода каталога,
 * чтобы самопроверка могла подать фикстуры без файловой системы.
 */
export function hotkeyOffenders(
  files: ReadonlyArray<{ name: string; source: string }>,
): string[] {
  const offenders: string[] = [];
  for (const { name, source } of files) {
    // Чистое правило без единого DOM-слушателя не может сделать действие
    // «только клавиатурным»: хоткей и мышиный путь ему навешивает фасад.
    if (!/addEventListener\(/.test(source)) continue;
    if (!/(?:ctrlKey|metaKey)/.test(source)) continue;
    const pointerPath = /addEventListener\(\s*['"](?:pointerdown|mousedown|click|dblclick)['"]/.test(source);
    if (!pointerPath) offenders.push(name);
  }
  return offenders;
}

/**
 * DOM/window-шим для поведенческой проверки сборки дерева: сторож проверяет
 * не упоминание конструкции в файле, а объявление, которое реально появляется
 * в реестре `lib/keymap` при вызове `buildFilterTree`.
 */
function installDomShim(): void {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    activeElement: null,
    querySelector: () => null,
  };
  const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
  win['innerWidth'] = 1200;
  win['innerHeight'] = 800;
  win['setTimeout'] = () => 1;
  win['clearTimeout'] = () => undefined;
  win['addEventListener'] = () => undefined;
  win['removeEventListener'] = () => undefined;
  win['matchMedia'] = () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */
}
/** Покоящееся «спрятано» — элемент недоступен мыши и клавиатуре. */
const HIDDEN =
  /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\D|$)|pointer-events\s*:\s*none)/;

/** Включение на наведении — действие появляется. */
const REVEAL =
  /(?:^|;)\s*(?:display\s*:\s*(?!none)|visibility\s*:\s*visible|pointer-events\s*:\s*auto|opacity\s*:\s*1(?:\D|$))/;

interface CssBlock {
  selector: string;
  body: string;
}

/** Блоки `селектор { … }` без комментариев. */
function cssBlocks(css: string): CssBlock[] {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...code.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1]!.trim().replace(/\s+/g, ' '),
    body: m[2]!,
  }));
}

/** Хвост селектора — последний простой селектор (для сопоставления базы и цели). */
function lastToken(selector: string): string {
  const parts = selector.trim().split(/\s+/);
  return parts[parts.length - 1]!;
}

/**
 * Селекторы, включаемые только на `:hover`/`:focus-within`: цель спрятана в
 * покое и не имеет парного `:focus`-пути.
 */
function findHoverOnlyReveals(css: string): string[] {
  const blocks = cssBlocks(css);
  const hiddenTokens = new Set(
    blocks.filter((b) => HIDDEN.test(b.body)).map((b) => lastToken(b.selector.replace(/\[[^\]]*\]/g, ''))),
  );
  const focusRevealed = new Set(
    blocks
      .filter((b) => /:(focus|focus-visible|focus-within)\b/.test(b.selector) && REVEAL.test(b.body))
      .map((b) => lastToken(b.selector)),
  );
  const violations: string[] = [];
  for (const block of blocks) {
    if (!/:hover\b/.test(block.selector)) continue;
    if (!REVEAL.test(block.body)) continue;
    // Цель включения: часть селектора после `:hover` (потомок) либо сам
    // элемент без `:hover`/`:focus-within`.
    const afterHover = block.selector.replace(/^[\s\S]*?:hover\b/, '').trim();
    const target = afterHover === '' || afterHover === block.selector
      ? lastToken(block.selector)
      : lastToken(afterHover.replace(/^[>+~]\s*/, ''));
    if (hiddenTokens.has(target) && !focusRevealed.has(target)) {
      violations.push(block.selector);
    }
  }
  return violations;
}

/**
 * Потребитель кросс-группового фасада `lib/ui/drag-tree.ts`, у которого нет
 * клавиатурного пути, оставляет перенос «только перетаскиванием». Правило
 * машинно проверяет две вещи в том же модуле-потребителе:
 *  - объявлен контекст команд (`defineKeyContext`) — путь через диспетчер
 *    `lib/keymap` (ADR b420b08c);
 *  - у строки есть фокус по умолчанию (`tabIndex = 0`) — иначе команда
 *    недостижима без мыши.
 */
const DRAG_CONSUMER = /\bcreateDragTree\s*\(/;
const KEYBOARD_PATH = /\bdefineKeyContext\s*\(/;
const FOCUS_PATH = /\.tabIndex\s*=\s*0\b/;

/** Рекурсивный сбор `.ts` под каталогом. */
function collectTsFiles(dir: string, base = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base === '' ? entry.name : `${base}/${entry.name}`;
    if (entry.isDirectory()) out.push(...collectTsFiles(path.join(dir, entry.name), rel));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(rel);
  }
  return out;
}

/** Файлы, где перенос доступен только мышью (потребитель drag-tree без клавиатуры). */
function findDragOnlyActions(dir: string): string[] {
  const offenders: string[] = [];
  for (const rel of collectTsFiles(dir)) {
    const raw = fs.readFileSync(path.join(dir, rel), 'utf8');
    // Комментарии не считаются кодом: упоминание конструкции в пояснении не
    // создаёт клавиатурный путь.
    const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    // Сам фасад объявляет `createDragTree`, но не является его потребителем.
    if (/export function createDragTree\s*\(/.test(source)) continue;
    if (!DRAG_CONSUMER.test(source)) continue;
    if (!KEYBOARD_PATH.test(source) || !FOCUS_PATH.test(source)) offenders.push(rel);
  }
  return offenders;
}

describe('guard: обнаружимость действий (e45ca252, стандарт 1b5f6200)', () => {
  it('нет hover-only показа действий в CSS lib/ui и styles.css', () => {
    const files = [
      ...fs.readdirSync(UI_ROOT).filter((f) => f.endsWith('.css')).map((f) => path.join(UI_ROOT, f)),
      assembledStylesFile(),
    ];
    const problems: string[] = [];
    for (const file of files) {
      for (const selector of findHoverOnlyReveals(fs.readFileSync(file, 'utf8'))) {
        problems.push(`  • ${path.relative(RENDERER_ROOT, file).replace(/\\/g, '/')} «${selector}»`);
      }
    }
    if (problems.length > 0) {
      throw new Error(
        `Действия, показываемые только наведением (${problems.length}):\n${problems.join('\n')}\n\n` +
          'У скрытого до hover действия обязан быть парный :focus-visible/:focus путь ' +
          'или видимая точка входа (стандарт 1b5f6200).',
      );
    }
  });

  it('компоненты lib/ui не живут на hover-событиях без мышиного/клавиатурного пути', () => {
    const offenders: string[] = [];
    for (const file of fs.readdirSync(UI_ROOT).filter((f) => f.endsWith('.ts'))) {
      const src = fs.readFileSync(path.join(UI_ROOT, file), 'utf8');
      if (/addEventListener\(\s*['"](?:mouseenter|mouseover)['"]/.test(src)) {
        offenders.push(`  • lib/ui/${file}`);
      }
    }
    if (offenders.length > 0) {
      throw new Error(
        `Компоненты lib/ui на mouseenter/mouseover (${offenders.length}):\n${offenders.join('\n')}\n\n` +
          'Функция компонента не может быть доступна только мышью (стандарт 1b5f6200): ' +
          'нужен pointer/клавиатурный путь.',
      );
    }
  });

  it('хоткей в lib/ui имеет мышиный путь в том же модуле', () => {
    const offenders = hotkeyOffenders(
      fs
        .readdirSync(UI_ROOT)
        .filter((f) => f.endsWith('.ts'))
        .map((file) => ({ name: `lib/ui/${file}`, source: fs.readFileSync(path.join(UI_ROOT, file), 'utf8') })),
    );
    if (offenders.length > 0) {
      throw new Error(
        `Хоткей без мышиного пути (${offenders.length}):\n${offenders.join('\n')}\n\n` +
          'Горячая клавиша — ускоритель, а не единственный путь: у действия в модуле ' +
          'обязан быть pointer/click-путь (стандарт 1b5f6200).',
      );
    }
  });

  it('анализ хоткеев краснеет на модуле-слушателе без мышиного пути', () => {
    // Нарушение: модуль сам вешает слушатель и знает Ctrl, а мышиного пути нет.
    assert.deepEqual(
      hotkeyOffenders([
        {
          name: 'bad.ts',
          source:
            "root.addEventListener('keydown', (e) => { if (e.ctrlKey) go(); });\n",
        },
      ]),
      ['bad.ts'],
      'хоткей без pointer/click-пути обязан распознаваться',
    );
    // Мышиный путь в том же модуле снимает нарушение.
    assert.deepEqual(
      hotkeyOffenders([
        {
          name: 'ok.ts',
          source:
            "root.addEventListener('keydown', (e) => { if (e.ctrlKey) go(); });\n" +
            "root.addEventListener('click', () => go());\n",
        },
      ]),
      [],
    );
    // Граница из шапки: чистый модуль правил слушателей не вешает — вне проверки,
    // хотя литерал `ctrlKey` в нём есть.
    assert.deepEqual(
      hotkeyOffenders([
        { name: 'pure-rules.ts', source: "const actions = { 'Ctrl+ArrowUp': 'collapse' }; e.ctrlKey;\n" },
      ]),
      [],
      'модуль без addEventListener осознанно пропускается (граница в шапке)',
    );
  });

  it('анализ hover-only краснеет на умышленном нарушении', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-discover-'));
    try {
      const file = path.join(dir, 'x.css');
      fs.writeFileSync(
        file,
        '.act { display: none; }\n.row:hover .act { display: block; }\n',
        'utf8',
      );
      const found = findHoverOnlyReveals(fs.readFileSync(file, 'utf8'));
      assert.ok(
        found.some((s) => s.includes('.row:hover .act')),
        'hover-only показ действия обязан распознаваться',
      );
      // Парный focus-путь снимает нарушение.
      fs.writeFileSync(
        file,
        '.act { display: none; }\n.row:hover .act,\n.row:focus-within .act { display: block; }\n',
        'utf8',
      );
      assert.deepEqual(
        findHoverOnlyReveals(fs.readFileSync(file, 'utf8')),
        [],
        'парный focus-путь делает действие доступным без мыши',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('перенос в дереве не остаётся «только перетаскиванием» (31b228f0)', () => {
    assert.deepEqual(
      findDragOnlyActions(RENDERER_ROOT),
      [],
      'потребитель drag-tree обязан иметь клавиатурный путь (defineKeyContext) ' +
        'и фокусируемую строку (tabIndex = 0) — иначе действие доступно только мышью',
    );
  });

  /**
   * Поведенческая проверка того же правила для единственного сегодняшнего
   * потребителя `drag-tree`. Статический поиск `defineKeyContext` в файле давал
   * ложно-зелёный результат: удаление вызова из `buildFilterTree` оставляло
   * сторож зелёным (замечание независимой проверки этапа 2). Поэтому контекст
   * ищется в РЕЕСТРЕ после реальной сборки, а `destroy` обязан его снять.
   */
  it('контекст переноса регистрируется в пути сборки дерева (31b228f0)', async () => {
    installDomShim();
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const keymap = await import('../src/renderer/lib/keymap.js');
    const treeModule = await import('../src/renderer/lib/filter-tree.js');
    keymap.keymapInternals.reset();
    const state = { tree: { kind: 'group', op: 'and', children: [] } } as any;
    const tree = treeModule.buildFilterTree({
      profile: 'thoughts',
      getState: () => state,
      data: { registry: new Map(), linkTypes: [] },
    });
    const ids = keymap.keymapInternals.contextIds();
    assert.ok(
      ids.some((id) => id.startsWith(treeModule.FILTER_TREE_KEY_CONTEXT_ID)),
      `buildFilterTree обязан объявить клавиатурный контекст переноса; реестр: [${ids.join(', ')}]`,
    );
    tree.destroy();
    assert.deepEqual(
      keymap.keymapInternals.contextIds(),
      [],
      'destroy дерева обязан снять его клавиатурные контексты (ui-filter-tree и drag-фасада)',
    );
    /* eslint-enable @typescript-eslint/no-explicit-any */
  });

  it('анализ drag-only краснеет на умышленном нарушении', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-drag-only-'));
    try {
      const file = path.join(dir, 'filter-drag.ts');
      fs.writeFileSync(file, 'createDragTree(root, adapter);\n', 'utf8');
      assert.deepEqual(
        findDragOnlyActions(dir),
        ['filter-drag.ts'],
        'потребитель без клавиатурного пути обязан ловиться',
      );
      // Контекст есть, но строки не фокусируемы — действие всё ещё только мышиное.
      fs.writeFileSync(
        file,
        'createDragTree(root, adapter);\ndefineKeyContext({ id, bindings });\n',
        'utf8',
      );
      assert.deepEqual(findDragOnlyActions(dir), ['filter-drag.ts'], 'нет tabIndex = 0 — нарушение');
      fs.writeFileSync(
        file,
        'createDragTree(root, adapter);\ndefineKeyContext({ id, bindings });\nitem.tabIndex = 0;\n',
        'utf8',
      );
      assert.deepEqual(findDragOnlyActions(dir), [], 'клавиатурный путь снимает нарушение');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

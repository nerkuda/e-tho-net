/**
 * Structural checks for the editor «Свойства»/«Упоминания»/«Граф» tabs
 * (задача 8ab775d9 — недореализованные критерии приёмки, доведены после
 * ревью тех.проекта a94998c6; перепланировка вёрстки 0.8.x — вкладка
 * «Граф» отделена, «Связи» переименована в «Упоминания», мини-граф уехал
 * на собственную вкладку; overflow-меню для не помещающихся вкладок).
 *
 * The DOM-bound code pulls in IPC, realtime and dialog modules — heavy for
 * the unit runner. Like `type-editor-tabs.test.ts`, these tests stay cheap
 * by asserting the structural anchors of the source files:
 *
 *  - «Свойства»: обе группы клампятся сплиттером высоты (rowSplitter +
 *    applyGroupClamp с persistKey `properties.*` — протяжка запоминается);
 *  - «Упоминания»: две плоские группы — «Ссылки на мысль» и «Упоминания в
 *    текстах», парная раскладка клампов и persistKey `links.mentions`;
 *  - «Граф»: мини-граф перенесён сюда из прежней группы «Локальный граф».
 *    Дублирующие «Прямые связи»/«Использование» (содержимое теперь живёт
 *    в свойствах-связях на вкладке «Свойства») удалены вместе со своими
 *    реалтайм-обработчиками;
 *  - overflow-меню редактора: использует обобщённую overflow-логику из
 *    `screens/tabs/tab-overflow.ts` (RecomputeOverflow + buildOverflowButton);
 *    кнопка `▾N` появляется справа от последней видимой вкладки, по клику
 *    открывает фиксированный дропдаун со скрытыми вкладками.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const SRC = {
  properties: resolve(import.meta.dirname, '..', 'src', 'renderer', 'editor', 'properties.ts'),
  links: resolve(import.meta.dirname, '..', 'src', 'renderer', 'editor', 'links-tab.ts'),
  graph: resolve(import.meta.dirname, '..', 'src', 'renderer', 'editor', 'graph-tab.ts'),
  editor: resolve(import.meta.dirname, '..', 'src', 'renderer', 'editor', 'editor.ts'),
  css: resolve(import.meta.dirname, '..', 'src', 'renderer', 'styles.css'),
};

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('вкладка «Свойства» — регулятор высоты (8ab775d9, приёмка №7 + приёмка 0.8.1)', () => {
  it('группы оснащены сплиттером и парной раскладкой с запоминанием высоты', () => {
    const src = readText(SRC.properties);
    // Сплиттер клампит ТЕЛО группы выше себя; раскладка парная
    // (applyTabGroupClamp): кламп действует только когда ОБЕ группы
    // развёрнуты, свёрнутая схлопывается, соседняя растягивается.
    assert.ok(src.includes("persistKey: 'properties.type'"), 'type group splitter key');
    assert.ok(
      src.includes("applyTabGroupClamp(typeGroup, 'properties.type'"),
      'type group paired clamp',
    );
    assert.ok(
      src.includes("applyTabGroupClamp(outsideGroup, 'properties.outside'"),
      'outside group paired clamp',
    );
    assert.ok(
      src.includes("addEventListener('etn:toggled'"),
      'collapse toggles re-run the paired layout',
    );
  });

  it('CSS даёт группам flex-вёрстку с клампом (как .links-tab)', () => {
    const css = readText(SRC.css);
    for (const sel of [
      '.properties-tab > .group:has(> .group-body)',
      '.properties-tab > .group > .group-body',
      '.properties-tab .prop-wrap',
    ]) {
      assert.ok(css.includes(sel), `CSS missing selector ${sel}`);
    }
  });
});

describe('вкладка «Упоминания» — две плоские группы, дубли removed (8ab775d9, приёмка №9 + перепланировка 0.8.x)', () => {
  it('содержит «Ссылки на мысль» и «Упоминания в текстах», но не «Локальный граф»/«Прямые связи»/«Использование»', () => {
    const src = readText(SRC.links);
    assert.ok(src.includes("title: 'Ссылки на мысль'"), 'backlinks group present');
    assert.ok(src.includes("title: 'Упоминания в текстах'"), 'text-mentions group present');
    assert.ok(!src.includes("title: 'Локальный граф'"), 'local graph group moved out');
    assert.ok(!src.includes("title: 'Прямые связи'"), 'direct-links group removed');
    assert.ok(!src.includes("title: 'Использование'"), 'usage group removed');
  });

  it('realtime-хук usage-группы и её persistKey удалены', () => {
    const src = readText(SRC.links);
    assert.ok(!src.includes('wireUsageRealtime'), 'usage realtime hook removed');
    assert.ok(!src.includes("'links.direct'"), 'links.direct persist key removed');
  });

  it('родительской группы «Упоминания» больше нет — обе группы на верхнем уровне', () => {
    // Сплиттер действует на паре плоских групп (не на обёртке).
    const src = readText(SRC.links);
    assert.ok(
      src.includes("applyTabGroupClamp(backlinks, 'links.backlinks'"),
      'backlinks group uses applyTabGroupClamp(links.backlinks)',
    );
    assert.ok(
      src.includes("applyTabGroupClamp(textMentions, 'links.text-mentions'"),
      'textMentions group uses applyTabGroupClamp(links.text-mentions)',
    );
    // persistKey для сплиттера сохраняем — это та же настройка высоты,
    // что была между «Упоминания» и «Локальный граф» раньше.
    assert.ok(
      src.includes("persistKey: 'links.mentions'"),
      'splitter keeps the legacy persistKey for the mentions height',
    );
  });
});

describe('вкладка «Граф» — мини-граф на всю высоту (перепланировка 0.8.x)', () => {
  it('мини-граф регистрируется отдельным модулем и заполняет родителя', () => {
    const graphSrc = readText(SRC.graph);
    assert.ok(graphSrc.includes("registerTabContent('graph'"), 'graph tab content registered');
    assert.ok(graphSrc.includes('fillHeight: true'), 'mini-graph fills the tab');
    // Резолв соседей до полных карточек переехал сюда из links-tab.
    assert.ok(
      /etn\.thoughts\.resolve\(\s*networkId,\s*neighbours\.slice\(0,\s*(?:RESOLVE_BATCH|100)\b/.test(graphSrc),
      'neighbours are batch-resolved in graph-tab',
    );
  });

  it('мини-граф больше не живёт в links-tab.ts', () => {
    const linksSrc = readText(SRC.links);
    assert.ok(!linksSrc.includes('buildLocalGraphBody'), 'no buildLocalGraphBody in links-tab');
    // Комментарии в шапке файла могут упоминать прежнюю группу по имени,
    // проверяем именно реестр заголовков групп.
    assert.ok(
      !/title:\s*'Локальный граф'/.test(linksSrc),
      'no «Локальный граф» group registered in links-tab',
    );
  });

  it('editor.ts содержит вкладку «Граф» между «Хроника» и «Метаданные» и «Упоминания»', () => {
    const editorSrc = readText(SRC.editor);
    assert.ok(editorSrc.includes("title: 'Упоминания'"), '«Упоминания» tab title present');
    assert.ok(editorSrc.includes("title: 'Граф'"), '«Граф» tab title present');
    const chronoIdx = editorSrc.indexOf("title: 'Хроника'");
    const graphIdx = editorSrc.indexOf("title: 'Граф'");
    const metadataIdx = editorSrc.indexOf("title: 'Метаданные'");
    assert.ok(chronoIdx >= 0 && graphIdx >= 0 && metadataIdx >= 0, 'all three titles present');
    assert.ok(chronoIdx < graphIdx && graphIdx < metadataIdx, '«Граф» sits between «Хроника» and «Метаданные»');
  });

  it('CSS даёт мини-графу flex-растяжение при fillHeight', () => {
    const css = readText(SRC.css);
    assert.ok(css.includes('.mini-graph-viewport--fill'), 'fill modifier class exists');
  });
});

describe('overflow-меню вкладок редактора (приёмка 0.8.1: ▾N при нехватке ширины)', () => {
  // Паттерн повторно использует overflow-логику из `screens/tabs/tab-overflow.ts`
  // — она там уже обкатана на вкладках рабочего стола. Здесь мы проверяем
  // структурные якоря в editor.ts: импорт обобщённых функций, константы ширин,
  // кнопка в DOM и ResizeObserver, который пересчитывает раскладку.
  it('editor.ts импортирует обобщённые overflow-функции из screens/tabs', () => {
    const editorSrc = readText(SRC.editor);
    assert.ok(
      /from\s+['"]\.\.\/screens\/tabs\/tab-overflow\.js['"]/.test(editorSrc),
      'editor.ts imports from screens/tabs/tab-overflow.js',
    );
    assert.ok(editorSrc.includes('recomputeOverflow'), 'recomputeOverflow imported');
    assert.ok(editorSrc.includes('buildOverflowButton'), 'buildOverflowButton imported');
    assert.ok(
      editorSrc.includes('StripElements'),
      'StripElements type imported for the strip-elements bundle',
    );
  });

  it('ширины вкладок адаптивные — по заголовку, с нижней границей', () => {
    const editorSrc = readText(SRC.editor);
    // Спецификация «Вкладки и группы редактора»: ширины вкладок редактора
    // считаются по содержимому кнопки (заголовок + счётчик «(N)»), а
    // EDITOR_TAB_MIN_W_PX = 80 — только пол для коротких заголовков.
    // Фиксированной ширины (110 со сжатием до 80) больше нет: в сжатой кнопке
    // «Комментарий» не помещался и вылезал за её пределы.
    assert.match(editorSrc, /EDITOR_TAB_MIN_W_PX\s*=\s*80/);
    assert.ok(
      !/EDITOR_TAB_W_DEFAULT_PX/.test(editorSrc),
      'the fixed default width must be gone — widths are content-sized now',
    );
  });

  it('overflow-кнопка добавляется в tabBar и подписана на recomputeOverflow', () => {
    const editorSrc = readText(SRC.editor);
    // Кнопка по умолчанию скрыта атрибутом `hidden=true`; `recomputeOverflow`
    // сбрасывает его, когда что-то не влезает. Имя класса — только
    // `.tab-overflow` (без `hidden`): общий `.hidden { display: none !important }`
    // в styles.css перебивает `hidden=false` атрибута и кнопка остаётся
    // невидимой (DevTools-пруф: `class="tab-overflow hidden" hidden=""` при
    // `textContent="▾3"`). Регрессионная защита — отдельный тест ниже.
    assert.ok(
      /el\(['"]button['"],\s*['"]tab-overflow['"]\)/.test(editorSrc) ||
        /classList:\s*['"]tab-overflow['"]/.test(editorSrc),
      'overflow button class is "tab-overflow" (no `hidden` class)',
    );
    assert.ok(editorSrc.includes('overflowBtn.hidden = true'), 'overflow button initially hidden');
    // ResizeObserver следит за шириной контейнера и вызывает recomputeOverflow.
    assert.ok(
      /new\s+ResizeObserver\(\s*reflowEditorOverflow\s*\)/.test(editorSrc) ||
        /new\s+ResizeObserver\(\(\)\s*=>\s*\{[^}]*recomputeOverflow/.test(editorSrc),
      'ResizeObserver triggers recomputeOverflow on tabBar resize',
    );
  });

  it('регрессия: CSS-класс `hidden` на overflow-кнопке НЕ ставится (баг `display: none !important`)', () => {
    // Общий `.hidden { display: none !important }` (styles.css:198) перебивает
    // HTML-атрибут `hidden=false`, поэтому кнопка остаётся скрытой, даже когда
    // recomputeOverflow уже решил её показать. Защита: ни в editor.ts, ни в
    // screens/tabs/tabs.ts класс `hidden` на overflow-кнопке не должен
    // появляться — ни при создании, ни после recomputeOverflow.
    const editorSrc = readText(SRC.editor);
    const tabsSrc = readFileSync(
      resolve(import.meta.dirname, '..', 'src', 'renderer', 'screens', 'tabs', 'tabs.ts'),
      'utf8',
    );
    for (const [label, src] of [['editor.ts', editorSrc], ['tabs.ts', tabsSrc]] as const) {
      assert.ok(
        !/el\(['"]button['"],\s*['"]tab-overflow\s+hidden['"]\)/.test(src) &&
          !/classList:\s*['"]tab-overflow\s+hidden['"]/.test(src),
        `${label}: overflow-кнопка не должна создаваться с CSS-классом "hidden"`,
      );
    }
  });

  it('buildOverflowButton навешивает обработчик клика для открытия дропдауна', () => {
    const editorSrc = readText(SRC.editor);
    assert.ok(
      /buildOverflowButton\(\s*overflowBtn,/.test(editorSrc) ||
        /buildOverflowButton\(\s*stripElements\.overflowButton,/.test(editorSrc),
      'editor wires the overflow button via buildOverflowButton',
    );
    // Render-функция строк дропдауна активирует скрытую вкладку по клику.
    assert.ok(
      /activateEditorTab\(item\.id\)/.test(editorSrc),
      'overflow row activates the clicked hidden tab',
    );
    // Полный набор вкладок сущности передаётся в recomputeOverflow для расчёта
    // раскладки (0.8.1: набор выбирается по типу сущности — локальная `tabs`
    // из `tabsFor(ctx)`, а не общая константа), и раскладка идёт в режиме
    // `content` — ширина кнопки по заголовку.
    assert.match(
      editorSrc,
      /recomputeOverflow\(\s*stripElements,\s*tabs,\s*\{[\s\S]{0,200}?kind:\s*'content'/,
      'recomputeOverflow uses the entity tab set and content-sized buttons',
    );
    assert.match(
      editorSrc,
      /kind:\s*'content',\s*minWidth:\s*EDITOR_TAB_MIN_W_PX/,
      'the content layout keeps the minimum width floor',
    );
    // Счётчик «(N)» расширяет кнопку — раскладку нужно пересчитать, иначе
    // вкладка остаётся обрезанной или зря скрытой.
    assert.match(
      editorSrc,
      /badge\.classList\.remove\('hidden'\)[\s\S]{0,600}?reflowEditorOverflow\(\)/,
      'a late counter «(N)» triggers a layout recompute',
    );
  });

  it('CSS задаёт стили overflow-кнопки и дропдауна (общие с воркспейс-вкладками)', () => {
    const css = readText(SRC.css);
    assert.ok(/\.tab-overflow\s*\{/.test(css), '.tab-overflow base style');
    assert.ok(/\.tab-overflow\[hidden\]/.test(css), '.tab-overflow[hidden] rule');
    assert.ok(/\.tab-overflow-dropdown\s*\{/.test(css), '.tab-overflow-dropdown style');
    assert.ok(/\.tab-overflow-row\s*\{/.test(css), '.tab-overflow-row style');
  });

  it('CSS вкладок редактора: кнопка по содержимому, без сжатия и переноса', () => {
    const css = readText(SRC.css);
    const rule = /\.editor-tab\s*\{[^}]*\}/.exec(css);
    assert.ok(rule !== null, '.editor-tab rule present');
    // Раскладка `content` в recomputeOverflow меряет «нужную» ширину кнопки —
    // без `flex: 0 0 auto` браузер сжимал бы кнопку меньше содержимого, и текст
    // снова вылез бы за её пределы.
    assert.ok(/flex:\s*0\s+0\s+auto/.test(rule[0]), '.editor-tab must not shrink');
    assert.ok(/white-space:\s*nowrap/.test(rule[0]), '.editor-tab title must not wrap');
  });

  it('регрессия: `.editor-tab[hidden]` и `.tab[hidden]` явно задают `display: none`', () => {
    // Настоящая причина того, что 4 предыдущих попытки не дали визуального
    // эффекта: `recomputeOverflow` прячет не поместившиеся вкладки атрибутом
    // `hidden`, но `[hidden] { display: none }` — правило user-agent
    // normal-приоритета, а `.editor-tab { display: inline-flex }` /
    // `.tab { display: inline-flex }` — author normal-приоритета. Author
    // ВСЕГДА перебивает user-agent при равном приоритете важности,
    // независимо от специфичности селектора — сам атрибут `hidden` без
    // явного `[hidden] { display: none }` в author-стилях эффекта не даёт.
    // Раньше это правило добавили только для `.tab-overflow` (кнопки
    // дропдауна), но не для самих кнопок вкладок — они оставались видимыми
    // и просто обрезались `.editor-tabs { overflow: hidden }`.
    const css = readText(SRC.css);
    for (const selector of ['.editor-tab', '.tab']) {
      const escaped = selector.replace('.', '\\.');
      const rule = new RegExp(`${escaped}\\[hidden\\]\\s*\\{[^}]*\\}`);
      const block = css.match(rule);
      assert.ok(block !== null, `${selector}[hidden] rule found`);
      assert.ok(/display:\s*none\b/.test(block![0]), `${selector}[hidden] sets display: none`);
    }
  });

  it('регрессия: `.editor-tabs` имеет `min-width: 0` и `overflow: hidden` (flexbox overflow)', () => {
    // Без `min-width: 0` flex-item в column-flex родителе раздувается по
    // min-content (сумма фиксированных кнопок), `recomputeOverflow` видит
    // огромный clientWidth и не прячет ничего — панель вкладок вылезает за
    // пределы редактора. `overflow: hidden` страхует на случай очень узких
    // окон, когда видимый набор + `▾N` всё равно не помещаются.
    const css = readText(SRC.css);
    const block = css.match(/\.editor-tabs\s*\{[^}]*\}/);
    assert.ok(block !== null, '.editor-tabs CSS block found');
    const body = block![0];
    assert.ok(/min-width:\s*0\b/.test(body), '.editor-tabs has min-width: 0');
    assert.ok(/overflow:\s*hidden\b/.test(body), '.editor-tabs has overflow: hidden');
  });
});

/** Source slice of a `const <name> … ];` array literal. */
function sliceConst(src: string, name: string): string {
  const start = src.indexOf(`const ${name}`);
  assert.ok(start >= 0, `${name} is declared`);
  const end = src.indexOf('];', start);
  assert.ok(end > start, `${name} array literal is closed`);
  return src.slice(start, end);
}

describe('набор вкладок зависит от сущности (0.8.1, задача 95775cfd)', () => {
  it('TABS_LINK — только «Комментарий», «Мысли», «Метаданные»', () => {
    const src = readText(SRC.editor);
    const link = sliceConst(src, 'TABS_LINK');
    assert.ok(link.includes("title: 'Комментарий'"), '«Комментарий» present in the link set');
    assert.ok(link.includes("title: 'Мысли'"), '«Мысли» present in the link set');
    assert.ok(link.includes("title: 'Метаданные'"), '«Метаданные» present in the link set');
    // Вкладок, осмысленных только для мысли, у связи нет.
    for (const gone of ["'Свойства'", "'Вложения'", "'Хроника'", "'Граф'", "'Упоминания'"]) {
      assert.ok(!link.includes(gone), `link tab set must not contain ${gone}`);
    }
    // id вкладки «Мысли» — тот же `links`, что у «Упоминаний» мысли: id-контракт
    // не плодится, предпочтение активной вкладки не сбрасывается.
    assert.ok(
      /id:\s*'links',\s*title:\s*'Мысли'/.test(link),
      '«Мысли» reuses the `links` tab id',
    );
    assert.ok(!/counted:\s*true/.test(link), 'no counted tabs in the link set');
  });

  it('набор выбирается по типу сущности через tabsFor(ctx)', () => {
    const src = readText(SRC.editor);
    assert.ok(src.includes('function tabsFor('), 'tabsFor is declared');
    assert.ok(
      /function tabsFor\(ctx: EditorContext\): EditorTabDef\[\]\s*\{[\s\S]*?return ctx\.ownerType === 'link' \? TABS_LINK : TABS_THOUGHT/.test(
        src,
      ),
      'tabsFor returns TABS_LINK for a link, TABS_THOUGHT otherwise',
    );
    assert.ok(src.includes('const tabs = tabsFor(ctx)'), 'render() takes its tab set from tabsFor');
  });

  it('сохранённая вкладка вне набора сущности не перезаписывает предпочтение', () => {
    const src = readText(SRC.editor);
    // Защищённая отрисовка: вкладка вне набора → «Комментарий», без persist.
    assert.ok(
      /const initial = tabs\.some\(\(t\) => t\.id === activeTab\) \? activeTab : 'main'/.test(src),
      'the guarded initial draw falls back to «Комментарий»',
    );
    assert.ok(src.includes('displayInitialTab('), 'the guarded draw is a shared helper');
    // Только явный пользовательский выбор пишет предпочтение в L4.
    assert.ok(
      /function activateEditorTab\([\s\S]*?persistActiveTab\(\)/.test(src),
      'only the user-activated tab persists the preference',
    );
    // Чтение L4 принимает id из ЛЮБОГО набора вкладок.
    assert.ok(src.includes('isKnownTabId(raw)'), 'loadActiveTab accepts ids of both tab sets');
  });

  it('displayTab отделён от activateEditorTab и ведёт shownTab', () => {
    const src = readText(SRC.editor);
    assert.ok(/function displayTab\(/.test(src), 'displayTab is declared');
    assert.ok(/let shownTab: EditorTabId/.test(src), 'shownTab tracks the actually displayed tab');
    assert.ok(
      /if \(shownTab === 'main'\) displayTab\('main'\)/.test(src),
      'invalidateMainPane reads shownTab (not activeTab)',
    );
    assert.ok(/if \(shownTab !== 'main'\)/.test(src), 'focusEditorComment reads shownTab');
  });
});

describe('вкладка «Мысли» редактора связи — облачка концов (0.8.1, задача 95775cfd)', () => {
  it('строит link-thoughts-tab с блоками «Источник»/«Назначение»', () => {
    const src = readText(SRC.links);
    assert.ok(src.includes("div('link-thoughts-tab')"), 'link-thoughts-tab container');
    assert.ok(
      src.includes("endpointBlock('Источник'") && src.includes("endpointBlock('Назначение'"),
      'both role blocks are built',
    );
    assert.ok(src.includes("div('link-endpoint')"), 'endpoint block wrapper');
    assert.ok(src.includes("'link-endpoint-label'"), 'endpoint role caption');
    // Один батч resolve на оба конца связи.
    assert.ok(
      /etn\.thoughts\.resolve\(\s*networkId,\s*\[link\.source_id,\s*link\.target_id\]/.test(src),
      'both endpoints are resolved in one call',
    );
  });

  it('облачко размечено и ведёт себя как облачко на холсте', () => {
    const src = readText(SRC.links);
    for (const anchor of [
      "div('cloud')",
      'applyCloudStyle(',
      'resolveCloudStyle(',
      'applyThoughtIcon(',
      'setTooltip(',
      'markThoughtCommentPreview(cloud',
      'deferSingleClick(',
      'openThoughtInEditor(',
      'setFocus(',
      'toggleSelection(',
      'showThoughtContextMenu(',
    ]) {
      assert.ok(src.includes(anchor), `cloud behaviour anchor missing: ${anchor}`);
    }
    // Полное название в тултипе + бледность неактуальной мысли.
    assert.ok(src.includes("classList.add('dim')"), 'inactive endpoint cloud is dimmed');
  });

  it('у облачков концов нет строки счётчиков 📝/📅/📎 (class cloud-ind)', () => {
    const src = readText(SRC.links);
    assert.ok(!src.includes('cloud-ind'), 'no indicator row on the «Мысли» tab');
    assert.ok(!src.includes('buildLinkEndpointsBody'), 'old flat endpoints body removed');
    assert.ok(!src.includes('endpointRow'), 'old endpointRow helper removed');
    // Ветка мысли (две группы со сплиттером) не тронута.
    assert.ok(
      src.includes("applyTabGroupClamp(backlinks, 'links.backlinks'") &&
        src.includes("persistKey: 'links.mentions'"),
      'the thought «Упоминания» branch is intact',
    );
  });

  it('CSS даёт блокам колонку, подписи — приглушённый вид, облачку — растяжение', () => {
    const css = readText(SRC.css);
    assert.ok(/\.link-thoughts-tab\s*\{/.test(css), '.link-thoughts-tab style');
    assert.ok(/\.link-endpoint\s*\{/.test(css), '.link-endpoint style');
    assert.ok(/\.link-endpoint-label\s*\{/.test(css), '.link-endpoint-label style');
    assert.ok(
      /\.link-endpoint\s+\.cloud\s*\{[^}]*width:\s*auto/.test(css),
      'endpoint cloud stretches to the panel width',
    );
  });
});


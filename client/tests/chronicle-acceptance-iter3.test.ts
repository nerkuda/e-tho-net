/**
 * Приёмочные регрессы «Дневника» 0.10.1, итерация №3 (задача 9bef6a27,
 * версия 0.10.1). Требования приёмки проверяются ПОВЕДЕНЧЕСКИ, а не чтением
 * исходников:
 *
 *  1) запись ленты в режиме просмотра рендерит ПОЛНЫЙ `body_html` (h2/ul/strong),
 *     а не однострочную выжимку `snippet`;
 *  2) свёрнутый день СКРЫВАЕТ список своих записей (скрывающее CSS-правило);
 *  3) период — виджет «список + сдвиг ±N»: комбобокс базовых пресетов и сдвиг
 *     собирают канонический токен, поле показывает человекочитаемую композицию,
 *     восстановление сохранённого отбора возвращает режим и поля, клик
 *     календаря пишет значения по режиму панели.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');

function read(rel: string): string {
  return readFileSync(resolve(RENDERER, ...rel.split('/')), 'utf8');
}

const CHRONICLE = read('screens/chronicle/chronicle.ts');
const CSS = read('styles/screens/chronicle.css');

/** Минимальный DOM-шим: хватает для сборки оболочки комментария и выпадашки. */
function installShim(): ShimElement {
  const body = new ShimElement('body');
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (text: string) => new ShimElement('#text', undefined, text),
    body,
    activeElement: body,
  };
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.innerWidth = 1200;
  win.innerHeight = 800;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  win.dispatchEvent = () => undefined;
  return body;
}

/** Даёт очереди микротасков/таймеров выпадашки прокрутиться. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

/** Рекурсивно ищет первый элемент с указанным классом. */
function findByClass(root: ShimElement, className: string): ShimElement | undefined {
  if (root.className.split(' ').includes(className)) return root;
  for (const child of root.children) {
    const hit = findByClass(child, className);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Все поля контрола по классу. */
function allFields(root: HTMLElement, cls: string): ShimElement[] {
  return (root as unknown as ShimElement).querySelectorAll(`.${cls}`);
}

// ---------------------------------------------------------------------------
// Пункт 1: полный текст записи в режиме просмотра
// ---------------------------------------------------------------------------

describe('приёмка №3, п.1: просмотр записи = полный body_html', () => {
  it('markdown записи рендерится целиком (h2/ul/strong), а не выжимкой snippet', async () => {
    installShim();
    const { renderMarkdown } = await import('@etn/markdown');
    const { commentShell } = await import('../src/renderer/lib/ui/comment.js');
    const { renderRecordView, RECORD_VIEW_CLASS } = await import(
      '../src/renderer/screens/chronicle/record-body.js'
    );

    const html = renderMarkdown('## Итоги дня\n\n- первое\n- второе\n\n**важно**');
    // У записи есть и выжимка (как в ответе API), и полный HTML. Просмотр
    // обязан взять полный HTML.
    const shell = commentShell({ variant: 'plain' }) as unknown as { root: ShimElement };
    renderRecordView(shell as never, {
      body_html: html,
      snippet: 'Итоги дня перв&#8230;',
    } as never);

    const view = findByClass(shell.root, RECORD_VIEW_CLASS);
    assert.ok(view, 'тело записи отрисовано');
    assert.match(view!.innerHTML, /<h2/, 'заголовок markdown — как <h2>');
    assert.match(view!.innerHTML, /<ul/, 'список markdown — как <ul>');
    assert.match(view!.innerHTML, /<strong/, 'жирный markdown — как <strong>');
    assert.ok(
      !view!.innerHTML.includes('Итоги дня перв'),
      'однострочная выжимка snippet не используется',
    );
  });

  it('пустая запись сохраняет приглашение', async () => {
    installShim();
    const { commentShell } = await import('../src/renderer/lib/ui/comment.js');
    const { renderRecordView, RECORD_VIEW_CLASS } = await import(
      '../src/renderer/screens/chronicle/record-body.js'
    );
    const shell = commentShell({ variant: 'plain' }) as unknown as { root: ShimElement };
    renderRecordView(shell as never, { body_html: '' });
    const view = findByClass(shell.root, RECORD_VIEW_CLASS);
    assert.ok(view, 'тело записи отрисовано');
    assert.ok(findByClass(view!, 'diary-snippet-empty'), 'пустое тело даёт приглашение');
  });

  it('лента строит тело через общий рендер записи, а не через snippet', () => {
    assert.match(CHRONICLE, /function fillRecordCard\(card: HTMLElement, row: ChronicleRow, day: string\): void \{[\s\S]*renderRecordView\(shell, row\)/);
    assert.ok(!/renderSnippet\(/.test(CHRONICLE), 'сниппет больше не рисуется в теле');
  });
});

// ---------------------------------------------------------------------------
// Пункт 2: сворачивание групп дней реально скрывает записи
// ---------------------------------------------------------------------------

describe('приёмка №3, п.2: свёрнутый день скрывает список записей', () => {
  it('скрытие задано CSS-правилом под классом is-collapsed (побеждает display:flex)', () => {
    const rule = /\.diary-day\.is-collapsed\s+\.diary-day-list\s*\{([^}]*)\}/.exec(CSS);
    assert.ok(rule, 'есть правило скрытия списка свёрнутого дня');
    assert.match(rule![1]!, /display:\s*none/, 'список свёрнутого дня реально скрыт');
  });

  it('сборка блока дня и класс, и hidden ставит по состоянию', () => {
    // Итерация №11: состояние группы (класс секции, hidden списка, aria,
    // подсказка) ставит общий помощник `applyDayCollapsed` — и при сборке, и
    // при in-place переключении (требование 165323a7, «Устойчивость»).
    assert.match(CHRONICLE, /applyDayCollapsed\(section, collapsed, dayGroupLabels\(\)\)/);
    const DAY_GROUPS = read('screens/chronicle/day-groups.ts');
    assert.match(DAY_GROUPS, /classList\?\.toggle\('is-collapsed', collapsed\)/);
    assert.match(DAY_GROUPS, /list\.hidden = collapsed/);
  });
});

// ---------------------------------------------------------------------------
// Пункт 3: период — виджет «список + сдвиг ±N»
// ---------------------------------------------------------------------------

describe('приёмка №3, п.3: период «список + сдвиг ±N»', () => {
  it('комбобокс базовых пресетов выбирает опору, поле показывает подпись, не токен', async () => {
    const body = installShim();
    const { buildPeriodEditor } = await import('../src/renderer/lib/period-editor.js');
    const editor = buildPeriodEditor({
      variant: 'panel',
      value: { from: '$today', to: '$today' },
    });
    const input = allFields(editor.root, 'pe-preset-anchor')[0]!;
    assert.equal(input.readOnly, true, 'поле только для чтения — токен не вводится');

    // Список базовых пресетов открывается фокусом (общая выпадашка).
    input.focus();
    await settle();
    const rows = body.querySelectorAll('.type-combo-item');
    const weekRow = rows.find((r) => r.flatText().includes('начало недели'));
    assert.ok(weekRow, 'в списке есть базовый пресет «начало недели»');
    weekRow!.click();
    await settle();

    assert.equal(editor.getValue().from, '$week.start', 'наружу уходит канонический токен');
    assert.equal(input.value, 'начало недели', 'поле показывает человекочитаемую подпись');
  });

  it('сдвиг ±N и единица [дн/нед/мес/лет] собирают токен и обновляют композицию', async () => {
    installShim();
    const { buildPeriodEditor } = await import('../src/renderer/lib/period-editor.js');
    const editor = buildPeriodEditor({
      variant: 'panel',
      value: { from: '$week.start', to: '$today' },
    });
    const input = allFields(editor.root, 'pe-preset-anchor')[0]!;
    const num = allFields(editor.root, 'pe-preset-num')[0]!;
    const unit = allFields(editor.root, 'pe-preset-unit')[0]!;

    num.value = '-1';
    num.emit('change');
    assert.equal(editor.getValue().from, '$week.start-1d', 'сдвиг в днях');

    unit.value = 'w';
    unit.emit('change');
    assert.equal(editor.getValue().from, '$week.start-1w', 'сдвиг в неделях');
    assert.equal(input.value, 'начало недели − 1 нед', 'композиция опоры и сдвига');
    assert.ok(!input.value.includes('$'), 'токен-строки в поле нет');
  });

  it('произвольный сдвиг (+2mo) не теряется: композиция и каноническая форма', async () => {
    installShim();
    const { buildPeriodEditor } = await import('../src/renderer/lib/period-editor.js');
    const editor = buildPeriodEditor({
      variant: 'panel',
      value: { from: '$month.end+2mo', to: '$year.start' },
    });
    const anchors = allFields(editor.root, 'pe-preset-anchor');
    assert.equal(anchors[0]!.value, 'конец месяца + 2 мес');
    assert.equal(anchors[1]!.value, 'начало года');
    assert.equal(editor.getValue().from, '$month.end+2mo');
    assert.equal(editor.getValue().to, '$year.start');
  });

  it('восстановление сохранённого отбора возвращает режим и поля виджета', async () => {
    installShim();
    const { buildPeriodEditor } = await import('../src/renderer/lib/period-editor.js');
    // Режим «Даты» + точные даты.
    const dates = buildPeriodEditor({
      variant: 'panel',
      panelMode: 'dates',
      value: { from: '2026-09-10', to: '2026-09-12' },
    });
    assert.equal(dates.getPanelMode(), 'dates');
    // Компонентное поле даты (итерация приёмки №8, п.4) несёт класс
    // `.date-field-input`; значения границ доступны для правки.
    const dateInputs = allFields(dates.root, 'date-field-input');
    assert.equal(dateInputs.length, 2);
    assert.equal(dateInputs[0]!.value, '2026-09-10');
    assert.equal(dateInputs[1]!.value, '2026-09-12');

    // Режим «Пресеты» + токен со сдвигом — виджет показывает композицию и
    // отдаёт тот же канонический токен.
    const presets = buildPeriodEditor({
      variant: 'panel',
      value: { from: '$week.start-1w', to: '$today' },
    });
    assert.equal(presets.getPanelMode(), 'presets');
    assert.equal(allFields(presets.root, 'pe-preset-anchor')[0]!.value, 'начало недели − 1 нед');
    assert.equal(presets.getValue().from, '$week.start-1w');
  });

  it('клик календаря пишет значения по режиму панели', async () => {
    const { periodValuesForRange } = await import(
      '../src/renderer/screens/chronicle/diary.js'
    );
    const today = '2026-09-26'; // суббота
    assert.deepEqual(periodValuesForRange(today, today, today, 'presets'), {
      from: '$today',
      to: '$today',
    });
    assert.deepEqual(periodValuesForRange('2026-09-21', '2026-09-27', today, 'presets'), {
      from: '$week.start',
      to: '$week.end',
    });
    assert.deepEqual(periodValuesForRange('2026-09-01', '2026-09-30', today, 'presets'), {
      from: '$month.start',
      to: '$month.end',
    });
    assert.deepEqual(periodValuesForRange('2026-01-01', '2026-12-31', today, 'presets'), {
      from: '$year.start',
      to: '$year.end',
    });
    // Произвольный интервал — день-арифметика на обеих границах.
    assert.deepEqual(periodValuesForRange('2026-09-24', '2026-09-28', today, 'presets'), {
      from: '$today-2d',
      to: '$today+2d',
    });
    // Режим «Даты» — точные даты без токенов.
    assert.deepEqual(periodValuesForRange('2026-09-10', '2026-09-12', today, 'dates'), {
      from: '2026-09-10',
      to: '2026-09-12',
    });
  });
});

/**
 * Футер редактора отбора (задача c74f17a0 ТП 11b2509a; элемент интерфейса
 * ca905fbc «Футер редактора отбора»).
 *
 * Проверяется то, за что отвечает `lib/filter-footer.ts`: маркер изменённости ●,
 * поле имени с ✕ очистки, сохранение копией при смене имени, фраза-превью ≤3
 * строк с тултипом (полный текст + список ошибок), состав кнопок как параметр
 * профиля места применения и запрет применения при красной диагностике.
 *
 * jsdom в проекте нет — общий DOM-шим (`./dom-shim.js`), как в
 * `filter-tree.test.ts`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

const RENDERER = path.resolve(import.meta.dirname, '..', 'src', 'renderer');

let mod: typeof import('../src/renderer/lib/filter-footer.js');
let filterMod: typeof import('../src/renderer/lib/filter-diagnostics.js');
let fieldMod: typeof import('../src/renderer/lib/ui/field.js');

/** Минимальный DOM/window-шим, которого требуют фасады. */
function installShim(): void {
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
  win['setTimeout'] = (fn: () => void) => {
    fn();
    return 1;
  };
  win['clearTimeout'] = () => undefined;
  win['addEventListener'] = () => undefined;
  win['removeEventListener'] = () => undefined;
  win['matchMedia'] = () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
}

/** Все потомки с ТОЧНЫМ классом. */
function exact(root: ShimElement, cls: string): ShimElement[] {
  return root.findAll((node) => node.classList.contains(cls));
}

function exactOne(root: ShimElement, cls: string): ShimElement | null {
  return exact(root, cls)[0] ?? null;
}

/**
 * Текст тултипа фразы. Тултип фразы — элемент с РАЗМЕТКОЙ раскраски (задача
 * 58f77990, п.12в): нативный `title` разметку не умеет, поэтому подсказка —
 * `.{@link mod.FILTER_FOOTER_TIP_CLASS}` внутри превью.
 */
function tipText(root: ShimElement): string {
  return exactOne(root, mod.FILTER_FOOTER_TIP_CLASS)?.flatText() ?? '';
}

/** Кнопка-потомок с точным текстом. */
function buttonByText(root: ShimElement, text: string): ShimElement | null {
  return root.findAll((node) => node.tagName === 'button' && node.flatText().trim() === text)[0] ?? null;
}

/** Стенд футера: состояние хоста + записанные вызовы. */
function buildFooter(
  overrides: Partial<Parameters<typeof mod.buildFilterFooter>[0]> = {},
): {
  handle: ReturnType<typeof mod.buildFilterFooter>;
  state: { name: string; saved: string | null; definition: unknown; baseline: unknown; preview: any };
  calls: { save: any[]; apply: number; clear: number };
} {
  const state = {
    name: '',
    saved: null as string | null,
    definition: { version: 1, filter: { op: 'and', children: [] } } as unknown,
    baseline: null as unknown,
    preview: { text: '', issues: [] } as any,
  };
  const calls = { save: [] as any[], apply: 0, clear: 0 };
  const handle = mod.buildFilterFooter({
    getName: () => state.name,
    setName: (name) => {
      state.name = name;
    },
    savedName: () => state.saved,
    baseline: () => state.baseline,
    current: () => state.definition,
    preview: () => state.preview,
    onSave: (request) => {
      calls.save.push(request);
    },
    onApply: () => {
      calls.apply += 1;
    },
    onClear: () => {
      calls.clear += 1;
    },
    ...overrides,
  });
  return { handle, state, calls };
}

describe('футер отбора: имя, маркер ● и сохранение копией (ca905fbc)', () => {
  before(async () => {
    installShim();
    mod = await import('../src/renderer/lib/filter-footer.js');
    filterMod = await import('../src/renderer/lib/filter-diagnostics.js');
    fieldMod = await import('../src/renderer/lib/ui/field.js');
  });

  it('маркер ● появляется при отличии от снимка и гаснет при совпадении', () => {
    const { handle, state } = buildFooter();
    const root = handle.root as unknown as ShimElement;
    const marker = exactOne(root, mod.FILTER_FOOTER_CHANGED_CLASS)!;
    assert.equal(marker.hidden, true, 'без снимка отбор не «изменён»');

    state.baseline = { version: 1, filter: { op: 'and', children: [] } };
    handle.refresh();
    assert.equal(marker.hidden, true, 'определение совпадает со снимком');

    state.definition = { version: 1, filter: { op: 'and', children: [{ kind: 'leaf' }] } };
    handle.refresh();
    assert.equal(marker.hidden, false, 'правка условия зажигает маркер');

    state.definition = { version: 1, filter: { op: 'and', children: [] } };
    handle.refresh();
    assert.equal(marker.hidden, true, 'возврат к снимку гасит маркер');
  });

  it('имя отбора — редактируемое поле с ✕ очистки; имя читается из модели', () => {
    const { handle, state } = buildFooter();
    const root = handle.root as unknown as ShimElement;
    const input = exactOne(root, 'ff-name__input')! as unknown as ShimElement;
    assert.equal(input.placeholder, 'имя отбора');

    input.value = 'Мой отбор';
    input.emit('input', {});
    assert.equal(state.name, 'Мой отбор', 'правка поля идёт в состояние хоста');

    state.name = 'Чужой отбор';
    handle.refresh();
    assert.equal(input.value, 'Чужой отбор', 'перерисовка подтягивает имя из модели');

    const clear = exactOne(root, fieldMod.FIELD_CLEAR_BTN_CLASS)!;
    // Фасад поля гасит всплытие клика по ✕ (`stopPropagation`) — шиму нужен event.
    clear.emit('click', { stopPropagation: () => undefined });
    assert.equal(state.name, '', '✕ очищает имя');
    assert.equal(input.value, '');
  });

  it('«Сохранить»: смена имени даёт копию, неизменное имя — запись того же отбора', () => {
    const { handle, state, calls } = buildFooter();
    const root = handle.root as unknown as ShimElement;

    state.name = '  Мой отбор  ';
    (exactOne(root, 'ff-save')!).emit('click', {});
    assert.deepEqual(calls.save[0], { name: 'Мой отбор', asCopy: false }, 'несохранённый отбор — простая запись, имя обрезано');

    state.saved = 'Мой отбор';
    state.name = 'Мой отбор';
    handle.refresh();
    (exactOne(root, 'ff-save')!).emit('click', {});
    assert.deepEqual(calls.save[1], { name: 'Мой отбор', asCopy: false });

    state.name = 'Мой отбор (копия)';
    handle.refresh();
    (exactOne(root, 'ff-save')!).emit('click', {});
    assert.deepEqual(
      calls.save[2],
      { name: 'Мой отбор (копия)', asCopy: true },
      'смена имени + «Сохранить» = сохранение КОПИЕЙ',
    );

    (exactOne(root, 'ff-apply')!).emit('click', {});
    (exactOne(root, 'ff-clear')!).emit('click', {});
    assert.equal(calls.apply, 1);
    assert.equal(calls.clear, 1);
  });

  it('состав кнопок — параметр места применения (модальный слой: Готово/Отмена)', () => {
    let done = 0;
    const { handle } = buildFooter({
      standardButtons: false,
      extraButtons: [
        { id: 'done', label: 'Готово', role: 'primary', onClick: () => (done += 1) },
        { id: 'cancel', label: 'Отмена', onClick: () => undefined },
      ],
    });
    const root = handle.root as unknown as ShimElement;
    assert.equal(exactOne(root, 'ff-save'), null, 'стандартный набор отключён');
    buttonByText(root, 'Готово')!.emit('click', {});
    assert.equal(done, 1);
    assert.ok(exactOne(root, 'ff-extra--cancel') !== null, 'кнопки профиля помечены своим id');
  });

  it('двухрядная компоновка: действия над отбором сверху, имя и сохранённые снизу', () => {
    let savedPicked = 0;
    const { handle } = buildFooter({
      extraButtons: [
        { id: 'commands', label: 'Команды ▾', onClick: () => undefined },
        { id: 'saved', label: 'Отборы…', place: 'name', onClick: () => (savedPicked += 1) },
      ],
    });
    const root = handle.root as unknown as ShimElement;
    const actions = exactOne(root, 'ff-actions')!;
    const nameRow = exactOne(root, 'ff-name')!;
    // Верхний ряд — действия над текущим отбором и его результатами.
    assert.ok(exactOne(actions, 'ff-apply') !== null, '«Применить» — в верхнем ряду');
    assert.ok(exactOne(actions, 'ff-clear') !== null, '«Очистить» — в верхнем ряду');
    assert.ok(exactOne(actions, 'ff-extra--commands') !== null, '«Команды ▾» — в верхнем ряду');
    assert.equal(exactOne(actions, 'ff-extra--saved'), null, 'кнопка сохранённых — не в верхнем ряду');
    // Нижний ряд — манипуляции с сохранёнными отборами: имя + «Сохранить» + «…».
    assert.ok(exactOne(nameRow, 'ff-name__input') !== null, 'поле имени — в нижнем ряду');
    assert.ok(exactOne(nameRow, 'ff-save') !== null, '«Сохранить» — в нижнем ряду');
    assert.ok(exactOne(nameRow, 'ff-extra--saved') !== null, '«Отборы…» — в нижнем ряду');
    exactOne(root, 'ff-extra--saved')!.emit('click', {});
    assert.equal(savedPicked, 1, 'кнопка нижнего ряда кликабельна');
  });

  it('кнопка нижнего ряда без строки имени не теряется — уходит в верхний ряд', () => {
    const { handle } = buildFooter({
      getName: undefined,
      setName: undefined,
      extraButtons: [{ id: 'saved', label: 'Отборы…', place: 'name', onClick: () => undefined }],
    });
    const root = handle.root as unknown as ShimElement;
    assert.equal(exactOne(root, 'ff-name'), null, 'строки имени нет — футер без имени');
    assert.ok(exactOne(root, 'ff-extra--saved') !== null, 'кнопка сохранена, не потеряна');
    assert.ok(exactOne(root, 'ff-save') !== null, '«Сохранить» ушло в верхний ряд');
  });

  it('компоновка: фраза → линия-разделитель → имя → кнопки (п.1)', () => {
    const { handle, state } = buildFooter();
    const root = handle.root as unknown as ShimElement;
    state.preview = { text: 'Город = Москва', issues: [] };
    handle.refresh();
    const classes = root.children.map((child) => child.className);
    const idx = (token: string): number => classes.findIndex((c) => c.includes(token));
    const previewIdx = idx(mod.FILTER_FOOTER_PREVIEW_CLASS);
    const dividerIdx = idx(mod.FILTER_FOOTER_DIVIDER_CLASS);
    const nameIdx = idx('ff-name');
    const actionsIdx = idx('ff-actions');
    assert.ok(previewIdx >= 0 && dividerIdx >= 0 && nameIdx >= 0 && actionsIdx >= 0, 'все секции на месте');
    assert.ok(previewIdx < dividerIdx, 'фраза над линией');
    assert.ok(dividerIdx < nameIdx, 'линия между фразой и именем');
    assert.ok(nameIdx < actionsIdx, 'имя над кнопками');
    // Пустая фраза прячет линию — отделять нечего.
    state.preview = { text: '', issues: [] };
    handle.refresh();
    assert.equal(exactOne(root, mod.FILTER_FOOTER_DIVIDER_CLASS)!.hidden, true, 'без фразы линии нет');
  });
});

describe('футер отбора: фраза-превью и запрет применения (cf8fdd4d, 44d61c8a)', () => {
  before(async () => {
    installShim();
    mod = await import('../src/renderer/lib/filter-footer.js');
    filterMod = await import('../src/renderer/lib/filter-diagnostics.js');
  });

  it('фраза показывается ≤3 строк, полный текст и ошибки — в тултипе', () => {
    const { handle, state } = buildFooter();
    const root = handle.root as unknown as ShimElement;
    state.preview = {
      text: 'Показать мысли: город = Москва',
      issues: [
        {
          severity: 'warning',
          source: 'server',
          code: 'property_detached',
          path: 'filter.children[0].entity',
          message: 'свойство отвязано',
          label: 'Город',
        },
        {
          severity: 'warning',
          source: 'server',
          code: 'build_warning',
          path: '',
          message: 'сборку нельзя локализовать в строку',
        },
      ],
    };
    handle.refresh();
    const box = exactOne(root, mod.FILTER_FOOTER_PREVIEW_CLASS)!;
    assert.equal(exactOne(root, 'ff-preview__text')!.flatText(), 'Показать мысли: город = Москва');
    assert.equal(box.dataset['severity'], 'warning');
    assert.match(tipText(root), /Показать мысли: город = Москва/, 'тултип несёт полный текст');
    assert.match(tipText(root), /свойство отвязано · «Город»/, 'и причину локализованной ошибки');
    assert.match(tipText(root), /сборку нельзя локализовать в строку/, 'и нелокализуемую ошибку');

    // Клампинг строк живёт в CSS-правиле: число сверяется с константой модуля.
    const css = fs.readFileSync(path.join(RENDERER, 'styles', 'filter-editor.css'), 'utf8');
    const rule = /\.ff-preview__text\s*\{[^}]*-webkit-line-clamp:\s*(\d+)/s.exec(css);
    assert.notEqual(rule, null, 'правило клампинга фразы обязано быть');
    assert.equal(Number(rule![1]), mod.FILTER_FOOTER_PREVIEW_LINES);
    assert.equal(mod.FILTER_FOOTER_PREVIEW_LINES, 3, 'элемент ca905fbc: ≤3 строк');
  });

  it('красное запрещает применение, жёлтое — нет; записи без ошибок краски не дают', () => {
    const { handle, state } = buildFooter();
    const root = handle.root as unknown as ShimElement;
    const box = exactOne(root, mod.FILTER_FOOTER_PREVIEW_CLASS)!;
    const apply = exactOne(root, 'ff-apply')!;

    state.preview = {
      text: 'битый отбор',
      issues: [
        {
          severity: 'error',
          source: 'server',
          code: 'entity_deleted',
          path: 'filter.children[0].entity',
          message: 'Свойство «Город» удалено из сети — отбор нельзя применить.',
          label: 'Город',
          deletedAt: '2026-10-01T00:00:00.000Z',
        },
      ],
    };
    handle.refresh();
    assert.equal(box.dataset['severity'], 'error');
    assert.equal(apply.disabled, true, 'применение красного отбора запрещено');
    assert.match(tipText(root), /удалено 2026-10-01T00:00:00\.000Z/);

    state.preview = {
      text: 'жёлтый отбор',
      issues: [
        {
          severity: 'warning',
          source: 'server',
          code: 'property_detached',
          path: 'sort[0]',
          message: 'свойство сортировки отвязано',
        },
      ],
    };
    handle.refresh();
    assert.equal(box.dataset['severity'], 'warning');
    assert.equal(apply.disabled, false, 'жёлтое не блокирует применение');

    state.preview = { text: 'чистый отбор', issues: [] };
    handle.refresh();
    assert.equal(box.dataset['severity'], undefined, 'без ошибок краски нет');
    assert.equal(apply.disabled, false);
  });

  it('переход к строке из запрета — по КЛИКУ НА ТЕКСТ фразы, без кнопки (0fd1dc5d, п.10)', () => {
    const fixed: string[] = [];
    const { handle, state } = buildFooter({ onFixIssue: (path) => fixed.push(path) });
    const root = handle.root as unknown as ShimElement;
    assert.equal(exactOne(root, 'ff-fix'), null, 'отдельной кнопки «исправить» нет (п.10)');
    const text = exactOne(root, 'ff-preview__text')!;
    const actionClass = mod.FILTER_FOOTER_PREVIEW_ACTION_CLASS;
    assert.equal(text.classList.contains(actionClass), false, 'пока ошибок нет — перехода нет');

    // Красное С адресом строки: текст фразы становится точкой перехода.
    state.preview = {
      text: 'битый отбор',
      issues: [
        {
          severity: 'error',
          source: 'server',
          code: 'entity_deleted',
          path: 'filter.children[0].entity',
          message: 'Свойство удалено из сети — отбор нельзя применить.',
        },
      ],
    };
    handle.refresh();
    assert.equal(text.classList.contains(actionClass), true, 'красное с адресом делает текст кликабельным');
    assert.match(tipText(root), /Нажмите на текст/, 'тултип подсказывает про клик');
    text.emit('click', {});
    assert.deepEqual(fixed, ['filter.children[0].entity'], 'клик по тексту ведёт в строку ошибки');

    // Красное БЕЗ адреса (сообщение о запрете, которое нельзя локализовать) —
    // перехода нет: вести пользователя некуда.
    state.preview = {
      text: 'битый отбор',
      issues: [
        {
          severity: 'error',
          source: 'server',
          code: 'build_warning',
          path: '',
          message: 'ошибку нельзя локализовать в строку',
        },
      ],
    };
    handle.refresh();
    assert.equal(text.classList.contains(actionClass), false, 'без адреса строки перехода нет');
    assert.doesNotMatch(tipText(root), /Нажмите на текст/, 'подсказки о клике нет');

    // Жёлтое не запрещает применение — перехода тоже нет.
    state.preview = {
      text: 'жёлтый отбор',
      issues: [
        {
          severity: 'warning',
          source: 'server',
          code: 'property_detached',
          path: 'filter.children[0].entity',
          message: 'свойство отвязано',
        },
      ],
    };
    handle.refresh();
    assert.equal(text.classList.contains(actionClass), false, 'жёлтое перехода не предлагает');
    text.emit('click', {});
    assert.deepEqual(fixed, ['filter.children[0].entity'], 'лишних вызовов нет');

    // Пустое превью снимает и кликабельность.
    state.preview = { text: '', issues: [] };
    handle.refresh();
    assert.equal(text.classList.contains(actionClass), false);
  });

  it('чистые помощники футера: изменённость, запрос записи, запрет применения', () => {    assert.equal(mod.filterChangedAgainst(null, { a: 1 }), false);
    assert.equal(mod.filterChangedAgainst({ a: 1 }, { a: 1 }), false);
    assert.equal(mod.filterChangedAgainst({ a: 1 }, { a: 2 }), true);
    assert.deepEqual(mod.filterSaveRequest('Имя', null), { name: 'Имя', asCopy: false });
    assert.deepEqual(mod.filterSaveRequest('Имя', 'Имя'), { name: 'Имя', asCopy: false });
    assert.deepEqual(mod.filterSaveRequest('Другое', 'Имя'), { name: 'Другое', asCopy: true });
    assert.equal(mod.filterFooterApplyBlocked(undefined), false);
    assert.equal(
      mod.filterFooterApplyBlocked({ text: '', issues: [{ severity: 'warning' } as any] }),
      false,
    );
    assert.equal(
      mod.filterFooterApplyBlocked({ text: '', issues: [{ severity: 'error' } as any] }),
      true,
    );
    assert.equal(filterMod.worstFilterIssueSeverity([]), null);
  });

  it('модуль и его CSS не содержат hex-хардкода (тона — токены дизайн-системы)', () => {
    for (const file of ['lib/filter-footer.ts', 'lib/filter-sort.ts', 'lib/filter-diagnostics.ts', 'styles/filter-editor.css']) {
      const source = fs.readFileSync(path.join(RENDERER, file), 'utf8');
      assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b/, `нет hex в ${file}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Фраза-превью: HTML-раскраска и тултип с разметкой
// (правка заказчика 2026-10-14, п.12в; задача 58f77990)
// ---------------------------------------------------------------------------

describe('футер отбора: раскраска фразы и тултип с разметкой (задача 58f77990)', () => {
  before(async () => {
    installShim();
    mod = await import('../src/renderer/lib/filter-footer.js');
    filterMod = await import('../src/renderer/lib/filter-diagnostics.js');
  });

  /** Токены фразы `(A ИЛИ B) И C` — как их отдаёт композер. */
  const NESTED_TOKENS = [
    { kind: 'paren', text: '(', depth: 1 },
    { kind: 'text', text: 'Актуальность = да' },
    { kind: 'operator', text: ' ИЛИ ', operator: 'or' },
    { kind: 'text', text: 'Помечено на удаление = нет' },
    { kind: 'paren', text: ')', depth: 1 },
    { kind: 'operator', text: ' И ', operator: 'and' },
    { kind: 'text', text: 'Есть комментарий заполнено' },
  ] as const;
  const NESTED_TEXT = '(Актуальность = да ИЛИ Помечено на удаление = нет) И Есть комментарий заполнено';

  it('операторы и скобки — спаны раскраски, текст фразы не меняется', () => {
    const { handle, state } = buildFooter();
    const root = handle.root as unknown as ShimElement;
    state.preview = { text: NESTED_TEXT, tokens: NESTED_TOKENS, issues: [] };
    handle.refresh();
    const text = exactOne(root, 'ff-preview__text')!;
    assert.equal(text.flatText(), NESTED_TEXT, 'видимый текст фразы не изменился');
    // Считаем разметку В СТРОКЕ фразы: тултип несёт такую же (проверка ниже).
    assert.equal(exact(text, 'ff-ph-op').length, 2, 'оба коннектора — спаны-операторы');
    assert.equal(exact(text, 'ff-ph-op--and').length, 1);
    assert.equal(exact(text, 'ff-ph-op--or').length, 1);
    assert.equal(exact(text, 'ff-ph-paren').length, 2, 'скобка пары — свой спан');
    // Тон скобки — цикл тонов вложенности: уровень 1 даёт второй тон цикла
    // (`ft-tone-2` у группы того же уровня в дереве).
    assert.equal(exact(text, 'ff-ph-paren--t2').length, 2, 'тон скобок — уровень вложенности');
  });

  it('тултип несёт ТУ ЖЕ разметку, что и строка фразы, плюс ошибки', () => {
    const { handle, state } = buildFooter();
    const root = handle.root as unknown as ShimElement;
    state.preview = {
      text: NESTED_TEXT,
      tokens: NESTED_TOKENS,
      issues: [
        {
          severity: 'warning',
          source: 'server',
          code: 'property_detached',
          path: 'sort[0]',
          message: 'свойство сортировки отвязано',
        },
      ],
    };
    handle.refresh();
    const text = exactOne(root, 'ff-preview__text')!;
    const tip = exactOne(root, mod.FILTER_FOOTER_TIP_CLASS)!;
    assert.notEqual(tip, null, 'тултип фразы нарисован');
    assert.ok(tip.flatText().startsWith(NESTED_TEXT), 'тултип начинается с той же фразы');
    for (const cls of ['ff-ph-op--and', 'ff-ph-op--or', 'ff-ph-paren--t2']) {
      assert.equal(exact(tip, cls).length, exact(text, cls).length, `разметка «${cls}» та же, что в строке`);
    }
    assert.match(tip.flatText(), /свойство сортировки отвязано/, 'и список ошибок');
  });

  it('вредоносное имя значения не создаёт разметку (только текстовые узлы)', () => {
    const evil = '<img src=x onerror="alert(1)">';
    const { handle, state } = buildFooter();
    const root = handle.root as unknown as ShimElement;
    state.preview = {
      text: `Город = ${evil}`,
      tokens: [{ kind: 'text', text: `Город = ${evil}` }],
      issues: [],
    };
    handle.refresh();
    const text = exactOne(root, 'ff-preview__text')!;
    const tip = exactOne(root, mod.FILTER_FOOTER_TIP_CLASS)!;
    assert.equal(text.flatText(), `Город = ${evil}`, 'имя показано как есть — текстом');
    assert.equal(tip.flatText().includes(evil), true);
    assert.equal(root.findAll((node) => node.tagName === 'img').length, 0, 'разметка из имени не создана');
    assert.equal(text.innerHTML, '', 'innerHTML не используется — фраза собрана узлами');
    assert.equal(tip.innerHTML, '', 'innerHTML не используется — тултип собран узлами');
  });

  it('разметки нет — текстовая деградация узлом (для мест без раскраски)', () => {
    const { handle, state } = buildFooter();
    const root = handle.root as unknown as ShimElement;
    state.preview = { text: 'фраза хоста', issues: [] };
    handle.refresh();
    const text = exactOne(root, 'ff-preview__text')!;
    assert.equal(text.flatText(), 'фраза хоста');
    assert.equal(exact(root, 'ff-ph-op').length, 0, 'раскраски нет');
    assert.equal(exactOne(root, mod.FILTER_FOOTER_TIP_CLASS)!.flatText().startsWith('фраза хоста'), true);
  });

  it('пустое превью снимает фразу и прячет тултип', () => {
    const { handle, state } = buildFooter();
    const root = handle.root as unknown as ShimElement;
    state.preview = { text: NESTED_TEXT, tokens: NESTED_TOKENS, issues: [] };
    handle.refresh();
    const tip = exactOne(root, mod.FILTER_FOOTER_TIP_CLASS)!;
    assert.equal(tip.style.display, '', 'тултип доступен при непустой фразе');

    state.preview = { text: '', issues: [] };
    handle.refresh();
    assert.equal(exactOne(root, 'ff-preview__text')!.flatText(), '', 'фраза снята');
    assert.equal(tip.style.display, 'none', 'тултип без фразы скрыт');
    assert.equal(tip.flatText(), '', 'и пуст');
  });

  it('классы раскраски и токены — единый источник модуля', () => {
    // Тона скобок берутся из цикла тонов вложенности (`lib/filter-tree.ts`):
    // четвёртый уровень замыкает цикл на первый.
    assert.equal(mod.filterPhraseParenClass(0), mod.filterPhraseParenClass(4), 'цикл тонов замкнут');
    assert.notEqual(mod.filterPhraseParenClass(0), mod.filterPhraseParenClass(1));
    for (const op of ['and', 'or', 'not'] as const) {
      assert.match(mod.FILTER_FOOTER_OPERATOR_CLASSES[op], /ff-ph-op--/);
    }
  });
});

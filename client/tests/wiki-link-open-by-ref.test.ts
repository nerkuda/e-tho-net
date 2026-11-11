/**
 * Wiki-ссылка в тексте комментария на экране «Структуры мыслей» открывает
 * мысль в редакторе ВСЕГДА (ошибка 4c2fe9b0, требование заказчика 2026-11-11):
 * так же, как панель истории и таблица свойств — без диалога «Мысль не
 * отображается / Переключиться на карту мыслей?», без смены активного вида и
 * без сдвига фокуса холста. Прежний контракт диалога (`confirmSwitchToMap`,
 * `wiki-link-confirm-switch.test.ts`) отменён требованием.
 *
 * Поведение проверяется на настоящем `openThoughtByRef` под Node с минимальным
 * DOM-шимом (приём `focus-on-map.test.ts`): `window.etn` подменён — `thoughts.get`
 * отдаёт мысль, `history.rotate` фиксирует историю посещения, `thoughts.focus`
 * ловит уход на карту; редактор получает цель через `setThoughtEditorTarget`
 * (store). Диалог ловится по DOM: каркас `lib/dialog.ts` монтирует
 * `.dialog-backdrop` в `document.body`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { openThoughtByRef } from '../src/renderer/editor/wiki-link.js';
import {
  mountStatusMessage,
  unmountStatusMessage,
  type StatusMessageHost,
} from '../src/renderer/lib/status-message.js';
import { store } from '../src/renderer/state.js';
import type { FocusResponse } from '@etn/shared';
import { ShimElement } from './dom-shim.js';

const NET = '11111111-1111-4111-8111-111111111111';
const PROFILE = '22222222-2222-4222-8222-222222222222';
const TAB = 'tab-1';
const PREV = '33333333-3333-4333-8333-333333333333';
const TARGET = '44444444-4444-4444-8444-444444444444';

/** Минимальная мысль для `openThoughtByRef`/`setThoughtEditorTarget`. */
function thought(id: string, overrides: Record<string, unknown> = {}): any {
  return {
    id,
    title: `Мысль ${id}`,
    type_id: null,
    icon: null,
    active: true,
    marked_for_deletion: false,
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function focusResponse(id: string): FocusResponse {
  const sort = { sort: 'alpha', order: 'asc' } as const;
  return {
    focused: thought(id),
    parents: [],
    children: [],
    siblings: [],
    edges: [],
    sorts: { parents: sort, children: sort, siblings: sort },
  } as unknown as FocusResponse;
}

interface EtnCalls {
  /** Id, ушедшие на карту через `thoughts.focus` (уход с «Структур»). */
  focus: string[];
  /** Запросы мысли по id (`thoughts.get`). */
  get: string[];
  /** Записи истории посещения `[покинутая, открытая, вкладка]`. */
  rotate: Array<[string, string, string | null]>;
}

/**
 * DOM-шим и подмена `window.etn`. Таймеры не срабатывают: тост и сообщение
 * статусбара живут до конца кейса, тестовый процесс не держит живой таймер.
 * Отказ «неактуальная мысль» идёт в зону сообщений статусбара (вид `info`), а
 * не тостом — зона монтируется на структурный шим `host`.
 */
function installDom(opts: { rejectGet?: boolean } = {}): {
  body: ShimElement;
  status: StatusMessageHost;
  calls: EtnCalls;
} {
  const body = new ShimElement('body');
  const calls: EtnCalls = { focus: [], get: [], rotate: [] };
  let timerSeq = 0;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    querySelector: () => null,
    activeElement: null,
  };
  const win: Record<string, unknown> = {
    innerWidth: 1200,
    innerHeight: 800,
    setTimeout: () => {
      timerSeq += 1;
      return timerSeq;
    },
    clearTimeout: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  win['etn'] = {
    thoughts: {
      get: async (_networkId: string, id: string) => {
        calls.get.push(id);
        if (opts.rejectGet === true) throw new Error('мысль недоступна');
        return thought(id);
      },
      focus: async (_networkId: string, id: string) => {
        calls.focus.push(id);
        return focusResponse(id);
      },
    },
    tabs: { updateState: async () => undefined, list: async () => [] },
    ui: { setState: async () => undefined },
    history: {
      rotate: async (oldId: string, newId: string, tabId: string | null) => {
        calls.rotate.push([oldId, newId, tabId]);
      },
    },
    logEvent: () => undefined,
  };
  (globalThis as any).window = win;
  unmountStatusMessage();
  const status: StatusMessageHost = { textContent: '', title: '' };
  mountStatusMessage(status);
  return { body, calls, status };
}

/** Сброс store в состояние «на экране `view`, в фокусе PREV». */
function resetState(view: string): void {
  store.update({
    networkId: NET,
    profileId: PROFILE,
    activeTabId: TAB,
    activeView: view,
    editorTarget: null,
    structuresActiveThought: null,
    structuresActiveThoughtId: null,
    focus: focusResponse(PREV),
    showInactive: false,
  } as any);
}

/** Есть ли в поддереве узел каркаса диалога. */
function hasDialog(node: ShimElement): boolean {
  return node.children.some(
    (child) => child.classList.contains('dialog-backdrop') || hasDialog(child),
  );
}

/** Число живых тостов в поддереве. */
function noticeCount(node: ShimElement): number {
  return node.children.reduce(
    (sum, child) => sum + (child.classList.contains('notice') ? 1 : 0) + noticeCount(child),
    0,
  );
}

describe('openThoughtByRef на «Структурах»: мысль всегда в редакторе (ошибка 4c2fe9b0)', () => {
  it('мысль НЕ в результатах структуры: редактор открыт, диалога нет, вид и фокус не тронуты', async () => {
    const { body, calls } = installDom();
    resetState('structures');
    // Результаты фильтра пусты (structures не монтировались) — прежний код
    // показывал здесь диалог «переключиться на карту?».
    await openThoughtByRef(thought(TARGET));

    assert.equal(store.state.editorTarget?.id, TARGET, 'мысль открыта в редакторе');
    assert.equal(store.state.activeView, 'structures', 'активный вид не переключился');
    assert.equal(store.state.focus?.focused.id, PREV, 'фокус холста не сдвинут');
    assert.deepEqual(calls.focus, [], 'на карту не уходили');
    assert.deepEqual(calls.rotate, [[PREV, TARGET, TAB]], 'история посещения пополнена');
    assert.equal(hasDialog(body), false, 'диалога переключения нет');
  });

  it('мысль В результатах и повторное открытие — то же поведение (паритет)', async () => {
    const { body, calls } = installDom();
    resetState('structures');

    await openThoughtByRef(thought(TARGET));
    const second = '55555555-5555-4555-8555-555555555555';
    await openThoughtByRef(thought(second));

    assert.equal(store.state.editorTarget?.id, second, 'открыта вторая мысль');
    assert.equal(store.state.activeView, 'structures', 'вид прежний');
    assert.equal(store.state.focus?.focused.id, PREV, 'фокус не сдвинут и вторым кликом');
    assert.deepEqual(calls.focus, [], 'карта не активировалась ни разу');
    assert.equal(hasDialog(body), false, 'диалога нет ни в одном случае');
  });

  it('«Дневник»: открытие в редакторе без карты (поведение не изменилось)', async () => {
    const { body, calls } = installDom();
    resetState('chronicle');
    await openThoughtByRef(thought(TARGET));

    assert.equal(store.state.editorTarget?.id, TARGET, 'мысль открыта в редакторе');
    assert.equal(store.state.activeView, 'chronicle', 'вид «Дневник» прежний');
    assert.deepEqual(calls.focus, [], 'фокус холста не переводился');
    assert.equal(hasDialog(body), false, 'диалога нет');
  });

  it('карта и прочие виды: фокус холста (поведение не изменилось)', async () => {
    for (const view of ['map', 'activity', 'publications']) {
      const { body, calls } = installDom();
      resetState(view);
      await openThoughtByRef(thought(TARGET));

      assert.deepEqual(calls.focus, [TARGET], `${view}: мысль ушла в фокус карты`);
      assert.equal(store.state.activeView, view, `${view}: вид не менялся`);
      assert.equal(store.state.editorTarget, null, `${view}: редактор не открывался`);
      assert.equal(hasDialog(body), false, `${view}: диалога нет`);
    }
  });

  it('неактуальная мысль при скрытых неактуальных — отказ в статусбаре, без диалога', async () => {
    const { body, status } = installDom();
    resetState('structures');
    await openThoughtByRef(thought(TARGET, { active: false }));

    assert.equal(store.state.editorTarget, null, 'редактор не открывался');
    assert.equal(store.state.activeView, 'structures', 'вид прежний');
    assert.equal(store.state.focus?.focused.id, PREV, 'фокус не сдвинут');
    assert.ok(status.textContent.trim() !== '', 'показано сообщение об отказе');
    assert.equal(hasDialog(body), false, 'диалога переключения нет');
  });

  it('недоступная мысль на «Структурах» — тост отказа, без диалога переключения', async () => {
    const { body, calls } = installDom({ rejectGet: true });
    resetState('structures');
    await openThoughtByRef(thought(TARGET));

    assert.deepEqual(calls.get, [TARGET], 'запрос мысли был');
    assert.equal(store.state.editorTarget, null, 'редактор не открыт');
    assert.equal(store.state.activeView, 'structures', 'вид прежний');
    assert.deepEqual(calls.focus, [], 'на карту не уходили');
    assert.equal(noticeCount(body), 1, 'показан тост ошибки');
    assert.equal(hasDialog(body), false, 'диалога переключения нет');
  });
});

describe('мёртвый код отменённого диалога удалён (ошибка 4c2fe9b0)', () => {
  const wiki = readFileSync(
    new URL('../src/renderer/editor/wiki-link.ts', import.meta.url),
    'utf8',
  );
  const structures = readFileSync(
    new URL('../src/renderer/screens/structures/structures.ts', import.meta.url),
    'utf8',
  );

  it('ветка «Структур» открывает мысль безусловно: ни проверки результатов, ни диалога', () => {
    const start = wiki.indexOf("store.state.activeView === 'structures'");
    const end = wiki.indexOf("if (store.state.activeView === 'chronicle'", start);
    assert.ok(start >= 0 && end > start, 'ветки вида найдены');
    const branch = wiki.slice(start, end);

    assert.ok(branch.includes('openStructuresThought(thought.id)'), 'открытие через общий вход');
    assert.ok(!branch.includes('if ('), 'в ветке нет условия по результатам фильтра');
    for (const dead of [
      'confirmSwitchToMap',
      'isThoughtInResults',
      'showDialog',
      'focusThoughtOnMap',
    ]) {
      assert.ok(!wiki.includes(dead), `wiki-link.ts: «${dead}» удалён`);
      assert.ok(!branch.includes(dead), `ветка «Структур»: «${dead}» удалён`);
    }
  });

  it('экспорт isThoughtInResults удалён из «Структур», потребителей не осталось', () => {
    assert.ok(!structures.includes('isThoughtInResults'), 'structures.ts: экспорт удалён');
    assert.ok(!wiki.includes('isThoughtInResults'), 'wiki-link.ts: импорт удалён');
  });

  it('ключи отменённого диалога удалены из всех словарей', () => {
    const deadKeys = [
      'wikiLink.title.thoughtNotOtobrazhaetsya',
      'wikiLink.etaThoughtNotOtobrazhaetsyaStruktureThoughts',
      'wikiLink.label.no',
      'wikiLink.label.da',
    ];
    for (const locale of ['ru', 'en', 'zh']) {
      const catalog = readFileSync(
        new URL(`../src/renderer/lib/locales/${locale}.ts`, import.meta.url),
        'utf8',
      );
      for (const key of deadKeys) {
        assert.ok(!catalog.includes(`'${key}'`), `${locale}.ts: ключ ${key} удалён`);
      }
    }
  });
});

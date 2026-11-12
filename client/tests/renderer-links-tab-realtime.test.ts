/**
 * Realtime-свежесть вкладки «Упоминания» (ошибка `91b8afbb`; 08-ui-spec.md §6.7,
 * ревизия 2026-11-11 «решение заказчика: realtime-свежесть вкладки»).
 *
 * Симптом: строки вкладки порождают комментарии и рёбра, но открытая вкладка
 * держала прежний список до переоткрытия мысли — «список обновится при
 * перераскрытии» (отменённый пункт спеки). Вкладка обязана подписываться на
 * инвалидацию запросов тем же механизмом, что «Свойства» (прецедент
 * cb875d0c/343448b6).
 *
 * Проверяется реальный путь `mountEditor` → вкладка «Упоминания» → событие через
 * `initRealtime` (роутер слоя → ключи → `onQueryInvalidated`):
 *  1) `comment.created` ЛЮБОГО владельца перечитывает обе группы (строку
 *     «Ссылок на мысль» порождает ID-ссылка в чужом комментарии) — новая строка
 *     появляется без переоткрытия мысли; `comment.updated`/`comment.deleted`
 *     тоже перечитывают (правка `body_md` меняет состав ID-ссылок);
 *  2) `link.created|updated|deleted` перечитывают вкладку, если конец ребра —
 *     показанная мысль; ребро чужой мысли — нет;
 *  3) посторонние события (`thought.updated`, `attachment.created`,
 *     `property-value.set` с окрестностью показанной мысли) НЕ перечитывают:
 *     вкладка реагирует на класс события, а не на любой погашенный ключ
 *     `focus:@<id>`;
 *  4) повторы волны схлопываются в ОДИН проход (окно склейки слоя), как в
 *     «Свойствах»;
 *  5) раскрытие групп и подпись потолка «Показано 20 из 22» переживают волну:
 *     тело группы перечитывается на месте, группа не пересобирается;
 *  6) свёрнутая группа ленива — волна её не читает, раскрытие читает свежее;
 *  7) снятие панели (`lifecycle.onDispose`) снимает подписку и таймеры: события
 *     после закрытия редактора чтений не дают.
 *
 * Гейт для мутаций: убрать подписку/вызов перечитывания в `links-tab.ts` или
 * перечитывать вкладку на любое событие слоя — кейсы 1–3 падают; убрать
 * коалесирование — падает кейс 4; пересобирать группу вместо перечитывания
 * тела — падает кейс 5.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AnyRealtimeEvent, BacklinkHit, MentionHit, RecordHit, Thought } from '@etn/shared';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// DOM-шим (как в renderer-properties-link-events.test.ts)
// ---------------------------------------------------------------------------

const documentListeners = new Map<string, Set<(event: any) => void>>();

class ShimCustomEvent {
  type: string;
  detail: unknown;
  constructor(type: string, init?: { detail?: unknown }) {
    this.type = type;
    this.detail = init?.detail;
  }
}

function shimDom(): void {
  (globalThis as any).HTMLElement = class {};
  (globalThis as any).CustomEvent = ShimCustomEvent;
  (globalThis as any).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  (globalThis as any).requestAnimationFrame = (cb: () => void): number => {
    cb();
    return 0;
  };
  (globalThis as any).getComputedStyle = () => ({ paddingLeft: '0px', paddingRight: '0px' });
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: { style: { setProperty: () => undefined, removeProperty: () => undefined } },
    body: new ShimElement('body'),
    addEventListener: (type: string, handler: (event: any) => void) => {
      const set = documentListeners.get(type) ?? new Set();
      set.add(handler);
      documentListeners.set(type, set);
    },
    removeEventListener: (type: string, handler: (event: any) => void) => {
      documentListeners.get(type)?.delete(handler);
    },
    dispatchEvent: (event: any): boolean => {
      for (const handler of [...(documentListeners.get(event.type) ?? [])]) handler(event);
      return true;
    },
    querySelector: () => null,
    activeElement: null,
  };
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.innerWidth = 1200;
  win.innerHeight = 800;
  win.dispatchEvent = () => undefined;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
}

// ---------------------------------------------------------------------------
// Данные ответов и фабрики строк
// ---------------------------------------------------------------------------

const NET = 'n1';
const SHOWN = 't1';

function makeThought(overrides: Partial<Thought> = {}): Thought {
  return {
    id: SHOWN,
    title: 'Показанная мысль',
    type_id: 'ty1',
    icon: null,
    icon_kind: 'emoji',
    icon_attachment_id: null,
    active: true,
    is_protected: false,
    is_root: false,
    marked_for_deletion: false,
    marked_for_deletion_at: null,
    marked_for_deletion_by: null,
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    synonyms: [],
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Владельческая строка: постоянный комментарий мысли/связи с упоминанием. */
function mentionHit(ownerId: string, title: string, snippet: string): MentionHit {
  return {
    kind: 'mention',
    owner_type: 'thought',
    owner_id: ownerId,
    title,
    comment_id: `c-${ownerId}`,
    snippet,
    active: true,
  };
}

/** Строка дневниковой записи (потолок вкладки считает их). */
function recordHit(index: number): RecordHit {
  const day = String((index % 28) + 1).padStart(2, '0');
  return {
    kind: 'record',
    comment_id: `r${index}`,
    valid_from: `2026-01-${day}T00:00:00.000Z`,
    valid_to: null,
    use_time: true,
    snippet: `Запись дня ${index}.`,
    targets: [],
    owner_type: 'thought',
    owner_id: SHOWN,
  };
}

/** Фабрика realtime-события (seq растёт — иначе роутер отбросит как опоздавшее). */
function realtimeEvent(
  type: string,
  data: unknown,
  seq: number,
  actor: { user_id: string; client_id: string } = { user_id: 'u2', client_id: 'c2' },
): AnyRealtimeEvent {
  return {
    type,
    seq,
    ts: '2026-01-01T00:00:00.000Z',
    actor,
    network_id: NET,
    audience: 'network',
    layer_id: '00000000-0000-4000-8000-000000000001',
    data,
  } as unknown as AnyRealtimeEvent;
}

// ---------------------------------------------------------------------------
// Поиск по дереву шима
// ---------------------------------------------------------------------------

/** Все элементы с данным классом внутри `root` (поиск в глубину). */
function findAllByClass(root: ShimElement, className: string): ShimElement[] {
  const out: ShimElement[] = [];
  const walk = (node: ShimElement): void => {
    if (node.className.split(/\s+/).includes(className)) out.push(node);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return out;
}

/** Группа вкладки по её стабильному `data-group-id` (ошибка c73bcb60). */
function groupOf(host: ShimElement, groupId: string): ShimElement | null {
  const tab = findAllByClass(host, 'links-tab')[0];
  if (tab === undefined) return null;
  for (const group of findAllByClass(tab, 'group')) {
    if (group.dataset['groupId'] === groupId) return group;
  }
  return null;
}

/** Прямой ребёнок с классом (тело группы — `.group-body`). */
function directChildByClass(parent: ShimElement, className: string): ShimElement | null {
  for (const child of parent.children) {
    if (child.className.split(/\s+/).includes(className)) return child;
  }
  return null;
}

/** Тело группы-списка: `collapsible` оборачивает его в `.group-body`. */
function mentionsBodyOf(group: ShimElement | null): ShimElement | null {
  if (group === null) return null;
  return findAllByClass(group, 'mentions-body')[0] ?? null;
}

/** Владельческие строки группы (прямые дети тела, не строки-записи). */
function ownerRows(body: ShimElement): ShimElement[] {
  return [...body.children].filter((child) =>
    child.className.split(/\s+/).includes('mention-item'),
  );
}

/** Ждёт выполнения условия не дольше `timeout` мс (шаг 10 мс). */
async function waitFor(cond: () => boolean, timeout = 3000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (cond()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return cond();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Реальный путь: вкладка «Упоминания» открыта, события идут через роутер
// ---------------------------------------------------------------------------

describe('вкладка «Упоминания» и realtime-свежесть (ошибка 91b8afbb)', () => {
  it('comment.* и link.* перечитывают развёрнутые группы; посторонние события — нет', async () => {
    shimDom();

    let backlinkCalls = 0;
    let mentionCalls = 0;
    let backlinkHits: BacklinkHit[] = [];
    let mentionHits: BacklinkHit[] = [];
    let realtimeHandler: ((raw: unknown) => void) | null = null;

    (globalThis as any).window.etn = {
      ui: { getState: async () => 'links', setState: async () => undefined },
      thoughts: {
        backlinks: async () => {
          backlinkCalls += 1;
          return backlinkHits.slice();
        },
        mentions: async () => {
          mentionCalls += 1;
          return mentionHits.slice();
        },
        // Чипы строк: имя и оформление приходят батчем (как у всех списков).
        resolve: async (_net: string, ids: string[]) =>
          ids.map((id) => ({ id, title: id, icon: null, icon_kind: 'emoji' })),
        get: async (_net: string, id: string) => makeThought({ id, title: 'HOME' }),
        focus: async () => null,
      },
      links: { get: async () => null, update: async () => undefined },
      structures: {
        // HOME сети: первый корень — служебная привязка (фильтр чипов).
        query: async () => ({ items: [{ id: 'home1' }], total: 1, limit: 1, offset: 0 }),
      },
      publications: { usage: async () => ({ items: [], total: 0, has_more: false }) },
      comments: { list: async () => [], create: async () => undefined },
      admin: { listUsers: async () => [] },
      realtime: {
        onStatusChange: () => undefined,
        onMaintenance: () => undefined,
        onStale: () => undefined,
        onNetworkLost: () => undefined,
        onLayerControl: () => undefined,
        onLanguage: () => undefined,
        onEvent: (handler: (raw: unknown) => void) => {
          realtimeHandler = handler;
        },
        notifyOnline: () => undefined,
      },
    };

    const { resetEventRouter } = await import('../src/renderer/lib/live/index.js');
    resetEventRouter();
    const { mountEditor } = await import('../src/renderer/editor/editor.js');
    const { store } = await import('../src/renderer/state.js');
    const { initRealtime } = await import('../src/renderer/realtime.js');

    // Обе группы-списка развёрнуты: их тела построены и подписаны на слот волны.
    store.update({
      networkId: NET,
      editorTarget: { kind: 'thought', id: SHOWN, thought: makeThought() },
      thoughtTypes: [{ id: 'ty1', name: 'основной тип', is_root: true, parent_id: null } as any],
      linkTypes: [],
      collapsedGroups: { 'links.backlinks': false, 'links.text-mentions': false },
    } as any);

    // Строк-записей 22 при потолке 20: подпись «Показано 20 из 22» — часть
    // состояния, которое волна не имеет права сбросить.
    backlinkHits = [
      mentionHit('x1', 'Первый сославшийся', 'См. [[#t1]] в комментарии'),
      ...Array.from({ length: 22 }, (_, index) => recordHit(index)),
    ];
    mentionHits = [mentionHit('x2', 'Первый упомянувший', 'Упомянул T1 в тексте')];

    initRealtime();
    const host = new ShimElement('div');
    mountEditor(host as any);

    // Первичная сборка: обе группы прочитали свои списки.
    await waitFor(() => backlinkCalls >= 1 && mentionCalls >= 1);
    assert.ok(backlinkCalls >= 1 && mentionCalls >= 1, 'обе группы прочитаны при раскрытии');
    const backlinksGroup = groupOf(host, 'links.backlinks');
    const mentionsGroup = groupOf(host, 'links.text-mentions');
    assert.ok(backlinksGroup !== null, 'группа «Ссылки на мысль» построена');
    assert.ok(mentionsGroup !== null, 'группа «Упоминания в текстах» построена');
    const backlinksBody = mentionsBodyOf(backlinksGroup);
    assert.ok(backlinksBody !== null, 'тело «Ссылок на мысль» развёрнуто');
    await waitFor(() => findAllByClass(backlinksBody!, 'record-row').length === 20);

    const failures: string[] = [];
    const check = (cond: boolean, message: string): void => {
      if (!cond) failures.push(message);
    };

    /** Состояние группы, которое волна НЕ должна сбрасывать. */
    const snapshot = (): {
      body: ShimElement | null;
      ownerRowCount: number;
      recordRowCount: number;
      caption: string;
    } => {
      const body = mentionsBodyOf(groupOf(host, 'links.backlinks'));
      const records = body === null ? [] : findAllByClass(body, 'record-row');
      const caption =
        body === null
          ? ''
          : body.textContent.includes('Показано 20 из 22')
            ? 'Показано 20 из 22'
            : '';
      return {
        body,
        ownerRowCount: body === null ? 0 : ownerRows(body).length,
        recordRowCount: records.length,
        caption,
      };
    };

    const initial = snapshot();
    check(initial.ownerRowCount === 1, `владельческих строк до событий: ${initial.ownerRowCount}`);
    check(initial.recordRowCount === 20, `строк-записей до событий: ${initial.recordRowCount}`);
    check(
      initial.caption === 'Показано 20 из 22',
      `подпись потолка до событий: «${initial.caption}»`,
    );

    let seq = 0;
    const emit = (type: string, data: unknown): void => {
      seq += 1;
      realtimeHandler!(realtimeEvent(type, data, seq));
    };
    const feed = async (type: string, data: unknown): Promise<void> => {
      emit(type, data);
      await sleep(20);
    };

    // --- Кейс 1: comment.created ЛЮБОГО владельца ---------------------------
    // Строку «Ссылок на мысль» порождает ID-ссылка в чужом комментарии:
    // адресовать событие одной мыслью нельзя, поэтому вкладка перечитывает
    // развёрнутые группы по глобальному сигналу слоя.
    backlinkHits = [
      mentionHit('x7', 'Новый сославшийся', 'Теперь [[#t1]] упомянут здесь'),
      ...backlinkHits,
    ];
    const beforeCreate = { back: backlinkCalls, men: mentionCalls };
    await feed('comment.created', {
      comment: { id: 'c-x7', owner_id: 'x7', owner_type: 'thought', kind: 'permanent' },
    });
    await waitFor(() => backlinkCalls > beforeCreate.back && mentionCalls > beforeCreate.men, 2500);
    check(
      backlinkCalls > beforeCreate.back,
      `comment.created не перечитал «Ссылки на мысль» (чтений ${backlinkCalls - beforeCreate.back})`,
    );
    check(
      mentionCalls > beforeCreate.men,
      `comment.created не перечитал «Упоминания в текстах» (чтений ${mentionCalls - beforeCreate.men})`,
    );
    await waitFor(() => snapshot().ownerRowCount === 2, 2000);
    const afterCreate = snapshot();
    check(
      afterCreate.ownerRowCount === 2,
      `новая строка не появилась: ${afterCreate.ownerRowCount}`,
    );
    check(
      afterCreate.body !== null && afterCreate.body.textContent.includes('Новый сославшийся'),
      'новая строка не несёт имени сославшейся мысли',
    );
    // Тело группы перечитано НА МЕСТЕ: раскрытие и потолок не сброшены.
    check(
      afterCreate.body === initial.body,
      'realtime-обновление пересобрало тело группы (сброс раскрытия)',
    );
    check(
      afterCreate.recordRowCount === 20,
      `потолок строк-записей сброшен: ${afterCreate.recordRowCount} вместо 20`,
    );
    check(
      afterCreate.caption === 'Показано 20 из 22',
      `подпись потолка пропала после волны: «${afterCreate.caption}»`,
    );

    // --- Кейс 1б: comment.updated и comment.deleted -------------------------
    backlinkHits = backlinkHits.slice(1);
    const beforeUpdate = { back: backlinkCalls, men: mentionCalls };
    await feed('comment.updated', {
      id: 'c-x7',
      owner_id: 'x7',
      owner_type: 'thought',
      kind: 'permanent',
      changes: { body_md: 'Ссылка снята' },
      version: 2,
    });
    await waitFor(() => backlinkCalls > beforeUpdate.back && mentionCalls > beforeUpdate.men, 2500);
    check(
      backlinkCalls > beforeUpdate.back && mentionCalls > beforeUpdate.men,
      'comment.updated (правка body_md) не перечитал обе группы',
    );
    await waitFor(() => snapshot().ownerRowCount === 1, 2000);
    check(snapshot().ownerRowCount === 1, 'удалённая ID-ссылка осталась строкой группы');

    const beforeDeleted = { back: backlinkCalls, men: mentionCalls };
    await feed('comment.deleted', { id: 'c-x7', owner_id: 'x7', owner_type: 'thought' });
    await waitFor(
      () => backlinkCalls > beforeDeleted.back && mentionCalls > beforeDeleted.men,
      2500,
    );
    check(
      backlinkCalls > beforeDeleted.back && mentionCalls > beforeDeleted.men,
      'comment.deleted не перечитал обе группы',
    );

    // --- Кейс 2: link.* — только конец показанной мысли --------------------
    const beforeForeignLink = { back: backlinkCalls, men: mentionCalls };
    await feed('link.created', {
      link: {
        id: 'l-foreign',
        type_id: 'lt1',
        source_id: 'x3',
        target_id: 'x4',
        active: true,
        version: 1,
      },
    });
    await sleep(450);
    check(
      backlinkCalls === beforeForeignLink.back && mentionCalls === beforeForeignLink.men,
      'ребро ЧУЖОЙ мысли перечитало вкладку',
    );

    const beforeOwnLink = { back: backlinkCalls, men: mentionCalls };
    await feed('link.created', {
      link: {
        id: 'l1',
        type_id: 'lt1',
        source_id: 'x5',
        target_id: SHOWN,
        active: true,
        version: 1,
      },
    });
    await waitFor(
      () => backlinkCalls > beforeOwnLink.back && mentionCalls > beforeOwnLink.men,
      2500,
    );
    check(
      backlinkCalls > beforeOwnLink.back && mentionCalls > beforeOwnLink.men,
      'ребро показанной мысли не перечитало вкладку',
    );

    const beforeLinkUpdate = { back: backlinkCalls, men: mentionCalls };
    await feed('link.updated', { id: 'l1', changes: { marked_for_deletion: true }, version: 2 });
    await waitFor(
      () => backlinkCalls > beforeLinkUpdate.back && mentionCalls > beforeLinkUpdate.men,
      2500,
    );
    check(
      backlinkCalls > beforeLinkUpdate.back && mentionCalls > beforeLinkUpdate.men,
      'link.updated кэшированного ребра не перечитал вкладку',
    );

    const beforeLinkDelete = { back: backlinkCalls, men: mentionCalls };
    await feed('link.deleted', { id: 'l1' });
    await waitFor(
      () => backlinkCalls > beforeLinkDelete.back && mentionCalls > beforeLinkDelete.men,
      2500,
    );
    check(
      backlinkCalls > beforeLinkDelete.back && mentionCalls > beforeLinkDelete.men,
      'link.deleted (концы из кэша) не перечитал вкладку',
    );

    // --- Кейс 3: посторонние события вкладку НЕ трогают --------------------
    // `thought.updated`, `attachment.created` и `property-value.set` гасят
    // окрестность показанной мысли, но строк «Упоминаний» не меняют: вкладка
    // реагирует на КЛАСС события, а не на любой погашенный `focus:@<id>`.
    const beforeForeign = { back: backlinkCalls, men: mentionCalls };
    await feed('thought.updated', { id: SHOWN, changes: { title: 'Новое имя' }, version: 2 });
    await feed('attachment.created', {
      attachment: { id: 'a1', owners: [{ owner_type: 'thought', owner_id: SHOWN }] },
    });
    await feed('property-value.set', { owner_type: 'thought', owner_id: SHOWN, property_id: 'p1' });
    await sleep(450);
    check(
      backlinkCalls === beforeForeign.back && mentionCalls === beforeForeign.men,
      `посторонние события перечитали вкладку (${backlinkCalls - beforeForeign.back}/${mentionCalls - beforeForeign.men})`,
    );

    // --- Кейс 4: волна схлопывается в ОДИН проход -------------------------
    const beforeWave = { back: backlinkCalls, men: mentionCalls };
    emit('comment.created', {
      comment: { id: 'c-w1', owner_id: 'x8', owner_type: 'thought', kind: 'permanent' },
    });
    emit('comment.updated', {
      id: 'c-w2',
      owner_id: 'x9',
      owner_type: 'thought',
      kind: 'permanent',
      changes: { body_md: 'a' },
      version: 2,
    });
    emit('comment.deleted', { id: 'c-w3', owner_id: 'x10', owner_type: 'thought' });
    await waitFor(() => backlinkCalls > beforeWave.back && mentionCalls > beforeWave.men, 2500);
    await sleep(400);
    check(
      backlinkCalls - beforeWave.back === 1,
      `волна из трёх событий дала ${backlinkCalls - beforeWave.back} чтений «Ссылок на мысль» вместо одного`,
    );
    check(
      mentionCalls - beforeWave.men === 1,
      `волна из трёх событий дала ${mentionCalls - beforeWave.men} чтений «Упоминаний в текстах» вместо одного`,
    );

    // --- Кейс 5: свёрнутая группа ленива, раскрытие читает свежее ---------
    const mentionsBefore = groupOf(host, 'links.text-mentions')!;
    const header = directChildByClass(mentionsBefore, 'group-header');
    check(header !== null, 'у группы «Упоминания в текстах» нет заголовка для сворачивания');
    header?.click();
    check(
      directChildByClass(mentionsBefore, 'group-body') === null,
      'сворачивание группы не сняло тело (ленивый контракт collapsible)',
    );
    const beforeCollapsed = { back: backlinkCalls, men: mentionCalls };
    await feed('comment.created', {
      comment: { id: 'c-c1', owner_id: 'x11', owner_type: 'thought', kind: 'permanent' },
    });
    await waitFor(() => backlinkCalls > beforeCollapsed.back, 2500);
    await sleep(400);
    check(
      mentionCalls === beforeCollapsed.men,
      'свёрнутая группа прочитала список по волне (ленивая группа обязана молчать)',
    );
    const beforeExpand = mentionCalls;
    directChildByClass(mentionsBefore, 'group-header')?.click();
    await waitFor(() => mentionCalls > beforeExpand, 2500);
    check(mentionCalls > beforeExpand, 'раскрытие группы не прочитало свежий список');

    // --- Кейс 6: снятие панели снимает подписку и таймеры -----------------
    store.update({ editorTarget: null } as any);
    await waitFor(() => findAllByClass(host, 'links-tab').length === 0, 2500);
    const beforeDispose = { back: backlinkCalls, men: mentionCalls };
    await feed('comment.created', {
      comment: { id: 'c-d1', owner_id: 'x12', owner_type: 'thought', kind: 'permanent' },
    });
    await sleep(500);
    check(
      backlinkCalls === beforeDispose.back && mentionCalls === beforeDispose.men,
      `снятая панель прочитала группы после dispose (${backlinkCalls - beforeDispose.back}/${mentionCalls - beforeDispose.men})`,
    );

    assert.deepEqual(
      failures,
      [],
      `дефекты realtime-свежести вкладки «Упоминания»:\n${failures.join('\n')}`,
    );
  });
});

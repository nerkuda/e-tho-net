/**
 * Живые чекбоксы задач в режиме ПРОСМОТРА комментария (0.16.1, задача
 * `cfb8cb72`, пункт 8 ТЗ живой приёмки).
 *
 * Просмотр записи/постоянного комментария — это готовый `body_html` от единого
 * рендерера: чекбокс в нём отключён и был простым индикатором. Модуль делает его
 * командой: клик переключает `- [ ]` ↔ `- [x]` В ТЕКСТЕ источника
 * (`etn.comments.update`), а не только вид контрола.
 *
 * Здесь проверяется адресация и запись:
 *  • клик по N-му чекбоксу правит N-ю строку с чек-боксом `body_md`;
 *  • вендорский `disabled` снимается, контрол помечается живым классом;
 *  • code fence и `- [ ]` в середине строки не адресуются (грамматика та же,
 *    что у просмотра);
 *  • число чекбоксов DOM и источника не совпало — no-op с откатом контрола
 *    (лучше ничего не делать, чем править чужую строку);
 *  • чекбокс блока трансклюзии правит ИСТОЧНИК по атрибутам блока (раздел —
 *    только в его пределах), а вложенный блок адресуется ближайшей обёртке.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

/** Дождаться промисов записи. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Минимальный DOM: модулю нужны `document.body`, `window.etn` и сеть в store. */
function shimDom(): void {
  const body = new ShimElement('body');
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (text: string) => new ShimElement('#text', undefined, text),
    documentElement: new ShimElement('html'),
    body,
    activeElement: null,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
    dispatchEvent: (): boolean => true,
    querySelector: (): null => null,
    contains: (node: unknown) => body.contains(node as ShimElement | null),
  };
  (ShimElement.prototype as any).ownerDocument = (globalThis as any).document;
  const win = ((globalThis as any).window ??= {}) as Record<string, any>;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.dispatchEvent = (): boolean => true;
  win.addEventListener = (): void => undefined;
  win.removeEventListener = (): void => undefined;
  win.matchMedia = () => ({
    matches: false,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  });
}

/** Чекбокс вендорской разметки (`input[type=checkbox][disabled]`). */
function checkbox(host: ShimElement, checked: boolean): ShimElement {
  const box = new ShimElement('input');
  box.type = 'checkbox';
  box.checked = checked;
  box.disabled = true;
  host.append(box);
  return box;
}

/**
 * Обёртка блока трансклюзии в `body_html` — такую разметку ставит единый
 * рендерер (`data-transclusion-source`/`data-transclusion-section`).
 */
function transclusionBlock(host: ShimElement, sourceId: string, section?: string): ShimElement {
  const block = new ShimElement('div', 'md-transclusion');
  block.setAttribute('data-transclusion-source', sourceId);
  if (section !== undefined) block.setAttribute('data-transclusion-section', section);
  host.append(block);
  return block;
}

/** Клик по контролу: в браузере `checked` меняется ДО `click`. */
function click(host: ShimElement, box: ShimElement): void {
  host.emit('click', {
    target: box,
    preventDefault: (): void => undefined,
    stopPropagation: (): void => undefined,
  });
}

/**
 * Клик с НАСТОЯЩИМ откатом отменённого нажатия: браузер меняет `checked` до
 * `click`, а отменённое нажатие откатывает его к прежнему значению
 * (legacy-canceled-activation). Откат применяется ПОСЛЕ обработчиков — внутри
 * `click` контрол ещё держит новое значение. Так воспроизводится живой дефект
 * «сервер записал `[x]`, а контрол остался визуально пустым» (вердикт 425ef01d).
 */
function clickWithBrowserRevert(host: ShimElement, box: ShimElement, revertTo: boolean): void {
  host.emit('click', {
    target: box,
    preventDefault: (): void => undefined,
    stopPropagation: (): void => undefined,
  });
  box.checked = revertTo;
}

interface Api {
  updates: Array<{ bodyMd: string; version: number }>;
  /** Комментарии, в которые писала правка (трансклюзия адресует ИСТОЧНИК). */
  ids: string[];
  /** Постоянные комментарии мыслей-источников: id мысли → комментарий. */
  sources: Map<string, { id: string; body_md: string; version: number }>;
}

/** Подставной `window.etn` с управляемым источником комментария. */
function fakeApi(bodyMd: string, version = 1): Api {
  const api: Api = { updates: [], ids: [], sources: new Map() };
  const stub = {
    comments: {
      get: async (_networkId: string, id: string) => {
        for (const source of api.sources.values()) {
          if (source.id === id) return { ...source, body_html: '<p>source</p>' };
        }
        return { id, body_md: bodyMd, version, body_html: '<p>html</p>' };
      },
      list: async (_networkId: string, _ownerType: string, ownerId: string) => {
        const source = api.sources.get(ownerId);
        if (source === undefined) return [];
        return [
          {
            id: source.id,
            owner_type: 'thought',
            owner_id: ownerId,
            kind: 'permanent',
            body_md: source.body_md,
            version: source.version,
            body_html: '<p>source</p>',
          },
        ];
      },
      update: async (
        _networkId: string,
        id: string,
        input: { body_md?: string },
        expected?: number,
      ) => {
        api.updates.push({ bodyMd: input.body_md ?? '', version: expected ?? 0 });
        api.ids.push(id);
        return {
          id,
          body_md: input.body_md,
          version: (expected ?? 0) + 1,
          body_html: '<p>new</p>',
        };
      },
    },
  };
  (globalThis as any).etn = stub;
  ((globalThis as any).window as Record<string, unknown>)['etn'] = stub;
  return api;
}

const { LIVE_TASK_CHECKBOX_CLASS, wireTaskCheckboxes } =
  await import('../src/renderer/editor/task-checkbox-toggle.js');

before(async () => {
  shimDom();
  const state = await import('../src/renderer/state.js');
  state.store.update({ networkId: 'n1', network: { first_day_of_week: 1 } } as any);
});

describe('живые чекбоксы просмотра комментария (пункт 8 ТЗ 2026-11-18)', () => {
  it('вендорский контрол становится живым: disabled снят, класс поставлен', () => {
    fakeApi('- [ ] задача');
    const host = new ShimElement('div');
    const box = checkbox(host, false);
    const off = wireTaskCheckboxes(host as unknown as HTMLElement, () => ({ commentId: 'c1' }));
    assert.equal(box.disabled, false, 'disabled снят — контрол шлёт клики');
    assert.ok(box.classList.contains(LIVE_TASK_CHECKBOX_CLASS), 'контрол помечен живым классом');
    off();
  });

  it('клик переключает `[ ]` → `[x]` в body_md источника', async () => {
    const api = fakeApi('- [ ] первая\n- [x] вторая', 3);
    const host = new ShimElement('div');
    const first = checkbox(host, false);
    checkbox(host, true);
    const saved: string[] = [];
    wireTaskCheckboxes(host as unknown as HTMLElement, () => ({
      commentId: 'c1',
      onSaved: (md) => saved.push(md),
    }));
    first.checked = true;
    click(host, first);
    await flush();
    assert.deepEqual(
      api.updates,
      [{ bodyMd: '- [x] первая\n- [x] вторая', version: 3 }],
      'правлена строка ИМЕННО этого чекбокса; соседняя не тронута, версия источника — в PATCH',
    );
    assert.deepEqual(
      saved,
      ['- [x] первая\n- [x] вторая'],
      'владельцу просмотра отдан новый markdown',
    );
  });

  it('клик снимает отметку: `[x]` → `[ ]`', async () => {
    const api = fakeApi('- [x] задача', 1);
    const host = new ShimElement('div');
    const box = checkbox(host, true);
    wireTaskCheckboxes(host as unknown as HTMLElement, () => ({ commentId: 'c1' }));
    box.checked = false;
    click(host, box);
    await flush();
    assert.deepEqual(api.updates, [{ bodyMd: '- [ ] задача', version: 1 }], 'отметка снята');
  });

  it('`- [ ]` внутри code fence не адресуется', async () => {
    const api = fakeApi('```\n- [ ] не задача\n```\n- [ ] задача', 1);
    const host = new ShimElement('div');
    const box = checkbox(host, false);
    wireTaskCheckboxes(host as unknown as HTMLElement, () => ({ commentId: 'c1' }));
    box.checked = true;
    click(host, box);
    await flush();
    assert.deepEqual(
      api.updates,
      [{ bodyMd: '```\n- [ ] не задача\n```\n- [x] задача', version: 1 }],
      'правлена строка после fence, а не «- [ ]» внутри него',
    );
  });

  it('`- [ ]` внутри `~~~` и незакрытого fence не адресуется (@152@)', async () => {
    // Ограждения разные, состояние блока определяет единый рендерер: первая
    // строка после закрытого `~~~` — настоящая задача, а всё после незакрытого
    // fence — код до конца комментария.
    const api = fakeApi(['~~~', '- [ ] тильда', '~~~', '- [ ] настоящая'].join('\n'), 1);
    const host = new ShimElement('div');
    const box = checkbox(host, false);
    wireTaskCheckboxes(host as unknown as HTMLElement, () => ({ commentId: 'c1' }));
    box.checked = true;
    click(host, box);
    await flush();
    assert.deepEqual(
      api.updates,
      [{ bodyMd: ['~~~', '- [ ] тильда', '~~~', '- [x] настоящая'].join('\n'), version: 1 }],
      'правлена настоящая строка, а не `- [ ]` в тильдах',
    );

    const unclosed = fakeApi('```\n- [ ] раз\n- [ ] два', 2);
    const unclosedHost = new ShimElement('div');
    const stray = checkbox(unclosedHost, false);
    wireTaskCheckboxes(unclosedHost as unknown as HTMLElement, () => ({ commentId: 'c2' }));
    stray.checked = true;
    click(unclosedHost, stray);
    await flush();
    assert.deepEqual(
      unclosed.updates,
      [],
      'строк задач в источнике нет: запись не производится (безопасный no-op)',
    );
    assert.equal(stray.checked, false, 'контрол возвращён к снапшоту');
  });

  it('просмотр кода не даёт ни живого чекбокса, ни пункта задачи (@152@)', async () => {
    // Единый рендерер — источник состояния код-блока: в HTML нет ни одного
    // `task-list-item`, поэтому `wireTaskCheckboxes` нечего оживлять.
    const { renderMarkdown } = await import('@etn/markdown');
    const html = renderMarkdown(
      ['```', '- [ ] в бэктиках', '```', '~~~', '- [ ] в тильдах', '~~~'].join('\n'),
    );
    assert.doesNotMatch(html, /task-list-item-checkbox/, 'интерактивного чекбокса кода нет');
    assert.doesNotMatch(html, /task-list-item/, 'пункта задачи код не создаёт');
    assert.equal(
      (html.match(/<pre><code/g) ?? []).length,
      2,
      'оба блока остались кодом (оба вида ограждений)',
    );

    const api = fakeApi(['```', '- [ ] код', '```'].join('\n'), 1);
    const host = new ShimElement('div');
    const off = wireTaskCheckboxes(host as unknown as HTMLElement, () => ({ commentId: 'c3' }));
    host.emit('click', { target: host, preventDefault: (): void => undefined });
    await flush();
    assert.deepEqual(api.updates, [], 'в просмотре кода писать нечего');
    off();
  });

  it('число чекбоксов DOM и источника не совпало — no-op с откатом контрола', async () => {
    const api = fakeApi('- [ ] только одна строка', 1);
    const host = new ShimElement('div');
    const first = checkbox(host, false);
    checkbox(host, false);
    wireTaskCheckboxes(host as unknown as HTMLElement, () => ({ commentId: 'c1' }));
    first.checked = true;
    click(host, first);
    await flush();
    assert.deepEqual(api.updates, [], 'источник не тронут: адрес неоднозначен');
    assert.equal(first.checked, false, 'контрол возвращён к снапшоту');
  });

  it('трансклюзия: чекбокс правит строку тела ИСТОЧНИКА, а не владельца (п.3 пачки 6)', async () => {
    // Владелец просмотра — ОДНА строка-трансклюзия `![[#id]]`; его `body_html`
    // несёт развёрнутый блок источника с тремя чекбоксами. Клик обязан править
    // постоянный комментарий ИСТОЧНИКА (адрес блока), а не тело владельца.
    const sourceId = '11111111-1111-4111-8111-111111111111';
    const api = fakeApi(`![[#${sourceId}]]`, 7);
    api.sources.set(sourceId, {
      id: 'c-source',
      body_md: '- [ ] первая\n- [ ] вторая\n- [x] третья',
      version: 5,
    });
    const host = new ShimElement('div');
    const block = transclusionBlock(host, sourceId);
    const first = checkbox(block, false);
    checkbox(block, false);
    checkbox(block, true);
    wireTaskCheckboxes(host as unknown as HTMLElement, () => ({ commentId: 'c-owner' }));
    assert.ok(
      first.classList.contains(LIVE_TASK_CHECKBOX_CLASS),
      'контрол блока трансклюзии тоже становится живым (снимается вендорский disabled)',
    );
    first.checked = true;
    click(host, first);
    await flush();
    assert.deepEqual(
      api.ids,
      ['c-source'],
      'адрес — постоянный комментарий источника, а не комментарий просмотра',
    );
    assert.deepEqual(
      api.updates,
      [{ bodyMd: '- [x] первая\n- [ ] вторая\n- [x] третья', version: 5 }],
      'правлена ровно строка своего чекбокса внутри источника; соседние целы',
    );
    assert.equal(first.checked, true, 'успешная отметка видна без пересборки просмотра');
  });

  it('трансклюзия раздела: правка не выходит за фрагмент `![[#id#Раздел]]`', async () => {
    // Ссылка адресовала раздел: в блоке только его чекбоксы. Индекс считается
    // по разделу, а строки источника за его пределами остаются нетронутыми.
    const api = fakeApi('owner', 1);
    api.sources.set('src', {
      id: 'c-source',
      body_md: '# Дела\n- [ ] внутри\n\n# Прочее\n- [ ] снаружи',
      version: 2,
    });
    const host = new ShimElement('div');
    const block = transclusionBlock(host, 'src', 'Дела');
    const inside = checkbox(block, false);
    wireTaskCheckboxes(host as unknown as HTMLElement, () => ({ commentId: 'c-owner' }));
    inside.checked = true;
    click(host, inside);
    await flush();
    assert.deepEqual(
      api.updates,
      [{ bodyMd: '# Дела\n- [x] внутри\n\n# Прочее\n- [ ] снаружи', version: 2 }],
      'правлен раздел; строка за его пределами цела',
    );
  });

  it('трансклюзия: адрес не строится (числа разошлись) — no-op с откатом контрола', async () => {
    // В блоке два контрола, а в источнике одна строка с чек-боксом: адрес
    // неоднозначен — правка наугад задела бы чужую строку.
    const api = fakeApi('owner', 1);
    api.sources.set('src', { id: 'c-source', body_md: '- [ ] только одна', version: 1 });
    const host = new ShimElement('div');
    const block = transclusionBlock(host, 'src');
    const first = checkbox(block, false);
    checkbox(block, false);
    wireTaskCheckboxes(host as unknown as HTMLElement, () => ({ commentId: 'c-owner' }));
    first.checked = true;
    click(host, first);
    await flush();
    assert.deepEqual(api.ids, [], 'запросов нет: адрес не построен');
    assert.deepEqual(api.updates, [], 'источник не тронут');
    assert.equal(first.checked, false, 'контрол возвращён к снапшоту (no-op, а не догадка)');
  });

  it('вложенная трансклюзия: чекбокс адресуется БЛИЖАЙШЕМУ блоку', async () => {
    const api = fakeApi('owner', 1);
    api.sources.set('outer', { id: 'c-outer', body_md: '- [ ] внешняя', version: 1 });
    api.sources.set('inner', { id: 'c-inner', body_md: '- [ ] вложенная', version: 1 });
    const host = new ShimElement('div');
    const outer = transclusionBlock(host, 'outer');
    const outerBox = checkbox(outer, false);
    const inner = transclusionBlock(outer, 'inner');
    const innerBox = checkbox(inner, false);
    wireTaskCheckboxes(host as unknown as HTMLElement, () => ({ commentId: 'c-owner' }));

    innerBox.checked = true;
    click(host, innerBox);
    await flush();
    assert.deepEqual(api.ids, ['c-inner'], 'контрол вложенного блока правит свой источник');
    assert.deepEqual(api.updates, [{ bodyMd: '- [x] вложенная', version: 1 }]);

    api.ids.length = 0;
    api.updates.length = 0;
    outerBox.checked = true;
    click(host, outerBox);
    await flush();
    assert.deepEqual(api.ids, ['c-outer'], 'контролы вложенного блока не сдвигают индекс внешнего');
    assert.deepEqual(api.updates, [{ bodyMd: '- [x] внешняя', version: 1 }]);
  });

  it('без адреса комментария клик ничего не пишет', async () => {
    const api = fakeApi('- [ ] задача', 1);
    const host = new ShimElement('div');
    const box = checkbox(host, false);
    wireTaskCheckboxes(host as unknown as HTMLElement, () => null);
    box.checked = true;
    click(host, box);
    await flush();
    assert.deepEqual(api.updates, [], 'просмотр без источника остаётся только индикатором');
  });

  it('отписка снимает слушатель', async () => {
    const api = fakeApi('- [ ] задача', 1);
    const host = new ShimElement('div');
    const box = checkbox(host, false);
    const off = wireTaskCheckboxes(host as unknown as HTMLElement, () => ({ commentId: 'c1' }));
    off();
    box.checked = true;
    click(host, box);
    await flush();
    assert.deepEqual(api.updates, [], 'после отписки клики не обрабатываются');
  });

  it('своя запись помечается ДО PATCH и снимается после ответа (гашение эха)', async () => {
    fakeApi('- [ ] задача', 2);
    const host = new ShimElement('div');
    const box = checkbox(host, false);
    const order: string[] = [];
    wireTaskCheckboxes(host as unknown as HTMLElement, () => ({
      commentId: 'c1',
      beginSave: () => {
        order.push('begin');
        return () => order.push('release');
      },
      onSaved: () => order.push('saved'),
    }));
    box.checked = true;
    click(host, box);
    await flush();
    // Сервер публикует `comment.updated` ДО ответа PATCH: метка обязана стоять
    // уже во время запроса, иначе эхо перерисует просмотр и сорвёт прокрутку.
    assert.deepEqual(order, ['begin', 'saved', 'release'], 'метка живёт ровно на время записи');
  });

  it('владелец просмотра получает ОБНОВЛЁННЫЙ комментарий (пункт 9 уточнения 2026-11-19)', async () => {
    fakeApi('- [ ] задача', 4);
    const host = new ShimElement('div');
    const box = checkbox(host, false);
    const saved: Array<{ md: string; html: string; version: number }> = [];
    wireTaskCheckboxes(host as unknown as HTMLElement, () => ({
      commentId: 'c1',
      onSaved: (md, html, comment) => saved.push({ md, html, version: comment.version }),
    }));
    box.checked = true;
    click(host, box);
    await flush();
    // Третий аргумент — ответ сервера: строка ленты обновляется точечно
    // (html + версия), без перезапроса и без пересборки карточки.
    assert.deepEqual(
      saved,
      [{ md: '- [x] задача', html: '<p>new</p>', version: 5 }],
      'снапшот строки обновляется из ответа comments.update',
    );
  });

  it('после успешной записи контрол показывает отметку (вердикт 425ef01d)', async () => {
    const api = fakeApi('- [ ] задача');
    const host = new ShimElement('div');
    const box = checkbox(host, false);
    wireTaskCheckboxes(host as unknown as HTMLElement, () => ({ commentId: 'c1' }));
    // Браузер: `checked` уже новое, но отменённый клик откатывает его обратно
    // (после обработчиков — `want` читается ещё верно).
    box.checked = true;
    clickWithBrowserRevert(host, box, false);
    assert.equal(box.checked, false, 'до ответа сервера браузер вернул прежнее состояние');
    await flush();
    assert.deepEqual(api.updates, [{ bodyMd: '- [x] задача', version: 1 }], 'источник записан');
    assert.equal(box.checked, true, 'успешная отметка видна в просмотре (точечно, без пересборки)');
  });

  it('отказ записи возвращает контрол в прежнее состояние', async () => {
    fakeApi('- [ ] задача');
    (globalThis as any).etn.comments.update = async (): Promise<never> => {
      throw new Error('boom');
    };
    const host = new ShimElement('div');
    const box = checkbox(host, false);
    wireTaskCheckboxes(host as unknown as HTMLElement, () => ({ commentId: 'c1' }));
    box.checked = true;
    clickWithBrowserRevert(host, box, false);
    await flush();
    assert.equal(box.checked, false, 'отметка не показана без успешной записи');
  });
});

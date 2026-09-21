/**
 * Regression test for ETN error 9ee8e608 «Счётчик значений свойства-связи в
 * редакторе не обновляется после собственного сохранения».
 *
 * Симптом: в таблице «Свойства типа» заголовок строки свойства-связи несёт
 * число целей — «Соавторы (2)». Убрал цель (или добавил) и сохранил: чипы в
 * поле обновились, а счётчик остался прежним, пока вкладка не пересоберётся.
 *
 * Причина: счётчик рисуется один раз при `reload()` (`valueCountOf`), после
 * своей записи таблица не перечитывается — `currentReload` дёргается только
 * realtime-подпиской на `property-value.*`, а собственное realtime-эхо
 * собственного клиента до рендерера не доходит (G8-applier), полный пересбор
 * редактора не запускается (гейт `mountEditor` сравнивает версию владельца, а
 * запись значения версию мысли не поднимает).
 *
 * Здесь проверяется реальный путь: удаление цели из чипа свойства-связи в
 * редакторе («Свойства типа») успешно пишет значение и СРАЗУ обновляет
 * счётчик в заголовке строки — вплоть до нуля при полной очистке.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// DOM-шим с записью слушателей (по образцу renderer-properties.test.ts)
// ---------------------------------------------------------------------------

function collect(
  root: ShimElement,
  pred: (el: ShimElement) => boolean,
  out: ShimElement[] = [],
): ShimElement[] {
  for (const child of root.children) {
    if (pred(child)) out.push(child);
    collect(child, pred, out);
  }
  return out;
}

function shimDom(): void {
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (text: string) => new ShimElement('#text', undefined, text),
    documentElement: { style: { setProperty: () => undefined, removeProperty: () => undefined } },
    body: new ShimElement('body'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    querySelector: () => null,
    activeElement: null,
  };
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  win['addEventListener'] ??= () => undefined;
  win['removeEventListener'] ??= () => undefined;
  win['setTimeout'] ??= (fn: () => void) => setTimeout(fn, 0) as unknown as number;
  win['clearTimeout'] ??= (t: unknown) => clearTimeout(t as NodeJS.Timeout);
  win['dispatchEvent'] ??= () => undefined;
  win['innerWidth'] ??= 1280;
  win['innerHeight'] ??= 800;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Ссылки на ячейки, добытые обходом дерева. */
function nameLabelOf(box: ShimElement): string {
  const cell = collect(box, (el) => el.className === 'prop-name-cell')[0];
  return cell?.children[0]?.textContent ?? '';
}

/** Кнопки «✕» чипов (title 'Убрать из значения'). */
function chipRemoveButtons(box: ShimElement): ShimElement[] {
  return collect(box, (el) => el.title === 'Убрать из значения');
}

/** Прогон: свойство-связь «Соавторы» с двумя целями, удаление целей из чипов. */
describe('счётчик значений свойства-связи обновляется после своей записи (9ee8e608)', () => {
  it('удаление цели и полная очистка сразу обновляют «(N)» в заголовке строки', async () => {
    shimDom();
    const win = ((globalThis as any).window ?? {}) as Record<string, unknown>;
    const etnApi = (win['etn'] ??= {}) as Record<string, unknown>;

    const setCalls: Array<{ key: string; value: unknown }> = [];
    etnApi['types'] = {
      listTypeProperties: async () => [
        {
          id: 'lk1',
          property_id: 'lk1',
          owner_type: 'thought_type',
          owner_id: 'ty1',
          key: 'Соавторы',
          value_type: 'link',
          config: {},
          required: false,
          position: 0,
          description: null,
        },
      ],
    };
    etnApi['properties'] = {
      get: async () => [
        {
          id: 'vlk1',
          owner_type: 'thought',
          owner_id: 't1',
          property_id: 'lk1',
          outside_type: false,
          property_name: 'Соавторы',
          value_type: 'link',
          direction: 'out',
          link_type_id: null,
          structural: false,
          count: 2,
          values: [
            { link_id: 'e1', target_id: 'ta1', target_title: 'Мысль ta1', target_type_id: null, comment: null },
            { link_id: 'e2', target_id: 'ta2', target_title: 'Мысль ta2', target_type_id: null, comment: null },
          ],
        },
      ],
      set: async (_n: string, _ot: string, _oi: string, key: string, value: unknown) => {
        setCalls.push({ key, value });
      },
    };
    etnApi['thoughts'] = {
      resolve: async (_n: string, ids: string[]) =>
        ids.map((id) => ({
          id,
          title: `Мысль ${id}`,
          type_id: null,
          icon: null,
          icon_kind: 'emoji',
          icon_attachment_id: null,
          active: true,
          marked_for_deletion: false,
          fg_color: null,
          bg_color: null,
          font_bold: null,
          font_italic: null,
          font_underline: null,
          font_strike: null,
        })),
      search: async () => [],
    };
    etnApi['system'] = { openExternal: async () => '' };
    etnApi['ui'] = { setState: async () => undefined };

    const { propertiesInternals } = await import('../src/renderer/editor/properties.js');
    const { store } = await import('../src/renderer/state.js');
    // Без фокуса: гейт `inFocusNeighbourhood` не пропускает пересчёт карты, но
    // счётчик строки обязан обновиться и в этом случае (он не карта).
    store.update({ networkId: 'n1', focus: null } as any);

    const ctx = {
      ownerType: 'thought' as const,
      ownerId: 't1',
      thought: {
        id: 't1',
        title: 'T',
        type_id: 'ty1',
        icon: null,
        icon_kind: 'emoji',
        active: true,
        is_protected: false,
        is_root: false,
        fg_color: null,
        bg_color: null,
        font_bold: null,
        font_italic: null,
        font_underline: null,
        font_strike: null,
        synonyms: [],
        version: 1,
        created_at: '2026',
        updated_at: '2026',
      },
      link: null,
    };
    const box = propertiesInternals.buildPropertiesBody(ctx as any) as unknown as ShimElement;
    await wait(80);

    assert.equal(nameLabelOf(box), 'Соавторы (2)', 'стартовый счётчик из value.count');

    // Убираем одну цель: чип «✕» → save(['ta1']) → счётчик должен стать (1).
    const removes = chipRemoveButtons(box);
    assert.ok(removes.length >= 2, 'чипы целей несут кнопку «✕»');
    removes[0]!.click();
    await wait(50);
    const afterOne = setCalls[0]?.value;
    assert.ok(Array.isArray(afterOne), 'запись значения-связи ушла массивом целей');
    assert.equal(afterOne.length, 1, 'запись значения-связи ушла с оставшейся целью');
    assert.equal(nameLabelOf(box), 'Соавторы (1)', 'счётчик обновлён сразу после записи');

    // Убираем последнюю цель: save(null) → полная очистка, счётчик (0).
    const lastRemove = chipRemoveButtons(box);
    assert.equal(lastRemove.length, 1, 'осталась одна цель-чип');
    lastRemove[0]!.click();
    await wait(50);
    assert.equal(setCalls[1]?.value, null, 'очистка пишется как set(..., null)');
    assert.equal(nameLabelOf(box), 'Соавторы (0)', 'счётчик обнулён сразу после очистки');
  });
});

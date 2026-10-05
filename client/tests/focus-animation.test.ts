/**
 * Оркестратор плавной смены фокуса на карте (`canvas/transition.ts`, спека
 * «FLIP-анимация холста», задача e9f0af94).
 *
 * Модуль — DOM-логика поверх Web Animations API: фазы (полёт → своп →
 * достройка), удержание старого содержимого фокуса до приземления, принудительное
 * завершение при реальном обновлении и мгновенный переход при
 * `prefers-reduced-motion`. Проверяется на общем DOM-ши́ме (`dom-shim.ts`) с
 * подменёнными `window.setTimeout`/`getComputedStyle`/`matchMedia` и фейковым
 * `Element.animate` — реальный движок анимаций в Node недоступен.
 *
 * Куда смотреть глазами (приёмка) — в отчёте задачи: смена фокуса из соседней
 * зоны и издалека, быстрые клики подряд, reduced-motion.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShimElement, type ShimRect } from './dom-shim.js';
import { clearFocusOrigin, noteFocusOrigin, takeFocusOrigin } from '../src/renderer/lib/focus-origin.js';

/** Значения токенов, которые «возвращает» getComputedStyle. */
const ANIM_TOKENS: Record<string, string> = {
  '--anim-focus-flight': '400ms',
  '--anim-focus-settle': '260ms',
  '--anim-focus-fade': '300ms',
  '--anim-focus-ease': 'cubic-bezier(0.2, 0.7, 0.3, 1)',
  '--anim-network-reveal': '300ms',
};

interface FakeAnimation {
  el: ShimElement;
  keyframes: any[];
  options: any;
  cancelled: boolean;
  cancel(): void;
}

/** Все созданные анимации текущего теста. */
let created: FakeAnimation[] = [];

(ShimElement.prototype as any).animate = function animate(
  this: ShimElement,
  keyframes: any[],
  options: any,
): FakeAnimation {
  const rec: FakeAnimation = {
    el: this,
    keyframes,
    options,
    cancelled: false,
    cancel(): void {
      rec.cancelled = true;
    },
  };
  created.push(rec);
  return rec;
};

/** Управляемые таймеры: тот же контракт, что у window.setTimeout. */
let clock = 0;
let nextTimerId = 1;
let scheduled: Array<{ id: number; at: number; fn: () => void }> = [];
/** `prefers-reduced-motion` текущего теста. */
let reducedMotion = false;

function installDom(): void {
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    body: new ShimElement('body'),
  };
  (globalThis as any).window = {
    matchMedia: () => ({ matches: reducedMotion }),
    getComputedStyle: () => ({
      getPropertyValue: (name: string): string => ANIM_TOKENS[name] ?? '',
    }),
    setTimeout: (fn: () => void, ms?: number): number => {
      const id = nextTimerId++;
      scheduled.push({ id, at: clock + (ms ?? 0), fn });
      return id;
    },
    clearTimeout: (id: number): void => {
      scheduled = scheduled.filter((t) => t.id !== id);
    },
  };
}

/** Прогоняет таймеры до момента `clock + ms` (вложенные — тоже). */
function advance(ms: number): void {
  clock += ms;
  for (;;) {
    const due = scheduled.filter((t) => t.at <= clock).sort((a, b) => a.at - b.at)[0];
    if (due === undefined) return;
    scheduled = scheduled.filter((t) => t !== due);
    due.fn();
  }
}

let mod: any = null;

async function load(): Promise<any> {
  if (mod === null) {
    installDom();
    mod = await import('../src/renderer/canvas/transition.js');
  }
  // Каждый тест начинает с чистой истории.
  mod.finishFocusTransition();
  created = [];
  clock = 0;
  nextTimerId = 1;
  scheduled = [];
  reducedMotion = false;
  clearFocusOrigin();
  return mod;
}

type Zone = 'focus' | 'parents' | 'siblings' | 'children';

function rect(left: number, top: number, width = 100, height = 40): ShimRect {
  return { left, top, right: left + width, bottom: top + height, width, height };
}

function cloud(id: string, zone: Zone, box: ShimRect): ShimElement {
  const node = new ShimElement('div', zone === 'focus' ? 'cloud focus-cloud' : 'cloud');
  node.dataset['id'] = id;
  if (zone !== 'focus') node.dataset['dir'] = zone;
  node.rect = box;
  return node;
}

/** Хост с приведённым набором облачков и слоем линий связей. */
function makeHost(clouds: ShimElement[]): ShimElement {
  const host = new ShimElement('div', 'canvas-host');
  host.rect = rect(0, 0, 1000, 800);
  const links = new ShimElement('svg', 'links-overlay links-layer');
  host.append(links, ...clouds);
  return host;
}

function layer(host: ShimElement): ShimElement | null {
  return host.querySelector('.focus-anim-layer') as ShimElement | null;
}

/** Пересобирает состав хоста под новую раскладку, сохраняя слой линий. */
function relayout(host: ShimElement, clouds: ShimElement[]): void {
  const links = host.querySelector('.links-layer') as ShimElement;
  host.replaceChildren(links, ...clouds);
}

describe('transition: плавная смена фокуса (задача e9f0af94)', () => {
  it('reduced-motion — мгновенный переход без слоёв и таймеров', async () => {
    const T = await load();
    reducedMotion = true;
    const host = makeHost([cloud('f', 'focus', rect(400, 100, 200, 80)), cloud('a', 'children', rect(100, 500))]);
    const before = T.captureClouds(host as unknown as HTMLElement);
    relayout(host, [cloud('a', 'focus', rect(400, 100, 200, 80)), cloud('f', 'children', rect(100, 500))]);

    let drawn = 0;
    T.playFocusTransition(host as unknown as HTMLElement, before, () => {
      drawn += 1;
    });

    assert.equal(layer(host), null, 'слой анимации не создаётся');
    assert.equal(created.length, 0, 'анимации не запускаются');
    assert.equal(drawn, 1, 'линии перерисовываются сразу');
  });

  it('полёт удерживает старое содержимое фокуса и свопает его на приземлении', async () => {
    const T = await load();
    const host = makeHost([
      cloud('f', 'focus', rect(400, 100, 200, 80)),
      cloud('a', 'children', rect(100, 500)),
      cloud('b', 'children', rect(220, 500)),
    ]);
    const before = T.captureClouds(host as unknown as HTMLElement);
    relayout(host, [
      cloud('a', 'focus', rect(400, 100, 200, 80)),
      cloud('f', 'parents', rect(100, 100)),
      cloud('b', 'children', rect(100, 500)),
      cloud('d', 'children', rect(220, 500)),
    ]);

    let drawn = 0;
    T.playFocusTransition(host as unknown as HTMLElement, before, () => {
      drawn += 1;
    });

    // Фаза полёта: в центре — клон старого фокуса, летит клон нового.
    const anim = layer(host);
    assert.ok(anim !== null, 'создан слой анимации');
    assert.equal(anim.childElementCount, 2, 'удерживаемый фокус + летящий клон');
    const focusAfter = host.querySelectorAll('.cloud').find((c) => c.classList.contains('focus-cloud'));
    assert.equal(focusAfter?.style.getPropertyValue('opacity'), '0', 'новый фокус скрыт до свопа');
    assert.equal(
      host.querySelectorAll('.cloud').find((c) => c.dataset['id'] === 'f' && c.dataset['dir'] === 'parents')
        ?.style.getPropertyValue('opacity'),
      '0',
      'бывший фокус ждёт в своей зоне',
    );
    const overlays = host.querySelectorAll('.links-layer');
    assert.equal(overlays[0]?.style.getPropertyValue('opacity'), '0', 'линии скрыты на время перехода');
    assert.equal(overlays[0]?.style.getPropertyValue('pointer-events'), 'none');
    // Анимации: полёт + переезд выжившего + уезжающий бывший фокус +
    // проявление нового (фаза 2).
    assert.equal(created.length, 4);
    const entering = created.find((a) => a.keyframes[0]?.opacity === '0' && a.keyframes[1]?.opacity === '1');
    assert.ok(entering !== undefined, 'новое облачко проявляется');
    assert.equal(entering.options.delay, 400, 'проявление — после полёта (фаза 2)');
    assert.equal(entering.options.duration, 260);

    // Своп: летящий клон и удержанный фокус сняты, реальные облачка показаны.
    advance(400);
    assert.equal(layer(host)?.childElementCount, 0, 'клоны сняты на свопе');
    assert.equal(
      host.querySelectorAll('.cloud').find((c) => c.classList.contains('focus-cloud'))?.style.getPropertyValue('opacity'),
      '1',
    );
    assert.equal(
      host.querySelectorAll('.cloud').find((c) => c.dataset['id'] === 'f' && c.dataset['dir'] === 'parents')
        ?.style.getPropertyValue('opacity'),
      '1',
    );

    // Достройка завершена: слой убран, линии возвращены.
    advance(260);
    assert.equal(layer(host), null, 'слой анимации удалён по завершении');
    assert.equal(drawn, 1, 'линии перерисованы по завершении');
    const restored = host.querySelectorAll('.links-layer')[0];
    assert.notEqual(restored?.style.getPropertyValue('transition'), 'none');
  });

  it('ушедший с карты фокус растворяется, а не пропадает рывком', async () => {
    const T = await load();
    const host = makeHost([cloud('f', 'focus', rect(400, 100, 200, 80)), cloud('a', 'siblings', rect(100, 500))]);
    const before = T.captureClouds(host as unknown as HTMLElement);
    relayout(host, [cloud('a', 'focus', rect(400, 100, 200, 80))]);

    T.playFocusTransition(host as unknown as HTMLElement, before);
    advance(400); // своп: старый фокус не найден в новой раскладке — гаснет
    const fade = created.find((a) => a.keyframes[0]?.opacity === '1' && a.keyframes[1]?.opacity === '0');
    assert.ok(fade !== undefined, 'удержанный фокус гаснет');
    assert.equal(fade.options.duration, 300, 'затухание — по токену fade');
    advance(300); // 700 > flight + settle — слой уже снят завершением
    assert.equal(layer(host), null);
  });

  it('фаза 1: полёт, уезжающий бывший фокус и переезд выжившего одновременны', async () => {
    const T = await load();
    const host = makeHost([
      cloud('f', 'focus', rect(400, 100, 200, 80)),
      cloud('a', 'children', rect(100, 500)),
      cloud('b', 'parents', rect(100, 100)),
    ]);
    const before = T.captureClouds(host as unknown as HTMLElement);
    relayout(host, [
      cloud('a', 'focus', rect(400, 100, 200, 80)),
      cloud('f', 'parents', rect(100, 100)),
      cloud('b', 'children', rect(100, 500)),
    ]);

    T.playFocusTransition(host as unknown as HTMLElement, before);
    // В фазе 1 двигаются все трое: клон нового фокуса (полёт), клон бывшего
    // фокуса (уезжает из центра) и выживший «b» (сменил зону). Без новых
    // облачков фазы 2 нет — значит ни одной задержки.
    const moves = created.filter((a) => a.keyframes[0]?.transform !== undefined);
    assert.ok(moves.length >= 3, 'полёт + уезжающий бывший фокус + переезд выжившего');
    for (const m of moves) {
      assert.equal(m.options.delay, 0, 'в фазе 1 движения стартуют одновременно');
      assert.equal(m.options.duration, 400, 'фаза 1 идёт по токену flight');
    }
    // Уезжающий клон бывшего фокуса уже стоит на целевом прямоугольнике своей
    // зоны и стартует переносом к центру, приземляясь в `transform: none`.
    // Конечный кадр обязан удерживаться до свопа: иначе гонка конца анимации с
    // `setTimeout(swap, flight)` может на кадр вернуть клон в центр.
    const depart = created.find(
      (a) => a.el.dataset['id'] === 'f' && a.keyframes[1]?.transform === 'none',
    );
    assert.ok(depart !== undefined, 'уезжающий клон бывшего фокуса');
    assert.equal(depart.keyframes[0]?.transform, 'translate(300px, 0px)', 'стартует из центра переносом');
    assert.equal(depart.options.fill, 'forwards', 'конечный кадр удержан до свопа');
    assert.equal(created.filter((a) => a.options.delay > 0).length, 0, 'входа нет — фазы 2 нет');
  });

  it('перелёты — чистый перенос без масштаба, клоны несут целевой размер/вид (ошибка 9e1b87c9)', async () => {
    const T = await load();
    // Фокус широкий и низкий; выбранное облачко зоны — узкое и высокое.
    // Пропорции старого и нового слотов РАЗНЫЕ — прежний scale() искажал глифы.
    const host = makeHost([
      cloud('f', 'focus', rect(400, 100, 200, 80)),
      cloud('a', 'children', rect(100, 500, 150, 120)),
    ]);
    const before = T.captureClouds(host as unknown as HTMLElement);
    relayout(host, [
      cloud('a', 'focus', rect(400, 100, 300, 60)),
      cloud('f', 'children', rect(100, 500, 150, 120)),
    ]);

    T.playFocusTransition(host as unknown as HTMLElement, before);

    // (а) Ни один transform перелёта не содержит `scale(` — только translate.
    const transforms = created.flatMap((a) =>
      a.keyframes.map((k) => String(k.transform)).filter((t) => t !== 'undefined' && t !== 'none'),
    );
    assert.ok(transforms.length >= 2, 'есть transform-анимации перелёта');
    for (const t of transforms) {
      assert.equal(t.includes('scale('), false, `transform без scale: ${t}`);
      assert.match(t, /^translate\(-?[\d.]+px, -?[\d.]+px\)$/, `чистый перенос: ${t}`);
    }

    // Клон выбранной мысли летит из старого слота (100,500) в целевой фокус
    // (400,100): dx = −300, dy = 400.
    const flyer = created.find(
      (a) => a.el.dataset['id'] === 'a' && a.keyframes[1]?.transform === 'none',
    );
    assert.ok(flyer !== undefined, 'клон выбранной мысли летит в центр');
    assert.equal(flyer.keyframes[0]?.transform, 'translate(-300px, 400px)', 'только перенос');

    // (б) Клон бывшего фокуса несёт ЦЕЛЕВОЙ прямоугольник/вид (облачко зоны
    // 150×120), а не старый фокус-слот 200×80: он уже стоит в целевом размере
    // и уезжает из центра домой переносом.
    const overlay = layer(host)?.querySelectorAll('.cloud').find((c) => c.dataset['id'] === 'f');
    assert.ok(overlay !== undefined, 'клон бывшего фокуса — облачко его новой зоны');
    assert.equal(overlay?.style.getPropertyValue('width'), '150px', 'ширина — целевого слота');
    assert.equal(overlay?.style.getPropertyValue('height'), '120px', 'высота — целевого слота');
    const depart = created.find((a) => a.el === overlay);
    assert.ok(depart !== undefined, 'анимация уезжающего клона');
    assert.equal(
      depart?.keyframes[0]?.transform,
      'translate(300px, -400px)',
      'старт-кадр — перенос к центру (oldFocus − releasedAfter)',
    );
    assert.equal(depart?.keyframes[1]?.transform, 'none', 'приземляется в свою зону');
    assert.equal(depart?.options.fill, 'forwards', 'конечный кадр удержан до свопа');
    T.finishFocusTransition();
  });

  it('фаза 1: перестановка внутри зоны без смены зоны тоже анимируется', async () => {
    const T = await load();
    const host = makeHost([
      cloud('f', 'focus', rect(400, 100, 200, 80)),
      cloud('b', 'children', rect(100, 500)),
      cloud('c', 'children', rect(220, 500)),
    ]);
    const before = T.captureClouds(host as unknown as HTMLElement);
    // «c» остаётся в зоне children, но меняет слот; «b» не двигается.
    relayout(host, [
      cloud('a', 'focus', rect(400, 100, 200, 80)),
      cloud('b', 'children', rect(100, 500)),
      cloud('c', 'children', rect(100, 500)),
    ]);

    T.playFocusTransition(host as unknown as HTMLElement, before);
    const slot = created.find(
      (a) => String(a.keyframes[0]?.transform).includes('translate(120px, 0px)'),
    );
    assert.ok(slot !== undefined, 'сдвинувшееся внутри зоны облачко анимируется в фазе 1');
    assert.equal(slot.options.delay, 0, 'без задержки — одновременно с остальными');
    assert.equal(slot.options.duration, 400, 'фаза 1 идёт по токену flight');
    assert.equal(
      created.filter((a) => a.options.delay > 0).length,
      0,
      'входа нет — фазы 2 нет',
    );
    T.finishFocusTransition();
  });

  it('фаза 1: переезд между зонами играется клоном в необрезаемом слое (приёмка 380cc1e2)', async () => {
    const T = await load();
    const host = makeHost([
      cloud('f', 'focus', rect(400, 100, 200, 80)),
      cloud('a', 'children', rect(100, 500)),
      cloud('b', 'children', rect(220, 500)),
    ]);
    const before = T.captureClouds(host as unknown as HTMLElement);
    // «b» переезжает из детей в родственников — как 4 выживших потомка при
    // выборе одного из них. Зона обрезает содержимое (`overflow-y: auto`),
    // поэтому FLIP реального элемента был бы невидим в полёте: переезд обязан
    // играться клоном в необрезаемом слое анимации, а реальное облачко — ждать
    // свопа скрытым на новом слоте.
    relayout(host, [
      cloud('a', 'focus', rect(400, 100, 200, 80)),
      cloud('f', 'parents', rect(100, 100)),
      cloud('b', 'siblings', rect(700, 100)),
    ]);

    T.playFocusTransition(host as unknown as HTMLElement, before);

    const anim = layer(host);
    const clone = anim
      ?.querySelectorAll('.cloud')
      .find((c) => c.dataset['id'] === 'b');
    assert.ok(clone !== undefined, 'переезжающее между зонами облачко играет клоном в слое');
    const real = host
      .querySelectorAll('.cloud')
      .find((c) => c.dataset['id'] === 'b' && c.dataset['dir'] === 'siblings');
    assert.equal(
      real?.style.getPropertyValue('opacity'),
      '0',
      'реальное облачко скрыто на новом слоте до свопа',
    );
    // Клон летит из старого слота (children 220,500) в новый (siblings 700,100):
    // dx = −480, dy = 400, без масштаба (клон уже целевого размера). Конечный
    // кадр удержан до свопа.
    const cloneAnims = created.filter((a) => a.el === clone);
    assert.equal(cloneAnims.length, 1, 'ровно одна transform-анимация клона');
    const move = cloneAnims[0]!;
    assert.equal(move.keyframes[0]?.transform, 'translate(-480px, 400px)', 'клон стартует из старого слота');
    assert.equal(move.keyframes[1]?.transform, 'none', 'приземляется на новом слоте');
    assert.equal(move.options.duration, 400, 'фаза 1 идёт по токену flight');
    assert.equal(move.options.delay, 0, 'переезд одновременен с остальными видимыми');
    assert.equal(move.options.fill, 'forwards', 'конечный кадр удержан до свопа');

    // Приземление: клон снят, реальное облачко показано на своём слоте.
    advance(400);
    assert.equal(
      real?.style.getPropertyValue('opacity'),
      '1',
      'по приземлении реальное облачко показано',
    );
    assert.equal(
      layer(host)
        ?.querySelectorAll('.cloud')
        .find((c) => c.dataset['id'] === 'b') ?? null,
      null,
      'клон снят на свопе',
    );
    T.finishFocusTransition();
  });

  it('ушедшее не-фокусное облачко растворяется в фазе 1', async () => {
    const T = await load();
    const host = makeHost([
      cloud('f', 'focus', rect(400, 100, 200, 80)),
      cloud('x', 'siblings', rect(100, 100)),
      cloud('y', 'siblings', rect(220, 100)),
    ]);
    const before = T.captureClouds(host as unknown as HTMLElement);
    // Фокус тот же: уходит только сосед «y» (plan.leaving), а не фокус.
    relayout(host, [
      cloud('f', 'focus', rect(400, 100, 200, 80)),
      cloud('x', 'siblings', rect(100, 100)),
    ]);

    T.playFocusTransition(host as unknown as HTMLElement, before);
    const fade = created.find((a) => a.keyframes[0]?.opacity === '1' && a.keyframes[1]?.opacity === '0');
    assert.ok(fade !== undefined, 'ушедшее облачко гаснет');
    assert.equal(fade.options.duration, 300, 'затухание — по токену fade');
    assert.equal(fade.options.fill, 'forwards', 'конечный кадр удержан');
    assert.equal(fade.options.delay, 0, 'затухание — в фазе 1');
    assert.ok(host.querySelector('.cloud-ghosts') !== null, 'призрак ушедшего облачка создан');
    T.finishFocusTransition();
  });

  it('фаза 2: новые облачка вылетают из своих источников после фазы 1', async () => {
    const T = await load();
    const host = makeHost([cloud('f', 'focus', rect(400, 100, 200, 80)), cloud('a', 'children', rect(100, 500))]);
    const before = T.captureClouds(host as unknown as HTMLElement);
    // Новые: предок «p», потомок «c» и родственник «s» (ребро p → s).
    relayout(host, [
      cloud('a', 'focus', rect(400, 100, 200, 80)),
      cloud('p', 'parents', rect(100, 100)),
      cloud('c', 'children', rect(100, 500)),
      cloud('s', 'siblings', rect(700, 100)),
    ]);

    T.playFocusTransition(host as unknown as HTMLElement, before, undefined, undefined, {
      focusId: 'a',
      parentIds: ['p'],
      edges: [{ source_id: 'p', target_id: 's' }],
    });

    const entries = created.filter((a) => a.options.delay === 400);
    assert.equal(entries.length, 3, 'три новых облачка стартуют после фазы 1');
    for (const e of entries) {
      assert.equal(e.options.duration, 260, 'фаза 2 идёт по токену settle');
      assert.equal(e.options.fill, 'both', 'проявление удерживает финальный кадр');
      assert.equal(e.keyframes[0]?.opacity, '0');
      assert.equal(e.keyframes[1]?.opacity, '1');
      assert.equal(e.options.delay > 0, true, 'фаза 2 не стартует раньше фазы 1');
    }
    // Стартовые трансформы: предок/потомок — из облачка фокуса «a», родственник
    // — из облачка своего предка «p». Только перенос, целевой размер у каждого
    // своего слота (масштаба нет — ошибка 9e1b87c9).
    const starts = entries.map((e) => String(e.keyframes[0]?.transform)).sort();
    assert.deepEqual(starts, [
      'translate(-600px, 0px)',
      'translate(300px, -400px)',
      'translate(300px, 0px)',
    ].sort());
    T.finishFocusTransition();
  });

  it('без топологии источником вылета служит облачко фокуса', async () => {
    const T = await load();
    const host = makeHost([cloud('f', 'focus', rect(400, 100, 200, 80))]);
    const before = T.captureClouds(host as unknown as HTMLElement);
    relayout(host, [cloud('a', 'focus', rect(400, 100, 200, 80)), cloud('v', 'children', rect(100, 500))]);

    T.playFocusTransition(host as unknown as HTMLElement, before);
    const entering = created.find((a) => a.options.delay === 400);
    assert.ok(entering !== undefined, 'новое облачко проявляется');
    assert.equal(String(entering.keyframes[0]?.transform), 'translate(300px, -400px)', 'только перенос из облачка фокуса');
    assert.equal(String(entering.keyframes[0]?.transform).includes('scale('), false, 'без масштаба');
    T.finishFocusTransition();
  });


  it('реальное обновление во время анимации догоняет переход до финала', async () => {
    const T = await load();
    const host = makeHost([cloud('f', 'focus', rect(400, 100, 200, 80)), cloud('a', 'children', rect(100, 500))]);
    const before = T.captureClouds(host as unknown as HTMLElement);
    relayout(host, [cloud('a', 'focus', rect(400, 100, 200, 80)), cloud('f', 'parents', rect(100, 100))]);

    T.playFocusTransition(host as unknown as HTMLElement, before);
    assert.ok(layer(host) !== null);
    T.finishFocusTransition();

    assert.equal(layer(host), null, 'слой анимации снят');
    assert.equal(
      host.querySelectorAll('.cloud').find((c) => c.classList.contains('focus-cloud'))?.style.getPropertyValue('opacity'),
      '',
      'новый фокус показан (инлайн-стиль снят)',
    );
    assert.ok(created.some((a) => a.cancelled), 'запущенные анимации отменены');
    // Сброшенный переход не мешает следующему: раскладка уже в финале, новый
    // полёт стартует с текущих (финальных) позиций.
    const before2 = T.captureClouds(host as unknown as HTMLElement);
    relayout(host, [cloud('f', 'focus', rect(400, 100, 200, 80)), cloud('a', 'children', rect(100, 500))]);
    T.playFocusTransition(host as unknown as HTMLElement, before2);
    assert.equal(layer(host)?.childElementCount, 2, 'новый переход стартовал заново');
    T.finishFocusTransition();
  });

  it('быстрые клики подряд оставляют ровно один переход', async () => {
    const T = await load();
    const host = makeHost([cloud('f', 'focus', rect(400, 100, 200, 80)), cloud('a', 'children', rect(100, 500))]);
    const first = T.captureClouds(host as unknown as HTMLElement);
    relayout(host, [cloud('a', 'focus', rect(400, 100, 200, 80)), cloud('f', 'parents', rect(100, 100))]);
    T.playFocusTransition(host as unknown as HTMLElement, first);

    // Второй двойной клик приходит посреди полёта: рендер сначала догоняет
    // старый переход, затем начинает новый.
    T.finishFocusTransition();
    const second = T.captureClouds(host as unknown as HTMLElement);
    relayout(host, [cloud('f', 'focus', rect(400, 100, 200, 80)), cloud('a', 'children', rect(100, 500)), cloud('b', 'children', rect(220, 500))]);
    T.playFocusTransition(host as unknown as HTMLElement, second);

    assert.equal(host.querySelectorAll('.focus-anim-layer').length, 1, 'ровно один слой анимации');
    T.finishFocusTransition();
  });

  it('клик вне карты: полёт стартует от прямоугольника источника (дефект 2)', async () => {
    const T = await load();
    const host = makeHost([
      cloud('f', 'focus', rect(400, 100, 200, 80)),
      cloud('a', 'children', rect(100, 500)),
    ]);
    const before = T.captureClouds(host as unknown as HTMLElement);
    // 'x' не было на карте — мысль пришла из панели закреплённых/истории.
    relayout(host, [
      cloud('x', 'focus', rect(400, 100, 200, 80)),
      cloud('f', 'children', rect(100, 500)),
    ]);
    const chip = rect(700, 20, 120, 24); // экранный прямоугольник кликнутого чипа

    T.playFocusTransition(host as unknown as HTMLElement, before, undefined, chip);

    const anim = layer(host);
    assert.equal(anim?.childElementCount, 2, 'удержанный старый фокус + летящий от чипа клон');
    assert.equal(
      host.querySelectorAll('.cloud').find((c) => c.classList.contains('focus-cloud'))?.style.getPropertyValue('opacity'),
      '0',
      'новый фокус спрятан до свопа — ни одного кадра с ним в центре',
    );
    // Полёт клона: dx = 700−400 = 300, dy = 20−100 = −80. Клон бывшего фокуса
    // тоже едет в фазе 1, поэтому ищем именно трансформ старта полёта.
    const flight = created.find(
      (a) =>
        typeof a.keyframes[0]?.transform === 'string' &&
        a.keyframes[0].transform.includes('translate(300px, -80px)'),
    );
    assert.ok(flight !== undefined, 'запущен полёт клона');
    T.finishFocusTransition();
  });

  it('клик вне карты без пригодного прямоугольника — мягкая деградация без полёта', async () => {
    const T = await load();
    const host = makeHost([cloud('f', 'focus', rect(400, 100, 200, 80))]);
    const before = T.captureClouds(host as unknown as HTMLElement);
    relayout(host, [cloud('x', 'focus', rect(400, 100, 200, 80))]);

    T.playFocusTransition(host as unknown as HTMLElement, before, undefined, null);

    const anim = layer(host);
    assert.ok(anim !== null, 'слой создан — старый фокус удерживается');
    assert.equal(anim.childElementCount, 1, 'только удержанный фокус: клона-полёта нет');
    assert.equal(
      created.filter((a) => a.keyframes[0]?.transform !== undefined).length,
      0,
      'ни одной transform-анимации полёта',
    );
    T.finishFocusTransition();
  });

  it('сбой хореографии не оставляет облачка невидимыми (ошибка 66deb70a)', async () => {
    const T = await load();
    const host = makeHost([cloud('f', 'focus', rect(400, 100, 200, 80)), cloud('a', 'children', rect(100, 500))]);
    const before = T.captureClouds(host as unknown as HTMLElement);
    // Смена фокуса приносит в нижнюю зону облачко отбора, которого раньше не
    // было (plan.entering) — именно этот цикл прячет облачко инлайновым
    // `opacity: 0` и проявляет анимацией.
    const entering = cloud('v', 'children', rect(220, 500));
    relayout(host, [cloud('x', 'focus', rect(400, 100, 200, 80)), entering]);
    (entering as any).animate = () => {
      throw new Error('animate unavailable');
    };

    // Хореография — украшение: её сбой обязан откатиться к собранной раскладке,
    // а не выбрасывать исключение в точку входа рендера.
    assert.doesNotThrow(() => {
      T.playFocusTransition(host as unknown as HTMLElement, before);
    }, 'сбой анимации не уходит наружу');

    // Владелец мутаций зарегистрирован ДО мутаций, поэтому откат вернул все
    // инлайновые стили: ни облачко отбора, ни новый фокус не остались скрытыми,
    // и следующий рендер может начать новый переход.
    assert.notEqual(entering.style.getPropertyValue('opacity'), '0', 'облачко отбора видимо');
    const focusAfter = host.querySelectorAll('.cloud').find((c) => c.classList.contains('focus-cloud'));
    assert.notEqual(focusAfter?.style.getPropertyValue('opacity'), '0', 'новый фокус видим');
    assert.equal(layer(host), null, 'слой анимации снят откатом');
    assert.equal(T.captureClouds(host as unknown as HTMLElement).length, 2, 'оба облачка на карте');
  });

  it('досрочная остановка восстанавливает стили даже при сбое свопа (ошибка 66deb70a)', async () => {
    const T = await load();
    const host = makeHost([cloud('f', 'focus', rect(400, 100, 200, 80)), cloud('a', 'children', rect(100, 500))]);
    const before = T.captureClouds(host as unknown as HTMLElement);
    // Выбранной мысли «x» на карте не было и внешнего источника нет — клона-полёта
    // нет, поэтому своп сам проявляет новый фокус (единственная анимация в swap).
    const released = cloud('f', 'children', rect(100, 500));
    const newFocus = cloud('x', 'focus', rect(400, 100, 200, 80));
    relayout(host, [newFocus, released]);
    T.playFocusTransition(host as unknown as HTMLElement, before);
    assert.equal(released.style.getPropertyValue('opacity'), '0', 'бывший фокус ждёт свопа скрытым');
    // Своп падает: новый фокус не умеет анимироваться (мягкая деградация без клона).
    (newFocus as any).animate = () => {
      throw new Error('swap failed');
    };

    // `finishFocusTransition` обязан снять владение мутациями даже при сбое
    // `swap` — иначе облачка остаются невидимыми навсегда.
    assert.throws(() => T.finishFocusTransition());
    assert.equal(layer(host), null, 'слой снят, несмотря на сбой свопа');
    assert.notEqual(released.style.getPropertyValue('opacity'), '0', 'бывший фокус снова видим');
  });

  it('проявление новых облачков удерживает финальный кадр (ошибка 90811979)', async () => {
    const T = await load();
    const host = makeHost([cloud('f', 'focus', rect(400, 100, 200, 80)), cloud('a', 'children', rect(100, 500))]);
    const before = T.captureClouds(host as unknown as HTMLElement);
    const entering = cloud('v', 'children', rect(220, 500));
    relayout(host, [cloud('x', 'focus', rect(400, 100, 200, 80)), entering]);

    T.playFocusTransition(host as unknown as HTMLElement, before);
    const fadeIn = created.find((a) => a.keyframes[0]?.opacity === '0' && a.keyframes[1]?.opacity === '1');
    assert.ok(fadeIn !== undefined, 'новое облачко проявляется');
    // `fill: 'backwards'` удерживает только первый кадр: как только анимация
    // заканчивается, снова действует инлайновый `opacity: 0`, и видимость
    // облачка зависит от гонки с восстановлением стилей. `both` удерживает и
    // финальный кадр — облачко не может исчезнуть.
    assert.equal(fadeIn.options.fill, 'both', 'проявление удерживает и первый, и последний кадр');
    advance(400 + 260);
    assert.notEqual(entering.style.getPropertyValue('opacity'), '0', 'облачко видно после завершения');
  });
});

describe('network-reveal: одно общее проявление расклада при смене мыслесети (задача 70a99f09)', () => {
  it('все облачка проявляются ОДНОВРЕМЕННО одной opacity-анимацией, без перелётов', async () => {
    const T = await load();
    const host = makeHost([
      cloud('f', 'focus', rect(400, 100, 200, 80)),
      cloud('p', 'parents', rect(100, 100)),
      cloud('c', 'children', rect(100, 500)),
      cloud('s', 'siblings', rect(700, 100)),
    ]);
    let drawn = 0;
    T.playNetworkReveal(host as unknown as HTMLElement, () => {
      drawn += 1;
    });

    // Ровно одна анимация на каждое облачко, все с нулевой задержкой и по токену.
    assert.equal(created.length, 4, 'по одной анимации на облачко');
    for (const a of created) {
      assert.deepEqual(a.keyframes, [{ opacity: '0' }, { opacity: '1' }], 'проявление opacity 0→1');
      assert.equal(a.options.delay, 0, 'все облачка стартуют одновременно');
      assert.equal(a.options.duration, 300, 'длительность — токен --anim-network-reveal');
      assert.equal(a.options.fill, 'both', 'финальный кадр удерживается');
    }
    assert.equal(
      created.filter((a) => a.keyframes.some((k: any) => k.transform !== undefined)).length,
      0,
      'никаких transform-анимаций (нет перелётов и клонов)',
    );
    assert.equal(layer(host), null, 'слой анимации фокуса не создаётся');
    assert.equal(drawn, 1, 'линии перерисовываются один раз');
    // Мутации принадлежат владельцу: до завершения облачка скрыты и проявить их
    // может только завершение/досрочная остановка.
    for (const c of host.querySelectorAll('.cloud')) {
      assert.equal(c.style.getPropertyValue('opacity'), '0', 'облачко скрыто до проявления');
    }
    advance(300);
    for (const c of host.querySelectorAll('.cloud')) {
      assert.notEqual(c.style.getPropertyValue('opacity'), '0', 'после проявления облачко видимо');
    }
  });

  it('reduced-motion — мгновенное проявление без анимаций', async () => {
    const T = await load();
    reducedMotion = true;
    const host = makeHost([cloud('f', 'focus', rect(400, 100, 200, 80)), cloud('c', 'children', rect(100, 500))]);
    let drawn = 0;
    T.playNetworkReveal(host as unknown as HTMLElement, () => {
      drawn += 1;
    });
    assert.equal(created.length, 0, 'анимации не запускаются');
    assert.equal(drawn, 1, 'линии перерисовываются сразу');
  });

  it('реальное обновление во время проявления доводит его до финала (облачка видимы)', async () => {
    const T = await load();
    const host = makeHost([cloud('f', 'focus', rect(400, 100, 200, 80)), cloud('c', 'children', rect(100, 500))]);
    T.playNetworkReveal(host as unknown as HTMLElement);
    assert.equal(host.querySelectorAll('.cloud')[0]?.style.getPropertyValue('opacity'), '0');
    T.finishFocusTransition();
    for (const c of host.querySelectorAll('.cloud')) {
      assert.equal(c.style.getPropertyValue('opacity'), '', 'инлайн-скрытие снято, облачко видимо');
    }
    assert.ok(created.every((a) => a.cancelled), 'запущенные анимации отменены');
  });

  it('проявление после смены сети снимает незавершённый фокус-переход (ровно один владелец)', async () => {
    const T = await load();
    const host = makeHost([cloud('f', 'focus', rect(400, 100, 200, 80)), cloud('a', 'children', rect(100, 500))]);
    const before = T.captureClouds(host as unknown as HTMLElement);
    relayout(host, [cloud('a', 'focus', rect(400, 100, 200, 80)), cloud('f', 'parents', rect(100, 100))]);
    T.playFocusTransition(host as unknown as HTMLElement, before);
    assert.ok(layer(host) !== null, 'фокус-переход запущен');
    // Смена сети приходит поверх: переход обязан быть доведён до финала, а
    // затем проявлен новый расклад — слой-клонов не остаётся.
    T.playNetworkReveal(host as unknown as HTMLElement);
    assert.equal(layer(host), null, 'слой фокус-перехода снят до проявления');
    assert.equal(
      created.filter((a) => a.keyframes[0]?.opacity === '0' && a.keyframes[1]?.opacity === '1').length,
      2,
      'каждое облачко получило своё проявление',
    );
    // Завершение проявления возвращает облачка в видимое состояние.
    T.finishFocusTransition();
    for (const c of host.querySelectorAll('.cloud')) {
      assert.equal(c.style.getPropertyValue('opacity'), '', 'облачко видимо после проявления');
    }
  });
});

describe('focus-origin: источник полёта при клике вне карты (дефект 2)', () => {
  it('запоминает прямоугольник клика и отдаёт его по совпадению id', () => {
    const chip = new ShimElement('div', 'pinned-chip');
    chip.rect = rect(700, 20, 120, 24);
    noteFocusOrigin('x', chip as unknown as Element);
    assert.deepEqual(takeFocusOrigin('x'), { left: 700, top: 20, width: 120, height: 24 });
    assert.equal(takeFocusOrigin('x'), null, 'источник одноразовый');
  });

  it('чужой id не отдаёт источник и очищает его', () => {
    const chip = new ShimElement('div', 'history-cloud');
    chip.rect = rect(10, 700, 90, 20);
    noteFocusOrigin('x', chip as unknown as Element);
    assert.equal(takeFocusOrigin('y'), null, 'чужой мысли источник не достаётся');
    assert.equal(takeFocusOrigin('x'), null, 'и чужой запрос источник уже забрал');
  });

  it('клик по облачку внутри холста не регистрируется', () => {
    const host = new ShimElement('div', 'canvas view-host');
    const cloudEl = new ShimElement('div', 'cloud focus-cloud');
    host.append(cloudEl);
    noteFocusOrigin('x', cloudEl as unknown as Element);
    assert.equal(takeFocusOrigin('x'), null, 'у облачка на карте свой слот — внешний источник не нужен');
  });

  it('элемент без раскладки — источник с null-прямоугольником (деградация)', () => {
    const detached = new ShimElement('div', 'pinned-chip');
    detached.rect = rect(0, 0, 0, 0);
    noteFocusOrigin('x', detached as unknown as Element);
    assert.equal(takeFocusOrigin('x'), null);
  });
});

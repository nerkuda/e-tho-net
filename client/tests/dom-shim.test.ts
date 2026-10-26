/**
 * Паритет общего DOM-шима с браузером по тексту (ошибка cca54310).
 *
 * Шим держал `textContent` ОТДЕЛЬНЫМ полем рядом с `children`, и это давало
 * ложно-зелёные тесты: `textContent = 'X'` не снимал детей, геттер не видел
 * текст потомков, `replaceChildren(a, b)` оставлял `textContent` пустым, а
 * `flatText()` склеивал «свой» текст с текстом детей. На такой шиме прошёл
 * дефект контракта текстовой деградации `filter-footer` (задача 58f77990):
 * порядок «`textContent = …; replaceChildren()`» в браузере стирает текст, а
 * шим его сохранял.
 *
 * Здесь закреплено поведение браузера: `textContent` — это ТЕКСТ УЗЛОВ-ДЕТЕЙ
 * (у элемента собственного текста нет), запись снимает детей, `children` —
 * только элементы, `childNodes` — все узлы, `childElementCount` и `flatText()`
 * считаются из тех же детей.
 *
 * Круг 2 (тот же дефект-класс) добавил паритет методов вставки/удаления и
 * живость коллекций: строковые аргументы `append`/`prepend`/`replaceWith`/
 * `replaceChildren`, возвраты `appendChild`/`insertBefore`/`removeChild`/
 * `replaceChild`, `NotFoundError` на чужом узле/якоре, `TypeError` на
 * примитиве, `cloneNode()` по умолчанию неглубокий, `children`/`childNodes`
 * видят мутации через ссылку, взятую ДО них, и не имеют мутаторов массива.
 * Эталон — пробы на живом Chromium (`.tmp/verify/cca54310/parity-ops-r2.js`,
 * сводка `parity-compare-r2.log`), а не документация.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

describe('DOM-шим: textContent и дети — как в браузере (cca54310)', () => {
  it('textContent = … снимает детей и кладёт один текстовый узел', () => {
    const host = new ShimElement('div');
    host.append(new ShimElement('span', 'a', 'A'), new ShimElement('span', 'b', 'B'));
    assert.equal(host.textContent, 'AB', 'геттер агрегирует текст потомков');
    assert.equal(host.childElementCount, 2);

    host.textContent = 'X';
    assert.equal(host.children.length, 0, 'детей-элементов не осталось');
    assert.equal(host.childElementCount, 0);
    assert.equal(host.childNodes.length, 1, 'остался ровно один узел — текстовый');
    assert.equal(host.childNodes[0]!.isTextNode, true, 'узел — текстовый');
    assert.equal(host.textContent, 'X', 'текст читается обратно');
    assert.equal(host.flatText(), 'X');

    host.textContent = '';
    assert.equal(host.childNodes.length, 0, 'пустая строка детей не оставляет');
    assert.equal(host.textContent, '');
  });

  it('геттер textContent агрегирует текст потомков (включая вложенные)', () => {
    const host = new ShimElement('div');
    const paragraph = new ShimElement('p');
    paragraph.append(new ShimElement('strong', undefined, 'Жирный'), ' текст');
    host.append(paragraph, new ShimElement('span', undefined, 'хвост'));
    assert.equal(host.textContent, 'Жирный текстхвост');
    assert.equal(host.flatText(), 'Жирный текстхвост');
  });

  it('replaceChildren пересчитывает текст из новых детей', () => {
    const host = new ShimElement('div', undefined, 'старый текст');
    host.replaceChildren(new ShimElement('span', undefined, 'a'), 'b');
    assert.equal(host.textContent, 'ab', 'текст — конкатенация новых детей');
    assert.equal(host.childElementCount, 1);
    assert.equal(host.children.length, 1, 'children — только элементы');
    assert.equal(host.childNodes.length, 2, 'childNodes — элемент и текстовый узел');

    host.replaceChildren();
    assert.equal(host.textContent, '', 'пустой replaceChildren снимает и текст');
    assert.equal(host.childNodes.length, 0);
  });

  it('appendChild/removeChild синхронно влияют на textContent и childElementCount', () => {
    const host = new ShimElement('div', undefined, 'a');
    const child = new ShimElement('span', undefined, 'b');

    host.appendChild(child);
    assert.equal(host.textContent, 'ab');
    assert.equal(host.childElementCount, 1);

    host.removeChild(child);
    assert.equal(host.textContent, 'a');
    assert.equal(host.childElementCount, 0);
    assert.equal(child.parent, null, 'узел отвязан от родителя');
  });

  it('flatText() — ровно текст браузера, включая пробелы и переносы', () => {
    const host = new ShimElement('div');
    const first = new ShimElement('p');
    first.append(new ShimElement('em', undefined, 'раз'), ' два\n', new ShimElement('b', undefined, 'три'));
    host.append(first, '\nчетыре');
    assert.equal(host.textContent, 'раз два\nтри\nчетыре');
    assert.equal(host.flatText(), host.textContent, 'flatText — тот же текст, что textContent');
    assert.equal(host.flatText(), host.flatText(), 'повторное чтение не меняет текст');
  });

  it('текстовый узел: собственные данные, их замена и nodeType', () => {
    const text = new ShimElement('#text', undefined, 'данные');
    assert.equal(text.isTextNode, true);
    assert.equal(text.nodeType, 3, 'Node.TEXT_NODE');
    assert.equal(text.textContent, 'данные');
    text.textContent = 'новые';
    assert.equal(text.textContent, 'новые');
    assert.equal(new ShimElement('span').nodeType, 1, 'элемент — Node.ELEMENT_NODE');
  });

  it('uppercaseTagNames не ломает вид текстового узла', () => {
    // Регресс на рекурсию: `#text`.toUpperCase() === '#TEXT' — сравнение вида
    // узла обязано быть без регистра.
    ShimElement.uppercaseTagNames = true;
    try {
      const host = new ShimElement('div');
      host.append('X');
      assert.equal(host.childNodes.length, 1);
      assert.equal(host.childNodes[0]!.isTextNode, true);
      assert.equal(host.textContent, 'X');
    } finally {
      ShimElement.uppercaseTagNames = false;
    }
  });

  it('cloneNode не удваивает текст потомков', () => {
    const host = new ShimElement('div', undefined, 'корень');
    host.append(new ShimElement('span', undefined, 'потомок'));
    const clone = host.cloneNode(true);
    assert.equal(clone.textContent, 'кореньпотомок');
    assert.equal(clone.childElementCount, 1);
  });

  it('порядок «textContent = …; replaceChildren()» теряет текст (в браузере так же)', () => {
    // Бывший ложно-зелёный случай filter-footer (58f77990, круг 2): при неверном
    // порядке пустой `replaceChildren()` обязан снять только что вставленный
    // текст. Если шим снова начнёт хранить текст отдельно от детей — тест
    // покраснеет, и класс дефекта опять пройдёт незамеченным.
    const defective = new ShimElement('div');
    defective.textContent = 'фраза';
    defective.replaceChildren();
    assert.equal(defective.textContent, '', 'дефектный порядок теряет текст');
    assert.equal(defective.flatText(), '');

    const correct = new ShimElement('div');
    correct.replaceChildren();
    correct.textContent = 'фраза';
    assert.equal(correct.textContent, 'фраза', 'верный порядок текст сохраняет');
  });
});

/**
 * Регрессионный тест на саму бывшую ложную зелень: контракт текстовой
 * деградации `filter-footer` проверяется НАСТОЯЩЕЙ функцией продукта. Мутация
 * `renderFilterPhrase` обратно на «`textContent = …; replaceChildren()`»
 * краснит этот тест (на старом шиме он оставался зелёным).
 */
describe('filter-footer: текстовая деградация видна честному шиму (58f77990, cca54310)', () => {
  /** Минимальный `document` для фасадов `lib/dom`/`lib/ui`. */
  function installDocument(): void {
    (globalThis as unknown as { document: unknown }).document = {
      createElement: (tag: string): ShimElement => new ShimElement(tag),
      createElementNS: (_ns: string, tag: string): ShimElement => new ShimElement(tag),
      documentElement: new ShimElement('html'),
      body: new ShimElement('body'),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      activeElement: null,
      querySelector: () => null,
    };
  }

  it('текст без токенов остаётся, разметка заменяет текст целиком', async () => {
    installDocument();
    const mod = await import('../src/renderer/lib/filter-footer.js');
    const host = new ShimElement('span') as unknown as HTMLElement;
    const shim = host as unknown as ShimElement;

    // Деградация: токенов нет — текст кладётся текстом (контракт `tokens?`).
    mod.renderFilterPhrase(host, undefined, 'фраза хоста');
    assert.equal(shim.textContent, 'фраза хоста', 'текстовая деградация видна');
    assert.equal(shim.flatText(), 'фраза хоста');
    assert.equal(shim.childElementCount, 0, 'разметки нет');

    // Разметка: текст — конкатенация токенов, прежний текст снят.
    mod.renderFilterPhrase(
      host,
      [
        { kind: 'text', text: 'Город = ' },
        { kind: 'text', text: 'Москва' },
      ],
      'Город = Москва',
    );
    assert.equal(shim.textContent, 'Город = Москва', 'разметка заменяет текст целиком');
    assert.equal(shim.childElementCount, 2, 'каждый токен — свой спан');

    // Обратно в текст: спаны сняты, текст ровно один раз.
    mod.renderFilterPhrase(host, undefined, 'снова текст');
    assert.equal(shim.textContent, 'снова текст');
    assert.equal(shim.childElementCount, 0, 'спаны разметки сняты');
  });
});

/**
 * Методы вставки/удаления. Ожидания сняты с живого Chromium пробами
 * `.tmp/verify/cca54310/parity-ops-r2.js` — включая возвраты, `TypeError` на
 * примитиве и `NotFoundError` на чужом узле/якоре.
 */
describe('DOM-шим: методы вставки/удаления и возвраты — как в браузере (cca54310, круг 2)', () => {
  /** Виды детей: `#text:<данные>` и тег элемента — как в браузерной пробе. */
  function nodeKinds(node: ShimElement): string[] {
    return Array.from(node.childNodes).map((child) =>
      child.isTextNode ? `#text:${child.textContent}` : child.tagName,
    );
  }

  function make(tag: string, value?: string): ShimElement {
    return new ShimElement(tag, undefined, value);
  }

  function hostWith(...children: ShimElement[]): ShimElement {
    const host = new ShimElement('div');
    for (const child of children) host.append(child);
    return host;
  }

  it('prepend принимает строки и узлы, сохраняет порядок; возврата нет', () => {
    const host = hostWith(make('span', 'A'));
    assert.equal(host.prepend(make('span', 'Z')), undefined);
    assert.equal(host.prepend('t0'), undefined);
    assert.equal(host.textContent, 't0ZA');
    assert.deepEqual(nodeKinds(host), ['#text:t0', 'span', 'span']);
  });

  it('prepend нескольких аргументов сохраняет их порядок', () => {
    const host = hostWith(make('span', 'A'));
    host.prepend('x', make('span', 'Y'));
    assert.deepEqual(nodeKinds(host), ['#text:x', 'span', 'span']);
    assert.equal(host.textContent, 'xYA');
  });

  it('append принимает строку и узел, переносит подключённый узел', () => {
    const first = hostWith(make('span', 'A'));
    const moved = make('span', 'M');
    first.append(moved);
    const second = new ShimElement('div');
    assert.equal(second.append('t', moved), undefined, 'append возврата не даёт');
    assert.deepEqual(nodeKinds(first), ['span'], 'узел снят с прежнего родителя');
    assert.deepEqual(nodeKinds(second), ['#text:t', 'span']);
    assert.equal(second.textContent, 'tM');
  });

  it('appendChild возвращает узел, строковый аргумент — TypeError', () => {
    const host = new ShimElement('div');
    const child = make('span', 'B');
    assert.equal(host.appendChild(child), child);
    assert.equal(host.textContent, 'B');
    assert.throws(
      () => host.appendChild('x' as unknown as ShimElement),
      TypeError,
      'в DOM appendChild принимает только Node',
    );
  });

  it('insertBefore возвращает вставленный узел; before=null — в конец; node===before — no-op', () => {
    const a = make('span', 'A');
    const c = make('span', 'C');
    const host = hostWith(a, c);
    const b = make('span', 'B');
    assert.equal(host.insertBefore(b, c), b);
    const tail = make('span', 'D');
    assert.equal(host.insertBefore(tail, null), tail, 'before=null — вставка в конец');
    const self = make('span', 'S');
    host.append(self);
    assert.equal(host.insertBefore(self, self), self, 'вставка перед собой — no-op');
    assert.deepEqual(nodeKinds(host), ['span', 'span', 'span', 'span', 'span']);
    assert.equal(host.textContent, 'ABCDS');
  });

  it('insertBefore перемещает подключённый узел того же родителя, а не дублирует', () => {
    const a = make('span', 'A');
    const b = make('span', 'B');
    const c = make('span', 'C');
    const host = hostWith(a, b, c);
    assert.equal(host.insertBefore(c, a), c);
    assert.deepEqual(nodeKinds(host), ['span', 'span', 'span']);
    assert.equal(host.textContent, 'CAB');
  });

  it('insertBefore с якорем из чужого родителя — NotFoundError, дерево не меняется', () => {
    const host = hostWith(make('span', 'A'));
    const other = hostWith(make('span', 'X'));
    const stranger = other.firstChild!;
    const node = make('span', 'N');
    assert.throws(() => host.insertBefore(node, stranger), { name: 'NotFoundError' });
    assert.deepEqual(nodeKinds(host), ['span'], 'дерево хоста не изменилось');
    assert.equal(node.parent, null, 'узел не подключён');
  });

  it('removeChild возвращает узел; чужой узел — NotFoundError; строка — TypeError', () => {
    const a = make('span', 'A');
    const b = make('span', 'B');
    const host = hostWith(a, b);
    assert.equal(host.removeChild(b), b);
    assert.equal(host.textContent, 'A');
    assert.equal(b.parent, null);
    assert.throws(() => host.removeChild(make('span', 'S')), { name: 'NotFoundError' });
    assert.throws(
      () => host.removeChild('x' as unknown as ShimElement),
      TypeError,
      'в DOM removeChild принимает только Node',
    );
  });

  it('replaceChild возвращает заменённый узел и отвязывает его; чужой old — NotFoundError; node===old — no-op', () => {
    const a = make('span', 'A');
    const b = make('span', 'B');
    const host = hostWith(a, b);
    const c = make('span', 'C');
    assert.equal(host.replaceChild(c, b), b, 'возвращается ЗАМЕНЁННЫЙ узел');
    assert.equal(b.parent, null);
    assert.deepEqual(nodeKinds(host), ['span', 'span']);
    assert.equal(host.textContent, 'AC');

    assert.throws(() => host.replaceChild(make('span', 'N'), make('span', 'S')), {
      name: 'NotFoundError',
    });
    const old = host.firstChild!;
    assert.equal(host.replaceChild(old, old), old, 'замена узла им же — no-op');
    assert.equal(host.textContent, 'AC');
  });

  it('replaceChild перемещает узел того же родителя', () => {
    const a = make('span', 'A');
    const b = make('span', 'B');
    const c = make('span', 'C');
    const host = hostWith(a, b, c);
    assert.equal(host.replaceChild(a, c), c);
    assert.deepEqual(nodeKinds(host), ['span', 'span']);
    assert.equal(host.textContent, 'BA', 'a занял место c, c снят');
  });

  it('replaceWith принимает строку и несколько узлов, не оставляет повреждённых записей', () => {
    // Круг 1: `e.replaceWith('t')` портил childNodes записью undefined и давал
    // текст «ACDundefined». Теперь строка становится текстовым узлом.
    const a = make('span', 'A');
    const b = make('span', 'B');
    const stringHost = hostWith(a, b);
    assert.equal(b.replaceWith('t'), undefined, 'replaceWith возврата не даёт');
    assert.deepEqual(nodeKinds(stringHost), ['span', '#text:t']);
    assert.equal(stringHost.textContent, 'At');

    const a2 = make('span', 'A');
    const c = make('span', 'C');
    const multiHost = hostWith(a2, c);
    const d = make('span', 'D');
    assert.equal(c.replaceWith('x', d), undefined);
    assert.deepEqual(nodeKinds(multiHost), ['span', '#text:x', 'span']);
    assert.equal(multiHost.textContent, 'AxD');
  });

  it('replaceWith на detached-узле — no-op; replaceWith(self, z) оставляет узел на месте', () => {
    const detached = make('span', 'S');
    assert.equal(detached.replaceWith('t'), undefined);
    assert.deepEqual(nodeKinds(detached), ['#text:S'], 'detached-узел не тронут');

    const a = make('span', 'A');
    const b = make('span', 'B');
    const host = hostWith(a, b);
    const z = make('span', 'Z');
    a.replaceWith(a, z);
    assert.deepEqual(nodeKinds(host), ['span', 'span', 'span']);
    assert.equal(host.textContent, 'AZB', 'узел остался, новый вставлен после него');
  });

  it('replaceWith следующим братом не теряет узел', () => {
    const a = make('span', 'A');
    const b = make('span', 'B');
    const c = make('span', 'C');
    const host = hostWith(a, b, c);
    a.replaceWith(b);
    assert.deepEqual(nodeKinds(host), ['span', 'span']);
    assert.equal(host.textContent, 'BC');
  });

  it('remove возвращает undefined и безопасен при повторе', () => {
    const a = make('span', 'A');
    const b = make('span', 'B');
    const host = hostWith(a, b);
    assert.equal(b.remove(), undefined);
    assert.equal(b.remove(), undefined, 'повторное снятие — no-op');
    assert.deepEqual(nodeKinds(host), ['span']);
    assert.equal(host.textContent, 'A');
    assert.equal(b.parent, null);
  });

  it('replaceChildren принимает строки и узлы, возврата нет, переносит подключённый узел', () => {
    const first = hostWith(make('span', 'A'));
    const moved = first.firstChild!;
    const second = hostWith(make('span', 'X'));
    assert.equal(second.replaceChildren('s', moved), undefined);
    assert.deepEqual(nodeKinds(first), [], 'узел снят с прежнего родителя');
    assert.deepEqual(nodeKinds(second), ['#text:s', 'span']);
    assert.equal(second.textContent, 'sA');
  });

  it('cloneNode() по умолчанию неглубокий, cloneNode(true) копирует детей', () => {
    const host = hostWith(make('span', 'A'));
    host.textContent = 'root';
    const child = make('span', 'B');
    host.append(child);

    const shallowDefault = host.cloneNode();
    const shallowFalse = host.cloneNode(false);
    const deep = host.cloneNode(true);
    assert.deepEqual(nodeKinds(shallowDefault), [], 'по умолчанию — без детей');
    assert.equal(shallowDefault.textContent, '');
    assert.deepEqual(nodeKinds(shallowFalse), []);
    assert.deepEqual(nodeKinds(deep), ['#text:root', 'span']);
    assert.equal(deep.textContent, 'rootB');
    assert.notEqual(deep, host);
  });

  it('insertAdjacentElement: возврат узла, четыре позиции, null без родителя, SyntaxError на неизвестной позиции', () => {
    const host = hostWith(make('span', 'A'), make('span', 'B'));
    const anchor = host.children[1]!;
    const afterEnd = make('span', 'E');
    assert.equal(anchor.insertAdjacentElement('afterend', afterEnd), afterEnd);
    const beforeBegin = make('span', 'P');
    assert.equal(anchor.insertAdjacentElement('beforebegin', beforeBegin), beforeBegin);
    const beforeEnd = make('span', 'Q');
    assert.equal(anchor.insertAdjacentElement('beforeend', beforeEnd), beforeEnd);
    assert.deepEqual(nodeKinds(host), ['span', 'span', 'span', 'span']);
    assert.equal(host.textContent, 'APBQE');
    assert.deepEqual(nodeKinds(anchor), ['#text:B', 'span']);
    assert.equal(anchor.textContent, 'BQ');

    assert.throws(
      () => anchor.insertAdjacentElement('afterbegin', 'x' as unknown as ShimElement),
      TypeError,
      'insertAdjacentElement принимает только Element, строки в браузере — TypeError',
    );
    assert.equal(make('span', 'D').insertAdjacentElement('afterend', make('span', 'R')), null);
    assert.throws(() => host.insertAdjacentElement('nonsense', make('span', 'Z')), {
      name: 'SyntaxError',
    });
  });
});

/**
 * Живость коллекций: взятая до мутации ссылка обязана видеть текущий состав.
 * В браузере `children` — `HTMLCollection`, `childNodes` — `NodeList`; у обоих
 * мутаторов массива нет, поэтому шим их не даёт.
 */
describe('DOM-шим: children/childNodes — живые коллекции (cca54310, круг 2)', () => {
  function kinds(node: ShimElement): string[] {
    return Array.from(node.childNodes).map((child) =>
      child.isTextNode ? `#text:${child.textContent}` : child.tagName,
    );
  }

  it('children, взятая до append, видит новый элемент; текст в children не попадает', () => {
    const host = new ShimElement('div');
    const live = host.children;
    assert.equal(live.length, 0);
    host.append(new ShimElement('span', undefined, 'A'));
    assert.equal(live.length, 1, 'ссылка до мутации видит добавленный элемент');
    assert.equal(live[0]!.textContent, 'A');
    host.append('text');
    assert.equal(live.length, 1, 'текстовый узел в children не считается');
    assert.equal(host.childNodes.length, 2);
    host.replaceChildren();
    assert.equal(live.length, 0, 'ссылка видит очистку');
    assert.equal(live[0], undefined);
  });

  it('childNodes, взятая до replaceChildren(), видит новый состав', () => {
    const host = new ShimElement('div', undefined, 'A');
    const live = host.childNodes;
    assert.equal(live.length, 1);
    host.replaceChildren('x', new ShimElement('span', undefined, 'B'));
    assert.equal(live.length, 2);
    assert.deepEqual(kinds(host), ['#text:x', 'span']);
    assert.equal(live[0]!.textContent, 'x');
  });

  it('childNodes видит снятие детей через textContent = …', () => {
    const host = new ShimElement('div', undefined, 'A');
    const live = host.childNodes;
    assert.equal(live.length, 1);
    host.textContent = 'T';
    assert.equal(live.length, 1, 'состав заменён, длина та же');
    assert.equal(live[0]!.nodeType, 3, 'единственный узел — текстовый');
    assert.equal(live[0]!.textContent, 'T');
    host.textContent = '';
    assert.equal(live.length, 0, 'пустая строка снимает и текст');
  });

  it('length/индексы/итерация/item() живые; firstChild/firstElementChild/childElementCount', () => {
    const host = new ShimElement('div');
    host.append(new ShimElement('span', undefined, 'A'), new ShimElement('span', undefined, 'B'));
    const children = host.children;
    const nodes = host.childNodes;

    assert.equal(children.item(0)!.textContent, 'A');
    assert.equal(children.item(-1), null);
    assert.equal(children[1]!.textContent, 'B');
    assert.equal(children[2], undefined);
    assert.deepEqual(
      Array.from(children).map((child) => child.textContent),
      ['A', 'B'],
    );
    assert.equal(children.length, 2);
    assert.equal(nodes.length, 2);
    assert.equal(host.childElementCount, 2);
    assert.equal(host.firstChild!.textContent, 'A');
    assert.equal(host.firstElementChild!.textContent, 'A');

    host.prepend('t');
    assert.equal(children.length, 2, 'children по-прежнему только элементы');
    assert.equal(nodes.length, 3);
    assert.equal(host.childElementCount, 2);
    assert.equal(host.firstChild!.nodeType, 3, 'firstChild — текстовый узел');
    assert.equal(host.firstElementChild!.textContent, 'A', 'firstElementChild пропускает текст');

    host.replaceChildren();
    assert.equal(children.length, 0);
    assert.equal(nodes.length, 0);
    assert.equal(host.firstChild, null);
    assert.equal(host.firstElementChild, null);
  });

  it('ссылка на коллекцию стабильна, мутаторов массива нет — как у HTMLCollection/NodeList', () => {
    const host = new ShimElement('div');
    const children = host.children;
    const nodes = host.childNodes;
    assert.equal(children, host.children, 'children — та же живая коллекция');
    assert.equal(nodes, host.childNodes, 'childNodes — та же живая коллекция');

    // Мутаторы браузерных коллекций не имеют; шим их тоже не даёт, иначе тест
    // мог бы «починить» состав в обход методов узла (прецедент children.pop()).
    const mutable = children as unknown as Record<string, unknown>;
    assert.equal(typeof mutable.pop, 'undefined');
    assert.equal(typeof mutable.push, 'undefined');
    assert.equal(typeof mutable.splice, 'undefined');
    assert.throws(() => {
      (children as unknown as ShimElement[])[0] = new ShimElement('b');
    }, TypeError);
    assert.throws(() => {
      (children as unknown as { length: number }).length = 5;
    }, TypeError);
  });
});

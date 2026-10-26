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

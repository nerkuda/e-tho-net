/**
 * Регресс ошибки f5809943 (ВТОРОЙ, независимый механизм того же симптома):
 * Ctrl+Enter в редакторе записи «Дневника» штатно завершает правку
 * (`md-editor.ts` keymap `Mod-Enter` → `onCommit` → `editor.blur()`, M10), но то
 * же нажатие всплывало по DOM до глобального обработчика вида
 * `wireChronicleApplyShortcut` и вызывало «применение отбора»: полный
 * перезапрос ленты с первой страницы + явный `feedWrap.scrollTop = 0` — лента
 * оказывалась в самом начале, правленая запись уходила из вида.
 *
 * Инварианты, которые фиксирует сторож:
 *  - Ctrl+Enter из редактора ЗАПИСИ (`.cm-editor` внутри `.md-field`) либо из
 *    поля заголовка внутри `.chron-feed-wrap` отбор НЕ применяет и прокрутку
 *    не сбрасывает;
 *  - Ctrl+Enter из поля ПАНЕЛИ ОТБОРА (`.chron-filter-area`) отбор применяет и
 *    показывает ленту с начала — это требование спеки «Горячие клавиши»
 *    (50bb672a), гард не является общим «не editable-цель»;
 *  - клавишу, которую уже поглотил внутренний редактор (`defaultPrevented`),
 *    шорткат не перехватывает повторно.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import * as keymap from '../src/renderer/lib/keymap.js';
import { isFeedRecordEditorTarget } from '../src/renderer/screens/chronicle/feed-nav.js';
import { wireChronicleApplyShortcut } from '../src/renderer/screens/chronicle/filter-panel.js';
import { ShimElement } from './dom-shim.js';

// Клавиатура вида идёт через диспетчер контекстов: стек между тестами чист.
beforeEach(() => keymap.keymapInternals.reset());

/** Приведение шима к `HTMLElement` — общий приём DOM-тестов проекта. */
const asEl = (el: ShimElement): HTMLElement => el as unknown as HTMLElement;

interface Harness {
  host: ShimElement;
  filterInput: ShimElement;
  feedWrap: ShimElement;
  titleInput: ShimElement;
  mdField: ShimElement;
  cmContent: ShimElement;
  applies: number;
}

/** Корень вида: панель отбора рядом с лентой (как в `mountChronicle`). */
function buildHarness(): Harness {
  const host = new ShimElement('div', 'chronicle-screen');

  const filterArea = new ShimElement('div', 'chron-filter-area');
  const filterInput = new ShimElement('input', 'chron-keywords');
  filterArea.append(filterInput);

  const feedWrap = new ShimElement('div', 'admin-table-wrap chron-table-wrap chron-feed-wrap');
  feedWrap.scrollTop = 500;
  const card = new ShimElement('div', 'diary-record');
  const titleInput = new ShimElement('input', 'diary-record-title');
  const mdField = new ShimElement('div', 'md-field');
  const cmEditor = new ShimElement('div', 'cm-editor');
  const cmContent = new ShimElement('div', 'cm-content');
  cmEditor.append(cmContent);
  mdField.append(cmEditor);
  card.append(titleInput, mdField);
  feedWrap.append(card);

  host.append(filterArea, feedWrap);

  const harness: Harness = { host, filterInput, feedWrap, titleInput, mdField, cmContent, applies: 0 };
  // Путь применения отбора воспроизводит симптом: перезапрос + `scrollTop = 0`.
  wireChronicleApplyShortcut(asEl(host), () => {
    harness.applies += 1;
    feedWrap.scrollTop = 0;
  });
  return harness;
}

function press(
  harness: Harness,
  target: ShimElement,
  opts: { defaultPrevented?: boolean } = {},
): { prevented: boolean } {
  const event = {
    ctrlKey: true,
    key: 'Enter',
    target,
    defaultPrevented: opts.defaultPrevented === true,
    prevented: false,
    preventDefault(): void {
      event.prevented = true;
    },
  };
  // Фокус внутри контейнера кладёт его контекст на вершину стека диспетчера.
  harness.host.emit('focusin', {});
  keymap.dispatchKeyEvent(event as unknown as KeyboardEvent);
  harness.host.emit('focusout', {});
  return event;
}

describe('Ctrl+Enter в «Дневнике»: редактор записи vs панель отбора (f5809943)', () => {
  it('из CM6-редактора записи (клавишу уже поглотил CM6) отбор не применяется, прокрутка на месте', () => {
    const h = buildHarness();
    const ev = press(h, h.cmContent, { defaultPrevented: true });
    assert.equal(h.applies, 0, 'отбор не применён');
    assert.equal(h.feedWrap.scrollTop, 500, 'прокрутка ленты не сброшена в начало');
    assert.equal(ev.prevented, false, 'клавишу внутреннего редактора не перехватываем');
  });

  it('из CM6-редактора без defaultPrevented отбор тоже не применяется (страховка по источнику)', () => {
    const h = buildHarness();
    const ev = press(h, h.cmContent);
    assert.equal(h.applies, 0);
    assert.equal(h.feedWrap.scrollTop, 500);
    assert.equal(ev.prevented, false, 'шорткат молчит и не глотает клавишу');
  });

  it('из поля заголовка записи внутри ленты отбор не применяется', () => {
    const h = buildHarness();
    press(h, h.titleInput);
    assert.equal(h.applies, 0);
    assert.equal(h.feedWrap.scrollTop, 500);
  });

  it('из поля панели отбора Ctrl+Enter по-прежнему применяет отбор и показывает ленту с начала', () => {
    const h = buildHarness();
    const ev = press(h, h.filterInput);
    assert.equal(h.applies, 1, 'отбор применён');
    assert.equal(h.feedWrap.scrollTop, 0, 'лента показана с начала');
    assert.equal(ev.prevented, true, 'клавиша обработана шорткатом');
  });

  it('Ctrl+Enter на корне вида (вне редакторов) применяет отбор — старое поведение цело', () => {
    const h = buildHarness();
    press(h, h.host);
    assert.equal(h.applies, 1);
  });

  it('другие комбинации и клавиши шорткат не трогает', () => {
    const h = buildHarness();
    h.host.emit('focusin', {});
    keymap.dispatchKeyEvent({
      ctrlKey: false,
      key: 'Enter',
      target: h.filterInput,
      defaultPrevented: false,
      preventDefault(): void {},
    } as unknown as KeyboardEvent);
    keymap.dispatchKeyEvent({
      ctrlKey: true,
      key: 'a',
      target: h.filterInput,
      defaultPrevented: false,
      preventDefault(): void {},
    } as unknown as KeyboardEvent);
    h.host.emit('focusout', {});
    assert.equal(h.applies, 0);
  });

  it('предикат isFeedRecordEditorTarget различает источники', () => {
    const h = buildHarness();
    assert.equal(isFeedRecordEditorTarget(asEl(h.cmContent)), true, 'CM6-редактор комментария');
    assert.equal(isFeedRecordEditorTarget(asEl(h.mdField)), true, 'обёртка поля комментария');
    assert.equal(isFeedRecordEditorTarget(asEl(h.titleInput)), true, 'поле заголовка в ленте');
    assert.equal(isFeedRecordEditorTarget(asEl(h.filterInput)), false, 'панель отбора не под гардом');
    assert.equal(isFeedRecordEditorTarget(asEl(h.host)), false, 'корень вида');
    assert.equal(isFeedRecordEditorTarget(null), false);
  });
});

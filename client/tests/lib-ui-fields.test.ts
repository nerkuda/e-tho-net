/**
 * Фасады полей и переключателей `lib/ui` (задача f351b894, требование e64083b5,
 * ADR 03eb2c61).
 *
 * Что закрепляем (DoD задачи «тесты на состояния и на строку ошибки»):
 *   • `fieldInput`/`fieldTextarea` — тип, значение, состояния (disabled/
 *     readonly), min/max/step, модификаторы и `bare`;
 *   • `fieldRow` — подпись со связью `for`, подсказка, строка ошибки, очистка;
 *   • `wrapClearable` — видимость кнопки по пустому значению, очистка;
 *   • `choiceRow`/`checkboxRow`/`radioRow`/`choiceControl` — вид, подпись,
 *     состояние и событие `change`;
 *   • `segmentedControl` — единственный активный сегмент, `aria-pressed`,
 *     `setActive`;
 *   • `toggleButton` — `aria-pressed`, переключение по клику (Space/Enter даёт
 *     нативная кнопка => click), откат `setPressed`;
 *   • `badge` — классы вида/тона, `setBadgeText`;
 *   • `filePathField` — запись выбранного пути; `colorField` — синхронизация
 *     picker/hex.
 *
 * jsdom в проекте нет — общий DOM-шим (`./dom-shim.js`), конвенция
 * `lib-ui-messages.test.ts`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ShimElement } from './dom-shim.js';

/** Минимальный DOM-шим для фасадов поля. */
function shimDom(): void {
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (text: string) => new ShimElement('#text') as any,
    body: new ShimElement('body'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<string, unknown>;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
}

type FieldModule = typeof import('../src/renderer/lib/ui/field.js');

/** Приводит DOM-узел к общему шиму (тесты идут без jsdom). */
function shim(node: unknown): ShimElement {
  return node as ShimElement;
}

async function field(): Promise<FieldModule> {
  shimDom();
  return import('../src/renderer/lib/ui/field.js');
}

describe('lib/ui/field: контрол и строка поля', () => {
  it('fieldInput: тип, значение, состояния и числовой режим', async () => {
    const f = await field();
    const input = f.fieldInput({ type: 'number', value: '7', min: 1, max: 9, step: 2, required: true, placeholder: 'N' });
    assert.equal(input.type, 'number');
    assert.equal(input.value, '7');
    assert.equal(input.min, '1');
    assert.equal(input.max, '9');
    assert.equal(input.step, '2');
    assert.equal(input.required, true);
    assert.equal(input.placeholder, 'N');
    assert.ok(input.classList.contains(f.FIELD_CONTROL_CLASS), 'базовый класс поля');
    assert.ok(f.fieldInput({ disabled: true }).disabled);
    assert.ok(f.fieldInput({ readonly: true }).readOnly);
  });

  it('fieldInput: extraClass и bare (специализированные виджеты)', async () => {
    const f = await field();
    const withExtra = f.fieldInput({ extraClass: 'chrono-meta-input' });
    assert.ok(withExtra.classList.contains('chrono-meta-input'));
    const bare = f.fieldInput({ extraClass: 'st-f-input', bare: true });
    assert.ok(bare.classList.contains('st-f-input'));
    assert.equal(bare.classList.contains(f.FIELD_CONTROL_CLASS), false, 'bare — без базового класса');
  });

  it('fieldTextarea несёт многострочный класс', async () => {
    const f = await field();
    const area = f.fieldTextarea({ rows: 3, value: 'x' });
    assert.ok(area.classList.contains(f.FIELD_CONTROL_CLASS));
    assert.ok(area.classList.contains(f.FIELD_MULTILINE_CLASS));
    assert.equal(area.rows, 3);
  });

  it('fieldRow: подпись со связью for, подсказка и строка ошибки', async () => {
    const f = await field();
    const input = f.fieldInput({ id: 'nm' });
    const row = shim(f.fieldRow({ label: 'Имя', control: input, id: 'nm', hint: 'подсказка', error: 'нельзя пусто' }));
    assert.ok(row.classList.contains(f.FIELD_CLASS));
    const label = shim(row.children[0]);
    assert.equal(label.textContent, 'Имя');
    assert.equal(label.htmlFor, 'nm');
    assert.equal(row.children[1], input as unknown as ShimElement, 'контрол в строке');
    assert.equal(row.children[2]!.textContent, 'подсказка');
    assert.ok(row.children[3]!.classList.contains('error-text'), 'строка ошибки общим видом');
  });

  it('wrapClearable: кнопка скрыта у пустого и очищает значение', async () => {
    const f = await field();
    const input = f.fieldInput({ value: 'abc' });
    const wrap = shim(f.wrapClearable(input, () => {
      input.value = '';
    }));
    const btn = wrap.children[1]!;
    assert.equal(wrap.classList.contains(f.FIELD_CLEARABLE_CLASS), true);
    assert.equal(btn.hidden, false, 'непустое — кнопка видна');
    btn.click();
    assert.equal(input.value, '', 'клик очистил значение');
    assert.equal(btn.hidden, true, 'пустое — кнопка скрыта');
  });
});

describe('lib/ui/choice-row: строки и голые контролы', () => {
  it('checkboxRow и radioRow: вид, подпись, change', async () => {
    shimDom();
    const c = await import('../src/renderer/lib/ui/choice-row.js');
    const seen: boolean[] = [];
    const cb = c.checkboxRow({ label: 'Включить', checked: true, onChange: (v) => seen.push(v) });
    assert.ok(cb.row.classList.contains(c.CHOICE_ROW_CLASS));
    assert.equal(cb.input.type, 'checkbox');
    assert.equal(cb.input.checked, true);
    assert.equal(shim(cb.row).children[1]!.textContent, 'Включить');
    cb.input.checked = false;
    shim(cb.input).emit('change');
    assert.deepEqual(seen, [false]);

    const radio = c.radioRow({ label: 'Раз', name: 'g', value: '1' });
    assert.equal(radio.input.type, 'radio');
    assert.equal(radio.input.name, 'g');
    assert.equal(radio.input.value, '1');
  });

  it('choiceControl — голый контрол без подписи', async () => {
    shimDom();
    const c = await import('../src/renderer/lib/ui/choice-row.js');
    const input = c.choiceControl('checkbox', { checked: true });
    assert.equal(input.type, 'checkbox');
    assert.equal(input.checked, true);
    assert.equal(input.children.length, 0);
    const group = c.choiceGroup();
    assert.equal(group.classList.contains(c.CHOICE_GROUP_CLASS), true);
  });
});

describe('lib/ui/segmented и toggle', () => {
  it('segmentedControl: активен ровно один, aria-pressed, setActive', async () => {
    shimDom();
    const s = await import('../src/renderer/lib/ui/segmented.js');
    const changes: string[] = [];
    const seg = s.segmentedControl({
      items: [{ id: 'a', label: 'А' }, { id: 'b', label: 'Б' }],
      activeId: 'a',
      onChange: (id) => changes.push(id),
    });
    const [a, b] = shim(seg.root).children;
    assert.equal(a!.getAttribute('aria-pressed'), 'true');
    assert.equal(b!.getAttribute('aria-pressed'), 'false');
    b!.click();
    assert.equal(seg.activeId(), 'b');
    assert.deepEqual(changes, ['b']);
    assert.equal(a!.getAttribute('aria-pressed'), 'false');
    seg.setActive('a');
    assert.equal(seg.activeId(), 'a');
    assert.deepEqual(changes, ['b'], 'setActive без обратного вызова');
  });

  it('toggleButton: aria-pressed, клик (Space/Enter), откат setPressed', async () => {
    shimDom();
    const tg = await import('../src/renderer/lib/ui/toggle.js');
    const seen: boolean[] = [];
    const toggle = tg.toggleButton({ label: 'Ж', title: 'Жирный', pressed: false, variant: 'glyph', onChange: (v) => seen.push(v) });
    assert.ok(toggle.root.classList.contains(`${tg.TOGGLE_CLASS}--glyph`));
    assert.equal(toggle.root.getAttribute('aria-pressed'), 'false');
    assert.equal(toggle.root.getAttribute('aria-label'), 'Жирный');
    toggle.root.click();
    assert.equal(toggle.pressed(), true);
    assert.equal(toggle.root.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(seen, [true]);
    toggle.setPressed(false);
    assert.equal(toggle.root.getAttribute('aria-pressed'), 'false');
    assert.deepEqual(seen, [true], 'setPressed без обратного вызова');
  });
});

describe('lib/ui/badge, file-path-field, color-field', () => {
  it('badge: вид, тон и смена текста', async () => {
    shimDom();
    const b = await import('../src/renderer/lib/ui/badge.js');
    const pill = b.badge('владелец', { tone: 'warn' });
    assert.ok(pill.classList.contains(`${b.BADGE_CLASS}--pill`));
    assert.ok(pill.classList.contains(`${b.BADGE_CLASS}--warn`));
    const quiet = b.badge('5', { kind: 'quiet' });
    assert.ok(quiet.classList.contains(`${b.BADGE_CLASS}--quiet`));
    b.setBadgeText(quiet, '');
    assert.ok(quiet.classList.contains('hidden'), 'пустой quiet-бейдж скрыт');
  });

  it('filePathField: выбор пути пишется в поле', async () => {
    shimDom();
    const fp = await import('../src/renderer/lib/ui/file-path-field.js');
    const field = fp.filePathField({ value: 'start', onPick: () => 'picked' });
    assert.equal(field.input.value, 'start');
    assert.equal(field.root.classList.contains('input-with-btn'), true);
    field.button.click();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(field.input.value, 'picked', 'выбранный путь записан');
  });

  it('colorField: picker и hex синхронны, hex валидируется', async () => {
    shimDom();
    const cf = await import('../src/renderer/lib/ui/color-field.js');
    const color = cf.colorField({ value: '#112233', withHex: true });
    assert.equal(color.picker.value, '#112233');
    assert.equal(color.hex!.value, '#112233');
    color.picker.value = '#445566';
    shim(color.picker).emit('input');
    assert.equal(color.hex!.value, '#445566', 'hex следует за picker');
    color.hex!.value = '#aabbcc';
    shim(color.hex!).emit('change');
    assert.equal(color.value(), '#aabbcc', 'hex задаёт значение');
    color.hex!.value = 'мусор';
    shim(color.hex!).emit('change');
    assert.equal(color.hex!.value, '#aabbcc', 'невалидный hex откатывается');
  });
});

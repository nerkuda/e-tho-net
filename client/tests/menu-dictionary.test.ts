/**
 * Юнит-тесты общего словаря пунктов меню `client/src/renderer/lib/menu.ts`
 * (задача 1d817620, требование f9ad4f53).
 *
 * Проверяются конструкторы словаря: `menuAction` / `menuChoice` /
 * `menuSubmenu` и разделитель `MENU_SEPARATOR` — форма пункта, отсутствие
 * `undefined`-ключей и роли (действие / отметка текущего режима / родитель
 * с подменю). Подписи и обработчики остаются за потребителем.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MENU_SEPARATOR,
  menuAction,
  menuChoice,
  menuSubmenu,
  type MenuItem,
} from '../src/renderer/lib/menu.js';

describe('lib/menu.ts — общий словарь пунктов', () => {
  it('menuAction: пункт-действие с обработчиком и опциями', () => {
    const clicks: string[] = [];
    const item = menuAction('Удалить', () => clicks.push('delete'), { danger: true });
    assert.equal(item.label, 'Удалить');
    assert.equal(item.danger, true);
    assert.equal(item.disabled, undefined, 'не заданная опция не заводится');
    item.onClick?.();
    assert.deepEqual(clicks, ['delete']);
  });

  it('menuAction: без обработчика — строка без действия (недоступный режим)', () => {
    const item = menuAction('порядок задаётся отбором', undefined, { disabled: true });
    assert.equal(item.onClick, undefined);
    assert.equal(item.disabled, true);
  });

  it('menuAction: переносит icon/content/dragId', () => {
    const node = {} as unknown as Node;
    const item = menuAction('Мысль', () => undefined, { content: node, dragId: 't1', icon: '✦' });
    assert.equal(item.content, node);
    assert.equal(item.dragId, 't1');
    assert.equal(item.icon, '✦');
  });

  it('menuAction без опций заводит только подпись', () => {
    assert.deepEqual(Object.keys(menuAction('Открыть')), ['label']);
  });

  it('menuChoice: отметка проставлена и у текущего, и у прочих пунктов', () => {
    const on = menuChoice('ручной', true, () => undefined);
    const off = menuChoice('по алфавиту (возр)', false, () => undefined);
    assert.equal(on.checked, true);
    assert.equal(off.checked, false);
  });

  it('menuSubmenu: родитель с подменю, подпись и неактивность', () => {
    const sub = menuSubmenu('Добавить', [menuAction('вверх (родитель)', () => undefined)]);
    assert.equal(sub.label, 'Добавить');
    assert.equal(sub.submenu?.length, 1);
    assert.equal(sub.submenu?.[0]?.label, 'вверх (родитель)');
    assert.equal(sub.onClick, undefined, 'у родителя нет обработчика');

    const disabled = menuSubmenu('Изменить порядок', [], { disabled: true });
    assert.equal(disabled.disabled, true);
  });

  it('пункты словаря совместимы с типом MenuItem', () => {
    const items: MenuItem[] = [
      MENU_SEPARATOR,
      menuAction('Экспорт…', () => undefined),
      menuChoice('ручной', true, () => undefined),
      menuSubmenu('Сортировка', [menuAction('по алфавиту', () => undefined)]),
    ];
    assert.deepEqual(
      items.map((item) => item.label),
      ['—', 'Экспорт…', 'ручной', 'Сортировка'],
    );
  });
});

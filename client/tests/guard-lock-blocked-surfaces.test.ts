/**
 * Сторож поверхностей чужого захвата (ошибка 4f18d9f5).
 *
 * Правило: получив исход `Blocked` от `acquireOrShowBlocked`, каждая
 * поверхность обязана перевестись в режим чтения, а не оставлять поля
 * редактируемыми (запись всё равно отклоняется 409). Заголовки мысли и связи
 * синхронно спрашивают кэш захватов (`foreignLockHeld`), диалоги-редакторы
 * вызывают `blockEditingSurface`; снятие чужого захвата возвращает форму в
 * редактирование (`subscribeForeignLockState` → `unblockEditingSurface`,
 * ошибка 2301d73d).
 *
 * Сторож текстовый, как соседние `guard-*`: он ловит удаление вызова и
 * «выключение» условия (`if (false && …)`), которое оставляет suite зелёным,
 * потому что `lock-surface.test.ts` проверяет только сам хелпер.
 *
 * Файл входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');

/** Секция исходника: маркер начала включён, конца — нет. */
function section(file: string, start: string, end: string): string {
  const source = fs.readFileSync(path.join(RENDERER_ROOT, file), 'utf8');
  const from = source.indexOf(start);
  assert.ok(from >= 0, `${file}: не найден маркер «${start}»`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `${file}: не найден маркер конца «${end}»`);
  return source.slice(from, to);
}

/** Проверяет наличие каждой подстроки в секции. */
function requireAll(label: string, body: string, needles: readonly string[]): void {
  for (const needle of needles) {
    assert.ok(body.includes(needle), `${label}: отсутствует «${needle}»`);
  }
}

describe('guard: чужой захват переводит поверхности в чтение (4f18d9f5)', () => {
  it('заголовок мысли: readOnly по foreignLockHeld + гейт входа', () => {
    const body = section(
      'editor/editor.ts',
      'function buildThoughtHeader(initial: Thought): HTMLElement {',
      'async function openThoughtActionsMenu',
    );
    requireAll('заголовок мысли', body, [
      "const blocked = foreignLockHeld('thought', thought.id);",
      'titleArea.readOnly = blocked;',
      'synonymsInput.readOnly = blocked;',
      "if (foreignLockBlocksEdit('thought', thought.id)) field.blur();",
      // Ошибка 201233ba: снятие чужого захвата — realtime-переход кэша,
      // шапка обязана пересчитаться сама, без смены фокуса.
      'bindHeaderLockSync(syncThoughtHeaderLock);',
    ]);
  });

  it('заголовок связи: тип и «актуально» выключаются по foreignLockHeld', () => {
    const body = section(
      'editor/editor.ts',
      'function buildLinkHeader(initial: Link): HTMLElement {',
      '/** Opens the link settings dialog',
    );
    requireAll('заголовок связи', body, [
      "const blocked = foreignLockHeld('link', link.id);",
      'typeCombo.setDisabled(blocked);',
      'activeCheck.disabled = blocked;',
      'syncLinkHeaderLock();',
      // Тот же класс дефекта (ошибка 201233ba): связь пересчитывается по
      // переходу кэша, а не только по сборке/фокусу.
      'bindHeaderLockSync(syncLinkHeaderLock);',
    ]);
  });

  it('подписка шапки отпускается при демонтаже и полной пересборке', () => {
    // Иначе слушатели копятся на пересборках шапки и держат отсоединённый DOM.
    const body = section(
      'editor/editor.ts',
      'export function mountEditor(editorHost: HTMLElement): void {',
      'function buildHeaderFor(',
    );
    requireAll('демонтаж редактора', body, ['releaseHeaderLockSync();']);
    const rebuild = section(
      'editor/editor.ts',
      'function renderFull(ctx: EditorContext | null): void {',
      'function restoreEditorFocus(',
    );
    requireAll('полная пересборка', rebuild, ['releaseHeaderLockSync();']);
  });

  it('настройки мысли/связи получают привязку к захвату сущности', () => {
    const thought = section(
      'editor/editor.ts',
      'function openThoughtSettings(thought: Thought): void {',
      'function changeThoughtIcon(thought: Thought): void {',
    );
    requireAll('настройки мысли', thought, [
      "lock: { entityType: 'thought', entityId: thought.id },",
    ]);

    const link = section(
      'editor/editor.ts',
      'function openLinkSettings(link: Link): void {',
      'export const editorInternals',
    );
    requireAll('настройки связи', link, [
      "lock: { entityType: 'link', entityId: link.id },",
    ]);
  });

  it('диалог оформления следует за кэшем захватов в обе стороны', () => {
    const body = section(
      'editor/style-dialog.ts',
      'export function showThoughtStyleDialog(',
      'export function showLinkStyleDialog(',
    );
    requireAll('диалог оформления мысли', body, [
      'subscribeForeignLockState(entityType, entityId, (holder) => {',
      'blockEditingSurface({',
      'unblockEditingSurface(body);',
      'unbindLock();',
    ]);
    const source = fs.readFileSync(path.join(RENDERER_ROOT, 'editor', 'style-dialog.ts'), 'utf8');
    const link = source.slice(source.indexOf('export function showLinkStyleDialog('));
    requireAll('диалог оформления связи', link, [
      'subscribeForeignLockState(entityType, entityId, (holder) => {',
      'unblockEditingSurface(body);',
      'unbindLock();',
    ]);
  });

  it('редактор типа: форма следует за захватом и возвращается в редактирование', () => {
    const body = section(
      'screens/type-manager.ts',
      'export function showThoughtTypeEditor(',
      '// Property-definition tables + property dialog',
    );
    requireAll('редактор типа', body, [
      "unbindLock = subscribeForeignLockState('thought_type', type.id, (holder) => {",
      'blockEditingSurface({',
      'commitButtons: [saveBtn, applyBtn],',
      'unblockEditingSurface(box);',
      'revalidateName();',
      'if (applyBtn !== null) applyBtn.disabled = blocked || clash;',
      'if (saveBtn !== null) saveBtn.disabled = blocked || clash;',
      'if (blockedMessage !== null && dialogRoot !== null) {',
    ]);
  });

  it('редактор свойства: форма следует за захватом и возвращается в редактирование', () => {
    const body = section(
      'screens/property-manager.ts',
      'export function openPropertyManagerEditor(',
      '// Сборка PropertyConfig из черновика',
    );
    requireAll('редактор свойства', body, [
      "unbindLock = subscribeForeignLockState('property', property.id, (holder) => {",
      'blockEditingSurface({',
      'commitButtons: [applyBtn],',
      'unblockEditingSurface(body);',
      'revalidateName();',
      'if (applyBtn !== null) applyBtn.disabled = blocked;',
    ]);
  });
});

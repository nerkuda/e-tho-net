/**
 * Сторож поверхностей чужого захвата (ошибка 4f18d9f5).
 *
 * Правило: получив исход `Blocked` от `acquireOrShowBlocked`, каждая
 * поверхность обязана перевестись в режим чтения, а не оставлять поля
 * редактируемыми (запись всё равно отклоняется 409). Заголовки мысли и связи
 * синхронно спрашивают кэш захватов (`foreignLockHeld`), диалоги-редакторы
 * вызывают `blockEditingSurface` / `setBlocked`.
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

  it('настройки мысли/связи переводятся в чтение через setBlocked', () => {
    const thought = section(
      'editor/editor.ts',
      'function openThoughtSettings(thought: Thought): void {',
      'function changeThoughtIcon(thought: Thought): void {',
    );
    requireAll('настройки мысли', thought, [
      "if (outcome.kind === 'blocked') {",
      "dialog.setBlocked(blockedByLockMessage('thought', outcome.holder));",
    ]);

    const link = section(
      'editor/editor.ts',
      'function openLinkSettings(link: Link): void {',
      'export const editorInternals',
    );
    requireAll('настройки связи', link, [
      "if (outcome.kind === 'blocked') {",
      "dialog.setBlocked(blockedByLockMessage('link', outcome.holder));",
    ]);
  });

  it('редактор типа: исход Blocked выключает форму и кнопки записи', () => {
    const body = section(
      'screens/type-manager.ts',
      'export function showThoughtTypeEditor(',
      '// Property-definition tables + property dialog',
    );
    requireAll('редактор типа', body, [
      "if (outcome.kind === 'blocked') {",
      'blockEditingSurface({',
      'commitButtons: [saveBtn, applyBtn],',
      'if (applyBtn !== null) applyBtn.disabled = blocked || clash;',
      'if (saveBtn !== null) saveBtn.disabled = blocked || clash;',
      'if (blockedMessage !== null && dialogRoot !== null) {',
    ]);
  });

  it('редактор свойства: исход Blocked выключает форму и перерисовку', () => {
    const body = section(
      'screens/property-manager.ts',
      'export function openPropertyManagerEditor(',
      '// Сборка PropertyConfig из черновика',
    );
    requireAll('редактор свойства', body, [
      "if (outcome.kind === 'blocked') {",
      'blockEditingSurface({',
      'commitButtons: [applyBtn],',
      'if (applyBtn !== null) applyBtn.disabled = blocked;',
      'if (blockedMessage !== null) {',
    ]);
  });
});

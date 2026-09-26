/**
 * Сторож оболочки комментария `lib/ui` (задача 9cb87c42, требование 24ca6770
 * «Оболочка комментария: единый просмотр и редактирование», ADR 03eb2c61,
 * каталог 3fc7c54d).
 *
 * Правило: комментарий собирается только оболочкой `lib/ui/comment.ts`
 * (`commentShell`): единая рамка, панель действий, тело-поле markdown и
 * состояния загрузки/пустоты/ошибки. Каждый запрет ловится обычным прогоном
 * `npm -w @etn/client test`.
 *
 * Запрещено вне `lib/ui/`:
 *   1. классы прежних самодельных контейнеров комментария
 *      (`comment-permanent`, `chrono-editor-body`, `chron-editor-body`,
 *      `hp-comment-body`) — их собирает `commentShell`;
 *   2. точка входа комментария (строит поле markdown и входит в правку либо
 *      несёт `commentContext`) без вызова `commentShell`.
 *
 * **Allow-край.** `editor/markdown-field.ts` — сам общий модуль поля markdown
 * (не точка входа): его имя `createMarkdownField`/опция `commentContext`
 * определяют контракт, а оболочку собирают потребители.
 *
 * Строки-комментарии правилами не считаются (в пояснениях имена классов
 * допустимы).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { assertGuardClean, listSourceFiles, type GuardRule } from './guard-helpers.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');

/** Общий модуль поля markdown — не точка входа комментария (см. шапку). */
const ALLOW_ENTRY = new Set(['editor/markdown-field.ts']);

/** Строка — комментарий? (в пояснениях имена классов допустимы). */
function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

function rules(): GuardRule[] {
  return [
    {
      name: 'no-handmade-comment-container',
      description:
        'Контейнер комментария строит commentShell (классы ui-comment*); ' +
        'самодельные comment-permanent/chrono-editor-body/chron-editor-body/' +
        'hp-comment-body запрещены (требование 24ca6770).',
      pattern: /['"](?:comment-permanent|chrono-editor-body|chron-editor-body|hp-comment-body)['"]/,
      allow: (rel, line) => isComment(line) || rel.startsWith('lib/ui/'),
    },
  ];
}

/** Файл — точка входа комментария (строит поле и входит в правку/несёт контекст). */
function isCommentEntryPoint(rel: string, content: string): boolean {
  if (rel.startsWith('lib/ui/')) return false;
  if (ALLOW_ENTRY.has(rel)) return false;
  if (!content.includes('createMarkdownField(')) return false;
  return content.includes('editMarkdownField(') || content.includes('commentContext');
}

describe('guard: оболочка комментария lib/ui', () => {
  it('самодельных контейнеров комментария нет', () => {
    assertGuardClean(RENDERER_ROOT, rules());
  });

  it('каждая точка входа комментария собирает оболочку', () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(RENDERER_ROOT)) {
      const rel = path.relative(RENDERER_ROOT, file).replace(/\\/g, '/');
      const content = fs.readFileSync(file, 'utf8');
      if (!isCommentEntryPoint(rel, content)) continue;
      if (!content.includes('commentShell')) offenders.push(rel);
    }
    assert.deepEqual(
      offenders,
      [],
      `точки входа комментария без commentShell: ${offenders.join(', ')}`,
    );
  });
});

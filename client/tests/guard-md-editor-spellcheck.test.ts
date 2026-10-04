/**
 * Сторож нативной проверки орфографии в редакторе комментария (задача
 * 1e373ac7).
 *
 * CodeMirror 6 в собственном `updateAttrs()` принудительно ставит
 * `spellcheck="false"` на contentDOM, поэтому без фасета
 * `EditorView.contentAttributes.of({ spellcheck: 'true' })` ошибочные слова в
 * комментарии не подчёркиваются — в отличие от обычных полей
 * (`lib/ui/field.ts`, где `spellcheck` включён по умолчанию). Снимаешь
 * расширение — краснеет этот сторож, а не пользователь.
 *
 * Языки спеллчекера задаёт главный процесс; их отсутствие тоже глушит
 * русскую проверку, поэтому второй тест следит и за ним.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MD_EDITOR = path.join(CLIENT_ROOT, 'src', 'renderer', 'editor', 'md-editor.ts');
const MAIN_INDEX = path.join(CLIENT_ROOT, 'src', 'main', 'index.ts');

test('1e373ac7: редактор markdown включает проверку орфографии (spellcheck=true)', () => {
  const src = fs.readFileSync(MD_EDITOR, 'utf8');
  assert.match(
    src,
    /EditorView\.contentAttributes\.of\(\s*\{\s*spellcheck:\s*['"]true['"]\s*\}\s*\)/,
    "В расширениях EditorView нет EditorView.contentAttributes.of({ spellcheck: 'true' }) — " +
      'CodeMirror снова глушит нативную проверку орфографии в комментарии (задача 1e373ac7).',
  );
});

test('1e373ac7: главный процесс задаёт языки спеллчекера ru и en-US', () => {
  const src = fs.readFileSync(MAIN_INDEX, 'utf8');
  assert.match(
    src,
    /setSpellCheckerLanguages\s*\(/,
    'Главный процесс не задаёт языки нативного спеллчекера — русский текст ' +
      'может не проверяться (задача 1e373ac7).',
  );
  assert.match(src, /['"]ru['"]/, "В списке языков спеллчекера нет 'ru' (задача 1e373ac7).");
  assert.match(src, /['"]en-US['"]/, "В списке языков спеллчекера нет 'en-US' (задача 1e373ac7).");
});

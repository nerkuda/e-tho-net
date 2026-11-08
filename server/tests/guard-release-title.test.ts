/**
 * Сторож заголовка GitHub-релиза (ошибка 9d0c2d5e, версия 0.15.3).
 *
 * На stable-прогоне `42163460550` заголовок релиза v0.15.2 вышел
 * `fix(ci): docker-image собирает коммит релиза при prerelease` вместо
 * `ETN 0.15.2 — <тема>`. Причина: тег `v0.15.2` создал
 * `softprops/action-gh-release` при prerelease — тег lightweight; шаг
 * «Prepare release notes» читал `git tag -l --format='%(contents:subject)'`,
 * а у lightweight-тега это subject КОММИТА, на который тег указывает.
 * Проверка «пусто → ETN X.Y.Z» не срабатывала: строка непустая.
 *
 * Контракт (заголовок всегда `ETN X.Y.Z — <тема>`):
 *   * `.github/workflows/release.yml` не читает `%(contents:subject)` сам —
 *     заголовок собирает `server/scripts/release-notes.mjs`; шаг
 *     «Prepare release notes» передаёт ему `--tag` и `--title-out`, а
 *     `softprops/action-gh-release` берёт `name` только из выхода этого шага;
 *   * в скрипте subject аннотации читается ТОЛЬКО после проверки
 *     `%(objecttype) === "tag"`: lightweight-тег (`commit`) не даёт тему;
 *   * источники темы по убыванию: аннотированный тег → лид-абзац секции
 *     версии `CHANGELOG.md` → явный `--title` (вход `title` ручного запуска);
 *     темы нет нигде — ошибка, а не релиз с голым `ETN X.Y.Z`;
 *   * префикс «ETN X.Y.Z» источника снимается и ставится заново из версии
 *     релиза — дубля «ETN … ETN …» не бывает.
 *
 * Статические проверки читают workflow как текст (комментарии отбрасываются,
 * чтобы упоминание в шапке не маскировало удаление настройки), как и остальные
 * релизные сторожа. Поведенческие проверки запускают скрипт в одноразовом
 * git-репозитории с lightweight и аннотированным тегом — это прямой тест
 * ошибки: lightweight-тег не должен приносить subject коммита.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(SERVER_ROOT, '..');

const RELEASE_WORKFLOW = '.github/workflows/release.yml';
const NOTES_SCRIPT = 'server/scripts/release-notes.mjs';
const NOTES_SCRIPT_ABS = path.join(REPO_ROOT, NOTES_SCRIPT);

/** Одноразовые каталоги поведенческих проверок: удаляются после прогона. */
const TEMP_DIRS: string[] = [];

after(() => {
  for (const dir of TEMP_DIRS) fs.rmSync(dir, { recursive: true, force: true });
});

/** Прочитать файл из репозитория с понятной ошибкой, если он пропал. */
function readRepoFile(file: string, role: string): string {
  const abs = path.join(REPO_ROOT, file);
  assert.ok(
    fs.existsSync(abs),
    `Нет файла ${file} (${role}) — сторож заголовка релиза не может проверить контракт. ` +
      'Если файл переехал, обнови путь в сторожа.',
  );
  return fs.readFileSync(abs, 'utf8');
}

/** Текст без строк-комментариев: упоминание в шапке — не настройка и не код. */
function stripComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/** Код скрипта без комментариев (`//`, `/* … *\/`, `#!/usr/bin/env`). */
function stripScriptComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*|#!)/.test(line))
    .join('\n');
}

/** Отступ строки в пробелах. */
function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Блок `key:` на заданном отступе: строка ключа и все строки глубже. */
function findBlock(lines: readonly string[], key: string, indent: number): string[] | null {
  const head = `${' '.repeat(indent)}${key}:`;
  const start = lines.findIndex(
    (line) => line.trimEnd() === head || line.trimEnd().startsWith(`${head} `),
  );
  if (start < 0) return null;

  const block: string[] = [lines[start] ?? ''];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) break;
    if (line.trim() === '') {
      block.push(line);
      continue;
    }
    if (indentOf(line) <= indent) break;
    block.push(line);
  }
  return block;
}

/** Элементы YAML-списка (`- ...`) в блоке вместе с продолжением. */
function listItems(block: readonly string[]): string[][] {
  const items: string[][] = [];
  let current: string[] | null = null;
  for (const line of block) {
    if (/^\s*-\s/.test(line)) {
      current = [line];
      items.push(current);
      continue;
    }
    if (current) current.push(line);
  }
  return items;
}

/** Значение `key: <value>` в блоке шага (заголовок `- …` или продолжение). */
function stepValue(step: readonly string[], key: string): string | null {
  const pattern = new RegExp(`^\\s*(?:-\\s+)?${key}:\\s*(.+?)\\s*$`);
  for (const line of step) {
    const match = pattern.exec(line);
    if (match?.[1]) return match[1];
  }
  return null;
}

/** Строки блочного скаляра шага (`key: |`). */
function blockValueLines(step: readonly string[], key: string): string[] {
  const start = step.findIndex((line) =>
    new RegExp(`^\\s*(?:-\\s+)?${key}:\\s*\\|\\s*$`).test(line),
  );
  if (start < 0) return [];

  const headIndent = indentOf(step[start] ?? '');
  const body: string[] = [];
  for (let i = start + 1; i < step.length; i += 1) {
    const line = step[i];
    if (line === undefined) break;
    if (line.trim() !== '' && indentOf(line) <= headIndent) break;
    body.push(line.trim());
  }
  return body.filter(Boolean);
}

/** Блок `with:` шага: его строки и всё, что глубже. */
function withBlock(step: readonly string[]): string[] {
  const start = step.findIndex((line) => /^\s*with:\s*$/.test(line));
  assert.ok(start >= 0, `${RELEASE_WORKFLOW}: у шага нет блока with.`);

  const headIndent = indentOf(step[start] ?? '');
  const block: string[] = [step[start] ?? ''];
  for (let i = start + 1; i < step.length; i += 1) {
    const line = step[i];
    if (line === undefined) break;
    if (line.trim() !== '' && indentOf(line) <= headIndent) break;
    block.push(line);
  }
  return block;
}

/** Шаг джобы по точному `name:`. */
function stepByName(job: readonly string[], name: string): string[] {
  const steps = findBlock(job, 'steps', 4);
  assert.ok(steps !== null, `${RELEASE_WORKFLOW}: у джобы нет блока steps.`);
  const step = listItems(steps).find((item) => stepValue(item, 'name') === name);
  assert.ok(step !== undefined, `${RELEASE_WORKFLOW}: нет шага «${name}».`);
  return step;
}

/** Шаги джобы, использующие action по префиксу `uses: <prefix>`. */
function stepsUsingPrefix(job: readonly string[], prefix: string): string[][] {
  const steps = findBlock(job, 'steps', 4);
  if (!steps) return [];
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^\\s*(?:-\\s+)?uses:\\s*${escaped}`);
  return listItems(steps).filter((item) => item.some((line) => pattern.test(line)));
}

/** Джоба workflow по имени (отступ 2). */
function job(name: string): string[] {
  const text = stripComments(readRepoFile(RELEASE_WORKFLOW, 'релизный конвейер'));
  const block = findBlock(text.split('\n'), name, 2);
  assert.ok(block !== null, `${RELEASE_WORKFLOW}: нет джобы ${name}.`);
  return block;
}

/** Git в одноразовом каталоге: без системных настроек и подписи. */
function git(dir: string, args: string[]): void {
  execFileSync('git', ['-c', 'user.name=ETN Test', '-c', 'user.email=test@example.com', ...args], {
    cwd: dir,
    stdio: 'ignore',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  });
}

/** Одноразовый git-репозиторий с одним пустым коммитом. */
function tempRepo(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  git(dir, ['init', '-q']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'fix(ci): subject коммита, а не тема релиза']);
  return dir;
}

/** Секция changelog для одноразового репозитория. */
function writeChangelog(dir: string, version: string, separator: string, body: string): string {
  const file = path.join(dir, 'CHANGELOG.md');
  fs.writeFileSync(
    file,
    `# Changelog\n\n## [${version}] ${separator} 2026-11-06\n\n${body}\n\n### Добавлено\n\n- Пункт.\n`,
    'utf8',
  );
  return file;
}

/** Запуск скрипта заметок; возвращает заголовок из `--title-out` и stderr. */
function runNotes(
  cwd: string,
  args: string[],
): { status: number | null; title: string; stderr: string } {
  const titleOut = path.join(cwd, 'release-title.txt');
  fs.rmSync(titleOut, { force: true });
  const result = spawnSync(
    process.execPath,
    [NOTES_SCRIPT_ABS, ...args, '--out', path.join(cwd, 'release-body.md'), '--title-out', titleOut],
    { cwd, encoding: 'utf8' },
  );
  const title = fs.existsSync(titleOut) ? fs.readFileSync(titleOut, 'utf8').trim() : '';
  return { status: result.status, title, stderr: result.stderr ?? '' };
}

describe('guard: заголовок GitHub-релиза собирается как ETN X.Y.Z — <тема>', () => {
  it(`${RELEASE_WORKFLOW}: не читает subject lightweight-тега`, () => {
    const code = stripComments(readRepoFile(RELEASE_WORKFLOW, 'релизный конвейер'));

    assert.ok(
      !code.includes('%(contents:subject)'),
      `${RELEASE_WORKFLOW}: workflow читает %(contents:subject) сам. У lightweight-тега ` +
        '(его создаёт softprops/action-gh-release при prerelease) это subject коммита, ' +
        'и заголовок релиза превращается в «fix(ci): …» (ошибка 9d0c2d5e). ' +
        'Заголовок собирает server/scripts/release-notes.mjs: он различает аннотированный ' +
        'тег и lightweight по %(objecttype).',
    );
    assert.ok(
      !/git\s+tag\b[^\n]*contents:/u.test(code),
      `${RELEASE_WORKFLOW}: в workflow осталось чтение содержимого тега через git tag — ` +
        'тему и заголовок формирует только server/scripts/release-notes.mjs.',
    );
  });

  it(`${RELEASE_WORKFLOW}: Prepare release notes передаёт тег и заголовок в скрипт`, () => {
    const step = stepByName(job('publish'), 'Prepare release notes');
    const run = blockValueLines(step, 'run').join('\n');

    assert.match(
      run,
      /node server\/scripts\/release-notes\.mjs/u,
      `${RELEASE_WORKFLOW}: шаг не вызывает server/scripts/release-notes.mjs — ` +
        'заголовок и тело релиза не собираются по контракту.',
    );
    assert.match(
      run,
      /--tag "\$\{TAG\}"/u,
      `${RELEASE_WORKFLOW}: шаг не передаёт --tag — скрипт не увидит аннотацию тега ` +
        'и возьмёт тему из changelog даже там, где аннотация задана явно.',
    );
    assert.match(
      run,
      /--title-out release-title\.txt/u,
      `${RELEASE_WORKFLOW}: шаг не передаёт --title-out — заголовок не попадает в выход шага.`,
    );
    assert.match(
      run,
      /title="\$\(cat release-title\.txt\)"/u,
      `${RELEASE_WORKFLOW}: заголовок не читается из release-title.txt.`,
    );
    assert.match(
      run,
      /echo "name=\$\{title\}" >> "\$\{GITHUB_OUTPUT\}"/u,
      `${RELEASE_WORKFLOW}: заголовок не пишется в выход шага как name.`,
    );
  });

  it(`${RELEASE_WORKFLOW}: gh-release берёт заголовок только из выхода шага заметок`, () => {
    const releases = stepsUsingPrefix(job('publish'), 'softprops/action-gh-release@');
    assert.equal(
      releases.length,
      1,
      `${RELEASE_WORKFLOW}: в publish ожидается ровно один шаг softprops/action-gh-release, ` +
        `найдено ${releases.length}.`,
    );
    assert.equal(
      stepValue(withBlock(releases[0] ?? []), 'name'),
      '${{ steps.notes.outputs.name }}',
      `${RELEASE_WORKFLOW}: заголовок релиза должен приходить только из ` +
        'steps.notes.outputs.name — иначе появляется второй путь установки заголовка.',
    );
  });

  it(`${NOTES_SCRIPT}: subject аннотации читается только у аннотированного тега`, () => {
    const code = stripScriptComments(readRepoFile(NOTES_SCRIPT, 'заголовок и тело релиза'));
    const objectType = code.indexOf('%(objecttype)');
    const subject = code.indexOf('%(contents:subject)');

    assert.ok(
      objectType >= 0,
      `${NOTES_SCRIPT}: нет проверки %(objecttype) — скрипт не различает аннотированный ` +
        'тег и lightweight.',
    );
    assert.ok(subject >= 0, `${NOTES_SCRIPT}: нет чтения %(contents:subject) аннотации тега.`);
    assert.ok(
      objectType < subject,
      `${NOTES_SCRIPT}: %(contents:subject) читается раньше проверки %(objecttype) — ` +
        'subject lightweight-тега (subject коммита) снова может стать заголовком.',
    );
    assert.equal(
      code.split('%(contents:subject)').length - 1,
      1,
      `${NOTES_SCRIPT}: subject тега читается больше одного раза — второе чтение легко ` +
        'обойти проверкой типа. Чтение должно быть одно, внутри annotatedTagSubject.',
    );

    const functionStart = code.indexOf('function annotatedTagSubject');
    assert.ok(functionStart >= 0, `${NOTES_SCRIPT}: нет функции annotatedTagSubject.`);
    assert.ok(
      functionStart < subject,
      `${NOTES_SCRIPT}: %(contents:subject) читается вне annotatedTagSubject.`,
    );
    assert.match(
      code.slice(functionStart, subject),
      /!==\s*'tag'/u,
      `${NOTES_SCRIPT}: annotatedTagSubject не проверяет objecttype !== 'tag' до чтения ` +
        'subject — lightweight-тег протечёт в заголовок (ошибка 9d0c2d5e).',
    );
  });

  it('lightweight-тег не приносит тему из subject коммита', () => {
    const repo = tempRepo('etn-release-title-light-');
    git(repo, ['tag', 'v9.9.9']); // lightweight: subject = subject коммита
    const changelog = writeChangelog(
      repo,
      '9.9.9',
      '—',
      'Версия о проверке заголовка: сторож не должен путать subject коммита с темой.',
    );

    const { status, title } = runNotes(repo, [
      '--version',
      '9.9.9',
      '--tag',
      'v9.9.9',
      '--changelog',
      changelog,
    ]);

    assert.equal(status, 0, 'скрипт заметок упал на lightweight-теге.');
    assert.equal(
      title,
      'ETN 9.9.9 — Версия о проверке заголовка',
      'lightweight-тег дал не тему из лида changelog. У lightweight-тега ' +
        '%(contents:subject) — subject коммита; заголовок не должен его использовать.',
    );
    assert.ok(
      !title.includes('fix(ci)'),
      `Заголовок «${title}» взят из subject коммита — это ошибка 9d0c2d5e.`,
    );
  });

  it('аннотированный тег даёт тему, «ETN» не дублируется', () => {
    const repo = tempRepo('etn-release-title-annotated-');
    git(repo, ['tag', '-a', 'v9.9.9', '-m', 'ETN 9.9.9 — Тема из аннотации']);
    const changelog = writeChangelog(
      repo,
      '9.9.9',
      '—',
      'Версия о лиде: эта тема не должна попасть в заголовок при аннотированном теге.',
    );

    const { status, title } = runNotes(repo, [
      '--version',
      '9.9.9',
      '--tag',
      'v9.9.9',
      '--changelog',
      changelog,
    ]);

    assert.equal(status, 0, 'скрипт заметок упал на аннотированном теге.');
    assert.equal(title, 'ETN 9.9.9 — Тема из аннотации');
    assert.equal(
      title.match(/\bETN\b/gu)?.length,
      1,
      `Заголовок «${title}» дублирует ETN: префикс источника снимается и ставится один раз.`,
    );
  });

  it('без тега и лида тема берётся из --title, разделитель заголовка любой', () => {
    const repo = tempRepo('etn-release-title-explicit-');
    // Заголовок секции с дефисом (`-`) — тоже валиден; лида в секции нет.
    const changelog = writeChangelog(repo, '9.9.9', '-', '');

    const withTitle = runNotes(repo, [
      '--version',
      '9.9.9',
      '--changelog',
      changelog,
      '--title',
      'ETN 9.9.9 — Явная тема',
    ]);
    assert.equal(withTitle.status, 0, 'скрипт заметок упал на явной теме.');
    assert.equal(withTitle.title, 'ETN 9.9.9 — Явная тема');

    const withoutTheme = runNotes(repo, ['--version', '9.9.9', '--changelog', changelog]);
    assert.notEqual(
      withoutTheme.status,
      0,
      'Заголовок без темы (голый ETN X.Y.Z) недопустим: скрипт обязан упасть, ' +
        'а не выпустить релиз без темы.',
    );
    assert.match(
      withoutTheme.stderr,
      /заголовок/iu,
      'Ошибка об отсутствии темы должна быть понятной (упоминает заголовок).',
    );
  });
});

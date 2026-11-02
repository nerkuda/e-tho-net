/**
 * Сторож обязательной сборки Docker-образа сервера (задача ae122f1d, 0.15.2).
 *
 * В 0.15.1 Docker-джоба была удалена из релизного конвейера, и релиз выходил
 * без образа: ни один прогон не краснел, потому что контракт «образ —
 * обязательная часть релиза» нигде не проверялся. Сторож фиксирует его:
 *
 *   * `.github/workflows/docker-image.yml` — переиспользуемая сборка:
 *     триггер `workflow_call` (вызов из релиза) и `workflow_dispatch`
 *     (доопубликовать образ для уже вышедшего тега), обязательный вход `tag`,
 *     checkout по тегу, пуш `ghcr.io/<repo>/etn-server:<tag>` из
 *     `server/Dockerfile`, права `contents: read` + `packages: write`;
 *   * `.github/workflows/release.yml` — джоба `docker-image` вызывает этот
 *     workflow и передаёт тег; джоба `publish` перечисляет `docker-image`
 *     в `needs`, поэтому релиз без успешной публикации образа не выходит.
 *
 * Сторож статический: читает YAML как текст, без новых зависимостей.
 * Полноценный разбор не нужен — проверяются именованные ключи на своих
 * уровнях отступов, а строки-комментарии отбрасываются, чтобы упоминание
 * в шапке файла не маскировало удаление фактической настройки.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(SERVER_ROOT, '..');

const DOCKER_WORKFLOW = '.github/workflows/docker-image.yml';
const RELEASE_WORKFLOW = '.github/workflows/release.yml';

/** Прочитать файл workflow с понятной ошибкой, если он пропал или переехал. */
function readWorkflow(file: string, role: string): string {
  const abs = path.join(REPO_ROOT, file);
  assert.ok(
    fs.existsSync(abs),
    `Нет файла ${file} (${role}) — сторож Docker-образа не может проверить контракт. ` +
      'Если файл переехал, обнови путь в сторожа.',
  );
  return fs.readFileSync(abs, 'utf8');
}

/** Текст без строк-комментариев: упоминание настройки в шапке — не настройка. */
function stripComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
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

  const firstLine = lines[start];
  if (firstLine === undefined) return null;

  const block: string[] = [firstLine];
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

/** Значения `needs` джобы: `needs: a`, `needs: [a, b]` или блочный список. */
function needsOf(job: readonly string[]): string[] {
  const block = findBlock(job, 'needs', 4);
  if (!block) return [];

  const head = (block[0] ?? '').replace(/^\s*needs:\s*/, '').trim();
  const unquote = (value: string): string => value.replace(/^['"]|['"]$/g, '');
  if (head) {
    const items = head.startsWith('[') ? head.replace(/^\[|\]$/g, '').split(',') : [head];
    return items.map((item) => unquote(item.trim())).filter(Boolean);
  }

  return block
    .slice(1)
    .map((line) => /^\s*-\s*(.+)\s*$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => unquote((match[1] ?? '').trim()));
}

/** Триггеры из блока `on:`. */
function triggersOf(text: string): Set<string> {
  const lines = stripComments(text).split('\n');
  const on = findBlock(lines, 'on', 0);
  if (!on) return new Set();

  const names = new Set<string>();
  for (const line of on.slice(1)) {
    const match = /^ {2}([A-Za-z0-9_-]+):/.exec(line);
    if (match?.[1]) names.add(match[1]);
  }
  return names;
}

/** Блок входа `tag` у триггера на отступе 6 (под `inputs:`). */
function inputTagBlock(workflow: string, trigger: string): string[] | null {
  const lines = stripComments(workflow).split('\n');
  const triggerBlock = findBlock(lines, trigger, 2);
  if (!triggerBlock) return null;
  const inputs = findBlock(triggerBlock, 'inputs', 4);
  if (!inputs) return null;
  return findBlock(inputs, 'tag', 6);
}

describe('guard: Docker-образ сервера — обязательная часть релиза', () => {
  it(`${DOCKER_WORKFLOW}: workflow_call и workflow_dispatch с обязательным входом tag`, () => {
    const text = readWorkflow(DOCKER_WORKFLOW, 'переиспользуемая сборка образа');
    const triggers = triggersOf(text);

    assert.ok(
      triggers.has('workflow_call'),
      `${DOCKER_WORKFLOW}: нет триггера workflow_call — release.yml не сможет вызвать ` +
        'сборку образа, и релиз выйдет без Docker-образа.',
    );
    assert.ok(
      triggers.has('workflow_dispatch'),
      `${DOCKER_WORKFLOW}: нет триггера workflow_dispatch — образ для уже вышедшего ` +
        'тега нельзя доопубликовать без пересборки остальных ассетов.',
    );

    for (const trigger of ['workflow_call', 'workflow_dispatch']) {
      const tag = inputTagBlock(text, trigger);
      assert.ok(
        tag !== null,
        `${DOCKER_WORKFLOW}: у триггера ${trigger} нет входа tag — сборка не знает, ` +
          'какой тег собирать и каким тегом помечать образ.',
      );
      assert.match(
        tag.join('\n'),
        /^\s+required:\s*true\s*$/m,
        `${DOCKER_WORKFLOW}: вход tag у триггера ${trigger} не обязателен (required: true). ` +
          'Без тега checkout и тег образа неоднозначны.',
      );
      assert.match(
        tag.join('\n'),
        /^\s+type:\s*string\s*$/m,
        `${DOCKER_WORKFLOW}: вход tag у триггера ${trigger} должен быть строкой (type: string).`,
      );
    }
  });

  it(`${DOCKER_WORKFLOW}: пушит ghcr.io/<repo>/etn-server:<tag> из server/Dockerfile`, () => {
    const text = stripComments(readWorkflow(DOCKER_WORKFLOW, 'переиспользуемая сборка образа'));

    assert.match(
      text,
      /^\s*(?:-\s+)?uses:\s*docker\/build-push-action@v7\s*$/m,
      `${DOCKER_WORKFLOW}: нет docker/build-push-action@v7 — образ не собирается.`,
    );
    assert.match(
      text,
      /^\s*(?:-\s+)?uses:\s*docker\/login-action@v4\s*$/m,
      `${DOCKER_WORKFLOW}: нет docker/login-action@v4 — пуш в GHCR не авторизуется.`,
    );
    assert.match(
      text,
      /^\s*registry:\s*ghcr\.io\s*$/m,
      `${DOCKER_WORKFLOW}: вход в реестр не указан (registry: ghcr.io).`,
    );
    assert.match(
      text,
      /^\s*username:\s*\$\{\{\s*github\.actor\s*\}\}\s*$/m,
      `${DOCKER_WORKFLOW}: пользователь GHCR должен быть github.actor.`,
    );
    assert.match(
      text,
      /^\s*password:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}\s*$/m,
      `${DOCKER_WORKFLOW}: пароль GHCR должен быть secrets.GITHUB_TOKEN.`,
    );
    assert.match(
      text,
      /^\s*file:\s*server\/Dockerfile\s*$/m,
      `${DOCKER_WORKFLOW}: сборка идёт не из server/Dockerfile — образ сервера не соберётся.`,
    );
    assert.match(
      text,
      /^\s*push:\s*true\s*$/m,
      `${DOCKER_WORKFLOW}: push: true не задан — образ соберётся, но не попадёт в GHCR.`,
    );
    assert.match(
      text,
      /^\s*tags:\s*ghcr\.io\/\$\{\{\s*github\.repository\s*\}\}\/etn-server:\$\{\{\s*inputs\.tag\s*\}\}\s*$/m,
      `${DOCKER_WORKFLOW}: тег образа должен быть ` +
        'ghcr.io/${{ github.repository }}/etn-server:${{ inputs.tag }} — ' +
        'только версия тега, без latest.',
    );
    assert.match(
      text,
      /^\s*ref:\s*\$\{\{\s*inputs\.tag\s*\}\}\s*$/m,
      `${DOCKER_WORKFLOW}: checkout идёт не по inputs.tag — образ собирается не из того кода.`,
    );
    assert.match(
      text,
      /^\s*packages:\s*write\s*$/m,
      `${DOCKER_WORKFLOW}: нет права packages: write — пуш в GHCR запрещён.`,
    );
    assert.match(
      text,
      /^\s*contents:\s*read\s*$/m,
      `${DOCKER_WORKFLOW}: нет права contents: read — checkout по тегу запрещён.`,
    );
  });

  it(`${RELEASE_WORKFLOW}: джоба docker-image вызывает reusable workflow с тегом релиза`, () => {
    const text = stripComments(readWorkflow(RELEASE_WORKFLOW, 'релизный конвейер'));
    const job = findBlock(text.split('\n'), 'docker-image', 2);
    assert.ok(
      job !== null,
      `${RELEASE_WORKFLOW}: нет джобы docker-image — релиз публикуется без Docker-образа.`,
    );

    const uses = findBlock(job, 'uses', 4);
    assert.ok(
      uses !== null &&
        /^\s*uses:\s*\.\/\.github\/workflows\/docker-image\.yml\s*$/.test(uses[0] ?? ''),
      `${RELEASE_WORKFLOW}: джоба docker-image не вызывает ./.github/workflows/docker-image.yml.`,
    );

    const withBlock = findBlock(job, 'with', 4);
    assert.ok(
      withBlock !== null &&
        withBlock.some((line) => /^\s*tag:\s*\$\{\{\s*inputs\.tag\s*\|\|\s*github\.ref_name\s*\}\}\s*$/.test(line)),
      `${RELEASE_WORKFLOW}: docker-image не передаёт тег релиза ` +
        '(with: tag: ${{ inputs.tag || github.ref_name }}) — ' +
        'ручной запуск и пуш тега собирали бы разные образы.',
    );

    const permissions = findBlock(job, 'permissions', 4);
    assert.ok(
      permissions !== null && permissions.some((line) => /^\s*packages:\s*write\s*$/.test(line)),
      `${RELEASE_WORKFLOW}: у джобы docker-image нет job-level права packages: write — ` +
        'reusable workflow может только сузить права вызывающей джобы, и пуш в GHCR ' +
        'упадёт на отказе доступа.',
    );
    assert.ok(
      permissions !== null && permissions.some((line) => /^\s*contents:\s*read\s*$/.test(line)),
      `${RELEASE_WORKFLOW}: у джобы docker-image нет job-level права contents: read.`,
    );
  });

  it(`${RELEASE_WORKFLOW}: publish зависит от docker-image`, () => {
    const text = stripComments(readWorkflow(RELEASE_WORKFLOW, 'релизный конвейер'));
    const publish = findBlock(text.split('\n'), 'publish', 2);
    assert.ok(publish !== null, `${RELEASE_WORKFLOW}: нет джобы publish.`);

    const needs = needsOf(publish);
    assert.ok(
      needs.includes('docker-image'),
      `${RELEASE_WORKFLOW}: publish.needs не содержит docker-image ` +
        `(сейчас: ${needs.join(', ') || 'пусто'}). Релиз обязан ждать публикации ` +
        'образа: иначе при сбое сборки релиз выйдет без Docker-образа.',
    );
  });
});

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
 *     необязательный вход `source_ref` у `workflow_call` — коммит кода
 *     образа, пуш `ghcr.io/<repo>/etn-server:<tag>` из `server/Dockerfile`,
 *     права `contents: read` + `packages: write`. Источник кода — явный вход:
 *     `ref: ${{ inputs.source_ref || inputs.tag }}`. Различать вызов из
 *     релиза по `github.event_name` нельзя: внутри reusable workflow это
 *     событие ВЫЗЫВАЮЩЕГО workflow (`workflow_dispatch`/`push`), а не
 *     `workflow_call` (ошибка dd38a306, итерация 2). Поэтому релиз передаёт
 *     `source_ref: github.sha`, а ручной `workflow_dispatch` его не передаёт,
 *     и `||` уводит checkout на `inputs.tag`.
 *     Настройки сверяются внутри своего шага (`checkout`, `login`,
 *     `build-push`): перенос `file:`/`push:`/`tags:` в чужой шаг сторож
 *     ловит. `if:` и `continue-on-error:` у джобы и у шага сборки запрещены —
 *     иначе обязательную сборку можно отключить при зелёном прогоне;
 *   * `.github/workflows/release.yml` — джоба `docker-image` зависит от
 *     `version` (упавшая валидация версии/тега не оставляет образ-сироту),
 *     вызывает этот workflow и передаёт `tag` и `source_ref: github.sha`;
 *     джоба `publish` перечисляет `docker-image` в `needs`, поэтому релиз
 *     без успешной публикации образа не выходит. Джоба `docker-image` не
 *     отключается (`if:`, `continue-on-error:` запрещены).
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
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildOciRegistryPackage, dockerImageRef } from '../src/docker/registry.js';
import { githubSlugFromRegistryName } from '../src/mcpb/manifest.js';
import { MCP_REGISTRY_NAME } from '../src/mcp/server.js';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(SERVER_ROOT, '..');

const DOCKER_WORKFLOW = '.github/workflows/docker-image.yml';
const RELEASE_WORKFLOW = '.github/workflows/release.yml';
const DOCKERFILE = 'server/Dockerfile';

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

/** Блок входа `<name>` у триггера на отступе 6 (под `inputs:`). */
function inputBlock(workflow: string, trigger: string, name: string): string[] | null {
  const lines = stripComments(workflow).split('\n');
  const triggerBlock = findBlock(lines, trigger, 2);
  if (!triggerBlock) return null;
  const inputs = findBlock(triggerBlock, 'inputs', 4);
  if (!inputs) return null;
  return findBlock(inputs, name, 6);
}

/** Блок входа `tag` у триггера. */
function inputTagBlock(workflow: string, trigger: string): string[] | null {
  return inputBlock(workflow, trigger, 'tag');
}

/** Экранирование строки для использования в регулярном выражении. */
function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Элементы YAML-списка (`- ...`) в блоке: шаг и его продолжение. */
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

/** Единственная джоба переиспользуемого workflow (её блок). */
function singleJob(workflow: string): string[] {
  const jobs = findBlock(workflow.split('\n'), 'jobs', 0);
  assert.ok(jobs !== null, `${DOCKER_WORKFLOW}: нет блока jobs.`);

  const names = jobs
    .map((line) => /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => match[1] ?? '');
  assert.equal(
    names.length,
    1,
    `${DOCKER_WORKFLOW}: ожидается ровно одна джоба, найдено ${names.length}: ` +
      `${names.join(', ') || 'ни одной'}.`,
  );

  const job = findBlock(jobs, names[0] ?? '', 2);
  assert.ok(job !== null, `${DOCKER_WORKFLOW}: не найден блок джобы ${names[0]}.`);
  return job;
}

/** Шаг с указанным `uses: <action>` (его блок вместе с `with:`). */
function stepUsing(job: readonly string[], action: string): string[] | null {
  const steps = findBlock(job, 'steps', 4);
  if (!steps) return null;
  const pattern = new RegExp(`^\\s*-\\s+uses:\\s*${escapeRe(action)}\\s*$`);
  return listItems(steps).find((item) => item.some((line) => pattern.test(line))) ?? null;
}

/** Ключ на уровне джобы (отступ 4): `if:`, `continue-on-error:` и подобные. */
function jobLevelKey(job: readonly string[], key: string): boolean {
  return job.some((line) => new RegExp(`^ {4}${escapeRe(key)}:`).test(line));
}

/** Ключ на уровне шага: `- if:` в заголовке или `if:` в продолжении. */
function stepKey(step: readonly string[], key: string): boolean {
  return step.some((line) => new RegExp(`^\\s*(?:-\\s+)?${escapeRe(key)}:`).test(line));
}

/** Блок `with:` шага: строка ключа и все строки глубже. */
function withBlock(step: readonly string[]): string[] | null {
  const start = step.findIndex((line) => /^\s*(?:-\s+)?with:\s*$/.test(line));
  if (start < 0) return null;

  const head = step[start] ?? '';
  const indent = indentOf(head);
  const body: string[] = [];
  for (let i = start + 1; i < step.length; i += 1) {
    const line = step[i];
    if (line === undefined) break;
    if (line.trim() !== '' && indentOf(line) <= indent) break;
    body.push(line);
  }
  return body;
}

/**
 * Значение `key: <value>` внутри блока `with:` шага.
 *
 * Читать аргументы action можно только отсюда: `name:` уровня шага — это
 * display name («Upload ETN installer»), а не `with.name` артефакта.
 * Прежний `stepValue` брал первое совпадение по всему шагу, и добавление
 * подписи шага подменяло имя артефакта (сторож зеленел/краснел ложно).
 */
function withValue(step: readonly string[], key: string): string | null {
  const block = withBlock(step);
  if (!block) return null;

  const pattern = new RegExp(`^\\s*${escapeRe(key)}:\\s*(.+?)\\s*$`);
  for (const line of block) {
    const match = pattern.exec(line);
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * Разобрать checkout-ref как выражение с запасным значением
 * `<основной> || <запасной>`. Пробелы внутри выражения не значимы.
 * `null` — выражение не такой формы.
 */
function parseRefFallback(ref: string): { primary: string; fallback: string } | null {
  const compact = ref.replace(/\s+/g, '');
  const body = /^\$\{\{(.+)\}\}$/.exec(compact)?.[1];
  if (!body) return null;
  const parts = /^(.+?)\|\|(.+)$/.exec(body);
  if (!parts) return null;
  return { primary: parts[1] ?? '', fallback: parts[2] ?? '' };
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

  it(`${DOCKER_WORKFLOW}: собирает и пушит etn-server и etn-mcp в GHCR и Docker Hub`, () => {
    const text = stripComments(readWorkflow(DOCKER_WORKFLOW, 'переиспользуемая сборка образов'));
    const job = singleJob(text);

    // Джоба сборки не отключается: `if: false` или `continue-on-error` дали бы
    // зелёный прогон без образов, а `publish` дождался бы «успеха».
    assert.ok(
      !jobLevelKey(job, 'if'),
      `${DOCKER_WORKFLOW}: у джобы сборки есть if: — её можно отключить (if: false), ` +
        'и образы молча не соберутся.',
    );
    assert.ok(
      !jobLevelKey(job, 'continue-on-error'),
      `${DOCKER_WORKFLOW}: у джобы сборки есть continue-on-error: — провал сборки/пуша ` +
        'не сделает джобу красной.',
    );

    const checkout = stepUsing(job, 'actions/checkout@v7');
    assert.ok(
      checkout !== null,
      `${DOCKER_WORKFLOW}: нет шага actions/checkout@v7 — код для образов не скачивается.`,
    );
    // Источник кода (после какого ref идёт checkout) проверяется отдельным
    // тестом ниже: он зависит от триггера, а не от факта пуша образов.

    // Метаданные — из единственного источника (идентичность не литерал).
    const meta = [...listItems(findBlock(job, 'steps', 4) ?? [])].find((item) =>
      item.some((line) => /node server\/scripts\/docker-metadata\.mjs/.test(line)),
    );
    assert.ok(
      meta !== undefined,
      `${DOCKER_WORKFLOW}: нет шага server/scripts/docker-metadata.mjs — метки образов ` +
        'пришлось бы писать литералами, и реестровое имя разошлось бы с кодом.',
    );
    assert.ok(
      meta.some((line) => /--github-output "\$GITHUB_OUTPUT"/.test(line)),
      `${DOCKER_WORKFLOW}: шаг метаданных не пишет в $GITHUB_OUTPUT — шаги сборки не увидят значения.`,
    );
    assert.ok(
      meta.some((line) =>
        /--revision "\$\{\{ inputs\.source_ref \|\| github\.sha \}\}"/.test(line),
      ),
      `${DOCKER_WORKFLOW}: шаг метаданных не передаёт --revision из коммита релиза — ` +
        'метка revision разойдётся с тегом.',
    );

    const builds = stepsUsingPrefix(job, 'docker/build-push-action@');
    assert.equal(
      builds.length,
      2,
      `${DOCKER_WORKFLOW}: ожидаются два шага docker/build-push-action (etn-server и etn-mcp), ` +
        `найдено ${builds.length}.`,
    );

    const buildOf = (target: string): string[] => {
      const step = builds.find(
        (item) =>
          blockValueLines(item, 'build-args').some((line) => line.includes('VERSION=')) &&
          item.some((line) => new RegExp(`^\\s*target:\\s*${target}\\s*$`).test(line)),
      );
      assert.ok(step !== undefined, `${DOCKER_WORKFLOW}: нет шага сборки цели ${target}.`);
      return step;
    };

    for (const target of ['server', 'mcp']) {
      const build = buildOf(target);
      assert.ok(
        build.some((line) => /^\s*file:\s*server\/Dockerfile\s*$/.test(line)),
        `${DOCKER_WORKFLOW}: в шаге ${target} нет file: server/Dockerfile — образ ` +
          'сервера не соберётся.',
      );
      assert.ok(
        build.some((line) => /^\s*push:\s*true\s*$/.test(line)),
        `${DOCKER_WORKFLOW}: в шаге ${target} нет push: true — образ соберётся, но никуда не попадёт.`,
      );
      assert.ok(
        withValue(build, 'platforms') === 'linux/amd64,linux/arm64',
        `${DOCKER_WORKFLOW}: шаг ${target} обязан собирать linux/amd64 и linux/arm64 ` +
          `(сейчас: ${withValue(build, 'platforms') ?? 'пусто'}).`,
      );
      assert.ok(
        !stepKey(build, 'if'),
        `${DOCKER_WORKFLOW}: у шага ${target} есть if: — сборку/пуш можно отключить.`,
      );
      assert.ok(
        !stepKey(build, 'continue-on-error'),
        `${DOCKER_WORKFLOW}: у шага ${target} есть continue-on-error: — провал пуша ` +
          'не сделает джобу красной.',
      );

      const tags = blockValueLines(build, 'tags');
      const image = target === 'server' ? 'server_image' : 'mcp_image';
      assert.ok(
        tags.includes(
          `ghcr.io/\${{ github.repository }}/\${{ steps.meta.outputs.${image} }}:\${{ inputs.tag }}`,
        ),
        `${DOCKER_WORKFLOW}: шаг ${target} не пушит ghcr.io/<repo>/<${image}>:<tag> — ` +
          'зеркало в GHCR выпадает из релиза.',
      );
      assert.ok(
        tags.includes(
          `docker.io/\${{ steps.meta.outputs.dockerhub_namespace }}/\${{ steps.meta.outputs.${image} }}:\${{ inputs.tag }}`,
        ),
        `${DOCKER_WORKFLOW}: шаг ${target} не пушит docker.io/<namespace>/<${image}>:<tag> — ` +
          'образ не попадёт в Docker Hub.',
      );
      assert.ok(
        tags.every((line) => !/:latest$/.test(line)),
        `${DOCKER_WORKFLOW}: шаг ${target} ставит тег latest — образ адресуется только версией.`,
      );

      const args = blockValueLines(build, 'build-args');
      for (const key of ['VERSION', 'REVISION', 'SOURCE_URL', 'LICENSE']) {
        assert.ok(
          args.some((line) => line.startsWith(`${key}=`)),
          `${DOCKER_WORKFLOW}: шаг ${target} не передаёт build-arg ${key} — метка OCI ` +
            'останется пустой и Dockerfile упадёт (assert).',
        );
      }
    }

    // Реестровая метка — только у stdio-образа: HTTP-образ MCP не запускает.
    const mcpArgs = blockValueLines(buildOf('mcp'), 'build-args');
    assert.ok(
      mcpArgs.includes('MCP_REGISTRY_NAME=${{ steps.meta.outputs.registry_name }}'),
      `${DOCKER_WORKFLOW}: шаг mcp не передаёт MCP_REGISTRY_NAME из метаданных — ` +
        'метка владения уедет в литерал или пропадёт.',
    );
    assert.ok(
      !blockValueLines(buildOf('server'), 'build-args').some((line) =>
        line.startsWith('MCP_REGISTRY_NAME='),
      ),
      `${DOCKER_WORKFLOW}: шаг server передаёт MCP_REGISTRY_NAME — HTTP-образ не должен ` +
        'нести реестровую метку (ADR d17c3a29 п. 2).',
    );

    const logins = stepsUsingPrefix(job, 'docker/login-action@');
    assert.equal(
      logins.length,
      2,
      `${DOCKER_WORKFLOW}: ожидаются входы в два реестра (ghcr.io и docker.io), ` +
        `найдено ${logins.length}.`,
    );
    const ghcrLogin = logins.find((item) =>
      item.some((line) => /^\s*registry:\s*ghcr\.io\s*$/.test(line)),
    );
    assert.ok(
      ghcrLogin !== undefined,
      `${DOCKER_WORKFLOW}: нет входа в ghcr.io — пуш в GHCR не авторизуется.`,
    );
    assert.ok(
      ghcrLogin.some((line) => /^\s*username:\s*\$\{\{\s*github\.actor\s*\}\}\s*$/.test(line)),
      `${DOCKER_WORKFLOW}: вход в GHCR должен использовать github.actor.`,
    );
    assert.ok(
      ghcrLogin.some((line) =>
        /^\s*password:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}\s*$/.test(line),
      ),
      `${DOCKER_WORKFLOW}: вход в GHCR должен использовать secrets.GITHUB_TOKEN.`,
    );
    const dockerHubLogin = logins.find((item) =>
      item.some((line) => /^\s*registry:\s*docker\.io\s*$/.test(line)),
    );
    assert.ok(
      dockerHubLogin !== undefined,
      `${DOCKER_WORKFLOW}: нет входа в docker.io — пуш в Docker Hub не авторизуется.`,
    );
    assert.ok(
      dockerHubLogin.some((line) =>
        /^\s*username:\s*\$\{\{\s*secrets\.DOCKERHUB_USERNAME\s*\}\}\s*$/.test(line),
      ),
      `${DOCKER_WORKFLOW}: вход в Docker Hub должен брать secrets.DOCKERHUB_USERNAME.`,
    );
    assert.ok(
      dockerHubLogin.some((line) =>
        /^\s*password:\s*\$\{\{\s*secrets\.DOCKERHUB_TOKEN\s*\}\}\s*$/.test(line),
      ),
      `${DOCKER_WORKFLOW}: вход в Docker Hub должен брать secrets.DOCKERHUB_TOKEN (не пароль).`,
    );

    assert.match(
      text,
      /^\s*packages:\s*write\s*$/m,
      `${DOCKER_WORKFLOW}: нет права packages: write — пуш в GHCR запрещён.`,
    );
    assert.match(
      text,
      /^\s*contents:\s*read\s*$/m,
      `${DOCKER_WORKFLOW}: нет права contents: read — чтение репозитория для checkout запрещено.`,
    );
  });

  it(`${DOCKER_WORKFLOW}: источник кода — вход source_ref, иначе tag`, () => {
    const text = stripComments(readWorkflow(DOCKER_WORKFLOW, 'переиспользуемая сборка образа'));
    const job = singleJob(text);
    const checkout = stepUsing(job, 'actions/checkout@v7');
    assert.ok(
      checkout !== null,
      `${DOCKER_WORKFLOW}: нет шага actions/checkout@v7 — код для образа не скачивается.`,
    );

    const ref = withValue(checkout, 'ref');
    assert.ok(
      ref !== null,
      `${DOCKER_WORKFLOW}: в шаге checkout нет ref: — код берётся по умолчанию (последний ` +
        'коммит ветки), а не из явного входа.',
    );

    const parsed = parseRefFallback(ref);
    assert.ok(
      parsed !== null,
      `${DOCKER_WORKFLOW}: ref checkout должен быть выражением ` +
        '${{ inputs.source_ref || inputs.tag }}, ' +
        `сейчас: "${ref}". github.event_name внутри reusable workflow — событие ` +
        'ВЫЗЫВАЮЩЕГО workflow, а не workflow_call: различать вызов из релиза по нему ' +
        'нельзя, и prerelease до создания тега снова упадёт на checkout по inputs.tag.',
    );

    // release.yml передаёт source_ref = github.sha (коммит релиза): тег создаст
    // publish позже, и github.sha — target_commitish будущего тега.
    assert.equal(
      parsed.primary,
      'inputs.source_ref',
      `${DOCKER_WORKFLOW}: checkout должен брать вход source_ref (коммит кода образа), ` +
        `сейчас: "${parsed.primary}". Ручной workflow_dispatch source_ref не передаёт — ` +
        'запасное значение уводит checkout на tag.',
    );
    assert.equal(
      parsed.fallback,
      'inputs.tag',
      `${DOCKER_WORKFLOW}: запасное значение checkout — inputs.tag ` +
        `(доопубликование образа существующего тега), сейчас: "${parsed.fallback}".`,
    );

    // Вход source_ref объявлен у workflow_call, необязательный, пустой по
    // умолчанию: без него (workflow_dispatch) inputs.source_ref — пустая строка,
    // и `||` уводит checkout на tag.
    const sourceRef = inputBlock(text, 'workflow_call', 'source_ref');
    assert.ok(
      sourceRef !== null,
      `${DOCKER_WORKFLOW}: у workflow_call нет входа source_ref — release.yml не сможет ` +
        'передать коммит релиза, и checkout останется на теге, которого при prerelease ' +
        'ещё нет (ошибка dd38a306).',
    );
    assert.match(
      sourceRef.join('\n'),
      /^\s+required:\s*false\s*$/m,
      `${DOCKER_WORKFLOW}: вход source_ref должен быть необязательным (required: false): ` +
        'ручной запуск релиза его передаёт, а другие вызовы не обязаны.',
    );
    assert.match(
      sourceRef.join('\n'),
      /^\s+type:\s*string\s*$/m,
      `${DOCKER_WORKFLOW}: вход source_ref должен быть строкой (type: string).`,
    );
    assert.match(
      sourceRef.join('\n'),
      /^\s+default:\s*(''|"")\s*$/m,
      `${DOCKER_WORKFLOW}: у входа source_ref должен быть пустой default (''): без него ` +
        'вызов без source_ref не сможет уйти на inputs.tag.',
    );
  });

  it(`${RELEASE_WORKFLOW}: джоба docker-image вызывает reusable workflow с тегом релиза`, () => {
    const text = stripComments(readWorkflow(RELEASE_WORKFLOW, 'релизный конвейер'));
    const job = findBlock(text.split('\n'), 'docker-image', 2);
    assert.ok(
      job !== null,
      `${RELEASE_WORKFLOW}: нет джобы docker-image — релиз публикуется без Docker-образа.`,
    );

    // Джобу нельзя отключить или сделать «необязательной»: зелёный прогон без
    // образа для publish неотличим от успешной публикации.
    assert.ok(
      !jobLevelKey(job, 'if'),
      `${RELEASE_WORKFLOW}: у джобы docker-image есть if: — её можно отключить ` +
        '(if: false), и релиз выйдет без образа при зелёном прогоне.',
    );
    assert.ok(
      !jobLevelKey(job, 'continue-on-error'),
      `${RELEASE_WORKFLOW}: у джобы docker-image есть continue-on-error: — провал сборки ` +
        'образа не сделает джобу красной, и publish не остановится.',
    );

    const jobNeeds = needsOf(job);
    assert.ok(
      jobNeeds.includes('version'),
      `${RELEASE_WORKFLOW}: docker-image не зависит от version (needs: ${jobNeeds.join(', ') || 'пусто'}) — ` +
        'при падении валидации версии/тега образ уедет в GHCR сиротой для релиза, ' +
        'который не выйдет.',
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
        withBlock.some((line) =>
          /^\s*tag:\s*\$\{\{\s*inputs\.tag\s*\|\|\s*github\.ref_name\s*\}\}\s*$/.test(line),
        ),
      `${RELEASE_WORKFLOW}: docker-image не передаёт тег релиза ` +
        '(with: tag: ${{ inputs.tag || github.ref_name }}) — ' +
        'ручной запуск и пуш тега собирали бы разные образы.',
    );
    // Источник кода образа — коммит релиза, а не тег: при prerelease через
    // workflow_dispatch тега ещё нет (его создаёт publish), и checkout по tag
    // падает (ошибка dd38a306).
    assert.ok(
      withBlock !== null &&
        withBlock.some((line) => /^\s*source_ref:\s*\$\{\{\s*github\.sha\s*\}\}\s*$/.test(line)),
      `${RELEASE_WORKFLOW}: docker-image не передаёт source_ref: github.sha — reusable ` +
        'workflow не знает коммит релиза и откатится на inputs.tag: prerelease до ' +
        'создания тега упадёт на checkout (ошибка dd38a306).',
    );
    // Docker Hub требует токен владельца namespace: reusable workflow получает
    // секреты вызывающей джобы только явно.
    const jobSecrets = findBlock(job, 'secrets', 4);
    assert.ok(
      jobSecrets !== null && /^ {4}secrets:\s*inherit\s*$/.test(jobSecrets[0] ?? ''),
      `${RELEASE_WORKFLOW}: docker-image не передаёт secrets: inherit — вход в Docker Hub ` +
        '(DOCKERHUB_USERNAME/DOCKERHUB_TOKEN) не получит токены, и релиз упадёт на login.',
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

/**
 * Контракт содержимого образов (задача 3db76d75, ADR ad67950b, aa9507e6,
 * d17c3a29).
 *
 * Dockerfile — единственное место, где собираются оба образа; метки OCI и
 * реестровая метка `io.modelcontextprotocol.server.name` обязаны приходить из
 * build-args (единственный источник — `server/src/mcp/server.ts`), а не быть
 * литералами. Локальный сборщик не пушит: публикация — только в конвейере.
 */

interface DockerMetadataLib {
  DOCKER_TARGETS: readonly string[];
  readRegistryName(repoRoot?: string): string;
  githubSlug(registryName: string): string;
  dockerHubNamespace(registryName: string): string;
  imageRefs(target: string, tag: string, registryName: string): { ghcr: string; dockerHub: string };
  rootVersion(repoRoot?: string): string;
  dockerBuildArgs(input?: { revision?: string; repoRoot?: string }): Record<string, string>;
  licenseIdentifier(repoRoot?: string): string;
  sourceUrl(registryName: string): string;
}

const dockerMetadata = (await import(
  pathToFileURL(path.join(SERVER_ROOT, 'scripts', 'lib', 'docker-metadata.mjs')).href
)) as DockerMetadataLib;

/** Стадии Dockerfile: имя (`AS <stage>`) → текст стадии без строки `FROM`. */
function dockerStages(text: string): Map<string, string> {
  const stages = new Map<string, string>();
  let current: string | null = null;
  const body: string[] = [];
  const flush = (): void => {
    if (current !== null) stages.set(current, body.join('\n'));
  };
  for (const line of text.split('\n')) {
    const match = /^FROM\s+\S+\s+AS\s+(\S+)\s*$/i.exec(line.trim());
    if (match?.[1]) {
      flush();
      current = match[1];
      body.length = 0;
      continue;
    }
    if (current !== null) body.push(line);
  }
  flush();
  return stages;
}

describe('guard: Dockerfile образов и метаданные из единственного источника', () => {
  const dockerfile = fs.readFileSync(path.join(REPO_ROOT, 'server', 'Dockerfile'), 'utf8');
  const stages = dockerStages(dockerfile);
  const stage = (name: string): string => {
    const text = stages.get(name);
    assert.ok(text !== undefined, `${DOCKERFILE}: нет стадии ${name} — цель образа пропала.`);
    return text;
  };

  it(`${DOCKERFILE}: две цели — HTTP-сервер и MCP stdio через общий cli.js mcp`, () => {
    for (const name of ['builder', 'runtime', 'server', 'mcp']) {
      assert.ok(stages.has(name), `${DOCKERFILE}: нет стадии ${name}.`);
    }

    const server = stage('server');
    assert.match(
      server,
      /^ENTRYPOINT \["node", "server\/dist\/index\.js"\]$/m,
      `${DOCKERFILE}: HTTP-цель обязана запускать node server/dist/index.js.`,
    );

    const mcp = stage('mcp');
    assert.match(
      mcp,
      /^ENTRYPOINT \["node", "server\/dist\/cli\.js", "mcp"\]$/m,
      `${DOCKERFILE}: MCP-цель обязана запускать node server/dist/cli.js mcp — ` +
        'общий bootstrap каталога данных (ADR aa9507e6 п. 5), а не свою обёртку.',
    );
    assert.doesNotMatch(
      mcp,
      /bin\/etn-mcp/,
      `${DOCKERFILE}: MCP-цель не должна идти через bin-обёртку пакета: ` +
        'в контейнере каталог данных задан ETN_DATA_DIR, личный каталог не нужен.',
    );

    // Данные — всегда /data (ADR ad67950b): volume и классификация каталога.
    const runtime = stage('runtime');
    assert.match(runtime, /ETN_DATA_DIR=\/data/, `${DOCKERFILE}: ETN_DATA_DIR обязан быть /data.`);
    assert.match(runtime, /^VOLUME \/data$/m, `${DOCKERFILE}: нет VOLUME /data — том не объявлен.`);
    assert.match(server, /^EXPOSE 4321$/m, `${DOCKERFILE}: HTTP-цель обязана объявлять порт 4321.`);
    assert.match(
      server,
      /ETN_HOST=0\.0\.0\.0/,
      `${DOCKERFILE}: HTTP-цель обязана слушать 0.0.0.0 в контейнере — иначе ` +
        '`docker run -p 4321:4321` не отвечает (сервер по умолчанию 127.0.0.1:3000).',
    );
    assert.match(
      server,
      /ETN_PORT=4321/,
      `${DOCKERFILE}: HTTP-цель обязана по умолчанию слушать 4321.`,
    );
    assert.doesNotMatch(mcp, /^EXPOSE /m, `${DOCKERFILE}: MCP-цель не публикует TCP-порт (stdio).`);
  });

  it(`${DOCKERFILE}: метки OCI из build-args, MCP-метка только у stdio-образа`, () => {
    for (const target of ['server', 'mcp']) {
      const text = stage(target);
      for (const label of ['version', 'revision', 'source', 'licenses']) {
        assert.ok(
          text.includes(`org.opencontainers.image.${label}="\${`),
          `${DOCKERFILE}: у цели ${target} метка org.opencontainers.image.${label} ` +
            'обязана подставлять build-arg, а не литерал.',
        );
      }
      assert.match(
        text,
        /^ARG VERSION$/m,
        `${DOCKERFILE}: цель ${target} не объявляет ARG VERSION — метка версии не соберётся.`,
      );
      assert.match(
        text,
        /RUN test -n "\$VERSION"/,
        `${DOCKERFILE}: цель ${target} не проверяет переданные метки — образ уедет с пустыми ` +
          'labels при сборке без build-args.',
      );
    }

    const mcp = stage('mcp');
    assert.match(
      mcp,
      /^ARG MCP_REGISTRY_NAME$/m,
      `${DOCKERFILE}: MCP-цель не объявляет ARG MCP_REGISTRY_NAME.`,
    );
    assert.match(
      mcp,
      /^\s*io\.modelcontextprotocol\.server\.name="\$\{MCP_REGISTRY_NAME\}"$/m,
      `${DOCKERFILE}: на stdio-образе нет метки io.modelcontextprotocol.server.name ` +
        'из MCP_REGISTRY_NAME (ADR d17c3a29 п. 2) — реестр не подтвердит владение.',
    );
    assert.doesNotMatch(
      stage('server'),
      /^\s*io\.modelcontextprotocol\.server\.name=/m,
      `${DOCKERFILE}: реестровая MCP-метка стоит на HTTP-образе — он не запускает MCP.`,
    );
    assert.doesNotMatch(
      dockerfile,
      /io\.github\./,
      `${DOCKERFILE}: реестровое имя вписано литералом — источник один ` +
        '(server/src/mcp/server.ts), значение приходит build-arg.',
    );
    assert.doesNotMatch(dockerfile, /:latest/, `${DOCKERFILE}: тег latest не публикуется.`);
  });

  it('метаданные образов совпадают с серверным кодом и манифестами', () => {
    const version = dockerMetadata.rootVersion(REPO_ROOT);
    const registryName = dockerMetadata.readRegistryName(REPO_ROOT);

    assert.equal(registryName, MCP_REGISTRY_NAME, 'реестровое имя читается из src/mcp/server.ts');
    assert.equal(
      dockerMetadata.githubSlug(registryName),
      githubSlugFromRegistryName(registryName),
      'slug из скрипта совпадает со slug в src/mcpb/manifest.ts',
    );
    assert.equal(dockerMetadata.dockerHubNamespace(registryName), 'nerkuda');
    assert.equal(dockerMetadata.sourceUrl(registryName), 'https://github.com/nerkuda/e-tho-net');

    const refs = dockerMetadata.imageRefs('mcp', `v${version}`, registryName);
    assert.deepEqual(refs, {
      ghcr: `ghcr.io/nerkuda/e-tho-net/etn-mcp:v${version}`,
      dockerHub: `docker.io/nerkuda/etn-mcp:v${version}`,
    });
    assert.equal(
      dockerImageRef('etn-mcp', version),
      refs.dockerHub,
      'запись OCI в server.json и сборочный скрипт берут имя образа из одного расчёта',
    );
    assert.deepEqual(buildOciRegistryPackage(version), {
      registryType: 'oci',
      identifier: `docker.io/nerkuda/etn-mcp:v${version}`,
      version,
      transport: { type: 'stdio' },
    });
    assert.throws(
      () => dockerMetadata.imageRefs('mcp', 'latest', registryName),
      /latest не публикуется/,
      'тег latest запрещён сборочным расчётом',
    );
    assert.throws(() => dockerMetadata.imageRefs('gateway', `v${version}`, registryName));
    assert.throws(() => dockerImageRef('etn-mcp', '1.2'), /X\.Y\.Z/);

    const args = dockerMetadata.dockerBuildArgs({ revision: 'deadbeef' });
    assert.deepEqual(args, {
      VERSION: version,
      REVISION: 'deadbeef',
      MCP_REGISTRY_NAME: MCP_REGISTRY_NAME,
      SOURCE_URL: 'https://github.com/nerkuda/e-tho-net',
      LICENSE: dockerMetadata.licenseIdentifier(REPO_ROOT),
    });
    assert.equal(args.LICENSE, 'MIT', 'лицензия читается из LICENSE');
    assert.equal(
      dockerMetadata.dockerBuildArgs({ revision: '' }).REVISION,
      'unknown',
      'без коммита revision не пустая метка',
    );
  });

  it('локальный сборщик: цель обязательна, пуша нет, метки из общего расчёта', () => {
    const script = fs.readFileSync(
      path.join(SERVER_ROOT, 'scripts', 'build-docker-image.mjs'),
      'utf8',
    );
    assert.match(
      script,
      /from '\.\/lib\/docker-metadata\.mjs'/,
      'сборщик обязан брать метки и имена из общего модуля метаданных',
    );
    assert.match(script, /--target/, 'сборщик требует явную цель образа');
    assert.match(
      script,
      /DOCKER_TARGETS\.includes\(options\.target\)/,
      'сборщик проверяет цель по списку Dockerfile',
    );
    assert.ok(
      script.includes("'--target',"),
      'сборщик передаёт --target в docker build: цель адресуется явно',
    );
    assert.match(
      script,
      /'--build-arg'/,
      'метки передаются build-arg, а не литералом в Dockerfile',
    );
    assert.doesNotMatch(
      script,
      /docker',\s*\['push'|--push\b|spawnSync\('docker', \['push'/,
      'локальный сборщик не пушит образы: публикация — конвейер релиза с токенами владельца',
    );

    const pkg = JSON.parse(fs.readFileSync(path.join(SERVER_ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    assert.equal(
      pkg.scripts?.['docker:build'],
      'node scripts/build-docker-image.mjs',
      'скрипт docker:build ведёт к сборщику образа',
    );
  });

  it('docker-compose.yml собирает HTTP-цель, а не последнюю стадию', () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, 'docker-compose.yml'), 'utf8');
    assert.match(
      text,
      /^ {6}dockerfile: server\/Dockerfile$/m,
      'compose-пример обязан собирать образ из server/Dockerfile',
    );
    assert.match(
      text,
      /^ {6}target: server$/m,
      'compose-пример без target соберёт последнюю стадию (mcp) — сервис HTTP не поднимется',
    );
  });

  it('.dockerignore не пускает в контекст данные, артефакты и клиент', () => {
    const file = path.join(REPO_ROOT, '.dockerignore');
    assert.ok(fs.existsSync(file), 'нет .dockerignore — контекст утащит node_modules и данные');
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of ['node_modules', '**/dist', 'etn_data', '.env', 'release']) {
      assert.ok(
        text.split('\n').some((line) => line.trim() === pattern),
        `.dockerignore: нет правила ${pattern}`,
      );
    }
    assert.match(
      text,
      /^!client\/package\.json$/m,
      '.dockerignore: манифест клиента нужен npm workspaces (исключение из client/*)',
    );
  });
});

/**
 * Сторож состава ассетов релиза (ошибка 054b0a66, 0.15.2).
 *
 * `docker/build-push-action` кладёт в артефакты прогона служебный
 * `.dockerbuild` — запись сборочного контекста. `actions/download-artifact`
 * без `pattern` скачивает ВСЕ артефакты прогона, и `softprops/action-gh-release`
 * публикует служебный файл как ассет релиза: в prerelease `v0.15.2` уехал
 * `nerkuda.e-tho-net.Z5ZMXK.dockerbuild` (28 736 байт). Тот же класс дефекта
 * уже закрывали в 6995459b (`pattern: etn-*`), но переписывание workflow в
 * 35c32a7b (0.15.1) потеряло настройку — сторожа на этот контракт не было.
 *
 * Контракт:
 *   * в джобе `publish` ровно один шаг `actions/download-artifact`, и у него
 *     `pattern: release-*` — только артефакты сборочных джоб;
 *   * `path: artifacts` и `merge-multiple: true` на месте — все файлы лягут
 *     в один каталог, по которому считается `SHA256SUMS`;
 *   * имена всех `actions/upload-artifact` в workflow начинаются с `release-`
 *     и читаются только из `with.name` (display name шага — не имя артефакта);
 *   * upload-шагов ровно четыре: три фиксированных — `release-windows`,
 *     `release-linux-client`, `release-linux-server` — и матричный
 *     `release-mcpb-${{ matrix.target }}` (upload-artifact v4 не разрешает
 *     грузить в артефакт одного имени из разных джоб matrix). Переименование
 *     любого или лишний артефакт — красный прогон: `publish` скачивает
 *     `release-*`, и состав релиза меняется молча;
 *   * md-контракт в шапке файла: перечислены шесть ожидаемых ассетов релиза
 *     и зафиксировано, что `.dockerbuild` ассетом не является.
 *
 * Сторож статический, как и остальные проверки этого файла: YAML читается
 * текстом, комментарии в теле отбрасываются (упоминание в шапке не маскирует
 * удаление настройки), а md-контракт проверяется отдельно по самой шапке.
 */

/** Все шаги джобы, использующие action по префиксу `uses: <prefix>`. */
function stepsUsingPrefix(job: readonly string[], prefix: string): string[][] {
  const steps = findBlock(job, 'steps', 4);
  if (!steps) return [];
  const pattern = new RegExp(`^\\s*(?:-\\s+)?uses:\\s*${escapeRe(prefix)}`);
  return listItems(steps).filter((item) => item.some((line) => pattern.test(line)));
}

/**
 * Артефакты всех шагов `actions/upload-artifact` workflow: джоба и `with.name`.
 * `name` читается только из `with:` — display name шага артефакт не называет.
 */
function uploadedArtifacts(workflow: string): { job: string; name: string | null }[] {
  const jobs = findBlock(workflow.split('\n'), 'jobs', 0);
  assert.ok(jobs !== null, `${RELEASE_WORKFLOW}: нет блока jobs.`);

  const jobNames = jobs
    .map((line) => /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => match[1] ?? '');

  const uploaded: { job: string; name: string | null }[] = [];
  for (const jobName of jobNames) {
    const job = findBlock(jobs, jobName, 2);
    if (!job) continue;
    for (const step of stepsUsingPrefix(job, 'actions/upload-artifact@')) {
      uploaded.push({ job: jobName, name: withValue(step, 'name') });
    }
  }
  return uploaded;
}

/** Строки шага после `key:` — содержимое блочного скаляра (`files: |`). */
function blockValueLines(step: readonly string[], key: string): string[] {
  const start = step.findIndex((line) =>
    new RegExp(`^\\s*(?:-\\s+)?${escapeRe(key)}:\\s*\\|\\s*$`).test(line),
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

/** Шапка workflow: ведущие строки-комментарии до первого объявления. */
function headerComments(workflow: string): string {
  const lines: string[] = [];
  for (const line of workflow.split('\n')) {
    if (line.trim() === '') continue;
    if (!/^\s*#/.test(line)) break;
    lines.push(line);
  }
  return lines.join('\n');
}

describe('guard: публикация релиза — только релизные артефакты', () => {
  it(`${RELEASE_WORKFLOW}: publish скачивает только артефакты release-*`, () => {
    const text = stripComments(readWorkflow(RELEASE_WORKFLOW, 'релизный конвейер'));
    const publish = findBlock(text.split('\n'), 'publish', 2);
    assert.ok(publish !== null, `${RELEASE_WORKFLOW}: нет джобы publish.`);

    const downloads = stepsUsingPrefix(publish, 'actions/download-artifact@');
    assert.equal(
      downloads.length,
      1,
      `${RELEASE_WORKFLOW}: в publish ожидается ровно один шаг ` +
        `actions/download-artifact, найдено ${downloads.length}. Несколько загрузок ` +
        'в один каталог смешивают состав релиза.',
    );

    const download = downloads[0] ?? [];
    const pattern = withValue(download, 'pattern');
    assert.ok(
      pattern !== null,
      `${RELEASE_WORKFLOW}: в publish downloads-artifact без pattern — шаг скачивает ` +
        'ВСЕ артефакты прогона, включая служебный .dockerbuild от ' +
        'docker/build-push-action, и тот уезжает в ассеты релиза (ошибка 054b0a66). ' +
        'Укажи pattern: release-*.',
    );
    const normalized = pattern.replace(/^['"]|['"]$/g, '').trim();
    assert.equal(
      normalized,
      'release-*',
      `${RELEASE_WORKFLOW}: pattern скачивания артефактов в publish — «${normalized}», ` +
        'ожидается «release-*». Широкий шаблон (в том числе «*») снова втянет ' +
        '.dockerbuild в релиз.',
    );

    assert.equal(
      withValue(download, 'path'),
      'artifacts',
      `${RELEASE_WORKFLOW}: шаг скачивания в publish должен класть артефакты в path: artifacts — ` +
        'по этому каталогу считает SHA256SUMS и публикует gh-release (files: artifacts/*).',
    );
    assert.equal(
      withValue(download, 'merge-multiple'),
      'true',
      `${RELEASE_WORKFLOW}: у шага скачивания в publish должен остаться merge-multiple: true — ` +
        'без него файлы трёх артефактов лягут в подкаталоги, и SHA256SUMS их не найдёт.',
    );
  });

  it(`${RELEASE_WORKFLOW}: все upload-artifact названы release-*`, () => {
    const text = stripComments(readWorkflow(RELEASE_WORKFLOW, 'релизный конвейер'));
    const uploaded = uploadedArtifacts(text);

    assert.ok(
      uploaded.length > 0,
      `${RELEASE_WORKFLOW}: не найдено ни одного шага actions/upload-artifact — ` +
        'publish скачивать нечего.',
    );
    for (const entry of uploaded) {
      assert.ok(
        entry.name !== null,
        `${RELEASE_WORKFLOW}: у upload-artifact в джобе ${entry.job} нет name — ` +
          'безымянный артефакт не попадёт под pattern: release-* и выпадет из релиза.',
      );
      // Матричный артефакт несёт выражение: `release-mcpb-${{ matrix.target }}`.
      assert.match(
        entry.name,
        /^release-[a-z0-9-]*(?:\$?\{\{[^}]+\}\})?$/,
        `${RELEASE_WORKFLOW}: артефакт «${entry.name}» (джоба ${entry.job}) не начинается ` +
          'с release-. publish качает только release-*, поэтому переименование ' +
          'артефакта молча исключит его из релиза.',
      );
    }

    // Три сборочные джобы — три артефакта, которые обязан скачать publish.
    for (const expected of ['release-windows', 'release-linux-client', 'release-linux-server']) {
      assert.ok(
        uploaded.some((entry) => entry.name === expected),
        `${RELEASE_WORKFLOW}: нет артефакта ${expected} — в релизе не будет одного ` +
          'из трёх бинарных ассетов.',
      );
    }
  });

  it(`${RELEASE_WORKFLOW}: ровно четыре upload-artifact с контрактными именами`, () => {
    const text = stripComments(readWorkflow(RELEASE_WORKFLOW, 'релизный конвейер'));
    const uploaded = uploadedArtifacts(text);

    // Контракт состава: три фиксированных артефакта и матрица MCPB-бандлов.
    // Лишний upload попадает под pattern: release-* и уезжает в релиз
    // лишним файлом; пропавший — оставляет релиз без ассета.
    assert.equal(
      uploaded.length,
      4,
      `${RELEASE_WORKFLOW}: ожидается ровно четыре шага actions/upload-artifact, ` +
        `найдено ${uploaded.length}: ` +
        `${uploaded.map((entry) => `${entry.name ?? '<без name>'} (${entry.job})`).join(', ') || 'ни одного'}.`,
    );

    const names = uploaded.map((entry) => entry.name ?? '').sort();
    assert.deepEqual(
      names,
      [
        'release-linux-client',
        'release-linux-server',
        'release-mcpb-${{ matrix.target }}',
        'release-windows',
      ],
      `${RELEASE_WORKFLOW}: имена артефактов — «${names.join(', ')}», ожидается точный ` +
        'набор: release-windows, release-linux-client, release-linux-server, ' +
        'release-mcpb-${{ matrix.target }}. Имена — контракт релиза (SHA256SUMS, ' +
        'install.sh, update-checker).',
    );
  });

  it(`${RELEASE_WORKFLOW}: md-контракт — шесть ассетов релиза, .dockerbuild не ассет`, () => {
    const text = readWorkflow(RELEASE_WORKFLOW, 'релизный конвейер');
    const header = headerComments(text);
    assert.ok(
      header.length > 0,
      `${RELEASE_WORKFLOW}: нет шапки-комментария с контрактом ассетов.`,
    );

    const assets: { label: string; pattern: RegExp }[] = [
      { label: 'ETN-Setup-<version>.exe', pattern: /ETN-Setup-[^\s]+\.exe/ },
      {
        label: 'ETN-Client-<version>-linux-x64.tar.gz',
        pattern: /ETN-Client-[^\s]+-linux-x64\.tar\.gz/,
      },
      { label: 'etn-server-<version>.tar.gz', pattern: /etn-server-[^\s]+\.tar\.gz/ },
      { label: 'etn-mcp-<version>-<platform>-<arch>.mcpb', pattern: /etn-mcp-[^\s]+\.mcpb/ },
      { label: 'SHA256SUMS', pattern: /\bSHA256SUMS\b/ },
      { label: 'install.sh', pattern: /\binstall\.sh\b/ },
    ];
    for (const asset of assets) {
      assert.match(
        header,
        asset.pattern,
        `${RELEASE_WORKFLOW}: в шапке-контракте нет ассета ${asset.label}. В релизе ` +
          'ровно шесть ожидаемых ассетов; шапка — md-контракт, по которому сверяются ' +
          'workflow, install.sh, тело релиза и update-checker.',
      );
    }
    assert.match(
      header,
      /\.dockerbuild/,
      `${RELEASE_WORKFLOW}: шапка-контракт не фиксирует, что .dockerbuild — служебный ` +
        'артефакт docker-джобы и в релиз не входит. Без этой строки следующий ' +
        'рефакторинг снова потеряет pattern (ошибка 054b0a66).',
    );
  });

  it(`${RELEASE_WORKFLOW}: gh-release публикует artifacts/* и install.sh`, () => {
    const text = stripComments(readWorkflow(RELEASE_WORKFLOW, 'релизный конвейер'));
    const publish = findBlock(text.split('\n'), 'publish', 2);
    assert.ok(publish !== null, `${RELEASE_WORKFLOW}: нет джобы publish.`);

    const releases = stepsUsingPrefix(publish, 'softprops/action-gh-release@');
    assert.equal(
      releases.length,
      1,
      `${RELEASE_WORKFLOW}: в publish ожидается ровно один шаг softprops/action-gh-release, ` +
        `найдено ${releases.length}.`,
    );

    const files = blockValueLines(releases[0] ?? [], 'files');
    assert.ok(
      files.includes('artifacts/*'),
      `${RELEASE_WORKFLOW}: gh-release не публикует artifacts/* — релиз выйдет без ` +
        'бинарных ассетов и SHA256SUMS.',
    );
    assert.ok(
      files.includes('scripts/install.sh'),
      `${RELEASE_WORKFLOW}: gh-release не публикует scripts/install.sh — установщик ` +
        'Linux-клиента выпадет из релиза.',
    );
  });
});

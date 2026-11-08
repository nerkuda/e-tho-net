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
function parseRefFallback(
  ref: string,
): { primary: string; fallback: string } | null {
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

  it(`${DOCKER_WORKFLOW}: пушит ghcr.io/<repo>/etn-server:<tag> из server/Dockerfile`, () => {
    const text = stripComments(readWorkflow(DOCKER_WORKFLOW, 'переиспользуемая сборка образа'));
    const job = singleJob(text);

    // Джоба сборки не отключается: `if: false` или `continue-on-error` дали бы
    // зелёный прогон без образа, а `publish` дождался бы «успеха».
    assert.ok(
      !jobLevelKey(job, 'if'),
      `${DOCKER_WORKFLOW}: у джобы сборки есть if: — её можно отключить (if: false), ` +
        'и образ молча не соберётся.',
    );
    assert.ok(
      !jobLevelKey(job, 'continue-on-error'),
      `${DOCKER_WORKFLOW}: у джобы сборки есть continue-on-error: — провал сборки/пуша ` +
        'не сделает джобу красной.',
    );

    const checkout = stepUsing(job, 'actions/checkout@v7');
    assert.ok(
      checkout !== null,
      `${DOCKER_WORKFLOW}: нет шага actions/checkout@v7 — код для образа не скачивается.`,
    );
    // Источник кода (после какого ref идёт checkout) проверяется отдельным
    // тестом ниже: он зависит от триггера, а не от факта пуша образа.

    const login = stepUsing(job, 'docker/login-action@v4');
    assert.ok(
      login !== null,
      `${DOCKER_WORKFLOW}: нет шага docker/login-action@v4 — пуш в GHCR не авторизуется.`,
    );
    assert.ok(
      login.some((line) => /^\s*registry:\s*ghcr\.io\s*$/.test(line)),
      `${DOCKER_WORKFLOW}: шаг login не входит в ghcr.io (registry: ghcr.io).`,
    );
    assert.ok(
      login.some((line) => /^\s*username:\s*\$\{\{\s*github\.actor\s*\}\}\s*$/.test(line)),
      `${DOCKER_WORKFLOW}: шаг login должен использовать github.actor.`,
    );
    assert.ok(
      login.some((line) => /^\s*password:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}\s*$/.test(line)),
      `${DOCKER_WORKFLOW}: шаг login должен использовать secrets.GITHUB_TOKEN.`,
    );

    const build = stepUsing(job, 'docker/build-push-action@v7');
    assert.ok(
      build !== null,
      `${DOCKER_WORKFLOW}: нет шага docker/build-push-action@v7 — образ не собирается.`,
    );
    // Проверки привязаны к шагу сборки: `file:`/`push:`/`tags:` в чужом шаге
    // (например, в login) образ не собирают и не пушат.
    assert.ok(
      build.some((line) => /^\s*file:\s*server\/Dockerfile\s*$/.test(line)),
      `${DOCKER_WORKFLOW}: в шаге build-push нет file: server/Dockerfile — ` +
        'образ сервера не соберётся.',
    );
    assert.ok(
      build.some((line) => /^\s*push:\s*true\s*$/.test(line)),
      `${DOCKER_WORKFLOW}: в шаге build-push нет push: true — образ соберётся, ` +
        'но не попадёт в GHCR.',
    );
    assert.ok(
      build.some((line) =>
        /^\s*tags:\s*ghcr\.io\/\$\{\{\s*github\.repository\s*\}\}\/etn-server:\$\{\{\s*inputs\.tag\s*\}\}\s*$/.test(
          line,
        ),
      ),
      `${DOCKER_WORKFLOW}: в шаге build-push тег образа должен быть ` +
        'ghcr.io/${{ github.repository }}/etn-server:${{ inputs.tag }} — ' +
        'только версия тега, без latest.',
    );
    assert.ok(
      !stepKey(build, 'if'),
      `${DOCKER_WORKFLOW}: у шага build-push есть if: — сборку/пуш можно отключить, ` +
        'и образ молча не соберётся.',
    );
    assert.ok(
      !stepKey(build, 'continue-on-error'),
      `${DOCKER_WORKFLOW}: у шага build-push есть continue-on-error: — провал сборки/пуша ` +
        'не сделает джобу красной.',
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
        withBlock.some((line) => /^\s*tag:\s*\$\{\{\s*inputs\.tag\s*\|\|\s*github\.ref_name\s*\}\}\s*$/.test(line)),
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
 *     `pattern: release-*` — только артефакты трёх сборочных джоб;
 *   * `path: artifacts` и `merge-multiple: true` на месте — три файла лежат
 *     в одном каталоге, по которому считается `SHA256SUMS`;
 *   * имена всех `actions/upload-artifact` в workflow начинаются с `release-`
 *     и читаются только из `with.name` (display name шага — не имя артефакта);
 *   * upload-шагов ровно три, их имена — точный контракт: `release-windows`,
 *     `release-linux-client`, `release-linux-server`. Четвёртый артефакт или
 *     переименование любого из трёх — красный прогон: `publish` скачивает
 *     `release-*`, и лишний/пропавший файл меняет состав релиза;
 *   * md-контракт в шапке файла: перечислены пять ожидаемых ассетов релиза
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
      assert.match(
        entry.name,
        /^release-[a-z0-9-]+$/,
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

  it(`${RELEASE_WORKFLOW}: ровно три upload-artifact с контрактными именами`, () => {
    const text = stripComments(readWorkflow(RELEASE_WORKFLOW, 'релизный конвейер'));
    const uploaded = uploadedArtifacts(text);

    // Контракт состава: ровно три сборочные джобы и ровно три артефакта.
    // Четвёртый upload попадает под pattern: release-* и уезжает в релиз
    // лишним файлом; пропавший — оставляет релиз без ассета.
    assert.equal(
      uploaded.length,
      3,
      `${RELEASE_WORKFLOW}: ожидается ровно три шага actions/upload-artifact, ` +
        `найдено ${uploaded.length}: ` +
        `${uploaded.map((entry) => `${entry.name ?? '<без name>'} (${entry.job})`).join(', ') || 'ни одного'}.`,
    );

    const names = uploaded.map((entry) => entry.name ?? '').sort();
    assert.deepEqual(
      names,
      ['release-linux-client', 'release-linux-server', 'release-windows'],
      `${RELEASE_WORKFLOW}: имена артефактов — «${names.join(', ')}», ожидается точный ` +
        'набор: release-windows, release-linux-client, release-linux-server. Имена — ' +
        'контракт релиза (SHA256SUMS, install.sh, update-checker).',
    );
  });

  it(`${RELEASE_WORKFLOW}: md-контракт — пять ассетов релиза, .dockerbuild не ассет`, () => {
    const text = readWorkflow(RELEASE_WORKFLOW, 'релизный конвейер');
    const header = headerComments(text);
    assert.ok(header.length > 0, `${RELEASE_WORKFLOW}: нет шапки-комментария с контрактом ассетов.`);

    const assets: { label: string; pattern: RegExp }[] = [
      { label: 'ETN-Setup-<version>.exe', pattern: /ETN-Setup-[^\s]+\.exe/ },
      { label: 'ETN-Client-<version>-linux-x64.tar.gz', pattern: /ETN-Client-[^\s]+-linux-x64\.tar\.gz/ },
      { label: 'etn-server-<version>.tar.gz', pattern: /etn-server-[^\s]+\.tar\.gz/ },
      { label: 'SHA256SUMS', pattern: /\bSHA256SUMS\b/ },
      { label: 'install.sh', pattern: /\binstall\.sh\b/ },
    ];
    for (const asset of assets) {
      assert.match(
        header,
        asset.pattern,
        `${RELEASE_WORKFLOW}: в шапке-контракте нет ассета ${asset.label}. В релизе ` +
          'ровно пять ожидаемых ассетов; шапка — md-контракт, по которому сверяются ' +
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

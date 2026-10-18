/**
 * Юнит-тесты `client/scripts/version-metrics.mjs` (задача 81a9a521 «Скрипт
 * метрик версии по хроникам»).
 *
 * Фикстуры в `tests/fixtures/version-metrics/` — СНИМКИ РЕАЛЬНЫХ данных сети
 * ETN (etn-remote) на момент ретро 0.12.1, а не рукодельные мини-сеты:
 *
 *   * `commits-0.12.1.txt`   — реальные subject'ы `git log v0.11.2..v0.12.1`;
 *   * `vlozheniya-tasks.json` — 14 задач ТП «Общие вложения» и их хроники;
 *   * `errors-sample.json`    — выборка ошибок (с пользовательскими находками
 *                               и без) с постоянными комментариями;
 *   * `chrono-samples.json`   — хроники отдельных работ (first-pass, повторная
 *                               делегация);
 *   * `polish-0.13.1.json`    — 7 эталонов эвристики замечаний заказчика:
 *                               6 карточек «полировка по визуальной проверке»
 *                               0.13.1 + a1100e0c («со слов пользователя»);
 *   * `mcp-config-sample.json` — образец MCP-конфига ZCode (ключ обезличен).
 *
 * Тела комментариев в фикстурах обрезаны до 2500 (хроно) / 5000 (постоянные)
 * символов — маркеры эвристик (`не принято`, источник-пользователь) стоят в
 * начале текста/заголовке, поэтому снимки остаются валидными и лёгкими.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseCommitSubject,
  summariseCommits,
  firstPassAccepted,
  verifierRoundCount,
  hasUserGuiFinding,
  hasRepeatedDelegation,
  summariseWorks,
  orderTags,
  previousTag,
  versionDuration,
  readMcpConfig,
  parseArgs,
  resolveEndpoint,
} from '../scripts/version-metrics.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures', 'version-metrics');
const readFixture = (name: string): string => readFileSync(path.join(FIX, name), 'utf8');
const readJson = <T>(name: string): T => JSON.parse(readFixture(name)) as T;

const chronoText = (comments: { kind: string; title?: string | null; body_md?: string | null }[]): string =>
  comments
    .filter((c) => c.kind !== 'permanent')
    .map((c) => `${c.title ?? ''}\n${c.body_md ?? ''}`)
    .join('\n');

test('parseCommitSubject: префикс задачи, scope, двойной префикс, merge', () => {
  assert.deepEqual(parseCommitSubject('[81a9a521] feat(server): домен'), {
    type: 'feat',
    scope: 'server',
    taskIds: ['81a9a521'],
    merge: false,
  });
  assert.deepEqual(parseCommitSubject('[d4c528d2][8f9768c9] fix(client): правка'), {
    type: 'fix',
    scope: 'client',
    taskIds: ['d4c528d2', '8f9768c9'],
    merge: false,
  });
  assert.equal(parseCommitSubject('редакторская правка').type, null);
  assert.deepEqual(parseCommitSubject('docs: история'), {
    type: 'docs',
    scope: null,
    taskIds: [],
    merge: false,
  });
  const merge = parseCommitSubject("Merge branch 'releases/0.12.1' into main");
  assert.equal(merge.merge, true);
  assert.equal(merge.type, null);
});

test('summariseCommits: реальный диапазон v0.11.2..v0.12.1', () => {
  const subjects = readFixture('commits-0.12.1.txt').split('\n').filter(Boolean);
  const summary = summariseCommits(subjects);
  assert.equal(summary.total, 255);
  assert.equal(summary.fix, 154);
  assert.equal(summary.feat, 59);
  assert.equal(summary.byType['test'], 17);
  assert.equal(summary.byType['docs'], 11);
  assert.equal(summary.byType['refactor'], 8);
  assert.equal(summary.byType['chore'], 3);
});

test('firstPassAccepted: вердикт верификатора «не принято» снимает first-pass', () => {
  const chrono = readJson<Record<string, { kind: string; title?: string; body_md?: string }[]>>('chrono-samples.json');
  const c = (id: string) => chrono[id] ?? [];
  // ff69343a, 7678876a — не принято; 369241e4 — принято с первой сдачи.
  assert.equal(firstPassAccepted(c('ff69343a-d1fd-4ff9-9ae2-147ae59d000a')), false);
  assert.equal(firstPassAccepted(c('1d15f14a-c969-4bb5-b151-5924469a27f4')), false);
  assert.equal(firstPassAccepted(c('369241e4-bbf0-444e-beaa-2f52975575b8')), true);
  assert.equal(verifierRoundCount(c('1d15f14a-c969-4bb5-b151-5924469a27f4')) >= 2, true);
});

test('hasRepeatedDelegation: повторная делегация сделанной работы', () => {
  const chrono = readJson<Record<string, { kind: string; title?: string; body_md?: string }[]>>('chrono-samples.json');
  const c = (id: string) => chrono[id] ?? [];
  assert.equal(hasRepeatedDelegation(chronoText(c('86598085-1ade-4175-9067-e65ecc779046'))), true);
  assert.equal(hasRepeatedDelegation(chronoText(c('369241e4-bbf0-444e-beaa-2f52975575b8'))), false);
});

test('hasUserGuiFinding: источник-пользователь в постоянном комментарии', () => {
  const fixture = readJson<{
    works: { id: string; title: string; type_id: string; active: boolean }[];
    comments: Record<string, { kind: string; title?: string; body_md?: string }[]>;
  }>('errors-sample.json');
  const permanent = (id: string): string => {
    const c = (fixture.comments[id] ?? []).find((x) => x.kind === 'permanent');
    return c ? `${c.title ?? ''}\n${c.body_md ?? ''}` : '';
  };
  const flagged = fixture.works.filter((w) => hasUserGuiFinding(permanent(w.id)));
  assert.equal(flagged.length, 10); // 10 реальных находок пользователя в выборке
  assert.ok(flagged.every((w) => w.type_id === '3d31c615-d6b0-42e9-a027-e8197f7cbe8b'));

  // Сводка повторяет тот же счёт и не путает ошибки с задачами.
  const summary = summariseWorks({ works: fixture.works, commentsById: fixture.comments });
  assert.equal(summary.userGuiFindings, flagged.length);
  assert.equal(summary.byType['ошибка'], fixture.works.length);
});

test('hasUserGuiFinding: маркеры заказчика — 6 полировочных карточек + a1100e0c', () => {
  const fixture = readJson<{
    works: { id: string; title: string; type_id: string; active: boolean }[];
    comments: Record<string, { kind: string; title?: string; body_md?: string }[]>;
  }>('polish-0.13.1.json');
  const permanent = (id: string): string => {
    const c = (fixture.comments[id] ?? []).find((x) => x.kind === 'permanent');
    return c ? `${c.title ?? ''}\n${c.body_md ?? ''}` : '';
  };

  // Эталонный снимок 4258e694: в одном комментарии — «замечаний заказчика»,
  // «по визуальной проверке», «формулировки заказчика».
  assert.equal(hasUserGuiFinding(permanent('4258e694-47b0-4d7e-8d19-61387dee396a')), true);

  // Каждый новый маркер по отдельности (ретро 0.13.1, задача 92674032).
  for (const text of [
    'замечания заказчика по экрану',
    'замечаний заказчика по визуальной проверке',
    'по визуальной проверке',
    'Заказчик ТРЕБУЕТ (третий раз)',
    'заказчику надоело вылавливать ID',
    'Полировочная карточка: формулировки заказчика',
  ]) {
    assert.equal(hasUserGuiFinding(text), true, `маркер не сработал: ${text}`);
  }
  // «Формулировки заказчика» — уточняющий маркер: вне полировочной карточки
  // (ранний визуальный аудит 0.13.1, 498876c4) один не считается.
  assert.equal(
    hasUserGuiFinding('Чек-лист исправлений (формулировки заказчика, все обязательны)'),
    false,
  );
  // Точность: простое упоминание заказчика без маркеров — не находка.
  assert.equal(hasUserGuiFinding('Заказчик попросил добавить кнопку; карточка заведена оркестратором.'), false);

  // Ровно 6 полировочных карточек + a1100e0c («со слов пользователя»).
  const summary = summariseWorks({ works: fixture.works, commentsById: fixture.comments });
  assert.equal(summary.userGuiFindings, 7);
  assert.deepEqual(
    [...summary.userGuiFindingIds].sort(),
    fixture.works.map((w) => w.id).sort(),
  );
});

test('summariseWorks: first-pass ТП «Общие вложения» = 11/14', () => {
  const fixture = readJson<{
    works: { id: string; title: string; type_id: string; active: boolean }[];
    groups: { name: string; taskIds: string[] }[];
    comments: Record<string, { kind: string; title?: string; body_md?: string }[]>;
  }>('vlozheniya-tasks.json');
  const summary = summariseWorks({ works: fixture.works, commentsById: fixture.comments, groups: fixture.groups });
  assert.equal(summary.total, 14);
  assert.deepEqual(summary.byType, { задача: 14 });
  assert.equal(summary.firstPass.accepted, 11);
  assert.equal(summary.firstPass.total, 14);
  const group = summary.firstPass.byGroup[0];
  assert.ok(group !== undefined);
  assert.equal(group.name, fixture.groups[0]?.name);
  assert.equal(group.notAccepted.length, 3);
});

test('orderTags / previousTag: semver-порядок тегов', () => {
  const tags = ['v0.12.1', 'v0.5.2', 'v0.9.1', 'v0.11.2', 'v0.10.3'];
  assert.deepEqual(orderTags(tags), ['v0.5.2', 'v0.9.1', 'v0.10.3', 'v0.11.2', 'v0.12.1']);
  assert.equal(previousTag(tags, 'v0.12.1'), 'v0.11.2');
  assert.equal(previousTag(tags, 'v0.5.2'), null);
});

test('versionDuration: от создания до даты публикации', () => {
  const d = versionDuration('2026-10-06T04:23:56.484Z', '2026-10-10', '2026-10-10T14:24:59.356Z');
  assert.ok(d !== null);
  assert.equal(d.from, '2026-10-06T04:23:56.484Z');
  assert.equal(d.to, '2026-10-10');
  assert.ok(d.days > 3.8 && d.days < 3.9);
  // Без обеих дат публикации и изменения — null.
  assert.equal(versionDuration('2026-10-06T04:23:56.484Z', null, null), null);
});

test('readMcpConfig: адрес и Bearer-ключ из MCP-конфига ZCode', () => {
  const cfg = readMcpConfig(readFixture('mcp-config-sample.json'));
  assert.ok(cfg !== null);
  assert.equal(cfg.url, 'https://etn.example.org');
  assert.equal(cfg.token, 'etn_TEST0000000000000000000000000000');
  assert.equal(readMcpConfig('{ не json'), null);
  assert.equal(readMcpConfig('{"mcpServers":{}}'), null);
});

test('parseArgs: версия, сравнение, подключение, json', () => {
  const opts = parseArgs(['--compare', 'v0.11.2', 'v0.12.1', '--json', 'out.json', '--base', 'http://x', '--no-git']);
  assert.equal(opts.compare, true);
  assert.deepEqual(opts.specs, ['v0.11.2', 'v0.12.1']);
  assert.equal(opts.json, 'out.json');
  assert.equal(opts.base, 'http://x');
  assert.equal(opts.noGit, true);
  assert.equal(parseArgs(['-v', '0.12.1']).specs[0], '0.12.1');
  assert.equal(parseArgs(['--help']).help, true);
});

test('resolveEndpoint: приоритет флаги → окружение → MCP-конфиг', () => {
  const configText = readFixture('mcp-config-sample.json');
  const readFile = (file: string): string | null =>
    /(?:^|[/\\])config\.json$/.test(file) || file.endsWith('custom/mcp.json') ? configText : null;

  // 1. Только конфиг.
  const fromConfig = resolveEndpoint({
    argv: ['v0.12.1'],
    env: {},
    readFile,
    home: '/nonexistent-home',
    repoRoot: '/nonexistent-repo',
  });
  assert.equal(fromConfig.base, 'https://etn.example.org');
  assert.equal(fromConfig.apiBase, 'https://etn.example.org/api/v1');
  assert.equal(fromConfig.token, 'etn_TEST0000000000000000000000000000');
  assert.equal(fromConfig.networkId, '253431e2-780d-466b-879e-6373f73fbad5');

  // 2. Окружение перебивает конфиг, флаг — окружение.
  const envOnly = resolveEndpoint({
    argv: ['--config', 'custom/mcp.json'],
    env: { ETN_REMOTE_URL: 'https://env.example', ETN_REMOTE_TOKEN: 'etn_env' },
    readFile,
    home: '/nonexistent-home',
  });
  assert.equal(envOnly.base, 'https://env.example');
  assert.equal(envOnly.token, 'etn_env');
  const flagged = resolveEndpoint({
    argv: ['--base', 'https://flag.example', '--token', 'etn_flag'],
    env: { ETN_REMOTE_URL: 'https://env.example', ETN_REMOTE_TOKEN: 'etn_env' },
    readFile,
    home: '/nonexistent-home',
  });
  assert.equal(flagged.base, 'https://flag.example');
  assert.equal(flagged.token, 'etn_flag');

  // 3. Ничего не нашлось — понятная ошибка.
  assert.throws(
    () => resolveEndpoint({ argv: [], env: {}, readFile: () => null, home: '/nonexistent-home' }),
    /Не найдены адрес\/ключ/,
  );
});

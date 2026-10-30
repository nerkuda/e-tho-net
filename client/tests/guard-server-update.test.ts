/**
 * Сторож обновления сервера из клиента (элемент c9c96e5c, задача ca26c59d,
 * тех.проект 2d9f5cc7).
 *
 * Правила (DoD задачи):
 *
 * 1. **Одно место запуска.** `applyServerUpdate` (IPC → `systemUpdateApply`
 *    rest-клиента) вызывается РОВНО из диалога обновления
 *    (`lib/server-update-dialog.ts`), и в нём — ровно один вызов. Второй
 *    вызов «на всякий случай» создал бы второе задание и второе скачивание
 *    установщика. Комментарии из исходников вырезаются: упоминание вызова в
 *    пояснении не считается вызовом.
 * 2. **Нет автоповтора.** У `systemUpdateApply` в rest-клиенте фактический
 *    аргумент `retry` равен `false`: повтор `POST /system/update/apply`
 *    неидемпотентен. Разбирается тело метода без комментариев (комментарий
 *    «retry: false» не спасает мутацию `retry: true`), а у вызова в IPC —
 *    фактический список аргументов: вызывающий не может передать свои
 *    `retry`/`timeoutMs`.
 * 3. **Поднятый тайм-аут.** Тот же метод обязан передавать `timeoutMs` из
 *    `UPDATE_APPLY_TIMEOUT_MS`: сервер отвечает только после скачивания
 *    установщика и проверки SHA-256 (до 10 минут), общий тайм-аут 30 с дал бы
 *    ложный обрыв.
 * 4. **Этап не выдуман.** Подписи этапов в модели (`CONFIRMED_UPDATE_STAGES`,
 *    `updateStageLabel`) ссылаются только на этапы, которые сервер реально
 *    пишет в задание (`server/src/update/apply.ts`): `installing`,
 *    `health-check` и т. п. сервер записать не может.
 * 5. **`backup_path: null` не рисуется как путь.** Модель берёт только
 *    `job?.backup_path ?? null`, диалог показывает строку архива лишь при
 *    непустом пути.
 *
 * У правил 2, 4 и 5 есть self-пробы на синтетическом исходнике: ослабление
 * детектора краснит тест, даже если в реальных файлах нарушений ещё нет.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { listSourceFiles } from './guard-helpers.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(CLIENT_ROOT, '..');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');
const REST_CLIENT = path.join(CLIENT_ROOT, 'src', 'main', 'net', 'rest-client.ts');
const HANDLERS = path.join(CLIENT_ROOT, 'src', 'main', 'ipc', 'handlers.ts');
const DIALOG_MODULE = path.join(RENDERER_ROOT, 'lib', 'server-update-dialog.ts');
const MODEL_MODULE = path.join(RENDERER_ROOT, 'lib', 'server-update.ts');
const SERVER_APPLY = path.join(REPO_ROOT, 'server', 'src', 'update', 'apply.ts');

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

/**
 * Вырезает комментарии, сохраняя переводы строк (номера строк не съезжают).
 * Строковые литералы не трогаются: `https://` внутри строки — не комментарий.
 * Шаблонные литералы обрабатываются как строки; вложенный `${}` с `//` внутри
 * комментарием не считается — в разбираемых файлах такого нет.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < source.length) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < source.length) {
        const c = source[i]!;
        out += c;
        i += 1;
        if (c === '\\') {
          if (i < source.length) {
            out += source[i];
            i += 1;
          }
          continue;
        }
        if (c === quote) break;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Число совпадений регулярки в тексте. */
function countMatches(text: string, pattern: RegExp): number {
  return (
    text.match(
      new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`),
    )?.length ?? 0
  );
}

/** Все вызовы `applyServerUpdate(` в исходнике без комментариев. */
const APPLY_CALL = /\bapplyServerUpdate\s*\(/g;

/** Блок `{ … }`, начинающийся после позиции `from` (балансировка скобок). */
function blockAfter(source: string, from: number): string {
  const open = source.indexOf('{', from);
  assert.ok(open >= 0, 'не найдена открывающая скобка блока');
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error('незакрытый блок');
}

/** Тело метода по сигнатуре (исходник уже без комментариев). */
function methodBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `не найден метод ${signature}`);
  return blockAfter(source, start);
}

/** Значения свойства объекта `key` в теле (все вхождения, по порядку). */
function optionValues(body: string, key: string): string[] {
  return [...body.matchAll(new RegExp(`\\b${key}\\s*:\\s*([^,}\\n]+)`, 'g'))].map((m) =>
    m[1]!.trim(),
  );
}

/**
 * Нарушения правила «нет автоповтора»: `retry` задан ровно один раз и равен
 * `false`; тайм-аут — из `UPDATE_APPLY_TIMEOUT_MS` с пер-вызовным перекрытием.
 */
function retryProblems(source: string): string[] {
  const body = methodBody(stripComments(source), 'public async systemUpdateApply');
  const problems: string[] = [];
  const retries = optionValues(body, 'retry');
  if (retries.length !== 1) {
    problems.push(`retry задан ${retries.length} раз(а) — нужен ровно один: retry: false`);
  } else if (retries[0] !== 'false') {
    problems.push(`фактический аргумент retry = ${retries[0]} — автоповтор apply запрещён`);
  }
  const timeouts = optionValues(body, 'timeoutMs');
  if (
    !timeouts.some((v) => /^opts\?\.timeoutMs\s*\?\?\s*UPDATE_APPLY_TIMEOUT_MS$/.test(v))
  ) {
    problems.push(
      'timeoutMs не перекрывается UPDATE_APPLY_TIMEOUT_MS — сервер отвечает до 10 минут',
    );
  }
  return problems;
}

/**
 * Аргументы фактического вызова `systemUpdateApply(...)` в IPC-обработчике:
 * вызывающий не должен иметь возможности передать свои `retry`/`timeoutMs`.
 */
function applyCallArguments(source: string): string[] {
  const code = stripComments(source);
  return [...code.matchAll(/\bsystemUpdateApply\s*\(([^)]*)\)/g)].map((m) => m[1]!.trim());
}

/**
 * Этапы, которые сервер реально пишет в задание (`server/src/update/apply.ts`):
 * значения второго аргумента `writeJob(...)` и литералы `stage:`.
 */
function serverWrittenStages(source: string): Set<string> {
  const code = stripComments(source);
  const stages = new Set<string>();
  for (const m of code.matchAll(/writeJob\([^)]*?'([a-z][a-z-]*)'/g)) stages.add(m[1]!);
  for (const m of code.matchAll(/\bstage:\s*'([a-z][a-z-]*)'/g)) stages.add(m[1]!);
  return stages;
}

/** Подписи этапов, объявленные в модели (список + `switch`). */
function labelledStages(modelSource: string): Set<string> {
  const code = stripComments(modelSource);
  const stages = new Set<string>();
  const list = /CONFIRMED_UPDATE_STAGES[^=]*=\s*\[([\s\S]*?)\]/.exec(code);
  assert.ok(list !== null, 'в модели найден CONFIRMED_UPDATE_STAGES');
  for (const m of list[1]!.matchAll(/'([^']+)'/g)) stages.add(m[1]!);
  const fnStart = code.indexOf('export function updateStageLabel');
  assert.ok(fnStart >= 0, 'в модели найдена updateStageLabel');
  const fn = blockAfter(code, fnStart);
  for (const m of fn.matchAll(/case\s+'([^']+)'/g)) stages.add(m[1]!);
  return stages;
}

/** Этапы модели, которых сервер не пишет (выдуманные). */
function inventedStages(modelSource: string, written: Set<string>): string[] {
  return [...labelledStages(modelSource)].filter((stage) => !written.has(stage)).sort();
}

/**
 * Нарушения правила «`backup_path: null` не рисуется как путь»: модель берёт
 * только `job?.backup_path ?? null`, диалог показывает путь лишь после явной
 * проверки на `null`.
 */
function backupPathProblems(modelSource: string, dialogSource: string): string[] {
  const problems: string[] = [];
  const model = stripComments(modelSource);
  if (!/backupPath\s*:\s*job\?\.backup_path\s*\?\?\s*null/.test(model)) {
    problems.push('модель: backupPath обязан вычисляться как `job?.backup_path ?? null`');
  }
  const dialog = stripComments(dialogSource);
  if (!/backupLine\.hidden\s*=\s*view\.backupPath\s*===\s*null/.test(dialog)) {
    problems.push('диалог: строка архива не скрывается при `view.backupPath === null`');
  }
  const lines = dialog.split('\n');
  lines.forEach((line, index) => {
    if (!line.includes('serverUpdate.backupPath')) return;
    const statement = lines.slice(Math.max(0, index - 2), index + 1).join('\n');
    if (!/backupPath\s*===\s*null\s*\?/.test(statement)) {
      problems.push(
        `диалог:${index + 1}: путь архива рисуется без проверки \`backupPath === null\` — ` +
          line.trim(),
      );
    }
  });
  return problems;
}

describe('guard: обновление сервера — одно место запуска (ca26c59d)', () => {
  it('applyServerUpdate вызывается только из диалога обновления (комментарии не в счёт)', () => {
    const callers: string[] = [];
    for (const abs of listSourceFiles(RENDERER_ROOT)) {
      const relative = path.relative(RENDERER_ROOT, abs).replace(/\\/g, '/');
      if (countMatches(stripComments(read(abs)), APPLY_CALL) > 0) callers.push(relative);
    }
    assert.deepEqual(
      callers,
      ['lib/server-update-dialog.ts'],
      'запуск обновления — единственная точка входа в диалоге; второй вызов создал бы второе задание',
    );
  });

  it('self-проба: упоминание applyServerUpdate в комментарии — не вызов', () => {
    const commented = '// applyServerUpdate(\n/* applyServerUpdate( */\nconst handler = 1;\n';
    assert.equal(countMatches(stripComments(commented), APPLY_CALL), 0);
    const real = 'const go = () => etn.system.applyServerUpdate(version);';
    assert.equal(countMatches(stripComments(real), APPLY_CALL), 1);
  });

  it('в диалоге ровно один вызов applyServerUpdate (нет циклов автоповтора)', () => {
    assert.equal(countMatches(stripComments(read(DIALOG_MODULE)), APPLY_CALL), 1, 'один запуск на диалог');
  });

  it('systemUpdateApply в rest-клиенте идёт с retry: false и поднятым тайм-аутом', () => {
    const problems = retryProblems(read(REST_CLIENT));
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  it('self-проба: комментарий «retry: false» не прикрывает фактический retry: true', () => {
    const source = [
      'class RestClient {',
      '  public async systemUpdateApply(targetVersion: string) {',
      '    // retry: false — пояснение в комментарии, а не аргумент',
      '    return this.request(\'POST\', \'/system/update/apply\', {',
      '      requestOptions: { retry: true, timeoutMs: opts?.timeoutMs ?? UPDATE_APPLY_TIMEOUT_MS },',
      '    });',
      '  }',
      '}',
    ].join('\n');
    const problems = retryProblems(source);
    assert.ok(
      problems.some((p) => p.includes('retry = true')),
      `мутация retry: true обязана краснить сторож:\n${problems.join('\n')}`,
    );
  });

  it('вызывающий не передаёт свои опции: systemUpdateApply(targetVersion)', () => {
    const args = applyCallArguments(read(HANDLERS));
    assert.deepEqual(
      args,
      ['targetVersion'],
      'IPC-обработчик передаёт только версию: retry/тайм-аут нельзя перекрыть снаружи',
    );
  });

  it('опрос прогресса — цепочка setTimeout, без setInterval-шторма (комментарии не в счёт)', () => {
    const source = stripComments(read(DIALOG_MODULE));
    assert.equal(countMatches(source, /setInterval\s*\(/), 0, 'интервал-шторм запрещён');
    assert.ok(countMatches(source, /setTimeout\s*\(/) >= 1, 'следующий опрос планируется по таймеру');
  });
});

describe('guard: обновление сервера — этапы и путь архива (ca26c59d)', () => {
  it('модель не выдумывает этапы, которых сервер не пишет', () => {
    const written = serverWrittenStages(read(SERVER_APPLY));
    assert.ok(written.size >= 3, `этапы сервера не найдены: ${[...written].join(', ')}`);
    const invented = inventedStages(read(MODEL_MODULE), written);
    assert.deepEqual(
      invented,
      [],
      `в модели есть подписи этапов, которых сервер не пишет (${[...written].join(', ')}): ` +
        invented.join(', '),
    );
  });

  it('self-проба: подпись для installing — выдуманный этап', () => {
    const model = [
      "export const CONFIRMED_UPDATE_STAGES = ['preparing', 'installing'] as const;",
      'export function updateStageLabel(stage: string) {',
      '  switch (stage) {',
      "    case 'preparing': return 'a';",
      "    case 'installing': return 'b';",
      '    default: return null;',
      '  }',
      '}',
    ].join('\n');
    const invented = inventedStages(model, new Set(['preparing', 'backing-up', 'done', 'failed']));
    assert.deepEqual(invented, ['installing']);
  });

  it('backup_path: null не рисуется как путь', () => {
    const problems = backupPathProblems(read(MODEL_MODULE), read(DIALOG_MODULE));
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  it('self-проба: путь архива без проверки на null — нарушение', () => {
    const model = 'const view = { backupPath: job?.backup_path ?? null };';
    const dialog = "backupLine.textContent = t('serverUpdate.backupPath', view.backupPath);";
    const problems = backupPathProblems(model, dialog);
    assert.ok(
      problems.some((p) => p.includes('serverUpdate.backupPath')),
      `отрисовка null как пути обязана краснить сторож:\n${problems.join('\n')}`,
    );
  });
});

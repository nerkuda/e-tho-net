/**
 * Сторож режима обслуживания сервера (задача 479e37ed, требование 9636b1cc).
 *
 * Правила, которые легко нарушить незаметно для типов:
 *  1. Центральный IPC-гейт изменений обязан спросить состояние обслуживания
 *     РАНЬШЕ, чем объявить обрыв связи: сокет закрыт именно из-за обновления,
 *     и пользователь должен увидеть `SERVER_UPDATING`, а не «нет соединения».
 *     Условие ветки при этом обязано быть ЖИВЫМ: `&& false`, сравнение с
 *     литералом или отключение проверки состояния сводят гейт в no-op, но
 *     подстрочный сторож этого не видит (замечание приёмки — «чисто текстовый
 *     сторож пропускает `if (maintenance !== null && false)`»).
 *  2. Открытие сокета НЕ завершает обслуживание: сервер в обслуживании
 *     намеренно принимает сокет и сразу закрывает его кодом 1012. Выход даёт
 *     сокет, проживший стабильное окно (`onMaintenanceStable`), либо успешный
 *     `GET /me` ВМЕСТЕ со сменой версии процесса (`GET /version` показывает
 *     другую/целевую версию): `/me` — чтение, и в обслуживании сервер
 *     отвечает на него 200, поэтому один `/me` ничего не доказывает (вердикт
 *     повторной приёмки 479e37ed). Ветка `status === 'connected'` не имеет
 *     права звать `serverMaintenance.leave()`.
 *  3. Предупреждение о потерянной связи показывает текст обслуживания раньше
 *     таблицы статусов — иначе «сервер обновляется» превращается в «аварию».
 *     Досыл черновиков и тост «Соединение восстановлено» в обслуживании не
 *     запускаются.
 *  4. Фраза «сервер обновляется» собирается В ОДНОМ месте рендерера:
 *     `lib/server-maintenance-text.ts` + словарь `lib/locales/ru.ts`. Второй
 *     литерал или второй сборщик из ключей `realtime.maintenance.*` — красный.
 *  5. Закрытие `1012` распознаётся только через общий справочник
 *     `REALTIME_CLOSE_CODES` (литерал `1012` разъезжается с сервером).
 *  6. Тексты обслуживания из словаря не называют сервер «недоступным».
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { listSourceFiles } from './guard-helpers.js';
import { ru } from '../src/renderer/lib/locales/ru.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN_ROOT = path.join(CLIENT_ROOT, 'src', 'main');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

/**
 * Грубо вырезает комментарии (сохраняя номера строк), чтобы упоминание фразы в
 * пояснении не считалось вторым источником текста. Полноценный лексер не нужен:
 * строковый литерал с фразой обслуживания и `//` в одном литерале не живут.
 */
function stripComments(source: string): string {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (block) =>
    block.replace(/[^\n]/g, ''),
  );
  return withoutBlocks
    .split('\n')
    .map((line) => {
      const at = line.indexOf('//');
      return at === -1 ? line : line.slice(0, at);
    })
    .join('\n');
}

/**
 * Условие ближайшего `if (...)` перед позицией `markerIndex`, с балансировкой
 * скобок. Нужно, чтобы проверять СМЫСЛ ветки, а не только порядок подстрок:
 * мутация `maintenance !== null && false` не меняет ни одного маркера.
 */
function conditionBefore(source: string, markerIndex: number): string {
  const head = source.slice(0, markerIndex);
  const at = head.lastIndexOf('if (');
  assert.notEqual(at, -1, 'не найден `if` ветки обслуживания');
  const open = at + 'if '.length;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error('незакрытое условие `if` ветки обслуживания');
}

/**
 * Заведомо мёртвые формы условия: значение ветки не зависит от состояния.
 * Каждая запись — объяснение для сообщения об ошибке.
 */
const DEAD_CONDITIONS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /(?:&&|\|\|)\s*\(\s*(?:false|true)\b/i, why: 'литерал true/false в конъюнкции' },
  { pattern: /(?:&&|\|\|)\s*(?:false|true)\b/i, why: 'литерал true/false в конъюнкции' },
  { pattern: /(?:false|true)\s*\)*\s*(?:&&|\|\|)/i, why: 'литерал true/false в конъюнкции' },
  {
    pattern:
      /(?:true|false|null|\d+|'[^']*'|"[^"]*")\s*(?:===|!==|==|!=)\s*(?:true|false|null|\d+|'[^']*'|"[^"]*")/i,
    why: 'сравнение двух литералов',
  },
  {
    pattern: /(?:maintenance|info)\w*\s*(?:===|!==|==|!=)\s*(?:['"`]|\d)/i,
    why: 'сравнение состояния обслуживания со строкой/числом',
  },
];

describe('guard: обслуживание сервера (479e37ed)', () => {
  it('IPC-гейт изменений отвечает SERVER_UPDATING раньше «обрыва связи»', () => {
    const source = read(path.join(MAIN_ROOT, 'ipc', 'register.ts'));
    const maintenance = source.indexOf('mutation blocked: server maintenance');
    const linkDown = source.indexOf('mutation blocked: network link down');
    assert.notEqual(maintenance, -1, 'нет ветки обслуживания в центральном IPC-гейте');
    assert.notEqual(linkDown, -1, 'пропала ветка обрыва связи');
    assert.ok(
      maintenance < linkDown,
      'ветка обслуживания обязана стоять ДО ветки connection-lost',
    );
    assert.match(source, /serverUpdatingError\(\{/, 'отказ отдаётся каноническим SERVER_UPDATING');
  });

  it('условие ветки обслуживания живое и проверяет состояние (не `&& false`)', () => {
    const source = read(path.join(MAIN_ROOT, 'ipc', 'register.ts'));
    const condition = conditionBefore(
      source,
      source.indexOf('mutation blocked: server maintenance'),
    );
    for (const { pattern, why } of DEAD_CONDITIONS) {
      assert.doesNotMatch(condition, pattern, `мёртвое условие ветки обслуживания: ${why}`);
    }
    assert.match(condition, /maintenance/i, 'ветка не проверяет состояние обслуживания');
    assert.match(
      condition,
      /!==?\s*(?:null|undefined)/,
      'ветка обязана проверять активность состояния (сравнение с null/undefined)',
    );
  });

  it('выход из обслуживания — стабильный сокет или /me со сменой версии, не по connected', () => {
    const source = read(path.join(MAIN_ROOT, 'ipc', 'register.ts'));
    const connectedAt = source.indexOf("if (status === 'connected') {");
    assert.notEqual(connectedAt, -1, 'нет ветки connected в onStatus');
    const connectedBlock = source.slice(connectedAt, source.indexOf('} else if', connectedAt));
    assert.doesNotMatch(
      connectedBlock,
      /serverMaintenance\.leave\(/,
      'открытие сокета НЕ завершает обслуживание (сервер принимает сокет и сразу шлёт 1012)',
    );
    assert.match(source, /onMaintenanceStable:/, 'нет выхода по стабильному окну сокета');
    assert.match(
      source,
      /onMaintenanceStable[\s\S]{0,400}?serverMaintenance\.leave\(\)/,
      'обработчик стабильного сокета обязан выходить из обслуживания',
    );
    assert.match(source, /onServerMaintenanceEnded:/, 'нет выхода по успешному `GET /me`');
  });

  it('выход по /me требует смены версии процесса: /me сам по себе не гасит состояние', () => {
    // Блокер повторной приёмки 479e37ed: сервер в обслуживании отвечает на
    // `/me` 200, поэтому успех `/me` сам по себе не отличает старый процесс от
    // нового. Доказательство — публичный `GET /version`: смена версии (или
    // версия не меньше `target_version`).
    const source = read(path.join(MAIN_ROOT, 'net', 'rest-client.ts'));
    const meAt = source.indexOf("path === '/me'");
    assert.notEqual(meAt, -1, 'нет обработки успешного GET /me');
    const meBranch = source.slice(meAt, meAt + 300);
    assert.doesNotMatch(
      meBranch,
      /\.leave\(/,
      'успешный /me не выходит из обслуживания сам по себе (чтения в обслуживании проходят)',
    );
    const decisionAt = source.indexOf('isMaintenanceEndedByVersion(');
    assert.notEqual(
      decisionAt,
      -1,
      'нет решения о выходе по смене версии (isMaintenanceEndedByVersion)',
    );
    const leaveAt = source.indexOf('.leave()');
    assert.notEqual(leaveAt, -1, 'нет действующего выхода из обслуживания (leave)');
    assert.ok(
      decisionAt < leaveAt,
      'leave обязан идти только ПОСЛЕ решения по версии процесса',
    );
    const leaves = source.match(/\.leave\(\)/g) ?? [];
    assert.equal(leaves.length, 1, 'в RestClient одно место выхода — после проверки версии');
    assert.match(
      source,
      /getVersion\(\)/,
      'проверка выхода обязана спрашивать публичный GET /version',
    );
  });

  it('действующий выход по /me заставляет realtime переподключиться', () => {
    // Вердикт повторной приёмки: без forceReconnectRealtime сокет остаётся
    // offline/server-maintenance и ждёт `retry_after` (наблюдали 300 с), хотя
    // REST уже работает: статус «Нет соединения» держится на пустом месте.
    const source = read(path.join(MAIN_ROOT, 'ipc', 'register.ts'));
    const at = source.indexOf('onServerMaintenanceEnded:');
    assert.notEqual(at, -1, 'нет выхода по успешному `GET /me`');
    const block = source.slice(at, at + 500);
    const force = block.indexOf('forceReconnectRealtime()');
    const recheck = block.indexOf('compatibility.recheck(');
    assert.notEqual(force, -1, 'выход по /me не переподключает realtime (forceReconnectRealtime)');
    assert.notEqual(recheck, -1, 'выход по /me не повторяет проверку совместимости');
    assert.ok(force < recheck, 'сначала принудительный реконнект, затем проверка совместимости');
    // Стабильный сокет — исключение: сокет уже жив, решения по версии и
    // принудительного реконнекта там быть не должно.
    const stableAt = source.indexOf('onMaintenanceStable:');
    assert.notEqual(stableAt, -1, 'нет выхода по стабильному окну сокета');
    const stableBlock = source.slice(stableAt, stableAt + 300);
    assert.match(stableBlock, /serverMaintenance\.leave\(\)/, 'стабильный сокет обязан выходить');
    assert.doesNotMatch(
      stableBlock,
      /isMaintenanceEndedByVersion|forceReconnectRealtime/,
      'стабильный сокет выходит безусловно, без проверки версии и реконнекта',
    );
  });

  it('потеря связи показывает текст обслуживания раньше таблицы статусов', () => {
    const source = read(path.join(RENDERER_ROOT, 'drafts.ts'));
    const maintenance = source.indexOf('store.state.serverMaintenance');
    const linkTable = source.indexOf("t('realtime.link.lostReconnecting')");
    assert.notEqual(maintenance, -1, 'drafts.ts не учитывает обслуживание');
    assert.ok(
      maintenance < linkTable,
      'проверка обслуживания обязана стоять до выбора текста по статусу связи',
    );
    // Досыл черновиков и тост восстановления не запускаются в обслуживании:
    // мигание сокета (connected → 1012) иначе даёт 12 волн и ложный зелёный тост.
    const connectedResend = source.indexOf('void retryPendingDrafts(nid)');
    const resendGuard = source.lastIndexOf('!inMaintenance', connectedResend);
    assert.notEqual(connectedResend, -1, 'нет досыла черновиков по восстановлению связи');
    assert.ok(
      resendGuard !== -1 && resendGuard < connectedResend,
      'досыл черновиков обязан быть под проверкой обслуживания',
    );
    const recoveredToast = source.indexOf("t('realtime.link.recovered')");
    const toastGuard = source.lastIndexOf('!inMaintenance', recoveredToast);
    assert.notEqual(recoveredToast, -1, 'нет тоста «Соединение восстановлено»');
    assert.ok(
      toastGuard !== -1 && toastGuard < recoveredToast,
      'тост восстановления обязан быть под проверкой обслуживания',
    );
  });

  it('фраза обслуживания — одна: только server-maintenance-text.ts и словарь', () => {
    // Единственные легальные источники: сборщик текста и каталоги языков
    // (`lib/locales/*`, с задачи d08c422d каталогов больше одного).
    const allowed = new Set(['lib/server-maintenance-text.ts']);
    const isAllowed = (rel: string): boolean =>
      allowed.has(rel) || rel.startsWith('lib/locales/');
    // Фраза в строковом литерале: кавычка стоит ДО фразы в той же строке
    // (упоминание в комментарии вида «сервер обновляется» нарушением не является).
    const phraseLiteral =
      /['"`][^'"`\n]*(?:Сервер обновляется|сервер обновляется|ожидаем восстановления)/;
    // Прямой сборщик из словарных ключей мимо общего модуля — тоже второй источник.
    const dictionaryKey = /realtime\.maintenance\./;
    const violations: string[] = [];
    for (const abs of listSourceFiles(RENDERER_ROOT, { extensions: ['.ts'] })) {
      const rel = path.relative(RENDERER_ROOT, abs).split(path.sep).join('/');
      if (isAllowed(rel)) continue;
      stripComments(read(abs))
        .split('\n')
        .forEach((line, i) => {
          if (phraseLiteral.test(line) || dictionaryKey.test(line)) {
            violations.push(`  • ${rel}:${i + 1} — ${line.trim()}`);
          }
        });
    }
    assert.deepEqual(
      violations,
      [],
      `второй источник фразы обслуживания в рендерере:\n${violations.join('\n')}`,
    );
    // Словарь хранит ровно одну пару фраз и не дублирует её ключами `realtime.tip.*`.
    const dictionary = read(path.join(RENDERER_ROOT, 'lib', 'locales', 'ru.ts'));
    assert.doesNotMatch(
      dictionary,
      /'realtime\.tip\.maintenance/,
      'дубль фразы в блоке realtime.tip.* снят замечанием приёмки',
    );
    const keys = [...(dictionary.match(/'realtime\.maintenance\.[a-zA-Z]+'/g) ?? [])].sort();
    assert.deepEqual(keys, [
      "'realtime.maintenance.noRetry'",
      "'realtime.maintenance.waiting'",
    ]);
  });

  it('close 1012 — только через REALTIME_CLOSE_CODES.SERVICE_RESTART', () => {
    const source = read(path.join(MAIN_ROOT, 'net', 'ws-client.ts'));
    assert.match(source, /code === REALTIME_CLOSE_CODES\.SERVICE_RESTART/);
    assert.doesNotMatch(source, /code === 1012/, 'литерал 1012 в ws-client.ts');
  });

  it('кадр maintenance уходит раньше статуса reconnecting/server-maintenance', () => {
    // Порядок в ветке кадра: сначала `emitTyped('maintenance')` (настоящий
    // `retry_after`, например 300 с), затем `setStatus` — иначе main входит в
    // обслуживание по статусу с запасными 30 с (замечание приёмки).
    const source = read(path.join(MAIN_ROOT, 'net', 'ws-client.ts'));
    const frameBranch = source.indexOf("obj.type === 'maintenance'");
    assert.notEqual(frameBranch, -1, 'нет ветки кадра maintenance');
    const branch = source.slice(frameBranch, source.indexOf('return;', frameBranch));
    const emit = branch.indexOf("emitTyped('maintenance'");
    const setStatus = branch.indexOf("setStatus('reconnecting', 'server-maintenance')");
    assert.notEqual(emit, -1, 'кадр maintenance не эмитится');
    assert.notEqual(setStatus, -1, 'нет статуса reconnecting/server-maintenance');
    assert.ok(emit < setStatus, 'кадр maintenance обязан уходить ДО статуса');
  });

  it('словарные тексты обслуживания не путают его с недоступностью', () => {
    const keys = ['realtime.maintenance.waiting', 'realtime.maintenance.noRetry'] as const;
    for (const key of keys) {
      const text = ru[key];
      assert.ok(text.trim().length > 0, `${key}: пустой текст`);
      assert.doesNotMatch(text, /недоступен|нет соединения|ошибк/i, `${key}: «${text}»`);
      assert.match(text, /обновляется/i, `${key}: текст не про обновление`);
    }
    assert.match(ru['realtime.status.serverMaintenance'], /обновление/);
  });
});

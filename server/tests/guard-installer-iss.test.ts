/**
 * Сторож исходника установщика Windows (задача 8789381a, версия 0.15.3).
 *
 * Раньше высокоценные запреты жили только в PowerShell-прогоне
 * `installer/tests/silent-codes.ps1` (216 статических проверок). Этот файл
 * переносит их в обычный `npm -w @etn/server test`, чтобы контракт `.iss`
 * проверялся на каждом прогоне, без установщика, ВМ и хуков TestMode.
 * PowerShell-остаток — `installer/tests/iss-static.ps1` (shape-проверки);
 * свежесть payload — `installer/tests/payload-freshness.ps1`; рантайм
 * проверяется E2E в ВМ (`installer/tests/e2e`).
 *
 * Контракт (карточка 8789381a):
 *   * в `[Code]` нет `MsgBox` — только `SuppressibleMsgBox` (silent-прогон
 *     не должен открывать окна и зависать);
 *   * UI-строки — только в `[CustomMessages]`: кириллические литералы `[Code]`
 *     запрещены, кроме журнальных аргументов (`LogLine` и родственные) и
 *     allowlist технических форматов;
 *   * каждый `CustomMessage('X')` определён в `[CustomMessages]`, имена
 *     уникальны (дубликат — ошибка компиляции Inno);
 *   * AppId — единственный литерал GUID, из него выводится ключ деинсталляции;
 *     в `[Code]` второго GUID быть не должно;
 *   * `PrivilegesRequired=lowest` + `PrivilegesRequiredOverridesAllowed=commandline`:
 *     мастер не перезапускается, `/ALLUSERS` передаёт служба автообновления;
 *   * порядок обновления: личность службы → остановка → бэкап БД → снимок
 *     отката (копирование файлов делает Inno после возврата);
 *   * health-check читает одно тело `GET /api/v1/health` (status/db/version),
 *     бюджет — фактическое время, без службы fail-closed;
 *   * откат: остановка службы → файлы и БД; при неудачной остановке файлы/БД
 *     не трогаются, в причине — архив, снимок и журнал;
 *   * legacy NSIS-деинсталлятор получает `/S` и `_?=` (грабли 25343551);
 *   * служба управляется `etn-service.exe stop|status|install|uninstall`,
 *     `sc query` в `.iss` нет;
 *   * SQLite-логики в Pascal нет: архивы и `integrity_check` — в CLI
 *     `etn-db-tool.mjs` (`server/dist/db/db-backup.js`).
 *
 * Сторож статический: читает `installer/etn.iss` текстом (fs) и вырезает
 * комментарии Pascal. Поведение проверяют E2E-сценарии в ВМ — здесь только
 * исходник.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(SERVER_ROOT, '..');

const ISS = 'installer/etn.iss';
const ISS_ABS = path.join(REPO_ROOT, ISS);

/** Прочитать исходник установщика с понятной ошибкой, если он пропал. */
function readIss(): string {
  assert.ok(
    fs.existsSync(ISS_ABS),
    `Нет файла ${ISS} — сторож контракта установщика не может проверить исходник. ` +
      'Если файл переехал, обнови путь в сторожа.',
  );
  return fs.readFileSync(ISS_ABS, 'utf8');
}

/** Секция `[Code]`: строки после заголовка и до следующей секции. */
function codeSection(text: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === '[Code]');
  assert.ok(start >= 0, `${ISS}: нет секции [Code].`);

  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^\s*\[[A-Za-z][A-Za-z0-9]*\]\s*$/.test(line)) break;
    body.push(line);
  }
  return body.join('\n');
}

/**
 * Код Pascal без комментариев: `{ … }`, `(* … *)`, `// …`. Строковые литералы
 * сохраняются — они и есть то, что проверяют сторожа UI-текстов.
 */
function stripPascalComments(code: string): string {
  let out = '';
  let block: 'brace' | 'paren' | null = null;
  let inString = false;

  for (let i = 0; i < code.length; i += 1) {
    const c = code[i]!;
    const next = code[i + 1];

    if (block === 'brace') {
      if (c === '}') block = null;
      continue;
    }
    if (block === 'paren') {
      if (c === '*' && next === ')') {
        block = null;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "'") {
        if (next === "'") {
          out += "'";
          i += 1;
          continue;
        }
        inString = false;
      }
      continue;
    }
    if (c === "'") {
      inString = true;
      out += c;
      continue;
    }
    if (c === '{') {
      block = 'brace';
      continue;
    }
    if (c === '(' && next === '*') {
      block = 'paren';
      i += 1;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < code.length && code[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    out += c;
  }
  return out;
}

/** Тело функции/процедуры по имени: от объявления до следующего объявления. */
function functionBody(code: string, name: string): string {
  const lines = code.split('\n');
  const startPattern = new RegExp(`^\\s*(?:function|procedure)\\s+${name}\\b`, 'i');
  const start = lines.findIndex((line) => startPattern.test(line));
  if (start < 0) return '';

  const nextDecl = /^\s*(?:function|procedure)\s+[A-Za-z_]/i;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (nextDecl.test(line)) break;
    body.push(line);
  }
  return body.join('\n');
}

/** Содержимое `[CustomMessages]`: значения (с продолжением `\`) и все имена. */
function customMessages(text: string): { map: Map<string, string>; names: string[] } {
  const map = new Map<string, string>();
  const names: string[] = [];
  const lines = text.split('\n');

  let inSection = false;
  let pendingName: string | null = null;
  let pendingValue = '';

  const flush = (): void => {
    if (pendingName !== null) {
      map.set(pendingName, pendingValue);
      pendingName = null;
      pendingValue = '';
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const section = /^\[([^\]]+)\]$/.exec(trimmed);
    if (section) {
      flush();
      inSection = (section[1] ?? '').toLowerCase() === 'custommessages';
      continue;
    }
    if (!inSection) continue;
    if (trimmed === '' || trimmed.startsWith(';')) continue;

    if (pendingName !== null && pendingValue.endsWith('\\')) {
      pendingValue = pendingValue.slice(0, -1) + trimmed;
      continue;
    }
    flush();

    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const name = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    names.push(name);
    if (value.endsWith('\\')) {
      pendingName = name;
      pendingValue = value;
    } else {
      map.set(name, value);
    }
  }
  flush();
  return { map, names };
}

/** Строки ini-секций без комментариев `;` (упоминание в шапке — не настройка). */
function stripIniComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*;/.test(line))
    .join('\n');
}

/** Журнальные вызовы: их строковые аргументы — не UI, а диагностика. */
const JOURNAL_CALLS = new Set([
  'logline',
  'logdefer',
  'logordefer',
  'log',
  'applydatabasetoolreport',
]);

/**
 * Технические форматы, которые разрешено держать в `[Code]` (решение
 * пользователя 4dc117f5): числа с единицами и строка подключения клиента.
 */
const UI_ALLOWLIST = new Set([
  '%.1f ГБ',
  '%.1f МБ',
  ' КБ',
  ' МБ',
  ' --connect-name="Локальный сервер"',
]);

/**
 * Кириллические литералы `[Code]` вне `[CustomMessages]`. Литерал внутри
 * журнального вызова (в том числе вложенного) — диагностика, а не UI.
 */
function uiLiterals(code: string): string[] {
  const found: string[] = [];
  const callStack: (string | null)[] = [];
  let inString = false;
  let stringStart = -1;

  for (let i = 0; i < code.length; i += 1) {
    const c = code[i]!;

    if (inString) {
      if (c === "'") {
        if (code[i + 1] === "'") {
          i += 1;
          continue;
        }
        inString = false;
        const value = code.slice(stringStart + 1, i).replace(/''/g, "'");
        if (/[А-Яа-яЁё]/.test(value) && !UI_ALLOWLIST.has(value)) {
          const inJournal = callStack.some(
            (callee) => callee !== null && JOURNAL_CALLS.has(callee),
          );
          if (!inJournal && !found.includes(value)) found.push(value);
        }
      }
      continue;
    }

    if (c === "'") {
      inString = true;
      stringStart = i;
      continue;
    }
    if (c === '(') {
      // Имя вызываемого — идентификатор перед скобкой; группировка даёт null.
      let j = i - 1;
      while (j >= 0 && /\s/.test(code[j]!)) j -= 1;
      const end = j;
      while (j >= 0 && /[A-Za-z0-9_]/.test(code[j]!)) j -= 1;
      callStack.push(end > j ? code.slice(j + 1, end + 1).toLowerCase() : null);
      continue;
    }
    if (c === ')') {
      callStack.pop();
    }
  }
  return found;
}

/** Индекс фрагмента в теле функции; -1 — нет. */
function indexOfIn(haystack: string, needle: string): number {
  return haystack.indexOf(needle);
}

describe('guard: исходник установщика — высокоценные запреты', () => {
  it(`${ISS}: в [Code] нет MsgBox (только SuppressibleMsgBox)`, () => {
    const code = stripPascalComments(codeSection(readIss()));
    const matches = code.match(/(?<!Suppressible)MsgBox\s*\(/g) ?? [];
    assert.equal(
      matches.length,
      0,
      `${ISS}: найден MsgBox в [Code] (${matches.length}). Silent-прогон не должен ` +
        'открывать окна: сообщения — SuppressibleMsgBox или журнал.',
    );
  });

  it(`${ISS}: кириллические литералы [Code] — только в [CustomMessages]`, () => {
    const code = stripPascalComments(codeSection(readIss()));
    const left = uiLiterals(code);
    assert.deepEqual(
      left,
      [],
      `${ISS}: UI-литералы в [Code] вне allowlist: ${left.join(' | ')}. ` +
        'Текст переезжает в [CustomMessages], в коде остаётся CustomMessage-ключ.',
    );
  });

  it(`${ISS}: CustomMessages определены и уникальны`, () => {
    const text = readIss();
    const code = stripPascalComments(codeSection(text));
    const { map, names } = customMessages(text);

    const calls = new Set<string>();
    for (const match of code.matchAll(/CustomMessage\('([A-Za-z0-9_]+)'\)/g)) {
      calls.add(match[1] ?? '');
    }
    const undefinedMessages = [...calls].filter((name) => !map.has(name)).sort();
    assert.deepEqual(
      undefinedMessages,
      [],
      `${ISS}: CustomMessage('X') без определения в [CustomMessages]: ` +
        `${undefinedMessages.join(', ') || 'нет'}. В рантайме Inno бросит исключение.`,
    );

    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const name of names) {
      if (seen.has(name)) duplicates.add(name);
      seen.add(name);
    }
    assert.deepEqual(
      [...duplicates].sort(),
      [],
      `${ISS}: дубликаты имён в [CustomMessages]: ${[...duplicates].join(', ')}. ` +
        'Дубликат — ошибка компиляции Inno.',
    );
  });

  it(`${ISS}: AppId — единственный источник идентификатора`, () => {
    const text = readIss();
    const code = stripPascalComments(codeSection(text));

    const defines = [...text.matchAll(/#define ProductAppId "([^"]+)"/g)];
    assert.equal(
      defines.length,
      1,
      `${ISS}: ожидается ровно один #define ProductAppId, найдено ${defines.length}.`,
    );
    const appId = defines[0]?.[1] ?? '';
    assert.match(
      appId,
      /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i,
      `${ISS}: ProductAppId не GUID: «${appId}».`,
    );

    // Литерал GUID — только в #define: AppId, ключ деинсталляции и код берут
    // его из одного места (ошибка a7394117).
    const occurrences = text.match(new RegExp(appId, 'gi')) ?? [];
    assert.equal(
      occurrences.length,
      1,
      `${ISS}: GUID ProductAppId встречается ${occurrences.length} раз(а) — ` +
        'идентификатор должен быть только в #define ProductAppId.',
    );
    assert.equal(
      code.match(/[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/gi)?.length ?? 0,
      0,
      `${ISS}: в [Code] есть литерал GUID — AppId и его производные берутся из [Setup].`,
    );

    assert.match(
      text,
      /^AppId=\{\{\{#ProductAppId\}\}$/m,
      `${ISS}: [Setup] AppId должен быть {{{#ProductAppId}} — единственный источник.`,
    );
    assert.match(
      code,
      /UNINSTALL_KEY_NAME = '\{#ProductUninstallKey\}';/,
      `${ISS}: имя ключа деинсталляции должно выводиться из {#ProductUninstallKey}, ` +
        'а не задаваться вторым литералом.',
    );
  });

  it(`${ISS}: PrivilegesRequired=lowest и /ALLUSERS через commandline`, () => {
    const setup = stripIniComments(readIss());
    assert.match(
      setup,
      /^PrivilegesRequired=lowest$/m,
      `${ISS}: нужен PrivilegesRequired=lowest — мастер не перезапускается после ` +
        'диалога режима Inno (respawn оставлял окно, не принимающее ввод).',
    );
    assert.match(
      setup,
      /^PrivilegesRequiredOverridesAllowed=commandline$/m,
      `${ISS}: нужен PrivilegesRequiredOverridesAllowed=commandline — /ALLUSERS ` +
        'передаёт служба автообновления (2dd215f7).',
    );
    assert.doesNotMatch(
      setup,
      /^PrivilegesRequired=admin$/m,
      `${ISS}: PrivilegesRequired=admin запрещён (aa5af30c).`,
    );
  });

  it(`${ISS}: порядок обновления — личность → остановка → бэкап → снимок`, () => {
    const code = stripPascalComments(codeSection(readIss()));
    const body = functionBody(code, 'PrepareServerUpdate');
    assert.notEqual(body, '', `${ISS}: нет функции PrepareServerUpdate.`);

    const order = [
      { label: 'CheckServiceIdentity', index: indexOfIn(body, 'CheckServiceIdentity(') },
      { label: 'EnsureDatabaseTool', index: indexOfIn(body, 'EnsureDatabaseTool(') },
      { label: 'StopServiceForUpdate', index: indexOfIn(body, 'StopServiceForUpdate(') },
      { label: 'CreateDatabaseBackup', index: indexOfIn(body, 'CreateDatabaseBackup(True)') },
      { label: 'CreateRollbackSnapshot', index: indexOfIn(body, 'CreateRollbackSnapshot') },
    ];
    for (const step of order) {
      assert.ok(
        step.index >= 0,
        `${ISS}: в PrepareServerUpdate нет шага ${step.label} — контракт обновления нарушен.`,
      );
    }
    for (let i = 1; i < order.length; i += 1) {
      const previous = order[i - 1]!;
      const current = order[i]!;
      assert.ok(
        current.index > previous.index,
        `${ISS}: порядок обновления нарушен: ${current.label} (${current.index}) должен ` +
          `идти после ${previous.label} (${previous.index}). Копирование файлов Inno ` +
          'выполняет только после возврата из PrepareServerUpdate.',
      );
    }
  });

  it(`${ISS}: health-check — тело ответа, фактический бюджет, fail-closed`, () => {
    const code = stripPascalComments(codeSection(readIss()));
    const once = functionBody(code, 'CheckHealthOnce');
    assert.notEqual(once, '', `${ISS}: нет функции CheckHealthOnce.`);
    assert.match(
      once,
      /'\/api\/v1\/health'/,
      `${ISS}: health-check должен запрашивать GET /api/v1/health.`,
    );
    for (const field of ['status', 'db', 'version']) {
      assert.match(
        once,
        new RegExp(`JsonGetRaw\\(Body, '${field}'\\)`),
        `${ISS}: CheckHealthOnce не разбирает поле ${field} из тела ответа. ` +
          'Одного HTTP 200 недостаточно (0a79d9de, a1ea1d40).',
      );
    }

    const probe = functionBody(code, 'ProbeHealth');
    assert.notEqual(probe, '', `${ISS}: нет функции ProbeHealth.`);
    assert.match(
      probe,
      /FileExists\(ServiceExePath\)/,
      `${ISS}: health-check должен быть fail-closed без службы (нет etn-service.exe — сбой).`,
    );
    assert.match(
      probe,
      /ServiceNowSeconds/,
      `${ISS}: бюджет health-check — фактическое время (ServiceNowSeconds), а не сумма Sleep.`,
    );
    assert.match(
      probe,
      /HealthWaitMs/,
      `${ISS}: ProbeHealth должен ограничивать ожидание через HealthWaitMs.`,
    );
    assert.match(
      code,
      /HEALTH_WAIT_MS = 60000;/,
      `${ISS}: бюджет health-check должен оставаться 60 с (a1ea1d40).`,
    );
  });

  it(`${ISS}: откат — остановка, файлы и БД, причина с архивом`, () => {
    const code = stripPascalComments(codeSection(readIss()));
    const body = functionBody(code, 'RollbackAfterFailure');
    assert.notEqual(body, '', `${ISS}: нет функции RollbackAfterFailure.`);

    const stop = indexOfIn(body, 'StopServiceForUpdate(');
    const files = indexOfIn(body, 'RestoreInstallFiles');
    const db = indexOfIn(body, 'RestoreDatabaseFromArchive');
    const health = indexOfIn(body, 'ProbeHealth(False)');
    assert.ok(
      stop >= 0 && files > stop && db > stop,
      `${ISS}: откат обязан остановить службу до RestoreInstallFiles/RestoreDatabaseFromArchive: ` +
        `StopServiceForUpdate=${stop}, RestoreInstallFiles=${files}, ` +
        `RestoreDatabaseFromArchive=${db}.`,
    );
    assert.ok(
      health > files,
      `${ISS}: после возврата файлов откат должен подтвердить ответ прежней версии ` +
        'health-check-ом (ProbeHealth(False)).',
    );
    assert.match(
      body,
      /CustomMessage\('EtnRollbackStopFailed'\)/,
      `${ISS}: при неудачной остановке откат не трогает файлы/БД и сообщает путь к снимку ` +
        'и архиву (EtnRollbackStopFailed, 34f8e315).',
    );
    assert.match(
      body,
      /GLastBackupDir/,
      `${ISS}: причина отказа отката обязана содержать путь к архиву БД.`,
    );
    assert.match(
      body,
      /CustomMessage\('EtnRollbackDataLost'\)/,
      `${ISS}: откат обязан предупреждать об окне потерь данных (EtnRollbackDataLost).`,
    );
  });

  it(`${ISS}: legacy NSIS-деинсталлятор — /S и _?=, без Inno-флагов`, () => {
    const code = stripPascalComments(codeSection(readIss()));
    const args = functionBody(code, 'UninstallerArgs');
    assert.notEqual(args, '', `${ISS}: нет функции UninstallerArgs.`);
    assert.match(
      args,
      /'\/S'/,
      `${ISS}: legacy-деинсталлятору NSIS нужен /S (тихий режим).`,
    );
    assert.match(
      args,
      /' _\?='/,
      `${ISS}: legacy-деинсталлятору NSIS нужен _?=<каталог> последним — без него ` +
        'он копирует себя в %TEMP% и возвращает управление сразу (грабли 25343551).',
    );
    assert.doesNotMatch(
      args,
      /\/VERYSILENT|\/SUPPRESSMSGBOXES|\/NORESTART/,
      `${ISS}: Inno-флаги /VERYSILENT/… legacy NSIS-деинсталлятору не передаются.`,
    );
  });

  it(`${ISS}: служба — etn-service.exe, без sc query`, () => {
    const code = stripPascalComments(codeSection(readIss()));
    assert.equal(
      code.match(/\bsc(?:\.exe)?\s+query\b/gi)?.length ?? 0,
      0,
      `${ISS}: найден sc query — управление службой идёт через etn-service.exe ` +
        'stop|status|install|uninstall (34f8e315).',
    );

    const exe = functionBody(code, 'ServiceExePath');
    assert.match(
      exe,
      /'\\service\\etn-service\.exe'/,
      `${ISS}: путь службы — {app}\\service\\etn-service.exe (ServiceDir).`,
    );
    assert.match(
      exe,
      /ServiceDir/,
      `${ISS}: ServiceExePath должен строиться от ServiceDir (в деинсталляторе — {app}).`,
    );

    const register = functionBody(code, 'RegisterServiceIfNeeded');
    assert.match(
      register,
      /RunServiceCommand\('install'\)/,
      `${ISS}: регистрация службы — etn-service.exe install (8b1f5980).`,
    );

    const remove = functionBody(code, 'RemoveServiceOnUninstall');
    const removeStop = indexOfIn(remove, 'StopServiceForUpdate(');
    const removeUninstall = indexOfIn(remove, "RunServiceCommand('uninstall')");
    assert.ok(
      removeStop >= 0 && removeUninstall > removeStop,
      `${ISS}: снятие службы — stop с ожиданием, затем uninstall (34f8e315).`,
    );
  });

  it(`${ISS}: SQLite-логики в Pascal нет — только CLI etn-db-tool.mjs`, () => {
    const code = stripPascalComments(codeSection(readIss()));
    for (const forbidden of [
      'sqlite3',
      'wal_checkpoint',
      'CopyDatabasesInto',
      'RotateBackupArchives',
      'OldestBackupDirName',
    ]) {
      assert.equal(
        code.toLowerCase().includes(forbidden.toLowerCase()),
        false,
        `${ISS}: в [Code] осталась SQLite-логика «${forbidden}» — бэкап, integrity_check, ` +
          'WAL и ротация живут в CLI (server/src/db/db-backup.ts, 3acd9c3c).',
      );
    }

    const backup = functionBody(code, 'CreateDatabaseBackup');
    assert.match(
      backup,
      /RunDatabaseTool\(/,
      `${ISS}: CreateDatabaseBackup обязан вызывать CLI через RunDatabaseTool.`,
    );
    assert.match(
      backup,
      /if not Needed/,
      `${ISS}: решение о необходимости бэкапа передаёт вызывающий (ремонт той же версии — без архива).`,
    );
    assert.match(
      code,
      /DB_TOOL_FILENAME = 'etn-db-tool\.mjs';/,
      `${ISS}: инструмент бэкапа извлекается как etn-db-tool.mjs.`,
    );
    assert.match(
      readIss(),
      /Source: "\{#ServerPayload\}\\dist\\db\\db-backup\.js"; DestName: "etn-db-tool\.mjs"/,
      `${ISS}: [Files] должен извлекать server\\dist\\db\\db-backup.js как etn-db-tool.mjs.`,
    );
  });
});

/**
 * Скачивание установщика обновления и запуск silent server-only режима
 * (задача 48312755; тех.проект 2d9f5cc7; контракт установщика a1211915).
 *
 * Покрытие DoD: несовпавший и отсутствующий хеш — ошибка без запуска
 * установщика; коды 0/10/20 (и прочие) классифицируются правильно; тайм-аут
 * не убивает процесс и несёт путь к журналу; флаги командной строки — ровно
 * контрактные; параллельный вызов не создаёт второй процесс; скачанный файл
 * проверяется по SHA-256 и лежит в `%TEMP%\ETN\update\<version>`.
 *
 * Фикстуры — внешний контракт (HTTP-ответ, процесс установщика, имя журнала),
 * а не данные мыслесети: сервер и установщик обмениваются байтами и кодами
 * возврата, поэтому фиктивный поток и подставной процесс собираются явно,
 * как метаданные фида в `update-checker.test.ts`.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  INSTALLER_DOWNLOAD_TIMEOUT_MS,
  INSTALLER_EXIT_FAILURE,
  INSTALLER_EXIT_PRECONDITION,
  INSTALLER_EXIT_SUCCESS,
  INSTALLER_LOG_MTIME_SLACK_MS,
  INSTALLER_LOG_PATTERN,
  INSTALLER_RUN_TIMEOUT_MS,
  INSTALLER_SILENT_ARGS,
  InstallerDownloadError,
  InstallerHashError,
  InstallerLaunchError,
  InstallerRunInProgressError,
  InstallerTimeoutError,
  InstallerTargetError,
  classifyInstallerExitCode,
  createInstallerRunner,
  defaultInstallerLogDirs,
  findInstallerLogPath,
  spawnInstallerProcess,
  type InstallerFetch,
  type InstallerFetchResponse,
  type InstallerProcessHandle,
  type InstallerRunner,
  type InstallerTarget,
  type SpawnInstaller,
} from '../src/update/installer-runner.js';

/** Версия установщика в тестах (имя каталога и ассета). */
const VERSION = '0.15.2';

/** Ссылка на установщик в тестовом фиде. */
const DOWNLOAD_URL = `https://feed.test/download/v${VERSION}/ETN-Setup-${VERSION}.exe`;

/** Байты установщика: содержимое произвольное, важен SHA-256. */
const INSTALLER_BYTES = Buffer.from('MZ test installer payload (внешний контракт)', 'utf8');

/** Временные каталоги теста — удаляются после прогона. */
const tempRoots: string[] = [];

/** Уникальный временный каталог под конкретный тест. */
function makeTempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

/** SHA-256 буфера — эталон для кеша и проверок. */
function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Поток тела ответа кусками: проверяет потоковую запись, а не одним буфером. */
function bodyChunks(data: Buffer, chunkSize = 7): AsyncIterable<Uint8Array> {
  return (async function* chunks(): AsyncGenerator<Uint8Array> {
    for (let offset = 0; offset < data.length; offset += chunkSize) {
      yield data.subarray(offset, offset + chunkSize);
    }
  })();
}

/** Успешный ответ загрузки ассета. */
function okResponse(data: Buffer = INSTALLER_BYTES): InstallerFetchResponse {
  return { ok: true, status: 200, body: bodyChunks(data) };
}

/** Цель обновления из кеша проверки (по умолчанию — корректная). */
function makeTarget(overrides: Partial<InstallerTarget> = {}): InstallerTarget {
  return {
    version: VERSION,
    downloadUrl: DOWNLOAD_URL,
    sha256: sha256Hex(INSTALLER_BYTES),
    ...overrides,
  };
}

/** Обработчики событий подставного процесса. */
type CloseHandler = (code: number | null, signal: NodeJS.Signals | null) => void;
type ErrorHandler = (error: Error) => void;

/**
 * Подставной процесс установщика с управляемыми событиями. Метода завершения
 * у runner'а нет намеренно, поэтому тест сам решает, когда процесс «закроется».
 */
class FakeProcess implements InstallerProcessHandle {
  #closeHandlers: CloseHandler[] = [];
  #errorHandlers: ErrorHandler[] = [];
  #closed = false;

  get closed(): boolean {
    return this.#closed;
  }

  on(event: 'close', handler: CloseHandler): void;
  on(event: 'error', handler: ErrorHandler): void;
  on(event: 'close' | 'error', handler: CloseHandler | ErrorHandler): void {
    if (event === 'close') {
      this.#closeHandlers.push(handler as CloseHandler);
    } else {
      this.#errorHandlers.push(handler as ErrorHandler);
    }
  }

  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const handler of this.#closeHandlers) handler(code, signal);
  }

  fail(error: Error): void {
    for (const handler of this.#errorHandlers) handler(error);
  }
}

/** Создать подставной процесс установщика. */
function makeFakeProcess(): FakeProcess {
  return new FakeProcess();
}

/** Подождать условие (старт скачивания/процесса) с ограничением по времени. */
async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('ожидание условия не завершилось за отведённое время');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Runner с подставным HTTP и подставным процессом. */
interface MakeRunnerOptions {
  fetchImpl?: InstallerFetch;
  spawnImpl?: SpawnInstaller;
  downloadRoot?: string;
  logDirs?: readonly string[];
  downloadTimeoutMs?: number;
  runTimeoutMs?: number;
  now?: () => number;
}

/** Собрать runner с безопасными для теста значениями по умолчанию. */
function makeRunner(options: MakeRunnerOptions = {}): InstallerRunner {
  return createInstallerRunner({
    fetchImpl: options.fetchImpl ?? (() => Promise.resolve(okResponse())),
    spawnImpl:
      options.spawnImpl ??
      (() => {
        const process = makeFakeProcess();
        queueMicrotask(() => process.close(INSTALLER_EXIT_SUCCESS));
        return process;
      }),
    downloadRoot: options.downloadRoot ?? makeTempRoot('etn-runner-dl-'),
    logDirs: options.logDirs ?? [makeTempRoot('etn-runner-log-')],
    downloadTimeoutMs: options.downloadTimeoutMs ?? 5_000,
    runTimeoutMs: options.runTimeoutMs ?? 5_000,
    now: options.now,
  });
}

after(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('контрактные флаги и путь загрузки', () => {
  it('флаги командной строки — ровно /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SERVERONLY /ALLUSERS', () => {
    assert.deepEqual([...INSTALLER_SILENT_ARGS], [
      '/VERYSILENT',
      '/SUPPRESSMSGBOXES',
      '/NORESTART',
      '/SERVERONLY',
      '/ALLUSERS',
    ]);
  });

  it('скачивает установщик в <корень>/<версия>, проверяет хеш и запускает с контрактными флагами', async () => {
    const downloadRoot = makeTempRoot('etn-runner-dl-');
    const calls: { installerPath: string; args: readonly string[] }[] = [];
    const runner = makeRunner({
      downloadRoot,
      spawnImpl: (installerPath, args) => {
        calls.push({ installerPath, args: [...args] });
        const process = makeFakeProcess();
        queueMicrotask(() => process.close(INSTALLER_EXIT_SUCCESS));
        return process;
      },
    });

    const result = await runner.run(makeTarget());

    const expectedPath = path.join(downloadRoot, VERSION, `ETN-Setup-${VERSION}.exe`);
    assert.equal(result.code, INSTALLER_EXIT_SUCCESS);
    assert.equal(result.installerPath, expectedPath);
    assert.equal(result.logPath, null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.installerPath, expectedPath);
    assert.deepEqual(calls[0]?.args, [
      '/VERYSILENT',
      '/SUPPRESSMSGBOXES',
      '/NORESTART',
      '/SERVERONLY',
      '/ALLUSERS',
    ]);
    assert.ok(existsSync(expectedPath), 'скачанный установщик остался на месте');
    assert.deepEqual(readFileSync(expectedPath), INSTALLER_BYTES);
    assert.deepEqual(readdirSync(path.dirname(expectedPath)), [`ETN-Setup-${VERSION}.exe`]);
  });
});

describe('проверка SHA-256 до запуска', () => {
  it('несовпавший хеш — ошибка, установщик не запущен, файла нет', async () => {
    const downloadRoot = makeTempRoot('etn-runner-dl-');
    let spawnCalls = 0;
    const runner = makeRunner({
      downloadRoot,
      spawnImpl: () => {
        spawnCalls += 1;
        return makeFakeProcess();
      },
    });

    await assert.rejects(
      runner.run(makeTarget({ sha256: 'a'.repeat(64) })),
      (err: unknown) => {
        assert.ok(err instanceof InstallerHashError, 'ожидается InstallerHashError');
        assert.equal(err.expected, 'a'.repeat(64));
        assert.equal(err.actual, sha256Hex(INSTALLER_BYTES));
        return true;
      },
    );
    assert.equal(spawnCalls, 0, 'установщик не должен запускаться');
    const versionDir = path.join(downloadRoot, VERSION);
    assert.deepEqual(readdirSync(versionDir), [], 'частичный файл и установщик удалены');
  });

  it('отсутствующий хеш — ошибка до сети и диска', async () => {
    let fetchCalls = 0;
    let spawnCalls = 0;
    const runner = makeRunner({
      fetchImpl: () => {
        fetchCalls += 1;
        return Promise.resolve(okResponse());
      },
      spawnImpl: () => {
        spawnCalls += 1;
        return makeFakeProcess();
      },
    });

    await assert.rejects(
      runner.run(makeTarget({ sha256: null })),
      (err: unknown) => {
        assert.ok(err instanceof InstallerTargetError);
        assert.match(err.message, /SHA-256/);
        return true;
      },
    );
    assert.equal(fetchCalls, 0);
    assert.equal(spawnCalls, 0);
  });

  it('хеш неверного формата — ошибка до сети', async () => {
    const runner = makeRunner();
    await assert.rejects(runner.run(makeTarget({ sha256: 'not-a-hash' })), InstallerTargetError);
  });
});

describe('недопустимая цель обновления', () => {
  it('нет ссылки на установщик — ошибка', async () => {
    const runner = makeRunner();
    await assert.rejects(
      runner.run(makeTarget({ downloadUrl: null })),
      (err: unknown) => {
        assert.ok(err instanceof InstallerTargetError);
        assert.match(err.message, /ссылки на установщик/);
        return true;
      },
    );
  });

  it('версия не semver (попытка выйти из каталога загрузки) — ошибка', async () => {
    let fetchCalls = 0;
    const runner = makeRunner({
      fetchImpl: () => {
        fetchCalls += 1;
        return Promise.resolve(okResponse());
      },
    });
    await assert.rejects(
      runner.run(makeTarget({ version: '../../0.15.2' })),
      InstallerTargetError,
    );
    assert.equal(fetchCalls, 0);
  });

  it('не https-ссылка — ошибка (применение только по HTTPS)', async () => {
    let fetchCalls = 0;
    const runner = makeRunner({
      fetchImpl: () => {
        fetchCalls += 1;
        return Promise.resolve(okResponse());
      },
    });
    for (const downloadUrl of [
      'file:///c:/temp/evil.exe',
      `http://feed.test/download/v${VERSION}/ETN-Setup-${VERSION}.exe`,
    ]) {
      await assert.rejects(runner.run(makeTarget({ downloadUrl })), InstallerTargetError);
    }
    assert.equal(fetchCalls, 0);
  });
});

describe('ошибки скачивания', () => {
  it('HTTP-код не 2xx — понятная ошибка без запуска установщика', async () => {
    let spawnCalls = 0;
    const runner = makeRunner({
      fetchImpl: () => Promise.resolve({ ok: false, status: 404, body: null }),
      spawnImpl: () => {
        spawnCalls += 1;
        return makeFakeProcess();
      },
    });
    await assert.rejects(
      runner.run(makeTarget()),
      (err: unknown) => {
        assert.ok(err instanceof InstallerDownloadError);
        assert.match(err.message, /HTTP 404/);
        return true;
      },
    );
    assert.equal(spawnCalls, 0);
  });

  it('сетевой сбой — InstallerDownloadError, установщик не запущен', async () => {
    let spawnCalls = 0;
    const runner = makeRunner({
      fetchImpl: () => Promise.reject(new Error('getaddrinfo ENOTFOUND feed.test')),
      spawnImpl: () => {
        spawnCalls += 1;
        return makeFakeProcess();
      },
    });
    await assert.rejects(runner.run(makeTarget()), InstallerDownloadError);
    assert.equal(spawnCalls, 0);
  });

  it('ответ без тела — InstallerDownloadError', async () => {
    const runner = makeRunner({
      fetchImpl: () => Promise.resolve({ ok: true, status: 200, body: null }),
    });
    await assert.rejects(runner.run(makeTarget()), InstallerDownloadError);
  });

  it('тайм-аут скачивания — InstallerDownloadError', async () => {
    const runner = makeRunner({
      downloadTimeoutMs: 20,
      fetchImpl: (_url, init) =>
        new Promise<InstallerFetchResponse>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const error = new Error('The operation was aborted due to timeout');
            error.name = 'TimeoutError';
            reject(error);
          });
        }),
    });
    // Таймер AbortSignal.timeout не удерживает цикл событий: держим его сами,
    // иначе node:test завершит тест раньше срабатывания сигнала.
    const keepAlive = setInterval(() => undefined, 5);
    try {
      await assert.rejects(
        runner.run(makeTarget()),
        (err: unknown) => {
          assert.ok(err instanceof InstallerDownloadError);
          assert.match(err.message, /время ожидания/);
          return true;
        },
      );
    } finally {
      clearInterval(keepAlive);
    }
  });
});

describe('коды возврата установщика', () => {
  it('0 — успех, 20 — предусловие, 10 и иное — сбой', () => {
    assert.equal(classifyInstallerExitCode(INSTALLER_EXIT_SUCCESS), 'success');
    assert.equal(classifyInstallerExitCode(INSTALLER_EXIT_PRECONDITION), 'precondition');
    for (const code of [INSTALLER_EXIT_FAILURE, 1, 2, 8, 99, -1]) {
      assert.equal(classifyInstallerExitCode(code), 'failure', `код ${code} — сбой`);
    }
    assert.equal(classifyInstallerExitCode(null), 'failure', 'завершение сигналом — сбой');
  });

  for (const code of [INSTALLER_EXIT_SUCCESS, INSTALLER_EXIT_FAILURE, INSTALLER_EXIT_PRECONDITION]) {
    it(`код ${code} возвращается заданию ровно как есть`, async () => {
      const runner = makeRunner({
        spawnImpl: () => {
          const process = makeFakeProcess();
          queueMicrotask(() => process.close(code));
          return process;
        },
      });
      const result = await runner.run(makeTarget());
      assert.equal(result.code, code);
    });
  }

  it('завершение сигналом — code null, классификация «сбой»', async () => {
    const runner = makeRunner({
      spawnImpl: () => {
        const process = makeFakeProcess();
        queueMicrotask(() => process.close(null, 'SIGTERM'));
        return process;
      },
    });
    const result = await runner.run(makeTarget());
    assert.equal(result.code, null);
    assert.equal(classifyInstallerExitCode(result.code), 'failure');
  });

  it('ошибка запуска процесса — InstallerLaunchError', async () => {
    const runner = makeRunner({
      spawnImpl: () => {
        const process = makeFakeProcess();
        queueMicrotask(() => process.fail(new Error('spawn ENOENT')));
        return process;
      },
    });
    await assert.rejects(runner.run(makeTarget()), InstallerLaunchError);
  });
});

describe('журнал установщика', () => {
  it('возвращает свежий install-*.log, а не старый и не посторонний файл', async () => {
    const logDir = makeTempRoot('etn-runner-log-');
    const oldLog = path.join(logDir, 'install-20260101-000000.log');
    writeFileSync(oldLog, 'old');
    const oldTime = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(oldLog, oldTime, oldTime);
    writeFileSync(path.join(logDir, 'setup.log'), 'чужое имя');
    const freshLog = path.join(logDir, 'install-20261029-120000.log');

    const runner = makeRunner({
      logDirs: [logDir],
      spawnImpl: () => {
        writeFileSync(freshLog, 'ETN setup log\n');
        const process = makeFakeProcess();
        queueMicrotask(() => process.close(INSTALLER_EXIT_FAILURE));
        return process;
      },
    });

    const result = await runner.run(makeTarget());
    assert.equal(result.code, INSTALLER_EXIT_FAILURE);
    assert.equal(result.logPath, freshLog);
  });

  it('нет подходящего журнала — logPath null', async () => {
    const runner = makeRunner({
      logDirs: [path.join(makeTempRoot('etn-runner-log-'), 'missing')],
    });
    const result = await runner.run(makeTarget());
    assert.equal(result.logPath, null);
  });

  it('findInstallerLogPath перебирает каталоги и берёт самый свежий файл', async () => {
    const first = makeTempRoot('etn-runner-log-');
    const second = makeTempRoot('etn-runner-log-');
    const older = path.join(first, 'install-20260101-000000.log');
    const newer = path.join(second, 'install-20261029-120001.log');
    writeFileSync(older, 'a');
    writeFileSync(newer, 'b');
    const now = Date.now();
    utimesSync(older, new Date(now - 1_000), new Date(now - 1_000));
    utimesSync(newer, new Date(now), new Date(now));

    const found = await findInstallerLogPath(
      [path.join(first, 'missing'), first, second],
      now - INSTALLER_LOG_MTIME_SLACK_MS,
    );
    assert.equal(found, newer);
  });

  it('каталоги журнала по умолчанию включают временный каталог', () => {
    assert.ok(defaultInstallerLogDirs().includes(os.tmpdir()));
  });
});

describe('тайм-аут ожидания установщика', () => {
  it('по тайм-ауту — ошибка с путём журнала, процесс не убит', async () => {
    const logDir = makeTempRoot('etn-runner-log-');
    const logPath = path.join(logDir, 'install-20261029-120000.log');
    let installerPath = '';
    let process: FakeProcess | null = null;
    const runner = makeRunner({
      logDirs: [logDir],
      runTimeoutMs: 60,
      spawnImpl: (pathToInstaller) => {
        installerPath = pathToInstaller;
        writeFileSync(logPath, 'ETN setup log\n');
        process = makeFakeProcess();
        return process;
      },
    });

    await assert.rejects(
      runner.run(makeTarget()),
      (err: unknown) => {
        assert.ok(err instanceof InstallerTimeoutError);
        assert.equal(err.timeoutMs, 60);
        assert.equal(err.installerPath, installerPath);
        assert.equal(err.logPath, logPath);
        assert.match(err.message, /оставлен работать/);
        assert.match(err.message, /install-20261029-120000\.log/);
        return true;
      },
    );
    assert.ok(process !== null);
    assert.equal((process as FakeProcess).closed, false, 'процесс не убит');
    assert.equal(runner.isRunning(), false, 'флаг занятости снят после тайм-аута');

    // Позднее завершение не должно ничего сломать: промис уже отклонён.
    (process as FakeProcess).close(INSTALLER_EXIT_SUCCESS);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('журнала нет — ошибка тайм-аута сообщает об этом', async () => {
    const runner = makeRunner({
      logDirs: [path.join(makeTempRoot('etn-runner-log-'), 'missing')],
      runTimeoutMs: 40,
      spawnImpl: () => makeFakeProcess(),
    });
    await assert.rejects(
      runner.run(makeTarget()),
      (err: unknown) => {
        assert.ok(err instanceof InstallerTimeoutError);
        assert.equal(err.logPath, null);
        assert.match(err.message, /журнал установщика не найден/);
        return true;
      },
    );
  });
});

describe('параллельные вызовы', () => {
  it('второй вызов во время первого отклоняется и не создаёт второй процесс', async () => {
    const downloadRoot = makeTempRoot('etn-runner-dl-');
    let spawnCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = makeRunner({
      downloadRoot,
      spawnImpl: () => {
        spawnCalls += 1;
        const process = makeFakeProcess();
        void gate.then(() => process.close(INSTALLER_EXIT_SUCCESS));
        return process;
      },
    });

    const first = runner.run(makeTarget());
    await waitFor(() => spawnCalls === 1);
    assert.equal(runner.isRunning(), true);

    await assert.rejects(runner.run(makeTarget()), InstallerRunInProgressError);
    assert.equal(spawnCalls, 1, 'второй процесс не создан');

    release();
    const result = await first;
    assert.equal(result.code, INSTALLER_EXIT_SUCCESS);
    assert.equal(runner.isRunning(), false);
  });
});

describe('константы контракта', () => {
  it('тайм-аут 15 минут, флаги и журнал совпадают с контрактом установщика', () => {
    assert.equal(INSTALLER_RUN_TIMEOUT_MS, 15 * 60 * 1000);
    assert.equal(INSTALLER_EXIT_SUCCESS, 0);
    assert.equal(INSTALLER_EXIT_FAILURE, 10);
    assert.equal(INSTALLER_EXIT_PRECONDITION, 20);
    assert.equal(INSTALLER_DOWNLOAD_TIMEOUT_MS, 10 * 60 * 1000);
    assert.match('install-20261029-120000.log', INSTALLER_LOG_PATTERN);
    assert.doesNotMatch('Setup Log 2026-10-29 #1.txt', INSTALLER_LOG_PATTERN);
  });
});

describe('процесс по умолчанию', () => {
  it('spawnInstallerProcess запускает реальный процесс и отдаёт его код', async () => {
    const handle = spawnInstallerProcess(process.execPath, ['-e', 'process.exit(20)']);
    const code = await new Promise<number | null>((resolve) => {
      handle.on('close', (exitCode) => resolve(exitCode));
    });
    assert.equal(code, 20);
  });

  it('spawnInstallerProcess сообщает ошибку запуска отсутствующего файла', async () => {
    const missing = path.join(makeTempRoot('etn-runner-missing-'), 'no-such-installer.exe');
    const handle = spawnInstallerProcess(missing, []);
    const error = await new Promise<Error>((resolve) => {
      handle.on('error', (err) => resolve(err));
    });
    assert.match(`${error.name} ${error.message}`, /ENOENT|not found/i);
  });
});

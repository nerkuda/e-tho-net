/**
 * Диалог обновления сервера — DOM-пробы (элемент c9c96e5c, задача ca26c59d).
 *
 * Покрыто:
 *  - вход только администратору: без роли диалога нет и сервер не опрашивается;
 *  - снимок кеша: версии, канал, дата проверки, ошибка проверки, deployment;
 *  - «Проверить»: `429` — состояние «проверка идёт», а не ошибка;
 *  - «Обновить сервер»: подтверждение с честными последствиями, apply →
 *    прогресс; обрыв/`409`/`503` трактуются как «обновление идёт» без ошибки;
 *  - показываются только подтверждённые сервером этапы; `installing`/
 *    `health-check` — общая строка без имён и процентов;
 *  - `502`: причина и путь к журналу, кнопки «Повторить» нет, apply не
 *    повторяется;
 *  - `backup_path: null` — путь архива не рисуется;
 *  - повторное открытие восстанавливает прогресс из `GET /progress`;
 *  - Docker-инструкция: строка + кнопка копирования (успех/ошибка), кнопки
 *    нет при `instruction: null`, текст инструкции не дублируется (c79afe43).
 *
 * Дом — общий DOM-шим (`dom-shim.ts`, конвенция `compatibility-dialog.test.ts`).
 * Скриншотов нет: доказательства — текст и состояние DOM.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { EtnError, type UpdateJob } from '@etn/shared';

import { ShimElement } from './dom-shim.js';

const windowListeners: Array<{ type: string; listener: (event: any) => void }> = [];

function installShim(): void {
  windowListeners.length = 0;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
    activeElement: null,
  };
  (globalThis as any).window = {
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: (type: string, listener: (event: any) => void) => {
      windowListeners.push({ type, listener });
    },
    removeEventListener: (type: string, listener: (event: any) => void) => {
      const index = windowListeners.findIndex((l) => l.type === type && l.listener === listener);
      if (index >= 0) windowListeners.splice(index, 1);
    },
  };
}

installShim();

const { openServerUpdateDialog, DEFAULT_POLL_INTERVAL_MS } = await import(
  '../src/renderer/lib/server-update-dialog.js'
);
const { closeDialog } = await import('../src/renderer/lib/dialog.js');
const { t } = await import('../src/renderer/lib/i18n.js');
import type {
  ServerUpdateDialogDeps,
} from '../src/renderer/lib/server-update-dialog.js';
import type { SystemUpdateStatus } from '../src/main/ipc/contract.js';

function body(): ShimElement {
  return (globalThis as any).document.body as ShimElement;
}

function backdrops(): ShimElement[] {
  return body().children.filter((c) => c.classList.contains('dialog-backdrop'));
}

function drainDialogs(): void {
  for (let i = 0; i < 20; i += 1) closeDialog();
}

function dialog(): ShimElement {
  const open = backdrops();
  assert.equal(open.length, 1, 'открыт ровно один диалог');
  return open[0]!;
}

function footerLabels(node: ShimElement): string[] {
  const footer = node.querySelector('.dialog-footer');
  if (footer === null) return [];
  return footer.querySelectorAll('button').map((b) => b.textContent);
}

function buttonByLabel(node: ShimElement, label: string): ShimElement {
  const button = node.querySelectorAll('button').find((b) => b.textContent === label);
  assert.ok(button !== undefined, `в диалоге есть кнопка «${label}»`);
  return button!;
}

function footerErrorText(node: ShimElement): string {
  const footer = node.querySelector('.dialog-footer');
  const line = footer?.querySelector('.dialog-footer-error');
  return line?.textContent ?? '';
}

async function tick(ms = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Снимок кеша: сервер-служба, есть версия новее. */
function status(overrides: Partial<SystemUpdateStatus> = {}): SystemUpdateStatus {
  return {
    current_version: '0.15.1',
    available_version: '0.15.2',
    channel: 'stable',
    checked_at: '2026-10-29T12:00:00.000Z',
    check_error: null,
    download_url: 'https://example.test/ETN-Setup-0.15.2.exe',
    sha256: 'a'.repeat(64),
    deployment: 'windows-service',
    instruction: null,
    ...overrides,
  };
}

function job(stage: UpdateJob['stage'], overrides: Partial<UpdateJob> = {}): UpdateJob {
  return {
    id: 'job-1',
    target_version: '0.15.2',
    stage,
    started_at: '2026-10-29T12:00:00.000Z',
    error: null,
    reason: null,
    failed_stage: null,
    exit_code: null,
    log_path: null,
    backup_path: null,
    ...overrides,
  };
}

/** Очередь ответов /progress: исчерпанная отдаёт последний снимок. */
function progressQueue(jobs: Array<UpdateJob | null>): () => Promise<{ job: UpdateJob | null }> {
  let index = 0;
  return async () => {
    const value = jobs[Math.min(index, jobs.length - 1)] ?? null;
    index += 1;
    return { job: value };
  };
}

/**
 * Зависимости сценария apply: до запуска задания `/progress` пуст (задание
 * создаётся сервером в момент вызова), после — отдаёт очередь этапов.
 */
function applyingScenario(
  jobs: Array<UpdateJob | null>,
  applyImpl: (targetVersion: string) => Promise<UpdateJob> = async () => job('preparing'),
): {
  apply(targetVersion: string): Promise<UpdateJob>;
  getProgress(): Promise<{ job: UpdateJob | null }>;
} {
  let started = false;
  let index = 0;
  return {
    apply: async (targetVersion) => {
      started = true;
      return applyImpl(targetVersion);
    },
    getProgress: async () => {
      if (!started) return { job: null };
      const value = jobs[Math.min(index, jobs.length - 1)] ?? null;
      index += 1;
      return { job: value };
    },
  };
}

/**
 * Ручной прогресс: тест сам выставляет текущее задание, поэтому проверка
 * этапов не зависит от гонки таймеров опроса.
 */
function manualProgress(): {
  getProgress(): Promise<{ job: UpdateJob | null }>;
  set(job: UpdateJob | null): void;
} {
  let current: UpdateJob | null = null;
  return {
    getProgress: async () => ({ job: current }),
    set(next) {
      current = next;
    },
  };
}

interface Harness {
  deps: ServerUpdateDialogDeps;
  calls: {
    status: number;
    checks: number;
    applies: string[];
    confirms: Array<{ title: string; message: string }>;
    copies: string[];
  };
  stop(): void;
}

/** Диалог поверх поддельных IPC-зависимостей. */
function mount(overrides: Partial<ServerUpdateDialogDeps> = {}): Harness {
  const calls = {
    status: 0,
    checks: 0,
    applies: [] as string[],
    confirms: [] as Array<{ title: string; message: string }>,
    copies: [] as string[],
  };
  const deps: ServerUpdateDialogDeps = {
    isAdmin: () => true,
    getStatus: async () => {
      calls.status += 1;
      return status();
    },
    check: async () => {
      calls.checks += 1;
      return status({ checked_at: '2026-10-29T12:05:00.000Z' });
    },
    apply: async () => job('preparing'),
    getProgress: async () => ({ job: null }),
    confirm: async (title, message) => {
      calls.confirms.push({ title, message });
      return true;
    },
    copyText: async (text) => {
      calls.copies.push(text);
    },
    pollIntervalMs: 5,
    ...overrides,
  };
  // Каждый запуск фиксируется в журнале вызовов — даже когда сценарий
  // подменяет apply своим (обрыв, 502, 409): так проверяется «ровно один раз».
  const applyImpl = deps.apply;
  deps.apply = async (targetVersion) => {
    calls.applies.push(targetVersion);
    return applyImpl(targetVersion);
  };
  openServerUpdateDialog(deps);
  return {
    deps,
    calls,
    stop() {
      drainDialogs();
    },
  };
}

afterEach(() => {
  drainDialogs();
});

describe('открытие диалога: только администратор (c9c96e5c)', () => {
  it('без роли администратора диалог не открывается и сервер не опрашивается', () => {
    const harness = mount({ isAdmin: () => false });
    try {
      assert.equal(backdrops().length, 0, 'диалога нет');
      assert.equal(harness.calls.status, 0, 'состояние обновлений не запрашивалось');
    } finally {
      harness.stop();
    }
  });

  it('администратору показывает версии, канал, дату проверки, режим и ошибку проверки', async () => {
    const harness = mount({
      getStatus: async () =>
        status({ check_error: 'фид недоступен', checked_at: '2026-10-29T12:00:00.000Z' }),
    });
    try {
      await tick();
      const text = dialog().flatText();
      assert.ok(text.includes(t('serverUpdate.current', '0.15.1')));
      assert.ok(text.includes(t('serverUpdate.available', '0.15.2')));
      assert.ok(text.includes(t('serverUpdate.channel', t('serverUpdate.channel.stable'))));
      assert.ok(text.includes(t('serverUpdate.deployment', t('serverUpdate.deployment.windowsService'))));
      assert.ok(text.includes(t('serverUpdate.checkError', 'фид недоступен')));
      assert.ok(!text.includes('Архив базы данных'), 'backup_path: null не рисуется как путь');
      assert.ok(footerLabels(dialog()).includes(t('serverUpdate.apply')));
    } finally {
      harness.stop();
    }
  });

  it('Docker: кнопки обновления нет, есть пояснение', async () => {
    const harness = mount({
      getStatus: async () => status({ deployment: 'docker', download_url: null, sha256: null }),
    });
    try {
      await tick();
      assert.equal(footerLabels(dialog()).includes(t('serverUpdate.apply')), false);
      assert.ok(dialog().flatText().includes(t('serverUpdate.dockerNote')));
    } finally {
      harness.stop();
    }
  });

  it('сбой чтения состояния: ошибка в футере, в теле нет «Чтение состояния…»', async () => {
    const harness = mount({
      getStatus: async () => {
        throw new Error('сервер недоступен');
      },
    });
    try {
      await tick();
      assert.ok(footerErrorText(dialog()).includes('сервер недоступен'));
      const text = dialog().flatText();
      assert.equal(text.includes(t('serverUpdate.loading')), false, 'тело не врёт про чтение');
      assert.equal(text.includes(t('serverUpdate.noUpdate')), false, 'и не заявляет «Обновлений нет»');
    } finally {
      harness.stop();
    }
  });
});

describe('проверка обновлений: 429 — состояние, а не ошибка', () => {
  it('успешная проверка обновляет дату проверки', async () => {
    const harness = mount();
    try {
      await tick();
      buttonByLabel(dialog(), t('serverUpdate.check')).click();
      await tick();
      assert.equal(harness.calls.checks, 1);
      assert.equal(footerErrorText(dialog()), '');
    } finally {
      harness.stop();
    }
  });

  it('429: показывает «проверка уже идёт» в теле и пустой футер', async () => {
    const harness = mount({
      check: async () => {
        throw new EtnError('RATE_LIMITED', 'Проверка обновлений уже идёт.');
      },
    });
    try {
      await tick();
      buttonByLabel(dialog(), t('serverUpdate.check')).click();
      await tick();
      const text = dialog().flatText();
      assert.ok(text.includes(t('serverUpdate.checkAlreadyRunning')));
      assert.equal(footerErrorText(dialog()), '', '429 не показывается ошибкой');
    } finally {
      harness.stop();
    }
  });

  it('прочий отказ проверки — строка ошибки в футере', async () => {
    const harness = mount({
      check: async () => {
        throw new Error('фид недоступен');
      },
    });
    try {
      await tick();
      buttonByLabel(dialog(), t('serverUpdate.check')).click();
      await tick();
      assert.ok(footerErrorText(dialog()).includes('фид недоступен'));
    } finally {
      harness.stop();
    }
  });
});

describe('запуск обновления и прогресс', () => {
  it('подтверждение честно описывает последствия; apply идёт с целевой версией', async () => {
    const harness = mount(applyingScenario([job('preparing'), job('done')]));
    try {
      await tick();
      buttonByLabel(dialog(), t('serverUpdate.apply')).click();
      await tick();
      assert.equal(harness.calls.confirms.length, 1);
      assert.ok(harness.calls.confirms[0]!.title.includes('0.15.2'));
      const message = harness.calls.confirms[0]!.message;
      assert.ok(message.includes('остановлен'), 'сказано про остановку сервера');
      assert.ok(message.includes('база данных скопирована'), 'сказано про бэкап БД');
      assert.ok(message.includes('503/1012'), 'сказано про 503/1012 у клиентов');
      assert.deepEqual(harness.calls.applies, ['0.15.2']);
    } finally {
      harness.stop();
    }
  });

  it('показывает только подтверждённые этапы; installing — общая строка без процентов', async () => {
    const progress = manualProgress();
    const harness = mount({
      apply: async () => job('preparing'),
      getProgress: progress.getProgress,
    });
    try {
      await tick();
      buttonByLabel(dialog(), t('serverUpdate.apply')).click();
      await tick(10);
      assert.ok(dialog().flatText().includes(t('serverUpdate.stage.preparing')));
      // Сервер записывает `installing` не может (служба остановлена): клиент
      // показывает общую строку без имени этапа и без процентов.
      progress.set(job('installing'));
      await tick(40);
      const installingText = dialog().flatText();
      assert.ok(installingText.includes(t('serverUpdate.stage.running')));
      assert.ok(!/installing|health-check|rolling-back/.test(installingText));
      assert.ok(!/%/.test(installingText), 'фиктивных процентов нет');
      progress.set(job('done'));
      await tick(40);
      assert.ok(dialog().flatText().includes(t('serverUpdate.stage.done')));
    } finally {
      harness.stop();
    }
  });

  it('после done кнопка «Обновить сервер» повторно не показывается', async () => {
    const progress = manualProgress();
    const harness = mount({
      apply: async () => job('preparing'),
      getProgress: progress.getProgress,
    });
    try {
      await tick();
      buttonByLabel(dialog(), t('serverUpdate.apply')).click();
      await tick(10);
      progress.set(job('done'));
      await tick(40);
      assert.ok(dialog().flatText().includes(t('serverUpdate.stage.done')));
      // Снимок кеша после done перечитывается и всё ещё предлагает 0.15.2;
      // повторная кнопка запуска не должна появляться.
      assert.equal(
        footerLabels(dialog()).includes(t('serverUpdate.apply')),
        false,
        'после завершённого задания повторное обновление не предлагается',
      );
    } finally {
      harness.stop();
    }
  });

  it('обрыв apply — «обновление идёт»: футер пуст, прогресс читается', async () => {
    const progress = manualProgress();
    const harness = mount({
      apply: async () => {
        throw new EtnError('INTERNAL', 'Сетевая ошибка', {
          kind: 'connect-failed',
          reason: 'timeout',
        });
      },
      getProgress: progress.getProgress,
    });
    try {
      await tick();
      buttonByLabel(dialog(), t('serverUpdate.apply')).click();
      await tick(10);
      progress.set(job('preparing'));
      await tick(40);
      assert.equal(footerErrorText(dialog()), '', 'обрыв не показывается ошибкой');
      assert.ok(dialog().flatText().includes(t('serverUpdate.stage.preparing')));
    } finally {
      harness.stop();
    }
  });

  it('409 с идущим заданием — показывает задание, не ошибку', async () => {
    const running = job('backing-up');
    const progress = manualProgress();
    const harness = mount({
      apply: async () => {
        throw new EtnError('VERSION_CONFLICT', 'Обновление уже идёт', {
          reason: 'job-active',
          job: running,
        });
      },
      getProgress: progress.getProgress,
    });
    try {
      await tick();
      buttonByLabel(dialog(), t('serverUpdate.apply')).click();
      await tick(20);
      progress.set(running);
      await tick(40);
      assert.equal(footerErrorText(dialog()), '');
      assert.ok(dialog().flatText().includes(t('serverUpdate.stage.backingUp')));
    } finally {
      harness.stop();
    }
  });

  it('503 обслуживания — «обновление идёт», не ошибка', async () => {
    const harness = mount(
      applyingScenario([job('preparing')], async () => {
        throw new EtnError('SERVER_UPDATING', 'Сервер обновляется');
      }),
    );
    try {
      await tick();
      buttonByLabel(dialog(), t('serverUpdate.apply')).click();
      await tick(10);
      assert.equal(footerErrorText(dialog()), '');
    } finally {
      harness.stop();
    }
  });

  it('502: причина и журнал, кнопки «Повторить» нет, apply не повторяется', async () => {
    const failed = job('failed', {
      reason: 'installer-hash',
      failed_stage: 'preparing',
      log_path: 'C:\\ProgramData\\ETN\\logs\\install-1.log',
      error:
        'SHA-256 mismatch detected; log: C:\\ProgramData\\ETN\\logs\\install-1.log',
    });
    const harness = mount(
      applyingScenario([failed], async () => {
        throw new EtnError('UPDATE_INSTALLER_FAILED', 'SHA-256 mismatch detected', {
          status: 502,
          stage: 'preparing',
          reason: 'installer-hash',
          retryable: false,
          job: failed,
        });
      }),
    );
    try {
      await tick();
      buttonByLabel(dialog(), t('serverUpdate.apply')).click();
      await tick(20);
      const node = dialog();
      const text = node.flatText();
      assert.ok(text.includes(t('serverUpdate.stage.failed')));
      // ADR daab6ac4 §4: причина — локализованный текст по коду и
      // `details.reason`, а не английский `job.error`.
      assert.ok(
        text.includes(t('errors.code.UPDATE_INSTALLER_FAILED.installer-hash')),
        'локализованная причина по коду и details.reason',
      );
      assert.ok(
        !text.includes('SHA-256 mismatch detected'),
        'сырой английский job.error пользователю не показан',
      );
      assert.ok(
        text.includes('C:\\ProgramData\\ETN\\logs\\install-1.log'),
        'путь к журналу установщика показан',
      );
      assert.ok(text.includes(t('serverUpdate.installerFailedNote')), 'сказано про журнал и текущую версию');
      assert.equal(
        footerLabels(node).includes(t('compatibility.action.retry')),
        false,
        'автоматического «Повторить» нет',
      );
      assert.equal(
        footerLabels(node).includes(t('serverUpdate.apply')),
        false,
        'повторный запуск после 502 не предлагается автоматически',
      );
      assert.ok(!text.includes('сервер недоступен'), 'ложного «сервер недоступен» нет');
      assert.deepEqual(harness.calls.applies, ['0.15.2'], 'apply вызван один раз');
      assert.equal(footerErrorText(node), '', '502 показан исходом задания, а не ошибкой операции');
    } finally {
      harness.stop();
    }
  });

  it('отказ до задания (409 docker) — строка ошибки в футере, без задания', async () => {
    const harness = mount({
      apply: async () => {
        throw new EtnError('VERSION_CONFLICT', 'Сервер развёрнут в Docker', {
          reason: 'docker',
        });
      },
    });
    try {
      await tick();
      buttonByLabel(dialog(), t('serverUpdate.apply')).click();
      await tick(10);
      const footer = footerErrorText(dialog());
      // Текст — из словаря по `details.reason`, серверный message не показан.
      assert.ok(footer.includes('автообновление в контейнере Docker невозможно'), footer);
      assert.ok(!footer.includes('Сервер развёрнут в Docker'), 'серверный текст не ушёл в UI');
      assert.deepEqual(harness.calls.applies, ['0.15.2']);
    } finally {
      harness.stop();
    }
  });
});

describe('Docker-инструкция: показ и копирование (c79afe43)', () => {
  /** Образец текста сервера (полная редакция — `DOCKER_UPDATE_INSTRUCTION`). */
  const DOCKER_COMMAND = 'docker compose pull && docker compose up -d';
  const DOCKER_INSTRUCTION =
    `Обновление выполняется на хосте с compose-файлом: ${DOCKER_COMMAND}. ` +
    'Данные лежат в томе `etn_data`, внутри — `/data` (он же `ETN_DATA_DIR`).';

  function dockerStatus(instruction: string | null = DOCKER_INSTRUCTION): SystemUpdateStatus {
    return status({
      deployment: 'docker',
      download_url: null,
      sha256: null,
      instruction,
    });
  }

  /** Кнопка копирования инструкции — по подписи словаря. */
  function copyInstructionButton(node: ShimElement): ShimElement | undefined {
    return node
      .querySelectorAll('button')
      .find((button) => button.textContent === t('serverUpdate.copyInstruction'));
  }

  /** Число вхождений подстроки в плоский текст диалога. */
  function countOccurrences(text: string, needle: string): number {
    return text.split(needle).length - 1;
  }

  it('Docker: инструкция показана с кнопкой; нажатие копирует текст сервера', async () => {
    const harness = mount({ getStatus: async () => dockerStatus() });
    try {
      await tick();
      const node = dialog();
      assert.ok(
        node.flatText().includes(t('serverUpdate.instruction', DOCKER_INSTRUCTION)),
        'строка инструкции в теле диалога',
      );
      const button = copyInstructionButton(node);
      assert.ok(button !== undefined, 'рядом с инструкцией есть кнопка копирования');
      button!.click();
      await tick();
      assert.deepEqual(harness.calls.copies, [DOCKER_INSTRUCTION], 'в буфер ушёл весь текст инструкции');
      assert.ok(
        node.flatText().includes(t('serverUpdate.instructionCopied')),
        'подтверждение копирования показано',
      );
      assert.equal(footerErrorText(node), '', 'успешное копирование — не ошибка действия');
    } finally {
      harness.stop();
    }
  });

  it('ошибка копирования — сообщение рядом с кнопкой, инструкция остаётся', async () => {
    const harness = mount({
      getStatus: async () => dockerStatus(),
      copyText: async () => {
        throw new Error('буфер недоступен');
      },
    });
    try {
      await tick();
      const node = dialog();
      copyInstructionButton(node)!.click();
      await tick();
      assert.ok(
        node.flatText().includes(t('serverUpdate.instructionCopyFailed')),
        'сказано, что скопировать не удалось',
      );
      assert.ok(
        node.flatText().includes(t('serverUpdate.instruction', DOCKER_INSTRUCTION)),
        'инструкция не пропала при ошибке копирования',
      );
      assert.equal(footerErrorText(node), '', 'ошибка копирования — не ошибка операции');
    } finally {
      harness.stop();
    }
  });

  it('instruction: null — кнопки копирования в диалоге нет', async () => {
    const harness = mount({
      getStatus: async () => status({ deployment: 'windows-service', instruction: null }),
    });
    try {
      await tick();
      const node = dialog();
      assert.equal(copyInstructionButton(node), undefined, 'копировать нечего — кнопки нет');
      assert.equal(
        node.flatText().includes(t('serverUpdate.instruction', '')),
        false,
        'пустой строки инструкции тоже нет',
      );
    } finally {
      harness.stop();
    }
  });

  it('пустой instruction — то же, что отсутствие: кнопки нет', async () => {
    const harness = mount({ getStatus: async () => status({ instruction: '   ' }) });
    try {
      await tick();
      assert.equal(copyInstructionButton(dialog()), undefined, 'пробельная инструкция — не команда');
    } finally {
      harness.stop();
    }
  });

  it('текст инструкции не дублируется: команда встречается в диалоге один раз', async () => {
    const harness = mount({ getStatus: async () => dockerStatus() });
    try {
      await tick();
      const text = dialog().flatText();
      assert.equal(
        countOccurrences(text, DOCKER_COMMAND),
        1,
        'команда показана ровно один раз (кнопка не повторяет текст)',
      );
      assert.equal(
        countOccurrences(text, DOCKER_INSTRUCTION),
        1,
        'строка инструкции одна',
      );
    } finally {
      harness.stop();
    }
  });
});

describe('восстановление прогресса при повторном открытии', () => {
  it('открытие читает /progress и показывает идущее задание', async () => {
    const harness = mount({ getProgress: progressQueue([job('backing-up'), job('done')]) });
    try {
      await tick();
      assert.ok(dialog().flatText().includes(t('serverUpdate.stage.backingUp')));
    } finally {
      harness.stop();
    }
  });

  it('после перезапуска задание failed с причиной восстанавливается из /progress', async () => {
    // Реальный английский текст сервера (`interruptedJobMessage`) пользователю
    // не показывается: причина локализуется по `reason`, этап — из
    // `failed_stage` (ADR daab6ac4 §4).
    const failed = job('failed', {
      reason: 'interrupted',
      failed_stage: 'installing',
      error:
        'The server restarted before the update job completed (stage "installing"); ' +
        'the job is not resumed automatically.',
    });
    const harness = mount({ getProgress: async () => ({ job: failed }) });
    try {
      await tick();
      const text = dialog().flatText();
      assert.ok(text.includes(t('serverUpdate.stage.failed')));
      assert.ok(
        text.includes('перезапустился до завершения задания обновления'),
        'локализованная причина по reason',
      );
      assert.ok(text.includes('«installing»'), 'этап из failed_stage');
      assert.ok(!text.includes('The server restarted'), 'английский job.error не показан');
    } finally {
      harness.stop();
    }
  });

  it('штатный сбой установщика из /progress: причина по reason, журнал из log_path', async () => {
    // `/progress` — штатный канал сбоя установщика (код выхода/предусловие/
    // тайм-аут): кода ошибки в конверте нет, причина обязана быть в задании.
    const failed = job('failed', {
      reason: 'installer-exit',
      failed_stage: 'backing-up',
      exit_code: 10,
      log_path: 'C:\\ProgramData\\ETN\\logs\\install-from-field.log',
      error:
        'The installer exited with code 10; the rollback was performed by the installer, ' +
        'log: C:\\ProgramData\\ETN\\logs\\install-from-field.log',
    });
    const harness = mount({ getProgress: async () => ({ job: failed }) });
    try {
      await tick();
      const text = dialog().flatText();
      assert.ok(text.includes('установщик завершился с кодом 10'), 'код из exit_code');
      assert.ok(!text.includes('The installer exited'), 'английский job.error не показан');
      assert.ok(
        text.includes('C:\\ProgramData\\ETN\\logs\\install-from-field.log'),
        'путь из машиночитаемого log_path',
      );
    } finally {
      harness.stop();
    }
  });

  it('задание без reason (сервер 0.15.1): общий текст и журнал, английский error не показан', async () => {
    // Старое задание не несёт поля `reason` вовсе: показывается общий
    // локализованный текст, путь к журналу — из старого серверного текста.
    const failed = job('failed', {
      error:
        'The installer exited with code 10; the rollback was performed by the installer, ' +
        'log: C:\\ProgramData\\ETN\\logs\\install-old.log',
    });
    delete (failed as { reason?: unknown }).reason;
    const harness = mount({ getProgress: async () => ({ job: failed }) });
    try {
      await tick();
      const text = dialog().flatText();
      assert.ok(
        text.includes(t('serverUpdate.failure.noReason')),
        'без reason — общий локализованный текст',
      );
      assert.ok(!text.includes('The installer exited'), 'английский job.error не показан');
      assert.ok(
        text.includes('C:\\ProgramData\\ETN\\logs\\install-old.log'),
        'путь к журналу извлечён из старого текста',
      );
    } finally {
      harness.stop();
    }
  });
});

describe('интервал опроса прогресса', () => {
  it('по умолчанию — разумный интервал без спама (не чаще раза в секунду)', () => {
    assert.ok(DEFAULT_POLL_INTERVAL_MS >= 1_000);
    assert.ok(DEFAULT_POLL_INTERVAL_MS <= 10_000);
  });
});

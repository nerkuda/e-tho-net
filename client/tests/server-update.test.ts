/**
 * Диалог обновления сервера — чистая модель и разбор отказов (элемент
 * c9c96e5c, задача ca26c59d, тех.проект 2d9f5cc7).
 *
 * Покрыто:
 *  - подтверждённые сервером этапы (`preparing`, `backing-up`) против
 *    этапов, которые сервер записать не может (`installing`, `health-check`,
 *    `rolling-back`): для них нет подписи и нет выдуманных процентов;
 *  - снимок кеша: версии, канал, дата проверки, ошибка проверки, deployment,
 *    instruction; кнопка обновления в Docker недоступна;
 *  - `backup_path: null` — путь не подставляется; появившийся путь берётся;
 *  - путь к журналу установщика из серверного текста (с пробелами в пути);
 *  - разбор отказа apply: обрыв/409 job-active/503 → «обновление идёт»;
 *    409 docker/downgrade/version-mismatch и 422 → настоящий отказ;
 *    502 → отказ установщика с `retryable: false` (автоповтор запрещён).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EtnError, type UpdateJob } from '@etn/shared';

import type { SystemUpdateStatus } from '../src/main/ipc/contract.js';
import {
  CONFIRMED_UPDATE_STAGES,
  classifyApplyFailure,
  extractJournalPath,
  serverUpdateViewModel,
  updateChannelLabel,
  updateDeploymentLabel,
  updateStageLabel,
  type ServerUpdateState,
} from '../src/renderer/lib/server-update.js';
import { setLang, t } from '../src/renderer/lib/i18n.js';

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

/** Задание обновления. */
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

/** Состояние диалога с одним снимком и заданием. */
function state(overrides: Partial<ServerUpdateState> = {}): ServerUpdateState {
  return {
    status: status(),
    job: null,
    phase: 'idle',
    checking: false,
    checkNote: null,
    disconnected: false,
    installerFailed: false,
    ...overrides,
  };
}

describe('server-update: этапы задания (1f39811c)', () => {
  it('подпись есть только у этапов, которые сервер действительно записывает', () => {
    assert.equal(updateStageLabel('preparing'), 'serverUpdate.stage.preparing');
    assert.equal(updateStageLabel('backing-up'), 'serverUpdate.stage.backingUp');
    assert.equal(updateStageLabel('done'), 'serverUpdate.stage.done');
    assert.equal(updateStageLabel('failed'), 'serverUpdate.stage.failed');
    for (const stage of ['stopping', 'installing', 'starting', 'health-check', 'rolling-back'] as const) {
      assert.equal(updateStageLabel(stage), null, `этап ${stage} клиент не называет`);
    }
  });

  it('подтверждённые этапы — ровно четыре (защита от появления installing в списке)', () => {
    assert.deepEqual([...CONFIRMED_UPDATE_STAGES], ['preparing', 'backing-up', 'done', 'failed']);
  });

  it('running-задание с неподтверждённым этапом показывает общую строку без имени этапа', () => {
    const view = serverUpdateViewModel(state({ job: job('installing'), phase: 'applying' }));
    assert.equal(view.stageConfirmed, false);
    assert.equal(view.stageText, t('serverUpdate.stage.running'));
    assert.equal(view.running, true);
    // Ни имени, ни процентов: строка одна и не называет installing.
    assert.ok(!view.stageText?.includes('installing'));
    assert.ok(!/%/.test(view.stageText ?? ''));
  });

  it('preparing и backing-up названы и подтверждены', () => {
    const preparing = serverUpdateViewModel(state({ job: job('preparing'), phase: 'applying' }));
    assert.equal(preparing.stageConfirmed, true);
    assert.equal(preparing.stageText, t('serverUpdate.stage.preparing'));
    const backing = serverUpdateViewModel(state({ job: job('backing-up'), phase: 'applying' }));
    assert.equal(backing.stageConfirmed, true);
    assert.equal(backing.stageText, t('serverUpdate.stage.backingUp'));
  });
});

describe('server-update: снимок кеша и доступность обновления', () => {
  it('версии, канал, дата проверки, режим и инструкция — из ответа сервера', () => {
    const view = serverUpdateViewModel(state());
    assert.equal(view.currentVersion, '0.15.1');
    assert.equal(view.availableVersion, '0.15.2');
    assert.equal(view.hasUpdate, true);
    assert.equal(view.channelText, t('serverUpdate.channel.stable'));
    assert.notEqual(view.checkedAtText, null);
    assert.equal(view.deploymentText, t('serverUpdate.deployment.windowsService'));
    assert.equal(view.canApply, true);
  });

  it('Docker: кнопки обновления нет, есть пояснение; инструкция показывается, когда придёт', () => {
    const view = serverUpdateViewModel(
      state({
        status: status({ deployment: 'docker', download_url: null, sha256: null }),
      }),
    );
    assert.equal(view.canApply, false);
    assert.equal(view.unavailableNote, t('serverUpdate.dockerNote'));
    const withInstruction = serverUpdateViewModel(
      state({
        status: status({
          deployment: 'docker',
          download_url: null,
          sha256: null,
          instruction: 'docker compose pull && docker compose up -d',
        }),
      }),
    );
    assert.equal(withInstruction.instruction, 'docker compose pull && docker compose up -d');
  });

  it('обновлений нет — кнопки обновления нет', () => {
    const view = serverUpdateViewModel(
      state({ status: status({ available_version: null, download_url: null, sha256: null }) }),
    );
    assert.equal(view.hasUpdate, false);
    assert.equal(view.canApply, false);
  });

  it('ошибка проверки показывается, но не отменяет последнюю удачную версию', () => {
    const view = serverUpdateViewModel(
      state({ status: status({ check_error: 'фид недоступен' }) }),
    );
    assert.equal(view.checkError, 'фид недоступен');
    assert.equal(view.availableVersion, '0.15.2');
  });

  it('подписи канала и режима — закрытый словарь', () => {
    assert.equal(updateChannelLabel('stable'), 'serverUpdate.channel.stable');
    assert.equal(updateChannelLabel('prerelease'), 'serverUpdate.channel.prerelease');
    assert.equal(updateDeploymentLabel('windows-service'), 'serverUpdate.deployment.windowsService');
    assert.equal(updateDeploymentLabel('standalone'), 'serverUpdate.deployment.standalone');
    assert.equal(updateDeploymentLabel('docker'), 'serverUpdate.deployment.docker');
  });
});

describe('server-update: итог задания и пути', () => {
  it('клиент 0.15.2 + задание без reason: общий текст, английский error не показан', () => {
    const serverText =
      'The installer exited with code 10; the rollback was performed by the installer, ' +
      'log: C:\\ProgramData\\ETN\\logs\\install-20261029.log';
    // Сервер 0.15.1 поля `reason` не присылает вовсе (в JSON его нет) —
    // проверяем и `null`, и отсутствующее поле.
    for (const reason of [null, undefined] as const) {
      const failed = job('failed', { error: serverText });
      if (reason === undefined) delete (failed as { reason?: unknown }).reason;
      const view = serverUpdateViewModel(state({ job: failed, phase: 'failed' }));
      assert.equal(view.failed, true);
      assert.equal(
        view.failureText,
        t('serverUpdate.failure.noReason'),
        'без reason — общий локализованный текст',
      );
      assert.ok(
        !view.failureText?.includes('The installer exited'),
        'английский job.error пользователю не показан',
      );
      assert.equal(
        view.journalPath,
        'C:\\ProgramData\\ETN\\logs\\install-20261029.log',
        'путь к журналу извлекается из старого текста как фолбэк',
      );
      assert.equal(view.backupPath, null, 'выдуманный путь архива не появляется');
    }
  });

  it('задание без reason: машиночитаемый log_path приоритетнее разбора текста', () => {
    const failed = job('failed', {
      log_path: 'C:\\logs\\from-field.log',
      error: 'The update failed; log: C:\\logs\\from-error.log',
    });
    delete (failed as { reason?: unknown }).reason;
    const view = serverUpdateViewModel(state({ job: failed, phase: 'failed' }));
    assert.equal(view.failureText, t('serverUpdate.failure.noReason'));
    assert.equal(view.journalPath, 'C:\\logs\\from-field.log');
  });

  it('failed с reason: причина локализована, английский error не показывается', () => {
    const serverText =
      'The installer exited with code 10; the rollback was performed by the installer, ' +
      'log: C:\\logs\\install-1.log';
    const cases: Array<[UpdateJob['reason'], string]> = [
      ['installer-target', 'сервер не принял целевую версию'],
      ['installer-download', 'не удалось скачать установщик обновления'],
      ['installer-hash', 'скачанный установщик не прошёл проверку контрольной суммы'],
      ['installer-launch', 'установщик обновления не запустился'],
      ['installer-precondition', 'ручной режим'],
      ['installer-timeout', 'не завершился за отведённое время'],
      ['not-a-service', 'не как служба Windows'],
      ['internal', 'внутренней ошибкой'],
    ];
    for (const [reason, fragment] of cases) {
      const view = serverUpdateViewModel(
        state({ job: job('failed', { error: serverText, reason }), phase: 'failed' }),
      );
      assert.ok(
        view.failureText?.includes(fragment),
        `${String(reason)}: ожидалась формулировка «${fragment}», получено «${view.failureText}»`,
      );
      assert.ok(
        !view.failureText?.includes('The installer exited'),
        `${String(reason)}: английский job.error пользователю не показан`,
      );
    }
  });

  it('installer-exit: код возврата из exit_code, log_path приоритетнее разбора текста', () => {
    const view = serverUpdateViewModel(
      state({
        job: job('failed', {
          reason: 'installer-exit',
          exit_code: 10,
          log_path: 'C:\\logs\\from-field.log',
          error: 'The installer exited with code 99; log: C:\\logs\\from-error.log',
        }),
        phase: 'failed',
      }),
    );
    assert.match(view.failureText ?? '', /кодом 10/, 'код — из машиночитаемого exit_code');
    assert.ok(!view.failureText?.includes('99'), 'код из текста не разбирается');
    assert.equal(view.journalPath, 'C:\\logs\\from-field.log', 'log_path приоритетнее разбора');
  });

  it('installer-exit без кода — аварийное завершение без выдуманного кода', () => {
    const view = serverUpdateViewModel(
      state({ job: job('failed', { reason: 'installer-exit', exit_code: null }), phase: 'failed' }),
    );
    assert.equal(view.failureText, t('serverUpdate.failure.installerExitNoCode'));
  });

  it('interrupted: этап из failed_stage, английский текст не показан', () => {
    const view = serverUpdateViewModel(
      state({
        job: job('failed', {
          reason: 'interrupted',
          failed_stage: 'installing',
          error:
            'The server restarted before the update job completed (stage "installing"); ' +
            'the job is not resumed automatically.',
        }),
        phase: 'failed',
      }),
    );
    assert.ok(view.failureText?.includes('«installing»'), view.failureText ?? '');
    assert.ok(!view.failureText?.includes('The server restarted'), 'английский текст не показан');
  });

  it('interrupted без этапа — текст без подстановки', () => {
    const view = serverUpdateViewModel(
      state({ job: job('failed', { reason: 'interrupted', failed_stage: null }), phase: 'failed' }),
    );
    assert.equal(view.failureText, t('serverUpdate.failure.interruptedNoStage'));
  });

  it('неизвестная причина от более свежего сервера — общий текст, не английский error', () => {
    const view = serverUpdateViewModel(
      state({
        job: job('failed', {
          error: 'A new failure the client does not know',
          reason: 'future-reason' as unknown as UpdateJob['reason'],
        }),
        phase: 'failed',
      }),
    );
    assert.equal(view.failureText, t('serverUpdate.failure.unknown'));
    assert.ok(!view.failureText?.includes('A new failure'));
  });

  it('английская форма причины — из en-каталога', () => {
    assert.equal(setLang('en'), true);
    try {
      const view = serverUpdateViewModel(
        state({ job: job('failed', { reason: 'installer-hash' }), phase: 'failed' }),
      );
      assert.equal(
        view.failureText,
        'the downloaded installer failed the checksum verification',
        'английская форма закреплена',
      );
    } finally {
      setLang('ru');
    }
  });

  it('backup_path, если сервер его прислал, показывается как есть', () => {
    const backupPath = 'C:\\ProgramData\\ETN\\backups\\etn-0.15.1.db';
    const view = serverUpdateViewModel(
      state({ job: job('failed', { backup_path: backupPath }) }),
    );
    assert.equal(view.backupPath, backupPath);
  });

  it('путь в журнале — английский маркер `log:`, русский остаётся совместимостью', () => {
    assert.equal(
      extractJournalPath(
        'The installer precondition failed — manual mode is required, ' +
          'log: C:\\Program Files\\ETN\\logs\\install-1.log',
      ),
      'C:\\Program Files\\ETN\\logs\\install-1.log',
      'путь с пробелами после английского маркера',
    );
    assert.equal(
      extractJournalPath('сбой, журнал: C:\\Program Files\\ETN\\logs\\install-1.log'),
      'C:\\Program Files\\ETN\\logs\\install-1.log',
      'русская форма — совместимость с заданиями до перевода',
    );
    assert.equal(
      extractJournalPath('log: C:\\logs\\new.log; журнал: C:\\logs\\legacy.log'),
      'C:\\logs\\new.log',
      'приоритет английской формы',
    );
    assert.equal(extractJournalPath('installer log not found'), null);
    assert.equal(extractJournalPath('журнал установщика не найден'), null);
    assert.equal(extractJournalPath(null), null);
  });

  it('done: итог успеха и отсутствие причины сбоя', () => {
    const view = serverUpdateViewModel(state({ job: job('done'), phase: 'done' }));
    assert.equal(view.done, true);
    assert.equal(view.failed, false);
    assert.equal(view.failureText, null);
    assert.equal(view.journalPath, null);
  });
});

describe('server-update: разбор отказа apply', () => {
  it('VERSION_CONFLICT job-active — «обновление идёт», задание из details', () => {
    const failure = classifyApplyFailure(
      new EtnError('VERSION_CONFLICT', 'Обновление уже идёт', {
        reason: 'job-active',
        job: job('preparing'),
      }),
    );
    assert.equal(failure.kind, 'in-progress');
    assert.equal(failure.text, null);
    assert.equal(failure.job?.id, 'job-1');
  });

  it('VERSION_CONFLICT docker/downgrade/version-mismatch — настоящий отказ с локализованным текстом', () => {
    const expected: Record<string, string> = {
      docker:
        'автообновление в контейнере Docker невозможно — обновите образ по инструкции сервера',
      downgrade: 'целевая версия не новее текущей — откат версии запрещён',
      'version-mismatch': 'доступная версия изменилась — проверьте обновления ещё раз',
    };
    for (const reason of ['docker', 'downgrade', 'version-mismatch'] as const) {
      const failure = classifyApplyFailure(
        new EtnError('VERSION_CONFLICT', `server rejected the update: ${reason}`, { reason }),
      );
      assert.equal(failure.kind, 'rejected', `reason ${reason} — отказ`);
      assert.equal(failure.text, expected[reason]);
      // ADR daab6ac4 §4: английский серверный message пользователю не уходит.
      assert.ok(!failure.text?.includes('server rejected'), 'серверный текст не показан');
    }
  });

  it('503 SERVER_UPDATING и обрыв (connect-failed) — «обновление идёт»', () => {
    assert.equal(
      classifyApplyFailure(new EtnError('SERVER_UPDATING', 'Сервер обновляется')).kind,
      'in-progress',
    );
    assert.equal(
      classifyApplyFailure(
        new EtnError('INTERNAL', 'Сетевая ошибка', { kind: 'connect-failed', reason: 'timeout' }),
      ).kind,
      'in-progress',
    );
  });

  it('502 UPDATE_INSTALLER_FAILED — отказ установщика, retryable: false', () => {
    const failure = classifyApplyFailure(
      new EtnError('UPDATE_INSTALLER_FAILED', 'SHA-256 mismatch detected', {
        status: 502,
        stage: 'preparing',
        reason: 'installer-hash',
        retryable: false,
        job: job('failed', { error: 'SHA-256 mismatch detected' }),
      }),
    );
    assert.equal(failure.kind, 'installer-failed');
    // Текст — по `details.reason`, а не английский серверный message (ADR §4).
    assert.equal(failure.text, 'скачанный установщик не прошёл проверку контрольной суммы');
    assert.equal(failure.retryable, false);
    assert.equal(failure.job?.stage, 'failed');
  });

  it('422/прочие ошибки — настоящий отказ', () => {
    assert.equal(
      classifyApplyFailure(new EtnError('VALIDATION_ERROR', 'Нет доступной версии')).kind,
      'rejected',
    );
    assert.equal(classifyApplyFailure(new Error('boom')).kind, 'rejected');
  });
});

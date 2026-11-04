/**
 * Диалог обновления сервера — чистая модель и разбор отказов (элемент
 * интерфейса c9c96e5c, задача ca26c59d, тех.проект 2d9f5cc7).
 *
 * Модуль без DOM: по снимку кеша проверки (`SystemUpdateStatus`) и
 * последнему заданию (`UpdateJob`) собирает готовые строки и флаги диалога, а
 * отказ `POST /system/update/apply` раскладывает на три исхода:
 *
 *  - `in-progress` — «обновление идёт». Так трактуются обрыв/тайм-аут (ответ
 *    apply идёт до конца скачивания установщика, до 10 минут), `409`
 *    `VERSION_CONFLICT` с `reason: job-active|installer-alive` и `503`
 *    `SERVER_UPDATING`. Это НЕ ошибка: фактическое состояние читается из
 *    `GET /system/update/progress` (DoD задачи);
 *  - `installer-failed` — `502 UPDATE_INSTALLER_FAILED` (`retryable: false`):
 *    установщик не скачался/не сошёлся по хешу/не запустился, сервер живёт на
 *    текущей версии. Диалог показывает причину и не предлагает «Повторить»
 *    автоматически;
 *  - `rejected` — настоящий отказ (`422` без версии, `409` docker/downgrade/
 *    version-mismatch, прочие ошибки): строка ошибки в футере.
 *
 * **Этапы задания.** Сервер успевает записать только `preparing` и
 * `backing-up`: `installing`/`health-check`/`rolling-back` пишет установщик,
 * который к этому моменту уже остановил службу. Поэтому подписи этапов берутся
 * только для подтверждённых значений; любой другой нетерминальный этап
 * показывается общей строкой «обновление выполняется» без выдуманного имени и
 * процентов (требование задания).
 *
 * `backup_path` сервер пока всегда отдаёт `null` (архив создаёт установщик) —
 * модель не подставляет путь; если поле появится, оно показывается как есть.
 */

import {
  EtnError,
  isUpdateJobFailureReason,
  type UpdateJob,
  type UpdateJobStage,
} from '@etn/shared';

import type {
  ServerDeployment,
  SystemUpdateStatus,
  UpdateChannel,
} from '../../main/ipc/contract.js';
import { errText, fmtDateTime } from './dom.js';
import { t, type MessageKey } from './i18n.js';

/** Фаза диалога: ожидание, проверка, идущее задание, итог. */
export type ServerUpdatePhase = 'idle' | 'checking' | 'applying' | 'done' | 'failed';

/**
 * Этапы, которые сервер действительно записывает (сущность 1f39811c):
 * создание задания и момент перед запуском установщика. Остальные значения
 * типа существуют, но клиент их не показывает как этапы.
 */
export const CONFIRMED_UPDATE_STAGES: readonly UpdateJobStage[] = [
  'preparing',
  'backing-up',
  'done',
  'failed',
];

/** Подпись подтверждённого этапа; `null` — этап сервером не записан. */
export function updateStageLabel(stage: UpdateJobStage): MessageKey | null {
  switch (stage) {
    case 'preparing':
      return 'serverUpdate.stage.preparing';
    case 'backing-up':
      return 'serverUpdate.stage.backingUp';
    case 'done':
      return 'serverUpdate.stage.done';
    case 'failed':
      return 'serverUpdate.stage.failed';
    default:
      // stopping/installing/starting/health-check/rolling-back клиент не
      // выдумывает: подписи для них нет.
      return null;
  }
}

/** Терминальный этап — задание завершено. */
export function isTerminalJobStage(stage: UpdateJobStage): boolean {
  return stage === 'done' || stage === 'failed';
}

/** Подпись канала обновлений. */
export function updateChannelLabel(channel: UpdateChannel): MessageKey {
  return channel === 'prerelease'
    ? 'serverUpdate.channel.prerelease'
    : 'serverUpdate.channel.stable';
}

/** Подпись режима развёртывания сервера. */
export function updateDeploymentLabel(deployment: ServerDeployment): MessageKey {
  switch (deployment) {
    case 'windows-service':
      return 'serverUpdate.deployment.windowsService';
    case 'docker':
      return 'serverUpdate.deployment.docker';
    default:
      return 'serverUpdate.deployment.standalone';
  }
}

/**
 * Маркер журнала установщика в серверном тексте ошибки. Сервер дописывает
 * `log: <путь>` в конец причины (`describeFailureExit`, `InstallerTimeoutError`
 * и др., ADR daab6ac4 — английский); путь может содержать пробелы, поэтому
 * берётся хвост после маркера.
 */
const ENGLISH_JOURNAL_MARKER = /\blog:\s*([^;]+?)(?:\s*;|\s*$)/i;

/**
 * Русская форма маркера — совместимость с заданиями, сохранёнными до перевода
 * серверных текстов. Приоритет у английской формы.
 */
const RUSSIAN_JOURNAL_MARKER = /журнал(?:\s+установщика)?:\s*([^;]+?)(?:\s*;|\s*$)/i;

/** Путь к журналу установщика из серверного текста ошибки. */
export function extractJournalPath(error: string | null): string | null {
  if (error === null || error.trim() === '') return null;
  const match =
    ENGLISH_JOURNAL_MARKER.exec(error) ?? RUSSIAN_JOURNAL_MARKER.exec(error);
  const path = match?.[1]?.trim() ?? '';
  return path === '' ? null : path;
}

/**
 * Текст причины сбоя задания по машиночитаемому `reason` (задача 4f6c972a,
 * ADR daab6ac4 §4). Возвращает `null`, когда причины нет: вызывающий берёт
 * `job.error` фолбэком (задание сохранено до появления поля). Неизвестное
 * значение (сервер новее клиента) — общий локализованный текст, а не сырой
 * английский `error`.
 *
 * `installer-*`-причины делят ключи с `502 UPDATE_INSTALLER_FAILED`: один и
 * тот же отказ установщика показывается одинаково и из конверта ошибки, и из
 * задания в `/progress`. `installer-exit` и `interrupted` подставляют
 * параметры из задания (`exit_code`, `failed_stage`), а не из текста.
 */
export function updateFailureText(
  job: Pick<UpdateJob, 'reason' | 'exit_code' | 'failed_stage'>,
): string | null {
  const reason = job.reason;
  if (reason === null) return null;
  switch (reason) {
    case 'installer-target':
      return t('errors.code.UPDATE_INSTALLER_FAILED.installer-target');
    case 'installer-download':
      return t('errors.code.UPDATE_INSTALLER_FAILED.installer-download');
    case 'installer-hash':
      return t('errors.code.UPDATE_INSTALLER_FAILED.installer-hash');
    case 'installer-launch':
      return t('errors.code.UPDATE_INSTALLER_FAILED.installer-launch');
    case 'installer-exit':
      return job.exit_code === null
        ? t('serverUpdate.failure.installerExitNoCode')
        : t('serverUpdate.failure.installerExit', String(job.exit_code));
    case 'installer-precondition':
      return t('serverUpdate.failure.installerPrecondition');
    case 'installer-timeout':
      return t('serverUpdate.failure.installerTimeout');
    case 'not-a-service':
      return t('serverUpdate.failure.notAService');
    case 'interrupted':
      return job.failed_stage === null
        ? t('serverUpdate.failure.interruptedNoStage')
        : t('serverUpdate.failure.interrupted', job.failed_stage);
    case 'internal':
      return t('serverUpdate.failure.internal');
    default:
      // Новое значение причины от более свежего сервера: общий текст, без
      // разбора английского `error`.
      return t('serverUpdate.failure.unknown');
  }
}

/** Снимок состояния диалога. */
export interface ServerUpdateState {
  /** Кеш проверки; `null` — ещё не загружен (или не удалось прочитать). */
  status: SystemUpdateStatus | null;
  /** Последнее задание с сервера. */
  job: UpdateJob | null;
  /** Фаза диалога. */
  phase: ServerUpdatePhase;
  /** Идёт НАШ вызов проверки (кнопка «Проверить» заблокирована). */
  checking: boolean;
  /** Строка-состояние проверки: «проверка уже идёт» (429); иначе `null`. */
  checkNote: string | null;
  /** Связь с сервером прервана во время обновления — ожидаемое состояние. */
  disconnected: boolean;
  /** Отказ установщика (`502`): сервер жив, повтор не предлагается. */
  installerFailed: boolean;
}

/** Готовая к отрисовке модель (все строки — из словаря). */
export interface ServerUpdateViewModel {
  currentVersion: string | null;
  availableVersion: string | null;
  /** Доступна версия строго новее текущей. */
  hasUpdate: boolean;
  channelText: string | null;
  checkedAtText: string | null;
  /** Текст последней ошибки проверки фида; `null` — проверка успешна. */
  checkError: string | null;
  deploymentText: string | null;
  /** Инструкция обновления от сервера (Docker); `null` — режим без инструкции. */
  instruction: string | null;
  /** Можно запросить проверку. */
  canCheck: boolean;
  /** Можно запустить обновление. */
  canApply: boolean;
  /** Пояснение, почему обновление недоступно (Docker); иначе `null`. */
  unavailableNote: string | null;
  /** Подтверждённая сервером подпись этапа; `null` — этапа нет. */
  stageText: string | null;
  /** Этап подтверждён сервером (а не общая строка «выполняется»). */
  stageConfirmed: boolean;
  /** Задание идёт (в т.ч. ожидание первого `preparing`). */
  running: boolean;
  /** Итог: задание завершено успешно. */
  done: boolean;
  /** Итог: задание провалилось. */
  failed: boolean;
  /**
   * Причина сбоя (`failed`) — локализованный текст по машиночитаемому
   * `reason` (ADR daab6ac4 §4). `job.error` (английский) — только фолбэк,
   * когда `reason` нет: задание сохранено до появления поля.
   */
  failureText: string | null;
  /**
   * Путь к журналу установщика: машиночитаемое `job.log_path` в первую
   * очередь, разбор `job.error` — только фолбэк для старых заданий.
   */
  journalPath: string | null;
  /** Путь к архиву БД; `null` — сервер не сообщил (сейчас всегда). */
  backupPath: string | null;
  disconnected: boolean;
  checking: boolean;
  /** Состояние «проверка уже идёт» (429); `null` — сообщения нет. */
  checkNote: string | null;
  /** Идёт вызов apply (ждать ответа до 10 минут). */
  applying: boolean;
  /** Отказ установщика (`502`) — повтор не предлагается. */
  installerFailed: boolean;
}

/** Собрать модель диалога из состояния. */
export function serverUpdateViewModel(state: ServerUpdateState): ServerUpdateViewModel {
  const status = state.status;
  const job = state.job;
  const availableRaw = status?.available_version ?? '';
  const availableVersion = availableRaw.trim() === '' ? null : availableRaw;
  // Пустой текст инструкции — то же, что её отсутствие: кнопки копирования
  // не на что вешать.
  const instructionRaw = status?.instruction ?? '';
  const instruction = instructionRaw.trim() === '' ? null : instructionRaw;
  const deployment = status?.deployment ?? null;
  const runningPhase = state.phase === 'applying';
  const done = state.phase === 'done' || job?.stage === 'done';
  const failed = state.phase === 'failed' || job?.stage === 'failed';

  const stageLabel = job === null ? null : updateStageLabel(job.stage);
  const confirmed = job !== null && CONFIRMED_UPDATE_STAGES.includes(job.stage);
  // Нетерминальный, но не подтверждённый этап (installing/health-check/…):
  // сервер его не записывает, поэтому показываем общую строку, а не имя.
  const unconfirmedRunning =
    job !== null && !confirmed && !isTerminalJobStage(job.stage);

  let stageText: string | null = null;
  if (stageLabel !== null) stageText = t(stageLabel);
  else if (unconfirmedRunning) stageText = t('serverUpdate.stage.running');

  const canApply =
    status !== null &&
    availableVersion !== null &&
    deployment !== 'docker' &&
    // После `done` повторная кнопка «Обновить сервер» не нужна: задание уже
    // завершено, новый снимок кеша покажет актуальную версию.
    !done &&
    !runningPhase &&
    // Отказ установщика (`502`, `retryable: false`): повторный запуск
    // автоматически НЕ предлагается — только причина и журнал.
    !state.installerFailed &&
    !(job !== null && !isTerminalJobStage(job.stage));

  return {
    currentVersion: status?.current_version ?? null,
    availableVersion,
    hasUpdate: availableVersion !== null,
    channelText: status === null ? null : t(updateChannelLabel(status.channel)),
    checkedAtText:
      status === null || status.checked_at === null
        ? null
        : fmtDateTime(status.checked_at),
    checkError: status?.check_error ?? null,
    deploymentText: deployment === null ? null : t(updateDeploymentLabel(deployment)),
    instruction,
    canCheck: !state.checking && !runningPhase,
    canApply,
    unavailableNote:
      deployment === 'docker'
        ? t('serverUpdate.dockerNote')
        : null,
    stageText,
    stageConfirmed: confirmed,
    running: runningPhase || (job !== null && !isTerminalJobStage(job.stage)),
    done,
    failed,
    failureText: failed ? (job === null ? null : (updateFailureText(job) ?? job.error)) : null,
    journalPath: failed
      ? (job?.log_path ?? extractJournalPath(job?.error ?? null))
      : null,
    backupPath: job?.backup_path ?? null,
    disconnected: state.disconnected,
    checking: state.checking,
    checkNote: state.checkNote,
    applying: runningPhase && state.job === null,
    installerFailed: state.installerFailed,
  };
}

/** Исход отказа `apply` (см. шапку модуля). */
export type ApplyFailureKind = 'in-progress' | 'installer-failed' | 'rejected';

/** Разобранный отказ `apply`. */
export interface ApplyFailure {
  kind: ApplyFailureKind;
  /**
   * Готовый пользовательский текст для `installer-failed`/`rejected` (по коду
   * `details.reason`, ADR daab6ac4 §4; серверный `message` не показывается)
   * или `null`. Поле не называется `message`: в контракте ADR это имя
   * закреплено за английским диагностическим текстом сервера.
   */
  text: string | null;
  /** Задание из `details.job`, если сервер его прислал. */
  job: UpdateJob | null;
  /** Сервер разрешает повтор (`details.retryable`); сейчас всегда `false`. */
  retryable: boolean;
}

/** Задание из `details` отказа — только с полным набором полей контракта. */
function jobFromDetails(details: unknown): UpdateJob | null {
  if (typeof details !== 'object' || details === null) return null;
  const job = (details as { job?: unknown }).job;
  if (typeof job !== 'object' || job === null) return null;
  const candidate = job as Partial<UpdateJob>;
  if (
    typeof candidate.id !== 'string' ||
    typeof candidate.target_version !== 'string' ||
    typeof candidate.stage !== 'string' ||
    typeof candidate.started_at !== 'string'
  ) {
    return null;
  }
  return {
    id: candidate.id,
    target_version: candidate.target_version,
    stage: candidate.stage as UpdateJobStage,
    started_at: candidate.started_at,
    error: typeof candidate.error === 'string' ? candidate.error : null,
    reason: isUpdateJobFailureReason(candidate.reason) ? candidate.reason : null,
    failed_stage:
      typeof candidate.failed_stage === 'string'
        ? (candidate.failed_stage as UpdateJobStage)
        : null,
    exit_code: typeof candidate.exit_code === 'number' ? candidate.exit_code : null,
    log_path: typeof candidate.log_path === 'string' ? candidate.log_path : null,
    backup_path: typeof candidate.backup_path === 'string' ? candidate.backup_path : null,
  };
}

/**
 * Разобрать отказ `POST /system/update/apply`.
 *
 * Признак «обновление идёт» — не HTTP-код сам по себе, а его причина:
 * `409` приходит и для docker/downgrade/version-mismatch, где задания нет.
 */
export function classifyApplyFailure(err: unknown): ApplyFailure {
  const error = err instanceof EtnError ? err : null;
  const details =
    typeof error?.details === 'object' && error.details !== null
      ? (error.details as Record<string, unknown>)
      : {};
  const job = jobFromDetails(details);
  const reason = typeof details.reason === 'string' ? details.reason : null;
  const transportKind = typeof details.kind === 'string' ? details.kind : null;

  // Обрыв/тайм-аут: apply отвечает только после скачивания и проверки хеша.
  if (transportKind === 'connect-failed') {
    return { kind: 'in-progress', text: null, job, retryable: false };
  }
  if (error?.code === 'SERVER_UPDATING') {
    return { kind: 'in-progress', text: null, job, retryable: false };
  }
  if (error?.code === 'VERSION_CONFLICT') {
    if (reason === 'docker' || reason === 'downgrade' || reason === 'version-mismatch') {
      return { kind: 'rejected', text: errText(err), job, retryable: false };
    }
    // job-active / installer-alive / 409 без причины — идущее обновление.
    return { kind: 'in-progress', text: null, job, retryable: false };
  }
  if (error?.code === 'UPDATE_INSTALLER_FAILED') {
    return {
      kind: 'installer-failed',
      text: errText(err),
      job,
      retryable: details.retryable === true,
    };
  }
  return {
    kind: 'rejected',
    text: errText(err),
    job,
    retryable: false,
  };
}

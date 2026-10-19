/**
 * Сторож коалесирования realtime-перечитываний (задача `96d7f05d`, ошибка
 * `49e05ea0`).
 *
 * Правило живого слоя: realtime-перечитывания идут ТОЛЬКО через коалесирующий
 * канал реестра. Для этого событие обязано доехать до реестра ПРИЧИНОЙ
 * инвалидации (`invalidateQueries(prefix, evt)`) или до производного эффекта
 * с событием (`scheduleRefresh(evt)` / `invalidateRef(id, true)`), а сами
 * effect-модули не вправе ходить в сеть напрямую — иначе снова появляется
 * запрос на каждое событие.
 *
 * Локальные пути (мутации, действия пользователя, смена слоя) обязаны нести
 * ЯВНУЮ причину `LOCAL_CAUSE` либо `invalidateRef(id, false)`: вызов без
 * причины или с `undefined`/`null` неотличим от забытого события и даёт
 * per-event перечитывание. Контрольные realtime-сигналы без payload события
 * (`resume.stale`, `focus-lost`) несут `REALTIME_CONTROL_CAUSE`.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`; мутация «убрать
 * причину из вызова» (в т.ч. «передать явный `undefined`») делает его красным.
 */

import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertGuardClean } from './guard-helpers.js';

const RENDERER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'renderer',
);

const ROUTER = 'lib/live/event-router.ts';
const EFFECTS = 'realtime-effects.ts';
const APP = 'app.ts';

/**
 * Строка комментария — не код: примеры в JSDoc правилом не считаются.
 * `filePattern` сообщает строку начала совпадения, поэтому комментарий внутри
 * многострочного вызова сюда не попадёт — такие вызовы в модулях не пишут.
 */
function isCommentLine(_rel: string, line: string): boolean {
  return /^\s*(?:\*|\/\/|\/\*)/.test(line);
}

/** Вызов `fn(...)` без второго аргумента (в т.ч. разнесённый по строкам). */
function callWithoutSecondArg(fn: string): RegExp {
  return new RegExp(`\\b${fn}\\((?:[^(),]|\\([^()]*\\))*\\)`, 'g');
}

describe('guard: realtime-перечитывания коалесируются (96d7f05d)', () => {
  it('роутер передаёт событие причиной инвалидации', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'realtime-invalidation-carries-cause',
        description:
          'Роутер обязан звать invalidateQueries(prefix, evt): без причины реестр ' +
          'не отличит realtime-волну от локальной мутации и не отложит перечитывание ' +
          'в окно (ошибка 49e05ea0). Явный undefined/null — тоже нарушение.',
        include: (rel) => rel === ROUTER,
        pattern: /invalidateQueries\(\s*prefix\s*(?:,\s*(?:undefined|null)\s*)?\)/,
        allow: isCommentLine,
      },
    ]);
  });

  it('производные эффекты передают событие в перечитывание и помечают realtime-ref', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'realtime-refresh-carries-event',
        description:
          'scheduleRefresh() без причины исполняет фокус-перечитывание по старому ' +
          'локальному пути (дебаунс + микротаска) — волна снова даст запрос на ' +
          'каждое событие. Передавай событие (scheduleRefresh(evt)) или явную ' +
          'причину LOCAL_CAUSE/REALTIME_CONTROL_CAUSE.',
        include: (rel) => rel === EFFECTS || rel === APP,
        pattern: /scheduleRefresh\(\s*(?:(?:undefined|null)\s*)?\)/,
        allow: isCommentLine,
      },
      {
        name: 'invalidation-carries-cause',
        description:
          'invalidateQueries без второй причины в effect-модулях неотличима от ' +
          'забытого realtime-события. Realtime-путь передаёт событие, локальный — ' +
          'LOCAL_CAUSE.',
        include: (rel) => rel === EFFECTS || rel === APP,
        filePattern: callWithoutSecondArg('invalidateQueries'),
        allow: isCommentLine,
      },
      {
        name: 'invalidation-cause-not-nullish',
        description:
          'Явный undefined/null вместо причины обходит realtime-окно: реестр ' +
          'трактует такую инвалидацию как локальную. Передай событие или ' +
          'LOCAL_CAUSE.',
        include: (rel) => rel === EFFECTS || rel === APP,
        pattern: /invalidateQueries\([^;]*?,\s*(?:undefined|null)\s*\)/,
        allow: isCommentLine,
      },
      {
        name: 'ref-invalidation-carries-realtime-flag',
        description:
          'invalidateRef без признака realtime в effect-модулях не даёт батчеру ' +
          'thoughts.resolve собрать id в окно. Realtime-путь — `true`, локальный — ' +
          'явный `false`.',
        include: (rel) => rel === EFFECTS || rel === APP,
        filePattern: callWithoutSecondArg('invalidateRef'),
        allow: isCommentLine,
      },
      {
        name: 'realtime-ref-invalidation-windowed',
        description:
          'Сброс ref-кэша по realtime-событию обязан нести realtime=true: иначе ' +
          'догрузка имён/облачков уйдёт немедленно на каждое событие волны, а не ' +
          'соберётся в окно thoughts.resolve.',
        include: (rel) => rel === EFFECTS,
        pattern: /invalidateRef\(\s*evt\.data\.id\s*(?:,\s*(?:false|undefined|null)\s*)?\)/,
        allow: isCommentLine,
      },
      {
        name: 'no-direct-network-in-effects',
        description:
          'Производные эффекты и роутер не ходят в сеть сами: перечитывание ' +
          'запускает только реестр по ключу (иначе коалесирование обходится).',
        include: (rel) => rel === EFFECTS || rel === ROUTER,
        pattern: /\betn\./,
        allow: isCommentLine,
      },
    ]);
  });
});

/**
 * Общее решение «куда ведёт клик по строке-записи» (0.15.4, техпроект 43329662,
 * задача ae72e47e, требование ce121e09, сценарии 55c7f9c7/eeffbc16/b87fb958).
 *
 * Модуль существует ровно потому, что правило нужно ДВУМ поверхностям — группе
 * поиска «Найдено в хронологии» и вкладке «Упоминания». Здесь фиксируется само
 * правило:
 *  - мысль: сначала `openRecordInEditor` (вкладка «Дневник» + строка записи),
 *    затем `focusFromUi` на ОТКРЫВАЕМУЮ привязку — force-ветка входа за фокусом
 *    не следует, поэтому фокус ставит вызывающая сторона;
 *  - связь: `getLink` → `openLinkInEditor`, без записи и без фокуса;
 *  - stale-цель: отказ уходит в `onFailure` (тишина/тост решает потребитель),
 *    редактор связи при этом не открывается; без `onFailure` отказ молчит.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Link } from '@etn/shared';

import { openRecordTarget, type RecordOpenActions } from '../src/renderer/lib/record-open.js';

const NETWORK = '00000000-0000-4000-8000-00000000000a';
const THOUGHT = '55555555-5555-4555-8555-555555555555';
const LINK = '88888888-8888-4888-8888-888888888888';
const COMMENT = '66666666-6666-4666-8666-666666666666';

/** Связь-заготовка: содержимое решению безразлично, важен сам факт загрузки. */
const LINK_ENTITY = { id: LINK, source_id: THOUGHT, target_id: THOUGHT } as unknown as Link;

/** Журнал вызовов действий — порядок важен (вход редактора раньше фокуса). */
interface Calls {
  log: string[];
  opened: { commentId: string; thoughtId: string }[];
  focused: string[];
  links: Link[];
  failures: unknown[];
}

/** Действия решения с журналом вызовов. */
function actions(overrides: Partial<RecordOpenActions> = {}): {
  calls: Calls;
  port: RecordOpenActions;
} {
  const calls: Calls = { log: [], opened: [], focused: [], links: [], failures: [] };
  const port: RecordOpenActions = {
    networkId: NETWORK,
    getLink: async (networkId, linkId) => {
      calls.log.push(`getLink:${networkId}:${linkId}`);
      return LINK_ENTITY;
    },
    openLinkInEditor: (link) => {
      calls.log.push('openLinkInEditor');
      calls.links.push(link);
    },
    openRecordInEditor: (thoughtId, commentId) => {
      calls.log.push('openRecordInEditor');
      calls.opened.push({ thoughtId, commentId });
    },
    focusFromUi: async (thoughtId) => {
      calls.log.push(`focusFromUi:${thoughtId}`);
      calls.focused.push(thoughtId);
    },
    ...overrides,
  };
  return { calls, port };
}

describe('общее открытие цели строки-записи (требование ce121e09)', () => {
  it('мысль: запись открывается в редакторе, ЗАТЕМ фокус на открываемую привязку', async () => {
    const { calls, port } = actions();

    await openRecordTarget({ kind: 'thought', id: THOUGHT }, COMMENT, port);

    assert.deepEqual(
      calls.log,
      ['openRecordInEditor', `focusFromUi:${THOUGHT}`],
      'порядок входа и фокуса',
    );
    assert.deepEqual(
      calls.opened,
      [{ thoughtId: THOUGHT, commentId: COMMENT }],
      'запись адресуется привязке',
    );
    assert.deepEqual(calls.focused, [THOUGHT], 'адресат фокуса — открываемая привязка');
  });

  it('связь: редактор связи БЕЗ записи, фокус не трогается', async () => {
    const { calls, port } = actions();

    await openRecordTarget({ kind: 'link', id: LINK }, COMMENT, port);

    assert.deepEqual(
      calls.log,
      [`getLink:${NETWORK}:${LINK}`, 'openLinkInEditor'],
      'связь грузится и открывается',
    );
    assert.deepEqual(calls.opened, [], 'записи у редактора связи нет');
    assert.deepEqual(calls.focused, [], 'фокус холста не меняется');
    assert.deepEqual(calls.links, [LINK_ENTITY], 'в редактор уходит загруженная связь');
  });

  it('stale-связь: отказ уходит потребителю, редактор не открывается', async () => {
    const stale = Object.assign(new Error('not found'), { status: 404 });
    const { calls, port } = actions({
      getLink: async () => {
        throw stale;
      },
      onFailure: (error) => calls.failures.push(error),
    });

    await openRecordTarget({ kind: 'link', id: LINK }, COMMENT, port);

    assert.deepEqual(calls.failures, [stale], 'потребитель решает: тишина или тост');
    assert.deepEqual(calls.links, [], 'редактор связи не открыт');
    assert.deepEqual(calls.opened, [], 'запись не открыта');
  });

  it('без `onFailure` отказ молчит (тихий пропуск stale-цели)', async () => {
    const { calls, port } = actions({
      getLink: async () => {
        throw new Error('gone');
      },
    });

    await assert.doesNotReject(
      openRecordTarget({ kind: 'link', id: LINK }, COMMENT, port),
      'отказ не выходит наружу: лишнего тоста и падения нет',
    );
    assert.deepEqual(calls.links, []);
  });
});

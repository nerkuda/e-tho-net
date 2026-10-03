/**
 * Юнит-тесты ядра фокусировки комментария `editor/comment-focus.ts` (блокер 4
 * верификации ea1b5f14): холодная смена мысли — ожидание обязано сверять
 * ВЛАДЕЛЬЦА отрисованной панели с запрошенной мыслью, иначе правка включается
 * у старой мысли, а поле целевой монтируется в режиме просмотра.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { commentFocusStep } from '../src/renderer/editor/comment-focus.js';

describe('editor/comment-focus: порядок фокусировки комментария (блокер 4)', () => {
  it('холодная смена мысли: поле СТАРОЙ мысли не принимается за целевое — ждём', () => {
    // Панель ещё показывает X (renderCtx=X), а поле X уже смонтировано:
    // раньше по одному факту наличия поля включалась правка X (дефект).
    assert.equal(
      commentFocusStep({ renderedOwnerId: 'X', thoughtId: 'Y', hasField: true, activated: false }),
      'wait',
      'владелец панели не совпал — не трогаем поле',
    );
    // Как только панель дорендерилась до Y, но поля ещё нет — тоже ждём.
    assert.equal(
      commentFocusStep({ renderedOwnerId: 'Y', thoughtId: 'Y', hasField: false, activated: false }),
      'wait',
      'поля целевой мысли ещё нет',
    );
  });

  it('панель целевой мысли + поле смонтировано → активируем вкладку, затем ставим каретку', () => {
    assert.equal(
      commentFocusStep({ renderedOwnerId: 'Y', thoughtId: 'Y', hasField: true, activated: false }),
      'activate',
      'сначала активировать вкладку/группу',
    );
    assert.equal(
      commentFocusStep({ renderedOwnerId: 'Y', thoughtId: 'Y', hasField: true, activated: true }),
      'focus',
      'после активации — каретка',
    );
  });

  it('клик по блоку уже открытой мысли — короткий путь (сразу фокус)', () => {
    assert.equal(
      commentFocusStep({ renderedOwnerId: 'Y', thoughtId: 'Y', hasField: true, activated: true }),
      'focus',
    );
  });
});

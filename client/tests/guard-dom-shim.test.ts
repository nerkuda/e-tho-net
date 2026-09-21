/**
 * Сторож: единый DOM-шим для клиентских тестов (задача ac0c198c).
 *
 * До этой задачи `ShimElement` + `shimDom` были скопированы в четыре десятка
 * тестовых файлов, и копии разошлись. Общий модуль — `tests/dom-shim.ts`;
 * новая копия класса (или его характерного поля-класс-листа) запрещена:
 * правка поведения шима должна быть одной правкой модуля, а не синхронной
 * в десятках файлов.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test` (образец —
 * `guard-renderer-electron.test.ts`, инфраструктура — `guard-helpers.ts`).
 */

import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertGuardClean } from './guard-helpers.js';

const TESTS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

/** Единственный файл, которому разрешено определять шим. */
const SHIM_MODULE = 'dom-shim.ts';

describe('guard: единый DOM-шим для клиентских тестов', () => {
  it('классы ShimElement/ShimClassList определены только в tests/dom-shim.ts', () => {
    assertGuardClean(TESTS_ROOT, [
      {
        name: 'dom-shim-single-definition',
        description:
          'Общий DOM-шим живёт в tests/dom-shim.ts: определения классов ' +
          'ShimElement и ShimClassList в других тестовых файлах запрещены — ' +
          'импортируйте их из ./dom-shim.js.',
        pattern: /^\s*(?:export\s+)?class\s+Shim(?:Element|ClassList)\b/,
        allow: (relPath) => relPath === SHIM_MODULE,
      },
      {
        name: 'dom-shim-no-inline-class-list',
        description:
          'Класс-лист элемента — часть общего шима: инлайновый литерал ' +
          '`classList = { ... }` внутри класса теста — признак новой копии ' +
          'шима. Импортируйте ShimElement/ShimClassList из ./dom-shim.js.',
        pattern: /(?:^|\s)classList\s*=\s*\{/,
        allow: (relPath) => relPath === SHIM_MODULE,
      },
      {
        name: 'dom-shim-no-element-constructor',
        description:
          'Конструктор элемента вида `constructor(tag: string, …)` в тестовом ' +
          'файле — копия шима. Используйте ShimElement из ./dom-shim.js.',
        pattern: /^\s*constructor\s*\(\s*tag\s*:\s*string/,
        allow: (relPath) => relPath === SHIM_MODULE,
      },
    ]);
  });
});

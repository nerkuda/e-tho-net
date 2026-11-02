/**
 * Сторож пайп-безопасности Linux-установщика (задача 20a56c57, версия 0.15.1).
 *
 * Одношная установка `curl -fsSL <base>/install.sh | bash` подаёт скрипт на
 * stdin интерпретатора. В этом режиме ломаются две вещи, которые в обычном
 * запуске `bash install.sh` незаметны:
 *
 *   * команда, читающая stdin (`read` без перенаправления, `cat` без файла),
 *     съедает остаток скрипта — установка обрывается на середине;
 *   * `$0` и `BASH_SOURCE` равны `bash`, поэтому путь к скрипту и каталог
 *     релиза из них не выводятся.
 *
 * Вторая половина контракта — определение последней версии. Для GitHub
 * работает редирект `<base>/releases/latest` → `/releases/tag/vX.Y.Z`, но у
 * зеркал и локальной раздачи редиректа нет: там лежит статический файл
 * `releases/latest` с текстом версии. Без этого фолбэка одношная команда на
 * зеркале требует `--version` и/или `ETN_RELEASE_BASE_URL`.
 *
 * Сторож статический: он читает `scripts/install.sh` и падает на
 * `npm -w @etn/server test`. Функциональный прогон пайпа и HTTP-раздачи —
 * `scripts/install-sh-smoke.sh` (Linux-джоба CI).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(SERVER_ROOT, '..');
const INSTALLER = path.join(REPO_ROOT, 'scripts', 'install.sh');

/** Текст установщика; отсутствие файла — отдельная понятная ошибка. */
function readInstaller(): string {
  assert.ok(
    fs.existsSync(INSTALLER),
    'Нет scripts/install.sh — сторож пайп-безопасности не может проверить контракт установщика.',
  );
  return fs.readFileSync(INSTALLER, 'utf8');
}

/** Номера строк (с 1), где найдено совпадение. */
function lineNumbers(text: string, pattern: RegExp): number[] {
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  return [...text.matchAll(re)].map((m) => text.slice(0, m.index ?? 0).split('\n').length);
}

describe('guard: scripts/install.sh работает в пайпе', () => {
  it('не выводит своё местоположение из $0 и BASH_SOURCE', () => {
    const text = readInstaller();
    const violations = [
      ...lineNumbers(text, /\$0\b/),
      ...lineNumbers(text, /\$\{0\}/),
      ...lineNumbers(text, /\bBASH_SOURCE\b/),
    ].sort((a, b) => a - b);
    assert.deepEqual(
      violations,
      [],
      `scripts/install.sh:${violations.join(',')}: путь к скрипту берётся из $0/BASH_SOURCE. ` +
        'В режиме `curl … | bash` эти переменные указывают на bash, а не на скрипт; ' +
        'имя программы задаётся литералом (PROG), база релиза — значением по умолчанию.',
    );
  });

  it('не читает stdin: нет голых read и cat без аргументов', () => {
    const text = readInstaller();
    const problems: string[] = [];
    for (const line of lineNumbers(text, /^[ \t]*read\b/m)) {
      problems.push(`scripts/install.sh:${line}: голый read читает stdin и съест остаток скрипта в пайпе`);
    }
    for (const line of lineNumbers(text, /^[ \t]*cat[ \t]*(?:#.*)?$/m)) {
      problems.push(`scripts/install.sh:${line}: cat без аргументов читает stdin и съест остаток скрипта в пайпе`);
    }
    for (const line of lineNumbers(text, /\bexec[ \t]+</)) {
      problems.push(`scripts/install.sh:${line}: exec < перенаправляет stdin со скрипта на файл/устройство`);
    }
    assert.deepEqual(
      problems,
      [],
      `Пайп-режим сломан:\n${problems.map((p) => `  • ${p}`).join('\n')}\n\n` +
        'Ввод в циклах — only через here-string (<<<) или here-doc (<<): оба ' +
        'перенаправляют stdin самой команды и не трогают скрипт.',
    );
  });

  it('определяет версию из статического <base>/releases/latest', () => {
    const text = readInstaller();
    const references = lineNumbers(text, /releases\/latest/);
    assert.ok(
      references.length >= 2,
      'scripts/install.sh: releases/latest упомянут меньше двух раз — нет отдельного ' +
        'источника версии помимо GitHub-редиректа. Зеркало и локальная раздача ' +
        'без статического файла потребуют --version.',
    );
    // Чтение ТЕЛА файла (не HEAD): `curl -fsSL` без `I` — статический файл
    // с текстом версии; HEAD-редирект остаётся отдельной веткой.
    const bodyRead = lineNumbers(text, /curl -fsSL [^\n]*"\$RELEASE_BASE_URL\/releases\/latest"/);
    assert.ok(
      bodyRead.length > 0,
      'scripts/install.sh: нет чтения тела <base>/releases/latest. Для зеркал и ' +
        'локальной раздачи версия берётся из текста файла (например «0.15.1»), ' +
        'а не только из GitHub-редиректа на /releases/tag/vX.Y.Z.',
    );
    // Текст файла проходит ту же проверку формата, что и --version: иначе
    // мусор в releases/latest уедет в URL и даст непонятную ошибку скачивания.
    assert.match(
      text,
      /^readonly VERSION_PATTERN='\^\[0-9\]\+/m,
      'scripts/install.sh: формат версии должен быть задан одной константой ' +
        "VERSION_PATTERN='^[0-9]+…' — ею проверяются и --version, и текст " +
        '<base>/releases/latest.',
    );
    const patternUses = lineNumbers(text, /"\$VERSION_PATTERN"/);
    assert.ok(
      patternUses.length >= 2,
      'scripts/install.sh: VERSION_PATTERN применяется меньше двух раз — текст ' +
        '<base>/releases/latest не валидируется тем же шаблоном, что и --version. ' +
        `Найдено: ${patternUses.join(', ') || 'ни одного'}.`,
    );
  });

  it('по умолчанию ставит в домашний каталог и не вызывает sudo', () => {
    const text = readInstaller();
    const sudoCalls = lineNumbers(text, /^[ \t]*sudo\b/m);
    assert.deepEqual(
      sudoCalls,
      [],
      `scripts/install.sh:${sudoCalls.join(',')}: установщик сам вызывает sudo. ` +
        'Повышение прав — только --system и решение пользователя (в одношной ' +
        'команде sudo нет); в пользовательском режиме скрипт работает без root.',
    );
    assert.match(
      text,
      /^MODE="user"/m,
      'scripts/install.sh: режим по умолчанию должен быть пользовательским (MODE="user") — ' +
        'одношная команда ставит клиент в ~/.local/opt/etn без sudo.',
    );
  });
});

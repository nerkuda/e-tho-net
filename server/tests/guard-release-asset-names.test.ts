/**
 * Сторож имён релизных ассетов (задача 6d93fe6f, версия 0.15.1).
 *
 * Имена ассетов — контракт между четырьмя независимыми потребителями:
 *
 *   * `.github/workflows/release.yml` — собирает, проверяет и публикует ассеты;
 *   * `scripts/install.sh` — скачивает клиентский архив и `SHA256SUMS` по URL
 *     `.../releases/download/v<версия>/<asset>`;
 *   * `server/scripts/release-notes.mjs` — пишет футер «Скачать» в тело релиза;
 *   * `server/src/update/checker.ts` — ищет в метаданных фида
 *     `ETN-Setup-<version>.exe` и `SHA256SUMS` для серверного обновления.
 *
 * Переименование в одном месте не ломает ни один тест по отдельности: сборка
 * зелёная, серверные тесты зелёные, а ассет выходит под именем, которого не
 * ждёт установщик (или скрипт не находит строку в `SHA256SUMS`) — и вскрывается
 * это у пользователя на скачивании, уже после публикации. Сторож сверяет
 * ШАБЛОНЫ имён (версия — переменная, не жёсткое значение) во всех четырёх
 * файлах и падает на `npm -w @etn/server test` при расхождении.
 *
 * Проверяются два правила:
 *
 *   1. каждый файл содержит имя каждого ассета, который он обязан знать
 *      (матрица ниже): без этого install.sh не скачает архив, update-checker
 *      не найдёт установщик, а тело релиза не подскажет файл;
 *   2. ни в одном из четырёх файлов нет имени ассета вне канонического
 *      шаблона — устаревшие `ETN.Setup`, `.msi`, `.AppImage`, `.deb`, `.dmg`,
 *      `SHA256SUMS.txt` и подобные не должны возвращаться.
 *
 * Почему не жестокая версия: версия приходит из тега и подставляется
 * переменной (`${VERSION}`, `$($env:VERSION)`, `${version}`, `$env:VERSION`,
 * `*` в путях артефактов, `<version>` в документации). Сторож принимает любой
 * из этих слотов и проверяет неизменную часть имени.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(SERVER_ROOT, '..');

/**
 * Слот версии в шаблоне имени: `${VERSION}`, `${version}`, `$($env:VERSION)`,
 * `$env:VERSION`, `*` (путь артефакта) или `<version>` (документация).
 */
const VERSION_SLOT = String.raw`(?:\$\{[^}\n]+\}|\$\([^)\n]+\)|\$env:[A-Za-z_][A-Za-z0-9_]*|\*|<[^>\n]+>)`;

/** Ключи ассетов контракта. */
type AssetKey = 'setup' | 'server' | 'client' | 'sums';

/** Канонические шаблоны имён (версия — слот, остальное неизменно). */
const ASSET_TEMPLATES: Record<AssetKey, RegExp> = {
  setup: new RegExp(String.raw`ETN-Setup-${VERSION_SLOT}\.exe`, 'g'),
  server: new RegExp(String.raw`etn-server-${VERSION_SLOT}\.tar\.gz`, 'g'),
  client: new RegExp(String.raw`ETN-Client-${VERSION_SLOT}-linux-x64\.tar\.gz`, 'g'),
  sums: /\bSHA256SUMS\b/g,
};

/** Человекочитаемое имя ассета для сообщений. */
const ASSET_LABELS: Record<AssetKey, string> = {
  setup: 'ETN-Setup-<version>.exe',
  server: 'etn-server-<version>.tar.gz',
  client: 'ETN-Client-<version>-linux-x64.tar.gz',
  sums: 'SHA256SUMS',
};

/** Файл контракта и ассеты, которые он обязан упоминать. */
interface ReleaseFile {
  /** Путь от корня репозитория, слеши `/`. */
  file: string;
  /** Зачем файл знает имена — для сообщения об ошибке. */
  role: string;
  /** Ассеты, без имени которых файл не выполняет свою роль. */
  requires: readonly AssetKey[];
}

/**
 * Матрица «файл → обязательные имена». install.sh ставит только Linux-клиента
 * (серверная поставка и Windows-установщик его не касаются), update-checker
 * работает с Windows-установщиком и `SHA256SUMS` — остальные имена ему не
 * нужны. Workflow и тело релиза описывают весь комплект.
 */
const RELEASE_FILES: readonly ReleaseFile[] = [
  {
    file: 'scripts/install.sh',
    role: 'скачивает клиентский архив и сверяет его с SHA256SUMS',
    requires: ['client', 'sums'],
  },
  {
    file: '.github/workflows/release.yml',
    role: 'собирает, проверяет и публикует ассеты',
    requires: ['setup', 'server', 'client', 'sums'],
  },
  {
    file: 'server/scripts/release-notes.mjs',
    role: 'перечисляет ассеты в футере тела релиза',
    requires: ['setup', 'server', 'client', 'sums'],
  },
  {
    file: 'server/src/update/checker.ts',
    role: 'ищет установщик и SHA256SUMS в метаданных фида обновлений',
    requires: ['setup', 'sums'],
  },
];

/** Похожее на имя ассета в исходнике: то, что сторож обязан опознать. */
interface AssetTokenPattern {
  label: string;
  token: RegExp;
  canonical: RegExp;
}

/**
 * Токены-«ловушки»: любое совпадение в файле контракта должно подходить под
 * канонический шаблон. Ловушки шире канона (устаревшие расширения, точка
 * вместо дефиса) — так возврат старого имени не проскочит.
 */
const ASSET_TOKENS: readonly AssetTokenPattern[] = [
  {
    label: ASSET_LABELS.setup,
    token: /ETN[-.]Setup[-_.][^\s"'`\\]*\.(?:exe|msi)/g,
    canonical: new RegExp(String.raw`^ETN-Setup-${VERSION_SLOT}\.exe$`),
  },
  {
    label: ASSET_LABELS.server,
    token: /etn-server-[^\s"'`\\]*\.(?:tar\.gz|tgz|zip|deb)/g,
    canonical: new RegExp(String.raw`^etn-server-${VERSION_SLOT}\.tar\.gz$`),
  },
  {
    label: ASSET_LABELS.client,
    token: /ETN-Client-[^\s"'`\\]*\.(?:tar\.gz|tgz|zip|deb|dmg|AppImage)/g,
    canonical: new RegExp(String.raw`^ETN-Client-${VERSION_SLOT}-linux-x64\.tar\.gz$`),
  },
  {
    label: ASSET_LABELS.sums,
    token: /\bSHA256SUMS(?:[.-][A-Za-z0-9._-]+)?\b/g,
    canonical: /^SHA256SUMS$/,
  },
];

/** Одно совпадение регулярки: значение и номер строки (с 1). */
interface Occurrence {
  value: string;
  line: number;
}

/** Все совпадения шаблона в тексте с номерами строк (флаг `g` не мутирует вход). */
function occurrences(text: string, pattern: RegExp): Occurrence[] {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  const result: Occurrence[] = [];
  for (const match of text.matchAll(re)) {
    const index = match.index ?? 0;
    result.push({ value: match[0], line: text.slice(0, index).split('\n').length });
  }
  return result;
}

/** Прочитать файл контракта с понятной ошибкой, если он пропал или переехал. */
function readReleaseFile(file: string, role: string): string {
  const abs = path.join(REPO_ROOT, file);
  assert.ok(
    fs.existsSync(abs),
    `Нет файла ${file} (${role}) — сторож имён ассетов не может проверить контракт. ` +
      'Если файл переехал, обнови матрицу RELEASE_FILES.',
  );
  return fs.readFileSync(abs, 'utf8');
}

describe('guard: имена релизных ассетов', () => {
  it('каждый файл контракта знает обязательные для него имена ассетов', () => {
    const problems: string[] = [];

    for (const entry of RELEASE_FILES) {
      const text = readReleaseFile(entry.file, entry.role);
      for (const key of entry.requires) {
        if (occurrences(text, ASSET_TEMPLATES[key]).length === 0) {
          problems.push(
            `${entry.file} (${entry.role}): нет имени ${ASSET_LABELS[key]} ` +
              'в каноническом шаблоне',
          );
        }
      }
    }

    assert.deepEqual(
      problems,
      [],
      `Контракт имён ассетов нарушен:\n${problems.map((p) => `  • ${p}`).join('\n')}\n\n` +
        'Имена ассетов — общий контракт workflow, install.sh, тела релиза и ' +
        'update-checker: переименование в одном месте ломает остальные. ' +
        'Правь все четыре файла сразу.',
    );
  });

  it('в файлах контракта нет имён ассетов вне канонического шаблона', () => {
    const problems: string[] = [];

    for (const entry of RELEASE_FILES) {
      const text = readReleaseFile(entry.file, entry.role);
      for (const pattern of ASSET_TOKENS) {
        for (const found of occurrences(text, pattern.token)) {
          if (pattern.canonical.test(found.value)) continue;
          problems.push(
            `${entry.file}:${found.line}: «${found.value}» не соответствует ` +
              `${pattern.label} (${pattern.canonical.source})`,
          );
        }
      }
    }

    assert.deepEqual(
      problems,
      [],
      `Найдены имена ассетов вне контракта (${problems.length}):\n` +
        `${problems.map((p) => `  • ${p}`).join('\n')}\n\n` +
        'Канон: ETN-Setup-<version>.exe, etn-server-<version>.tar.gz, ' +
        'ETN-Client-<version>-linux-x64.tar.gz, SHA256SUMS. Устаревшие имена ' +
        '(ETN.Setup, .msi, .AppImage, .deb, .dmg, SHA256SUMS.txt) возвращать нельзя: ' +
        'их не ждут install.sh, тело релиза и update-checker.',
    );
  });
});

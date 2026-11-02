/**
 * Проверка канала обновлений сервера и кеш версий (задача 8264988a, сущность
 * 6f79610d, требование d3ed341b, ADR 23a931f9).
 *
 * Покрытие DoD: пустой ответ фида, невалидный фид, отсутствие `SHA256SUMS`,
 * отсутствие строки ассета в `SHA256SUMS`, prerelease на канале `stable`,
 * отфильтрованный downgrade, ошибка сети не обнуляет последний успешный
 * результат, интервал 12 часов на фейковых часах, стартовая проверка не
 * блокирует старт сервера. Отдельно — конфигурация `ETN_UPDATE_*` и режим
 * развёртывания `ETN_DEPLOYMENT`.
 *
 * Фикстуры — метаданные фида в формате GitHub Releases API: это внешний
 * контракт (не данные мыслесети), поэтому собираются явно, а не нарезаются из
 * экспорта «Тест 1».
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConfigError, DEFAULT_UPDATE_CONFIG, loadConfig } from '../src/config.js';
import {
  DEFAULT_UPDATE_CHECK_INTERVAL_MS,
  DEFAULT_UPDATE_FEED_URL,
  MAX_UPDATE_CHECK_INTERVAL_MS,
  MIN_UPDATE_CHECK_INTERVAL_MS,
  SHA256SUMS_ASSET_NAME,
  UpdateCheckInProgressError,
  createUpdateChecker,
  installerAssetName,
  parseSha256Sums,
  parseUpdateFeed,
  selectUpdateCandidate,
  startUpdateCheckScheduler,
  type UpdateCache,
  type UpdateChannel,
  type UpdateFetch,
  type UpdateFeedAsset,
  type UpdateFeedRelease,
  type UpdateFetchResponse,
  type UpdateSchedulerTimers,
} from '../src/update/checker.js';
import {
  DOCKER_MARKER_PATH,
  DeploymentConfigError,
  resolveDeployment,
  type Deployment,
} from '../src/update/deployment.js';

/** Адрес тестового фида. */
const FEED = 'https://feed.test/releases';

/** Два разных «правильных» хеша. */
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

/** Адрес ассета в тестовом фиде. */
function assetUrl(version: string, name: string): string {
  return `https://feed.test/download/v${version}/${name}`;
}

/** Параметры тестового релиза. */
interface ReleaseOptions {
  /** Версия без `v`; тег — `v<версия>`. */
  version: string;
  /** GitHub-флаг prerelease (даже если тег без суффикса). */
  prerelease?: boolean;
  draft?: boolean;
  /** Не прикладывать установщик. */
  noInstaller?: boolean;
  /** Не прикладывать `SHA256SUMS` (`null` — ассета нет). */
  noSums?: boolean;
  /** Тело `SHA256SUMS`; по умолчанию строка установщика с {@link HASH_A}. */
  sumsBody?: string;
}

/** Собрать релиз в формате GitHub Releases API. */
function makeRelease(options: ReleaseOptions): UpdateFeedRelease {
  const installer = installerAssetName(options.version);
  const assets: UpdateFeedAsset[] = [];
  if (options.noInstaller !== true) {
    assets.push({ name: installer, browser_download_url: assetUrl(options.version, installer) });
  }
  if (options.noSums !== true) {
    assets.push({
      name: SHA256SUMS_ASSET_NAME,
      browser_download_url: assetUrl(options.version, SHA256SUMS_ASSET_NAME),
    });
  }
  return {
    tag_name: `v${options.version}`,
    prerelease: options.prerelease === true,
    draft: options.draft === true,
    assets,
  };
}

/** Тело `SHA256SUMS` для версии. */
function sumsBody(version: string, hash = HASH_A): string {
  return `${hash}  ${installerAssetName(version)}\n`;
}

/** Ответ фида/ассета. */
function response(status: number, body: string): UpdateFetchResponse {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

/** Маршруты поддельного HTTP-клиента: адрес → ответ или ошибка. */
type Routes = Record<string, { status?: number; body?: string; error?: Error }>;

/** Поддельный HTTP-клиент: пишет запрошенные адреса в `calls`. */
function fakeFetch(routes: Routes, calls: string[]): UpdateFetch {
  return async (url) => {
    calls.push(url);
    const route = routes[url];
    if (route === undefined) {
      throw new Error(`неожиданный запрос: ${url}`);
    }
    if (route.error !== undefined) {
      throw route.error;
    }
    return response(route.status ?? 200, route.body ?? '');
  };
}

/** «Ворота» для подвешивания запроса: промис и функция открытия. */
function deferredGate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Фиксированные часы, сдвигаемые тестом. */
function fakeClock(startIso: string): { now: () => Date; advance: (ms: number) => void } {
  let current = new Date(startIso).getTime();
  return {
    now: () => new Date(current),
    advance: (ms) => {
      current += ms;
    },
  };
}

/** Обновления нет: успешная проверка, версия не предлагается. */
function assertNoUpdate(cache: UpdateCache): void {
  assert.equal(cache.available_version, null);
  assert.equal(cache.download_url, null);
  assert.equal(cache.sha256, null);
  assert.equal(cache.check_error, null);
  assert.notEqual(cache.checked_at, null);
}

describe('Конфигурация канала обновлений (ETN_UPDATE_*)', () => {
  const ENV = { ETN_DATA_DIR: '/tmp/etn-update-config' };

  it('по умолчанию: GitHub Releases, stable, 12 часов, standalone', () => {
    const cfg = loadConfig(ENV, { deployment: 'standalone' });
    assert.equal(cfg.update.feedUrl, DEFAULT_UPDATE_FEED_URL);
    assert.equal(cfg.update.channel, 'stable');
    assert.equal(cfg.update.intervalMs, 12 * 60 * 60 * 1000);
    assert.equal(cfg.update.intervalMs, DEFAULT_UPDATE_CHECK_INTERVAL_MS);
    assert.equal(cfg.deployment, 'standalone');
  });

  it('читает фид, канал и интервал из окружения', () => {
    const cfg = loadConfig(
      {
        ...ENV,
        ETN_UPDATE_FEED: 'http://mirror.local/etn/releases.json',
        ETN_UPDATE_CHANNEL: 'PRERELEASE',
        ETN_UPDATE_CHECK_INTERVAL_HOURS: '1.5',
      },
      { deployment: 'windows-service' },
    );
    assert.equal(cfg.update.feedUrl, 'http://mirror.local/etn/releases.json');
    assert.equal(cfg.update.channel, 'prerelease');
    assert.equal(cfg.update.intervalMs, Math.round(1.5 * 60 * 60 * 1000));
    assert.equal(cfg.deployment, 'windows-service');
  });

  it('отклоняет неизвестный канал', () => {
    assert.throws(
      () => loadConfig({ ...ENV, ETN_UPDATE_CHANNEL: 'beta' }, { deployment: 'standalone' }),
      (err: unknown) => err instanceof ConfigError && /ETN_UPDATE_CHANNEL/.test(err.message),
    );
  });

  it('отклоняет интервал меньше часа и не-число', () => {
    for (const value of ['0', '0.5', 'abc', '-12']) {
      assert.throws(
        () =>
          loadConfig(
            { ...ENV, ETN_UPDATE_CHECK_INTERVAL_HOURS: value },
            { deployment: 'standalone' },
          ),
        (err: unknown) =>
          err instanceof ConfigError && /ETN_UPDATE_CHECK_INTERVAL_HOURS/.test(err.message),
        value,
      );
    }
  });

  it('отклоняет интервал больше платформенного потолка setInterval', () => {
    const tooLong = MAX_UPDATE_CHECK_INTERVAL_MS / (60 * 60 * 1000) + 1;
    assert.throws(
      () =>
        loadConfig(
          { ...ENV, ETN_UPDATE_CHECK_INTERVAL_HOURS: String(tooLong) },
          { deployment: 'standalone' },
        ),
      (err: unknown) =>
        err instanceof ConfigError && /ETN_UPDATE_CHECK_INTERVAL_HOURS/.test(err.message),
    );
  });

  it('отклоняет фид не-URL и не-http(s) схему', () => {
    for (const feed of ['mirror.local/releases', 'ftp://mirror.local/releases']) {
      assert.throws(
        () => loadConfig({ ...ENV, ETN_UPDATE_FEED: feed }, { deployment: 'standalone' }),
        (err: unknown) => err instanceof ConfigError && /ETN_UPDATE_FEED/.test(err.message),
        feed,
      );
    }
  });

  it('ETN_DEPLOYMENT: известные значения принимаются, мусор отклоняется', () => {
    for (const mode of ['docker', 'windows-service', 'standalone'] as Deployment[]) {
      const cfg = loadConfig({ ...ENV, ETN_DEPLOYMENT: mode });
      assert.equal(cfg.deployment, mode);
    }
    assert.throws(
      () => loadConfig({ ...ENV, ETN_DEPLOYMENT: 'kubernetes' }),
      (err: unknown) => err instanceof ConfigError && /ETN_DEPLOYMENT/.test(err.message),
    );
  });

  it('DEFAULT_UPDATE_CONFIG совпадает с дефолтами загрузчика', () => {
    const cfg = loadConfig(ENV, { deployment: 'standalone' });
    assert.deepEqual(cfg.update, DEFAULT_UPDATE_CONFIG);
  });
});

describe('Режим развёртывания (resolveDeployment)', () => {
  it('явный ETN_DEPLOYMENT перекрывает маркер контейнера', () => {
    assert.equal(
      resolveDeployment(
        { ETN_DEPLOYMENT: 'standalone' },
        { platform: 'linux', exists: (p) => p === DOCKER_MARKER_PATH },
      ),
      'standalone',
    );
  });

  it('маркер /.dockerenv на Linux даёт docker', () => {
    assert.equal(
      resolveDeployment({}, { platform: 'linux', exists: (p) => p === DOCKER_MARKER_PATH }),
      'docker',
    );
  });

  it('без маркера — standalone', () => {
    assert.equal(resolveDeployment({}, { platform: 'linux', exists: () => false }), 'standalone');
  });

  it('на Windows маркер не проверяется (ложное срабатывание исключено)', () => {
    assert.equal(resolveDeployment({}, { platform: 'win32', exists: () => true }), 'standalone');
  });

  it('ETN_DEPLOYMENT=windows-service (окружение шаблона WinSW) — режим службы', () => {
    // Ошибка e375123f: шаблон службы передаёт windows-service; режим обязан
    // определяться и на Windows, и в Linux-контейнере (явная переменная
    // перекрывает маркер /.dockerenv).
    for (const platform of ['win32', 'linux'] as NodeJS.Platform[]) {
      assert.equal(
        resolveDeployment(
          { ETN_DEPLOYMENT: 'windows-service' },
          { platform, exists: (p) => p === DOCKER_MARKER_PATH },
        ),
        'windows-service',
        platform,
      );
    }
  });

  it('без ETN_DEPLOYMENT (режим app) — standalone', () => {
    assert.equal(
      resolveDeployment({}, { platform: 'win32', exists: () => false }),
      'standalone',
    );
  });

  it('неизвестный ETN_DEPLOYMENT — DeploymentConfigError', () => {
    assert.throws(
      () => resolveDeployment({ ETN_DEPLOYMENT: 'vm' }),
      (err: unknown) => err instanceof DeploymentConfigError && /ETN_DEPLOYMENT/.test(err.message),
    );
  });
});

describe('parseSha256SUMS', () => {
  it('читает строки в формате «хеш + два пробела + имя»', () => {
    const sums = parseSha256Sums(
      `${HASH_A}  ETN-Setup-0.15.1.exe\n${HASH_B}  etn-client-0.15.1.tar.gz\n`,
    );
    assert.equal(sums.get('ETN-Setup-0.15.1.exe'), HASH_A);
    assert.equal(sums.get('etn-client-0.15.1.tar.gz'), HASH_B);
    assert.equal(sums.size, 2);
  });

  it('нормализует регистр хеша и допускает «*» и табы', () => {
    const sums = parseSha256Sums(`${HASH_A.toUpperCase()}\t*ETN-Setup-0.15.1.exe\r\n`);
    assert.equal(sums.get('ETN-Setup-0.15.1.exe'), HASH_A);
  });

  it('игнорирует мусорные строки и повторы имени', () => {
    const sums = parseSha256Sums(
      `\nне-хеш  ETN-Setup-0.15.1.exe\n${HASH_A}  ETN-Setup-0.15.1.exe\n${HASH_B}  ETN-Setup-0.15.1.exe\n`,
    );
    assert.equal(sums.get('ETN-Setup-0.15.1.exe'), HASH_A);
    assert.equal(sums.size, 1);
  });
});

describe('parseUpdateFeed', () => {
  it('пустой список — валидный ответ', () => {
    assert.deepEqual(parseUpdateFeed([]), []);
  });

  it('отклоняет не-массив и элементы без tag_name', () => {
    for (const payload of [
      { message: 'Not Found' },
      'html',
      null,
      [{}],
      [{ tag_name: '' }],
      [42],
    ]) {
      assert.throws(() => parseUpdateFeed(payload), /фида|tag_name/i);
    }
  });

  it('отклоняет битый список ассетов', () => {
    assert.throws(() => parseUpdateFeed([{ tag_name: 'v0.15.1', assets: {} }]), /assets/);
    assert.throws(
      () => parseUpdateFeed([{ tag_name: 'v0.15.1', assets: [{ name: 'x' }] }]),
      /browser_download_url/,
    );
  });

  it('читает реальную форму релиза с посторонними полями', () => {
    const releases = parseUpdateFeed([
      {
        tag_name: 'v0.15.1',
        name: 'ETN 0.15.1',
        draft: false,
        prerelease: true,
        published_at: '2026-10-29T00:00:00Z',
        html_url: 'https://github.com/nerkuda/e-tho-net/releases/tag/v0.15.1',
        assets: [
          {
            name: 'ETN-Setup-0.15.1.exe',
            size: 123,
            browser_download_url: assetUrl('0.15.1', 'ETN-Setup-0.15.1.exe'),
            content_type: 'application/octet-stream',
          },
        ],
      },
    ]);
    assert.equal(releases.length, 1);
    assert.equal(releases[0]?.prerelease, true);
    assert.equal(releases[0]?.assets.length, 1);
    assert.equal(releases[0]?.assets[0]?.name, 'ETN-Setup-0.15.1.exe');
  });
});

describe('selectUpdateCandidate', () => {
  const current = '0.15.1';

  it('выбирает самую новую версию выше текущей', () => {
    const candidate = selectUpdateCandidate(
      [makeRelease({ version: '0.15.2' }), makeRelease({ version: '0.15.3' })],
      { currentVersion: current, channel: 'stable' },
    );
    assert.equal(candidate?.version, '0.15.3');
  });

  it('на stable пропускает prerelease (и по тегу, и по флагу релиза)', () => {
    // Только prerelease-тег.
    assert.equal(
      selectUpdateCandidate([makeRelease({ version: '0.15.2-rc.1' })], {
        currentVersion: current,
        channel: 'stable',
      }),
      null,
    );
    // Обычный тег, но релиз помечен prerelease.
    assert.equal(
      selectUpdateCandidate([makeRelease({ version: '0.15.2', prerelease: true })], {
        currentVersion: current,
        channel: 'stable',
      }),
      null,
    );
    // Обычный релиз предлагается.
    const candidate = selectUpdateCandidate(
      [
        makeRelease({ version: '0.15.2-rc.1' }),
        makeRelease({ version: '0.15.2', prerelease: true }),
        makeRelease({ version: '0.15.2' }),
      ],
      { currentVersion: current, channel: 'stable' },
    );
    assert.equal(candidate?.version, '0.15.2');
    assert.equal(candidate?.release.prerelease, false);
  });

  it('на prerelease принимает prerelease и обычные релизы', () => {
    const candidate = selectUpdateCandidate(
      [makeRelease({ version: '0.15.2' }), makeRelease({ version: '0.16.0-rc.1' })],
      { currentVersion: current, channel: 'prerelease' },
    );
    assert.equal(candidate?.version, '0.16.0-rc.1');
  });

  it('отфильтровывает downgrade и текущую версию', () => {
    const candidate = selectUpdateCandidate(
      [makeRelease({ version: '0.15.0' }), makeRelease({ version: '0.15.1' })],
      { currentVersion: current, channel: 'stable' },
    );
    assert.equal(candidate, null);
  });

  it('пропускает черновики и теги не-semver', () => {
    const candidate = selectUpdateCandidate(
      [
        makeRelease({ version: '0.15.9', draft: true }),
        { ...makeRelease({ version: '0.15.8' }), tag_name: 'nightly' },
        makeRelease({ version: '0.15.2' }),
      ],
      { currentVersion: current, channel: 'stable' },
    );
    assert.equal(candidate?.version, '0.15.2');
  });
});

describe('createUpdateChecker', () => {
  /** Собрать сервис с поддельным HTTP-клиентом и фиксированными часами. */
  function buildChecker(options: {
    releases?: UpdateFeedRelease[];
    routes?: Routes;
    channel?: UpdateChannel;
    currentVersion?: string;
    deployment?: Deployment;
    fetchImpl?: UpdateFetch;
    calls?: string[];
  }): {
    cache: () => UpdateCache;
    checker: ReturnType<typeof createUpdateChecker>;
    calls: string[];
  } {
    const calls = options.calls ?? [];
    const routes: Routes = { ...options.routes };
    if (routes[FEED] === undefined) {
      routes[FEED] = { body: JSON.stringify(options.releases ?? []) };
    }
    const clock = fakeClock('2026-10-29T12:00:00.000Z');
    const checker = createUpdateChecker({
      feedUrl: FEED,
      channel: options.channel ?? 'stable',
      currentVersion: options.currentVersion ?? '0.15.1',
      deployment: options.deployment ?? 'standalone',
      fetchImpl: options.fetchImpl ?? fakeFetch(routes, calls),
      now: clock.now,
    });
    return { cache: () => checker.getCache(), checker, calls };
  }

  it('пустой ответ фида: обновлений нет, ошибки нет', async () => {
    const { checker, calls } = buildChecker({ releases: [] });
    const cache = await checker.checkNow();
    assertNoUpdate(cache);
    assert.equal(cache.current_version, '0.15.1');
    assert.equal(cache.channel, 'stable');
    assert.equal(cache.deployment, 'standalone');
    assert.deepEqual(calls, [FEED], 'при пустом фиде ассеты не запрашиваются');
  });

  it('находит версию, берёт ссылку и хеш из SHA256SUMS; установщик не скачивается', async () => {
    const release = makeRelease({ version: '0.15.2' });
    const { checker, calls } = buildChecker({
      releases: [release],
      routes: { [assetUrl('0.15.2', SHA256SUMS_ASSET_NAME)]: { body: sumsBody('0.15.2') } },
    });
    const cache = await checker.checkNow();
    assert.equal(cache.available_version, '0.15.2');
    assert.equal(cache.download_url, assetUrl('0.15.2', 'ETN-Setup-0.15.2.exe'));
    assert.equal(cache.sha256, HASH_A);
    assert.equal(cache.check_error, null);
    assert.equal(cache.checked_at, '2026-10-29T12:00:00.000Z');
    assert.deepEqual(calls, [FEED, assetUrl('0.15.2', SHA256SUMS_ASSET_NAME)]);
    assert.equal(
      calls.includes(assetUrl('0.15.2', 'ETN-Setup-0.15.2.exe')),
      false,
      'установщик на этапе проверки не скачивается',
    );
  });

  it('нет SHA256SUMS — версия непригодна', async () => {
    const { checker } = buildChecker({
      releases: [makeRelease({ version: '0.15.2', noSums: true })],
    });
    const cache = await checker.checkNow();
    assert.equal(cache.available_version, null);
    assert.match(cache.check_error ?? '', /SHA256SUMS/);
  });

  it('в SHA256SUMS нет строки установщика — версия непригодна', async () => {
    const { checker } = buildChecker({
      releases: [makeRelease({ version: '0.15.2' })],
      routes: {
        [assetUrl('0.15.2', SHA256SUMS_ASSET_NAME)]: {
          body: `${HASH_B}  etn-client-0.15.2.tar.gz\n`,
        },
      },
    });
    const cache = await checker.checkNow();
    assert.equal(cache.available_version, null);
    assert.match(cache.check_error ?? '', /нет хеша для ETN-Setup-0\.15\.2\.exe/);
  });

  it('нет установщика в релизе — версия непригодна', async () => {
    const { checker } = buildChecker({
      releases: [makeRelease({ version: '0.15.2', noInstaller: true })],
    });
    const cache = await checker.checkNow();
    assert.equal(cache.available_version, null);
    assert.match(cache.check_error ?? '', /нет установщика ETN-Setup-0\.15\.2\.exe/);
  });

  it('непригодная самая новая версия не подменяется более старой', async () => {
    const { checker } = buildChecker({
      releases: [
        makeRelease({ version: '0.15.2' }),
        makeRelease({ version: '0.15.3', noSums: true }),
      ],
      routes: { [assetUrl('0.15.2', SHA256SUMS_ASSET_NAME)]: { body: sumsBody('0.15.2') } },
    });
    const cache = await checker.checkNow();
    assert.equal(cache.available_version, null);
    assert.match(cache.check_error ?? '', /0\.15\.3/);
  });

  it('prerelease на stable не предлагается, на prerelease — предлагается', async () => {
    const release = makeRelease({ version: '0.15.2-rc.1' });
    const stable = buildChecker({ releases: [release] });
    assertNoUpdate(await stable.checker.checkNow());

    const pre = buildChecker({
      releases: [release],
      channel: 'prerelease',
      routes: {
        [assetUrl('0.15.2-rc.1', SHA256SUMS_ASSET_NAME)]: { body: sumsBody('0.15.2-rc.1') },
      },
    });
    const cache = await pre.checker.checkNow();
    assert.equal(cache.available_version, '0.15.2-rc.1');
    assert.equal(cache.channel, 'prerelease');
  });

  it('downgrade отфильтрован', async () => {
    const { checker } = buildChecker({ releases: [makeRelease({ version: '0.15.0' })] });
    assertNoUpdate(await checker.checkNow());
  });

  it('ошибка сети на первой проверке: кеш пуст, ошибка записана', async () => {
    const { checker } = buildChecker({
      fetchImpl: async () => {
        throw new Error('getaddrinfo ENOTFOUND feed.test');
      },
    });
    const cache = await checker.checkNow();
    assert.equal(cache.available_version, null);
    assert.match(cache.check_error ?? '', /Фид обновлений: запрос не выполнен/);
  });

  it('ошибка сети после успешной проверки не обнуляет последний результат', async () => {
    const release = makeRelease({ version: '0.15.2' });
    const calls: string[] = [];
    const routes: Routes = {
      [FEED]: { body: JSON.stringify([release]) },
      [assetUrl('0.15.2', SHA256SUMS_ASSET_NAME)]: { body: sumsBody('0.15.2') },
    };
    const clock = fakeClock('2026-10-29T12:00:00.000Z');
    let fail = false;
    const fetchImpl: UpdateFetch = async (url, init) => {
      if (fail) throw new Error('ETIMEDOUT');
      return fakeFetch(routes, calls)(url, init);
    };
    const checker = createUpdateChecker({
      feedUrl: FEED,
      channel: 'stable',
      currentVersion: '0.15.1',
      deployment: 'standalone',
      fetchImpl,
      now: clock.now,
    });

    const first = await checker.checkNow();
    assert.equal(first.available_version, '0.15.2');
    const firstCheckedAt = first.checked_at;

    clock.advance(60_000);
    fail = true;
    const second = await checker.checkNow();
    assert.equal(second.available_version, '0.15.2', 'последний успешный результат сохранён');
    assert.equal(second.download_url, assetUrl('0.15.2', 'ETN-Setup-0.15.2.exe'));
    assert.equal(second.sha256, HASH_A);
    assert.match(second.check_error ?? '', /ETIMEDOUT/);
    assert.notEqual(second.checked_at, firstCheckedAt, 'время попытки обновлено');

    // Следующая успешная проверка очищает ошибку.
    fail = false;
    clock.advance(60_000);
    const third = await checker.checkNow();
    assert.equal(third.check_error, null);
    assert.equal(third.available_version, '0.15.2');
  });

  it('невалидный фид: не-JSON и не-список релизов', async () => {
    const nonJson = buildChecker({ routes: { [FEED]: { body: '<html>404</html>' } } });
    assert.match((await nonJson.checker.checkNow()).check_error ?? '', /не JSON/);

    const nonList = buildChecker({
      routes: { [FEED]: { body: JSON.stringify({ message: 'Not Found' }) } },
    });
    assert.match((await nonList.checker.checkNow()).check_error ?? '', /не список релизов/);
  });

  it('HTTP-ошибка фида попадает в check_error', async () => {
    const { checker } = buildChecker({ routes: { [FEED]: { status: 503, body: '' } } });
    const cache = await checker.checkNow();
    assert.match(cache.check_error ?? '', /Фид обновлений: HTTP 503/);
  });

  it('Docker: версия видна, ссылки и хеша нет', async () => {
    const { checker } = buildChecker({
      releases: [makeRelease({ version: '0.15.2' })],
      deployment: 'docker',
      routes: { [assetUrl('0.15.2', SHA256SUMS_ASSET_NAME)]: { body: sumsBody('0.15.2') } },
    });
    const cache = await checker.checkNow();
    assert.equal(cache.available_version, '0.15.2');
    assert.equal(cache.download_url, null);
    assert.equal(cache.sha256, null);
    assert.equal(cache.deployment, 'docker');
  });

  it('невалидная текущая версия — ошибка проверки, не исключение', async () => {
    const { checker } = buildChecker({ releases: [], currentVersion: '0.15' });
    const cache = await checker.checkNow();
    assert.equal(cache.available_version, null);
    assert.match(cache.check_error ?? '', /не является semver/);
  });

  it('вторая проверка во время первой отклоняется (429 у эндпоинта)', async () => {
    const gate = deferredGate();
    const fetchImpl: UpdateFetch = async (url) => {
      await gate.promise;
      return response(url === FEED ? 200 : 404, '[]');
    };
    const checker = createUpdateChecker({
      feedUrl: FEED,
      channel: 'stable',
      currentVersion: '0.15.1',
      deployment: 'standalone',
      fetchImpl,
    });
    const first = checker.checkNow();
    assert.equal(checker.isCheckInProgress(), true);
    await assert.rejects(() => checker.checkNow(), UpdateCheckInProgressError);
    gate.open();
    await first;
    assert.equal(checker.isCheckInProgress(), false);
  });
});

describe('startUpdateCheckScheduler', () => {
  /** Ручные таймеры: «фейковые часы» без реального ожидания. */
  interface ManualInterval {
    handler: () => void;
    intervalMs: number;
    cleared: boolean;
  }

  function manualTimers(): { timers: UpdateSchedulerTimers; intervals: ManualInterval[] } {
    const intervals: ManualInterval[] = [];
    return {
      intervals,
      timers: {
        setInterval(handler, intervalMs) {
          const entry: ManualInterval = { handler, intervalMs, cleared: false };
          intervals.push(entry);
          return entry;
        },
        clearInterval(handle) {
          (handle as ManualInterval).cleared = true;
        },
      },
    };
  }

  it('запускается при старте и не блокирует запуск', async () => {
    const gate = deferredGate();
    let calls = 0;
    const checker = createUpdateChecker({
      feedUrl: FEED,
      channel: 'stable',
      currentVersion: '0.15.1',
      deployment: 'standalone',
      fetchImpl: async () => {
        calls += 1;
        await gate.promise;
        return response(200, '[]');
      },
    });
    const { timers } = manualTimers();
    const scheduler = startUpdateCheckScheduler({
      checker,
      intervalMs: DEFAULT_UPDATE_CONFIG.intervalMs,
      timers,
    });
    // Планировщик вернул ручку, хотя проверка ещё висит на сети.
    assert.equal(calls, 1);
    gate.open();
    await scheduler.started;
    scheduler.stop();
  });

  it('интервал по умолчанию — 12 часов; тик запускает проверку', async () => {
    let calls = 0;
    const checker = createUpdateChecker({
      feedUrl: FEED,
      channel: 'stable',
      currentVersion: '0.15.1',
      deployment: 'standalone',
      fetchImpl: async () => {
        calls += 1;
        return response(200, '[]');
      },
    });
    const { timers, intervals } = manualTimers();
    const scheduler = startUpdateCheckScheduler({
      checker,
      intervalMs: DEFAULT_UPDATE_CONFIG.intervalMs,
      timers,
    });
    await scheduler.started;
    assert.equal(calls, 1);
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0]?.intervalMs, 12 * 60 * 60 * 1000);
    assert.equal(DEFAULT_UPDATE_CHECK_INTERVAL_MS, 12 * 60 * 60 * 1000);

    assert.equal(MIN_UPDATE_CHECK_INTERVAL_MS, 60 * 60 * 1000);
    assert.ok(MAX_UPDATE_CHECK_INTERVAL_MS > MIN_UPDATE_CHECK_INTERVAL_MS);

    intervals[0]?.handler();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 2, 'тик через 12 часов запускает новую проверку');
    scheduler.stop();
  });

  it('ошибка стартовой проверки не отклоняет started и не роняет планировщик', async () => {
    let calls = 0;
    const checker = createUpdateChecker({
      feedUrl: FEED,
      channel: 'stable',
      currentVersion: '0.15.1',
      deployment: 'standalone',
      fetchImpl: async () => {
        calls += 1;
        throw new Error('network down');
      },
    });
    const { timers, intervals } = manualTimers();
    const scheduler = startUpdateCheckScheduler({
      checker,
      intervalMs: DEFAULT_UPDATE_CONFIG.intervalMs,
      timers,
    });
    await scheduler.started;
    assert.equal(checker.getCache().check_error !== null, true);

    intervals[0]?.handler();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 2);
    scheduler.stop();
  });

  it('stop очищает таймер и гасит следующий запуск', async () => {
    let calls = 0;
    const checker = createUpdateChecker({
      feedUrl: FEED,
      channel: 'stable',
      currentVersion: '0.15.1',
      deployment: 'standalone',
      fetchImpl: async () => {
        calls += 1;
        return response(200, '[]');
      },
    });
    const { timers, intervals } = manualTimers();
    const scheduler = startUpdateCheckScheduler({
      checker,
      intervalMs: DEFAULT_UPDATE_CONFIG.intervalMs,
      timers,
    });
    await scheduler.started;
    scheduler.stop();
    assert.equal(intervals[0]?.cleared, true);
    intervals[0]?.handler();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 1, 'после stop проверка не запускается');
  });
});

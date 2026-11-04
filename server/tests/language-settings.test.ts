/**
 * Настройки языков: сервер, сеть, профиль пользователя
 * (ADR daab6ac4 «Язык серверных поверхностей», задача f99f0542).
 *
 * Проверяется весь контракт серверной части:
 *
 *   * права трёх уровней (админ сервера / владелец сети / сам пользователь);
 *   * резолвинг эффективного языка по цепочке `пользователь → сеть → сервер`
 *     (все ветки: user, network, server) и отсутствие `null` наружу;
 *   * REST-контракт `GET/PUT /admin/settings/language` и
 *     `GET /users/me/language-settings`;
 *   * WebSocket: кадр готовности `ready { language, source }` и событие
 *     `settings.language` при смене языка сети/сервера — только затронутым
 *     сокетам, чей эффективный язык реально изменился.
 *
 * HTTP-часть идёт через `app.inject`; WebSocket-часть слушает эфемерный порт,
 * потому что `inject` не умеет WebSocket.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { WebSocket } from 'ws';

import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  createPlainUser,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';

interface LanguageSettingsBody {
  language: string | null;
  networks: Array<{
    network_id: string;
    language: string | null;
    effective: { language: string; source: 'user' | 'network' | 'server' };
    can_edit: boolean;
  }>;
}

interface Frame {
  type?: string;
  language?: string;
  source?: string;
  [key: string]: unknown;
}

/** Подключиться к `/api/v1/realtime` и вернуть сокет вместе с очередью кадров. */
function connect(
  port: number,
  networkId: string,
  key: string,
): { socket: WebSocket; next: (match: (frame: Frame) => boolean, label: string) => Promise<Frame> } {
  const url = new URL(`ws://127.0.0.1:${port}/api/v1/realtime`);
  url.searchParams.set('network_id', networkId);
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${key}` } });
  const queue: Frame[] = [];
  const waiters: Array<{ match: (frame: Frame) => boolean; resolve: (frame: Frame) => void }> = [];

  socket.on('message', (raw: Buffer) => {
    let frame: Frame;
    try {
      frame = JSON.parse(raw.toString()) as Frame;
    } catch {
      return;
    }
    const waiterIndex = waiters.findIndex((w) => w.match(frame));
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      waiter!.resolve(frame);
      return;
    }
    queue.push(frame);
  });

  const next = (
    match: (frame: Frame) => boolean,
    label: string,
    timeoutMs = 5_000,
  ): Promise<Frame> => {
    const index = queue.findIndex(match);
    if (index >= 0) {
      const [frame] = queue.splice(index, 1);
      return Promise.resolve(frame!);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        match,
        resolve: (frame: Frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      };
      const timer = setTimeout(() => {
        const waiterIndex = waiters.indexOf(waiter);
        if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
        reject(new Error(`frame not received: ${label} (queue: ${JSON.stringify(queue)})`));
      }, timeoutMs);
      waiters.push(waiter);
    });
  };

  return { socket, next };
}

function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
}

function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    socket.once('close', () => resolve());
    socket.close();
  });
}

/** Убедиться, что за отведённое окно подходящий кадр НЕ пришёл. */
async function expectNoFrame(
  next: (match: (frame: Frame) => boolean, label: string, timeoutMs?: number) => Promise<Frame>,
  match: (frame: Frame) => boolean,
  label: string,
): Promise<void> {
  await assert.rejects(
    next(match, label, 500),
    /frame not received/,
    `неожиданный кадр: ${label}`,
  );
}

function languageOf(body: LanguageSettingsBody, networkId: string) {
  const network = body.networks.find((n) => n.network_id === networkId);
  assert.ok(network !== undefined, `сеть ${networkId} в контракте настроек`);
  return network;
}

describe(
  'language settings (ADR daab6ac4, f99f0542)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('server level: default en, admin-only read/write, tag validation', async () => {
      const ctx: RestTestContext = await buildRestContext();
      try {
        const h = authHeaders(ctx);

        // Дефолт — английский (ADR §1).
        const initial = await ctx.app.inject({
          method: 'GET',
          url: '/api/v1/admin/settings/language',
          headers: h,
        });
        assert.equal(initial.statusCode, 200);
        assert.deepEqual(initial.json().data, { language: 'en' });

        // Не-админ читать/менять не может.
        const plain = createPlainUser(ctx);
        const forbiddenGet = await ctx.app.inject({
          method: 'GET',
          url: '/api/v1/admin/settings/language',
          headers: { authorization: `Bearer ${plain.key}` },
        });
        assert.equal(forbiddenGet.statusCode, 403);
        assert.equal(forbiddenGet.json().error.code, 'FORBIDDEN');
        const forbiddenPut = await ctx.app.inject({
          method: 'PUT',
          url: '/api/v1/admin/settings/language',
          headers: { authorization: `Bearer ${plain.key}` },
          payload: { language: 'ru' },
        });
        assert.equal(forbiddenPut.statusCode, 403);

        // Тег канонизируется (`RU` → `ru`).
        const changed = await ctx.app.inject({
          method: 'PUT',
          url: '/api/v1/admin/settings/language',
          headers: h,
          payload: { language: 'RU' },
        });
        assert.equal(changed.statusCode, 200);
        assert.deepEqual(changed.json().data, { language: 'ru' });
        const readBack = await ctx.app.inject({
          method: 'GET',
          url: '/api/v1/admin/settings/language',
          headers: h,
        });
        assert.deepEqual(readBack.json().data, { language: 'ru' });

        // Некорректный синтаксис тега — 422 с машиночитаемым полем.
        const invalid = await ctx.app.inject({
          method: 'PUT',
          url: '/api/v1/admin/settings/language',
          headers: h,
          payload: { language: 'en_US' },
        });
        assert.equal(invalid.statusCode, 422);
        assert.equal(invalid.json().error.code, 'VALIDATION_ERROR');
        assert.equal(invalid.json().error.details.field, 'language');
        // Неизменённое значение не пишется заново (идемпотентность по смыслу).
        const same = await ctx.app.inject({
          method: 'PUT',
          url: '/api/v1/admin/settings/language',
          headers: h,
          payload: { language: 'ru' },
        });
        assert.equal(same.statusCode, 200);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('network level: stored value, owner-only change, concrete tag survives server change', async () => {
      const ctx: RestTestContext = await buildRestContext();
      try {
        const h = authHeaders(ctx);

        // По умолчанию сеть наследует сервер.
        let settings = await ctx.app.inject({
          method: 'GET',
          url: '/api/v1/users/me/language-settings',
          headers: h,
        });
        assert.equal(settings.statusCode, 200);
        let body = settings.json().data as LanguageSettingsBody;
        assert.equal(body.language, null);
        assert.deepEqual(languageOf(body, ctx.networkId).effective, {
          language: 'en',
          source: 'server',
        });

        // Владелец ставит конкретный язык сети; тег канонизируется.
        const patched = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}`,
          headers: h,
          payload: { language: 'zh-hans' },
        });
        assert.equal(patched.statusCode, 200);
        assert.equal(patched.json().data.language, 'zh-Hans');

        // Смена языка сервера НЕ меняет конкретный выбор сети (ADR §2).
        await ctx.app.inject({
          method: 'PUT',
          url: '/api/v1/admin/settings/language',
          headers: h,
          payload: { language: 'ru' },
        });
        settings = await ctx.app.inject({
          method: 'GET',
          url: '/api/v1/users/me/language-settings',
          headers: h,
        });
        body = settings.json().data as LanguageSettingsBody;
        assert.deepEqual(languageOf(body, ctx.networkId).effective, {
          language: 'zh-Hans',
          source: 'network',
        });

        // Обычный участник менять язык сети не может.
        const member = createPlainUser(ctx);
        ctx.sys.addNetworkMember(ctx.networkId, member.userId, 'member', ctx.adminId);
        ctx.app.members.invalidate(member.userId, ctx.networkId);
        const forbidden = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}`,
          headers: { authorization: `Bearer ${member.key}` },
          payload: { language: 'en' },
        });
        assert.equal(forbidden.statusCode, 403);
        assert.equal(forbidden.json().error.code, 'FORBIDDEN');

        // Передача владения: новый владелец (не админ) меняет язык сети.
        const transfer = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/members/${member.userId}`,
          headers: h,
          payload: { role: 'owner' },
        });
        assert.equal(transfer.statusCode, 204);
        ctx.app.members.invalidate();
        const ownerPatched = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}`,
          headers: { authorization: `Bearer ${member.key}` },
          payload: { language: 'en' },
        });
        assert.equal(ownerPatched.statusCode, 200);
        assert.equal(ownerPatched.json().data.language, 'en');

        // `null` — «использовать язык сервера»; эффективный язык падает на ru.
        const inherited = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}`,
          headers: { authorization: `Bearer ${member.key}` },
          payload: { language: null },
        });
        assert.equal(inherited.statusCode, 200);
        assert.equal(inherited.json().data.language, null);
        settings = await ctx.app.inject({
          method: 'GET',
          url: '/api/v1/users/me/language-settings',
          headers: h,
        });
        body = settings.json().data as LanguageSettingsBody;
        assert.deepEqual(languageOf(body, ctx.networkId).effective, {
          language: 'ru',
          source: 'server',
        });

        // Некорректный тег сети — 422.
        const invalid = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}`,
          headers: { authorization: `Bearer ${member.key}` },
          payload: { language: 'not a tag' },
        });
        assert.equal(invalid.statusCode, 422);
        assert.equal(invalid.json().error.details.field, 'language');
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('user level: app_language overrides networks, null inherits; stored per user', async () => {
      const ctx: RestTestContext = await buildRestContext();
      try {
        const h = authHeaders(ctx);

        // Конкретный язык сети — нижняя ступень для пользователя без своего.
        await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}`,
          headers: h,
          payload: { language: 'zh-Hans' },
        });
        await ctx.app.inject({
          method: 'PUT',
          url: '/api/v1/admin/settings/language',
          headers: h,
          payload: { language: 'ru' },
        });

        // Сам пользователь ставит «язык приложения»; тег канонизируется.
        const set = await ctx.app.inject({
          method: 'PUT',
          url: '/api/v1/users/me/settings/app_language',
          headers: h,
          payload: { value: 'EN' },
        });
        assert.equal(set.statusCode, 200);
        assert.deepEqual(set.json().data, { key: 'app_language', value: 'en' });

        let settings = await ctx.app.inject({
          method: 'GET',
          url: '/api/v1/users/me/language-settings',
          headers: h,
        });
        let body = settings.json().data as LanguageSettingsBody;
        assert.equal(body.language, 'en');
        assert.deepEqual(languageOf(body, ctx.networkId).effective, {
          language: 'en',
          source: 'user',
        });

        // `null` — «использовать язык сетей»: возвращаемся к языку сети.
        const cleared = await ctx.app.inject({
          method: 'PUT',
          url: '/api/v1/users/me/settings/app_language',
          headers: h,
          payload: { value: null },
        });
        assert.equal(cleared.statusCode, 200);
        assert.deepEqual(cleared.json().data, { key: 'app_language', value: null });
        settings = await ctx.app.inject({
          method: 'GET',
          url: '/api/v1/users/me/language-settings',
          headers: h,
        });
        body = settings.json().data as LanguageSettingsBody;
        assert.deepEqual(languageOf(body, ctx.networkId).effective, {
          language: 'zh-Hans',
          source: 'network',
        });

        // Некорректный тег — 422; настройка не записана.
        const invalid = await ctx.app.inject({
          method: 'PUT',
          url: '/api/v1/users/me/settings/app_language',
          headers: h,
          payload: { value: 'e n' },
        });
        assert.equal(invalid.statusCode, 422);
        assert.equal(invalid.json().error.details.field, 'value');
        settings = await ctx.app.inject({
          method: 'GET',
          url: '/api/v1/users/me/language-settings',
          headers: h,
        });
        assert.equal((settings.json().data as LanguageSettingsBody).language, null);

        // Настройка — уровне «пользователь × сервер»: второй пользователь
        // её не видит.
        const other = createPlainUser(ctx);
        ctx.sys.addNetworkMember(ctx.networkId, other.userId, 'member', ctx.adminId);
        ctx.app.members.invalidate(other.userId, ctx.networkId);
        const otherSettings = await ctx.app.inject({
          method: 'GET',
          url: '/api/v1/users/me/language-settings',
          headers: { authorization: `Bearer ${other.key}` },
        });
        assert.equal(otherSettings.statusCode, 200);
        const otherBody = otherSettings.json().data as LanguageSettingsBody;
        assert.equal(otherBody.language, null);
        assert.equal(languageOf(otherBody, ctx.networkId).can_edit, false);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('WebSocket: ready frame and settings.language on network/server change', async () => {
      const ctx: RestTestContext = await buildRestContext();
      try {
        await ctx.app.listen({ port: 0, host: '127.0.0.1' });
        const address = ctx.app.server.address();
        if (address === null || typeof address === 'string') {
          throw new Error('expected a TCP address');
        }
        const port = address.port;
        const h = authHeaders(ctx);

        // Сокет админа наследует сервер (en).
        const adminSocket = connect(port, ctx.networkId, ctx.adminKey);
        await waitForOpen(adminSocket.socket);
        const ready = await adminSocket.next((f) => f.type === 'ready', 'ready');
        assert.deepEqual(ready, { type: 'ready', language: 'en', source: 'server' });

        // Смена языка сервера — событие всем, кто наследует серверную ступень.
        await ctx.app.inject({
          method: 'PUT',
          url: '/api/v1/admin/settings/language',
          headers: h,
          payload: { language: 'ru' },
        });
        const serverChanged = await adminSocket.next(
          (f) => f.type === 'settings.language',
          'settings.language(server)',
        );
        assert.deepEqual(serverChanged, {
          type: 'settings.language',
          language: 'ru',
          source: 'server',
        });

        // Сокет участника с явным «языком приложения» — не затрагивается.
        const member = createPlainUser(ctx);
        ctx.sys.addNetworkMember(ctx.networkId, member.userId, 'member', ctx.adminId);
        ctx.app.members.invalidate(member.userId, ctx.networkId);
        ctx.sys.setUserSetting(member.userId, 'app_language', 'en');
        const memberSocket = connect(port, ctx.networkId, member.key);
        await waitForOpen(memberSocket.socket);
        const memberReady = await memberSocket.next((f) => f.type === 'ready', 'ready(member)');
        assert.deepEqual(memberReady, { type: 'ready', language: 'en', source: 'user' });

        // Смена языка сети: админ (наследует) получает событие, участник с
        // явным языком — нет.
        const patched = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}`,
          headers: h,
          payload: { language: 'zh-Hans' },
        });
        assert.equal(patched.statusCode, 200);
        const networkChanged = await adminSocket.next(
          (f) => f.type === 'settings.language',
          'settings.language(network)',
        );
        assert.deepEqual(networkChanged, {
          type: 'settings.language',
          language: 'zh-Hans',
          source: 'network',
        });
        await expectNoFrame(
          memberSocket.next,
          (f) => f.type === 'settings.language',
          'member with explicit app_language must not receive settings.language',
        );

        // Смена языка сервера при конкретном языке сети не меняет эффективный
        // язык админа — события нет.
        await ctx.app.inject({
          method: 'PUT',
          url: '/api/v1/admin/settings/language',
          headers: h,
          payload: { language: 'en' },
        });
        await expectNoFrame(
          adminSocket.next,
          (f) => f.type === 'settings.language',
          'network language shadows server change',
        );

        // Участник со снятым app_language теперь наследует сеть: при смене
        // языка сети получает событие.
        ctx.sys.setUserSetting(member.userId, 'app_language', null);
        const nextPatch = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}`,
          headers: h,
          payload: { language: 'en' },
        });
        assert.equal(nextPatch.statusCode, 200);
        const memberChanged = await memberSocket.next(
          (f) => f.type === 'settings.language',
          'settings.language(member, inherited)',
        );
        assert.deepEqual(memberChanged, {
          type: 'settings.language',
          language: 'en',
          source: 'network',
        });

        await closeSocket(memberSocket.socket);
        await closeSocket(adminSocket.socket);
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);

#!/usr/bin/env node
/**
 * Фикстура GUI-проверки ошибки eb6f5794 «статусная строка показывает события из
 * всех сетей, а не только активной вкладки».
 *
 * Стенд `ui-probe-stand.mjs` засеивает ОДНУ пробную сеть A (HOME + мысль с
 * комментарием). Для проверки нужна ВТОРАЯ мыслесеть B на том же сервере: в ней
 * сценарий создаст мысль, и её `thought.created` придёт в клиент по сокету
 * вкладки B. Сеть создаётся здесь (а не из страницы), чтобы id попал в
 * подстановки `{{netB}}` шагов `api` — раннер их видит, а переменные страницы
 * нет.
 *
 * Идемпотентность: сеть ищется по имени; повторный запуск на том же стенде её
 * переиспользует (требование стенда к фикстурам).
 *
 * Использование (аргументы передаёт стенд):
 *   node client/scripts/ui-probe.eb6f5794-seed.mjs \
 *     --data-dir .tmp/<стенд>/data --network-id <uuid> --center-id <uuid> \
 *     --api http://127.0.0.1:4417/api/v1 --api-key etn_…
 *
 * Печатает JSON: { netB, nameB }.
 */

const NETWORK_B_NAME = 'Соседняя сеть eb6f5794';

/** Аргументы вида `--name value`. */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    out[arg.slice(2)] = argv[i + 1];
    i += 1;
  }
  return out;
}

/** REST-вызов стенда: `data` разворачивается, ошибка — исключением. */
async function rest(base, key, method, apiPath, body) {
  const headers = { authorization: `Bearer ${key}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${apiPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // не-JSON — отдаём как есть
  }
  if (!res.ok) {
    throw new Error(`REST ${method} ${apiPath}: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  if (parsed !== null && typeof parsed === 'object' && 'data' in parsed) return parsed.data;
  return parsed;
}

async function main() {
  const argv = parseArgs(process.argv.slice(2));
  const api = argv.api;
  const key = argv['api-key'];
  if (typeof api !== 'string' || typeof key !== 'string') {
    throw new Error('фикстуре нужны --api и --api-key (их передаёт стенд)');
  }

  const networks = await rest(api, key, 'GET', '/networks');
  const list = Array.isArray(networks) ? networks : (networks.items ?? []);
  const existing = list.find((net) => net.display_name === NETWORK_B_NAME);
  const netB =
    existing ?? (await rest(api, key, 'POST', '/networks', { display_name: NETWORK_B_NAME }));

  // Последняя строка stdout — JSON: стенд превращает скаляры в `--var`.
  process.stdout.write(`${JSON.stringify({ netB: netB.id, nameB: NETWORK_B_NAME })}\n`);
}

main().catch((err) => {
  console.error(`[ui-probe.eb6f5794-seed] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

/**
 * Integration-тест: «после рестарта пользовательский размер не перетирается».
 *
 * Запуск:
 *   ./node_modules/.bin/electron --no-sandbox client/tests/window-bounds-restart.test.cjs
 *
 * Сценарий 1 (без auto-events):
 *  1. В БД уже лежит (948, 252, 1749, 1136).
 *  2. Создаём окно. Подписываемся на resize/move ПОСЛЕ ready-to-show
 *     (имитация production-цикла createWindow).
 *  3. После show ждём debounce — никаких авто-событий быть не должно.
 *  4. БД должна по-прежнему содержать (948, 252, 1749, 1136).
 *
 * Сценарий 2 (пользовательский resize):
 *  5. Программно меняем размер через setBounds.
 *  6. После debounce БД должна содержать новый размер.
 */
const { app, BrowserWindow, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const TEST_DIR = path.join(app.getPath('temp'), `etn-bounds-restart-${Date.now()}`);
fs.mkdirSync(TEST_DIR, { recursive: true });
const DB_PATH = path.join(TEST_DIR, 'local.db');

const USER_BOUNDS = { x: 948, y: 252, width: 1749, height: 1136 };

// Повтор wireWindowBoundsPersistence — только resize/move часть (close уже
// подключён в createWindow).
function wirePersistence(win, db, initialBounds) {
  let pending = null;
  let lastSaved = initialBounds;
  const saveCurrent = (label) => {
    if (win.isDestroyed()) return;
    if (win.isMinimized()) return;
    const b = win.getNormalBounds();
    const next = { x: b.x, y: b.y, width: b.width, height: b.height };
    if (lastSaved.x === next.x && lastSaved.y === next.y &&
        lastSaved.width === next.width && lastSaved.height === next.height) {
      console.log(`[t] ${label}: dedupe, skip`);
      return;
    }
    db.prepare(
      'INSERT INTO client_meta (key, value) VALUES (?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run('window_bounds', JSON.stringify(next));
    lastSaved = next;
    console.log(`[t] ${label}: SAVED`, next);
  };
  const schedule = () => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => { pending = null; saveCurrent('debounce'); }, 500);
  };
  win.on('resize', () => { console.log('[t] event: resize'); schedule(); });
  win.on('move',   () => { console.log('[t] event: move');   schedule(); });
}

// close-handler отдельно, как в production-коде.
function wireCloseSave(win, db) {
  win.on('close', () => {
    if (win.isDestroyed()) return;
    if (win.isMinimized()) return;
    const b = win.getNormalBounds();
    db.prepare(
      'INSERT INTO client_meta (key, value) VALUES (?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run('window_bounds', JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height }));
    console.log('[t] event: close, saved');
  });
}

function readBounds(db) {
  const row = db.prepare("SELECT value FROM client_meta WHERE key = 'window_bounds'").get();
  return row ? JSON.parse(row.value) : null;
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

app.whenReady().then(async () => {
  // 1. Подготовка БД
  const setup = new Database(DB_PATH);
  setup.pragma('journal_mode = WAL');
  setup.exec(`CREATE TABLE IF NOT EXISTS client_meta (key TEXT PRIMARY KEY, value TEXT);`);
  setup.prepare(
    'INSERT INTO client_meta (key, value) VALUES (?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run('window_bounds', JSON.stringify(USER_BOUNDS));
  setup.close();

  const writes = new Database(DB_PATH);
  const displays = screen.getAllDisplays();
  console.log('[t] displays:', displays.map((d) => ({ x: d.bounds.x, y: d.bounds.y, w: d.bounds.width, h: d.bounds.height })));
  console.log('[t] start DB:', readBounds(writes));

  // 2. Создаём окно с применёнными границами (= USER_BOUNDS, влезает в дисплей)
  const applied = USER_BOUNDS;
  const win = new BrowserWindow({
    x: applied.x, y: applied.y, width: applied.width, height: applied.height,
    show: false,
  });

  // 3. В production close-handler подключён сразу, resize/move — отложенно
  // (после ready-to-show). Здесь без загрузки renderer'а ready-to-show не
  // выстрелит, поэтому имитируем отложенное подключение явным sleep'ом —
  // проверяем, что в окне ДО этого resize не пишется в БД.
  wireCloseSave(win, writes);

  // Имитируем враждебные авто-события, которые Electron иногда файрит на
  // layout. Сейчас листенер resize/move ещё не подключён → БД не меняется.
  console.log('[t] >>> имитация авто-resize до 1280x800 (листенер ещё не подключён)');
  win.setBounds({ x: 1080, y: 320, width: 1280, height: 800 });
  await sleep(700);
  const afterHostile = readBounds(writes);
  console.log('[t] после авто-resize:', afterHostile);

  const step1 = JSON.stringify(afterHostile) === JSON.stringify(USER_BOUNDS);

  // 4. ready-to-show → wirePersistence → пользовательский resize.
  console.log('[t] >>> ready-to-show → wirePersistence');
  wirePersistence(win, writes, USER_BOUNDS);
  console.log('[t] >>> пользователь ресайзит до 1800x1100');
  win.setBounds({ x: 200, y: 200, width: 1800, height: 1100 });
  await sleep(800);
  const afterResize = readBounds(writes);
  console.log('[t] после resize:', afterResize);

  const step2 = afterResize && afterResize.width === 1800 && afterResize.height === 1100;

  const ok = step1 && step2;
  console.log(
    ok
      ? '\n[t] ✅ PASS: после рестарта размер не перетирается; пользовательский resize записывается'
      : `\n[t] ❌ FAIL: step1=${step1} step2=${step2}`,
  );

  win.close();
  await sleep(200);
  writes.close();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  app.exit(ok ? 0 : 1);
}).catch((err) => {
  console.error('[t] crashed:', err);
  app.exit(2);
});


/**
 * Регресс ошибки 0757cd08: «Текст комментария псевдо-записи теряется при
 * создании записи по заголовку».
 *
 * Симптом: blur заголовка создавал запись и подменял слот карточкой
 * (`insertCreatedRecord` → `slotRoot.replaceWith(card)`), живой редактор
 * комментария отсоединялся, а последующий `ensureSlot({ body })` при
 * `slot === null` возвращал `null` — набранный текст не попадал в сеть
 * (на сервере запись с пустым телом, один POST создания).
 *
 * Ожидаемое поведение: весь введённый текст комментария попадает в созданную
 * запись НЕЗАВИСИМО от порядка ввода (заголовок→текст и текст→заголовок).
 *
 * Часть 1 — поведенческая: решение `planSlotCommit` (чистый помощник `diary.ts`)
 * прогоняется через поддельное хранилище в обоих порядках ввода и проверяет
 * итоговую запись (заголовок И текст).
 * Часть 2 — структурная по исходнику экрана: сам модуль рендерера под Node без
 * Electron-каркаса не поднимается (конвенция `chronicle-home-mechanics`),
 * поэтому проводка фикса (update уже созданной записи, отложенная конвертация
 * слота по фокусу, стража гонки) проверяется по исходнику.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  hasRowId,
  planSlotCommit,
  type SlotCommitPlan,
} from '../src/renderer/screens/chronicle/diary.js';

const RENDERER_ROOT = path.resolve(import.meta.dirname, '..', 'src', 'renderer');
const CHRONICLE = fs.readFileSync(
  path.join(RENDERER_ROOT, 'screens', 'chronicle', 'chronicle.ts'),
  'utf8',
);

/** Тело функции верхнего уровня по её объявлению (стиль файла: `}` в первой колонке). */
function functionBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `исходник содержит «${signature}»`);
  const body = src.slice(start);
  const end = body.indexOf('\n}\n');
  assert.ok(end >= 0, `у «${signature}» найдено тело`);
  return body.slice(0, end);
}

/** Мини-хранилище записей: id → запись (заголовок, тело). */
interface FakeComment {
  title: string | null;
  body: string;
}

/**
 * Применить решение экрана к поддельному серверу и вернуть id записи.
 * Повторяет семантику `runEnsureSlot`/`updateSlotComment`: create пишет
 * заголовок и тело, update — заголовок всегда, тело только когда передано.
 */
function applyPlan(
  store: Map<string, FakeComment>,
  commentId: string | null,
  plan: SlotCommitPlan,
): string | null {
  if (plan.action === 'none') return commentId;
  if (plan.action === 'create') {
    store.set('rec', { title: plan.title, body: plan.body });
    return 'rec';
  }
  const rec = store.get(commentId!);
  assert.ok(rec, 'обновляемая запись существует');
  rec.title = plan.title;
  if (plan.bodyProvided) rec.body = plan.body;
  return commentId;
}

describe('псевдо-запись: заголовок и текст сохраняются в любом порядке (ошибка 0757cd08)', () => {
  it('заголовок → текст: на сервере запись с заголовком И текстом', () => {
    const store = new Map<string, FakeComment>();
    let id: string | null = null;
    // Blur заголовка: первое содержание — заголовок.
    id = applyPlan(store, id, planSlotCommit({ commentId: id, title: 'Встреча' }));
    assert.equal(store.get('rec')!.title, 'Встреча');
    assert.equal(store.get('rec')!.body, '');
    // Ctrl+Enter/blur редактора: текст ДОПОЛНЯЕТ уже созданную запись.
    id = applyPlan(
      store,
      id,
      planSlotCommit({ commentId: id, title: 'Встреча', body: 'обсудили план' }),
    );
    assert.equal(id, 'rec', 'дубль записи не создаётся');
    assert.equal(store.get('rec')!.title, 'Встреча');
    assert.equal(store.get('rec')!.body, 'обсудили план');
  });

  it('текст → заголовок: правка заголовка не затирает текст', () => {
    const store = new Map<string, FakeComment>();
    let id: string | null = null;
    // Сначала набран текст (заголовок ещё пуст) — запись создаётся по тексту.
    id = applyPlan(
      store,
      id,
      planSlotCommit({ commentId: id, title: '', body: 'обсудили план' }),
    );
    assert.equal(store.get('rec')!.title, null);
    assert.equal(store.get('rec')!.body, 'обсудили план');
    // Затем заголовок: обновляется только он, текст цел.
    id = applyPlan(store, id, planSlotCommit({ commentId: id, title: 'Встреча' }));
    assert.equal(id, 'rec', 'дубль записи не создаётся');
    assert.equal(store.get('rec')!.title, 'Встреча');
    assert.equal(store.get('rec')!.body, 'обсудили план');
  });

  it('пустой черновик без записи ничего не пишет (ленивое создание)', () => {
    assert.equal(planSlotCommit({ commentId: null, title: '  ', body: ' ' }).action, 'none');
    assert.equal(planSlotCommit({ commentId: null, title: ' ' }).action, 'none');
  });

  it('уже созданная запись обновляется даже при пустом вводе (не создаётся заново)', () => {
    const plan = planSlotCommit({ commentId: 'rec', title: '' });
    assert.equal(plan.action, 'update');
    assert.equal(plan.title, null);
    assert.equal(plan.bodyProvided, false);
  });
});

describe('псевдо-запись: проводка фикса в экране (ошибка 0757cd08)', () => {
  it('запись создаётся один раз, дальше — update по state.commentId', () => {
    assert.match(CHRONICLE, /state\.commentId = comment\.id;/, 'создание запоминает id записи');
    assert.match(CHRONICLE, /planSlotCommit\(/, 'решение create/update — общий помощник');
    assert.match(
      CHRONICLE,
      /comment = await updateSlotComment\(networkId, state\.commentId!, plan, extra, home\);/,
      'при существующем id идёт обновление',
    );
    const plan = fs.readFileSync(
      path.join(RENDERER_ROOT, 'screens', 'chronicle', 'diary.ts'),
      'utf8',
    );
    assert.match(plan, /action: has \? 'create' : 'none'/, 'пустой черновик не пишется');
    assert.match(plan, /action: 'update'/, 'существующая запись обновляется');
  });

  it('обновление шлёт заголовок всегда, тело — только когда передано', () => {
    assert.match(
      CHRONICLE,
      /const patch: Record<string, unknown> = \{ title: plan\.title \};/,
      'заголовок входит в патч',
    );
    assert.match(
      CHRONICLE,
      /if \(plan\.bodyProvided\) patch\['body_md'\] = plan\.body;/,
      'тело патчится только когда реально передано',
    );
  });

  it('слот не подменяется карточкой, пока фокус внутри', () => {
    // Вид поля фокусируем — уход заголовка в комментарий остаётся внутри слота.
    assert.match(
      CHRONICLE,
      /\.md-field-view'\)\?\.setAttribute\('tabindex', '-1'\)/,
      'вид комментария фокусируем',
    );
    // Конвертация только при уходе фокуса из слота (или явном convert).
    assert.match(
      CHRONICLE,
      /if \(opts\.convert === true \|\| !slotFocusInside\) \{\s*await insertCreatedRecord\(localRow\);/,
      'insertCreatedRecord вызывается лишь когда фокус покинул слот',
    );
    // Уход фокуса — единственная точка сохранения/конвертации.
    assert.match(CHRONICLE, /root\.addEventListener\('focusout'/, 'уход из слота отслеживается');
    assert.match(
      CHRONICLE,
      /slotFocusInside = next !== null && root\.contains\(next\);/,
      'фокус внутри слота считается по relatedTarget',
    );
    assert.match(
      CHRONICLE,
      /if \(!slotFocusInside\) void ensureSlot\(\{\}\);/,
      'уход из слота сохраняет черновик',
    );
  });

  it('blur заголовка сохраняет черновик, не теряя текст (стража гонки)', () => {
    // Заголовок слота — общий компонент (ошибка 36c330a3). Уход из поля
    // (`blur`) завершает правку и зовёт `onCommit` → `ensureSlot({ title })`.
    assert.match(
      CHRONICLE,
      /void ensureSlot\(\{ title: next \}\)/,
      'blur/Enter заголовка по-прежнему сохраняет черновик',
    );
    assert.match(
      CHRONICLE,
      /if \(slotBusy !== null\) return slotBusy;/,
      'параллельные сохранения не создают дубль',
    );
  });
});

describe('псевдо-запись: Ctrl+Enter → повторный слот не роняет ленту (ошибка 0757cd08, круг 1)', () => {
  it('дедуп по id: локальная вставка не добавляет вторую строку с тем же ключом', () => {
    // Модель ленты: строку могла вставить другая ветка (realtime-событие,
    // перезагрузка/сверка), пока слот ждал ухода фокуса.
    const rows: { id: string }[] = [];
    const insertLocal = (row: { id: string }): void => {
      if (hasRowId(rows, row.id)) return; // правило insertCreatedRecord
      rows.push(row);
    };
    rows.push({ id: 'rec-1' }); // вставка realtime-путём
    insertLocal({ id: 'rec-1' }); // локальная конвертация слота того же id
    assert.equal(rows.length, 1, 'второй узел с тем же ключом не появился');
    // После Ctrl+Enter повторный слот создаётся: ключей-дублей нет.
    assert.equal(hasRowId(rows, 'rec-2'), false);
    insertLocal({ id: 'rec-2' });
    assert.deepEqual(
      rows.map((r) => r.id),
      ['rec-1', 'rec-2'],
    );
  });

  it('insertCreatedRecord дедуплицирует по id до insertRowByDay', () => {
    const fn = functionBody(CHRONICLE, 'async function insertCreatedRecord(');
    assert.match(
      fn,
      /if \(hasRowId\(rows, row\.id\)\) \{[\s\S]*?slotRoot\?\.remove\(\);[\s\S]*?pendingReconcile = true;[\s\S]*?return;/,
      'существующая строка — слот снимается, дубль не вставляется',
    );
    const guard = fn.indexOf('hasRowId(rows, row.id)');
    const insert = fn.indexOf('insertRowByDay(rows, row');
    assert.ok(guard >= 0 && insert >= 0 && guard < insert, 'дедуп стоит ДО вставки строки');
  });

  it('renderFeed снимает слот, чья запись уже пришла из сети', () => {
    assert.match(
      CHRONICLE,
      /stale\.commentId !== null && hasRowId\(rows, stale\.commentId\)/,
      'слот-двойник не показывается',
    );
  });

  it('ошибка отрисовки не оставляет слот-стейт неконсистентным (кнопка работает)', () => {
    assert.match(
      CHRONICLE,
      /try \{\s*renderFeed\(\);\s*(?:\/\/[^\n]*\n\s*)*state\.title\.beginEdit\(\);\s*\} catch \(err\) \{\s*if \(slot === state\) \{\s*slot = null;/,
      'сбой renderFeed в startSlot сбрасывает slot',
    );
  });
});

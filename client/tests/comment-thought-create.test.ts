/**
 * Юнит-тесты команд «Создать мысль из раздела» / «Создать мысль из выделенного»
 * (0.12.1, задача 5f854e7a, ТП3): `editor/comment-thought-create.ts`.
 *
 * DOM-shimmed, как соседние тесты команд поля. Сеть подменяется портом
 * {@link CommentThoughtCreatePort}, редактор — фейком со снимком/правкой, как в
 * `comment-format.test.ts`. Проверяются:
 *  - план команд: название по правилу `f64f5893` (первая значимая строка, ≤250,
 *    без разрыва wiki-ссылки), тело (раздел — без заголовка, выделение — целиком);
 *  - родитель — текущая мысль (владелец комментария), тип не задаётся;
 *  - на месте фрагмента — трансклюзия `![[#<id>]]` (сборка `@etn/markdown`);
 *  - доступность команд (заголовок/выделение) и отсутствие владельца.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { formatTransclusionRef, parseTransclusions } from '@etn/markdown';

import type {
  CommentThoughtCreatePort,
  CommentThoughtCreateRequest,
} from '../src/renderer/editor/comment-thought-create.js';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

function installShim(): void {
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: { style: {} },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    body: new ShimElement('body'),
    querySelector: () => null,
    activeElement: null,
  };
  const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  win.innerWidth = 1024;
  win.innerHeight = 768;
}

type Commands = typeof import('../src/renderer/editor/comment-commands.js');
type Create = typeof import('../src/renderer/editor/comment-thought-create.js');

let commands: Commands;
let create: Create;

const PARENT_ID = '11111111-1111-4111-8111-111111111111';
const NEW_ID = '22222222-2222-4222-8222-222222222222';
const LINK_ID = '33333333-3333-4333-8333-333333333333';
/** Идентификаторы для команды разделения — по одному на каждую единицу. */
const UNIT_IDS = [
  '44444444-4444-4444-8444-444444444401',
  '44444444-4444-4444-8444-444444444402',
  '44444444-4444-4444-8444-444444444403',
] as const;

/** Фейковый редактор: хранит снимок и собирает применённые правки. */
function fakeEditor(text: string, from: number, to: number = from) {
  const state = { text, from, to };
  const edits: any[] = [];
  return {
    snapshot: () => ({ ...state }),
    applyEdit: (edit: any) => {
      edits.push(edit);
    },
    edits,
  };
}

/** Хост поля с редактором и владельцем комментария. */
function host(editor: unknown, owner: unknown = { ownerType: 'thought', ownerId: PARENT_ID }) {
  return {
    getEditor: () => editor,
    root: new ShimElement('div'),
    getCommentOwner: () => owner,
  } as any;
}

/** Фейковый порт создания: фиксирует запросы, отдаёт заданный id. */
function fakePort(overrides: Partial<CommentThoughtCreatePort> = {}) {
  const created: CommentThoughtCreateRequest[] = [];
  const resolved: unknown[] = [];
  const port: CommentThoughtCreatePort = {
    resolveParent: async (owner: { ownerType: 'thought' | 'link'; ownerId: string }) => {
      resolved.push(owner);
      return PARENT_ID;
    },
    create: async (request: CommentThoughtCreateRequest) => {
      created.push(request);
      return { id: NEW_ID };
    },
    ...overrides,
  };
  return { port, created, resolved };
}

/** Дожидается завершения асинхронного тела команды (две `await`-ступени). */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
  installShim();
  commands = (await import('../src/renderer/editor/comment-commands.js')) as Commands;
  create = (await import('../src/renderer/editor/comment-thought-create.js')) as Create;
  commands.commentCommandsInternals.reset();
  create.setCommentThoughtCreatePort(null);
  create.installCommentThoughtCreateCommands();
});

describe('план: название и тело (правило f64f5893)', () => {
  it('из выделения: название — первая значимая строка, тело — всё выделение', () => {
    const text = 'заголовок\n\nвторой абзац';
    const plan = create.planFromSelection({ text, from: 0, to: text.length });
    assert.equal(plan?.title, 'заголовок');
    assert.equal(plan?.bodyMd, text, 'первая строка остаётся в теле');
    assert.equal(plan?.start, 0);
    assert.equal(plan?.end, text.length);
  });

  it('из выделения: маркер списка и символы заголовка уходят из названия', () => {
    assert.equal(create.thoughtTitle('- элемент списка'), 'элемент списка');
    assert.equal(create.thoughtTitle('## Раздел'), 'Раздел');
    assert.equal(create.thoughtTitle('- [ ] задача'), 'задача');
    assert.equal(create.thoughtTitle('> цитата'), 'цитата');
    // Первая строка — только маркер: берётся следующая значимая.
    assert.equal(create.thoughtTitle('-\nсодержимое'), 'содержимое');
    // Ограждение блока кода пропускается.
    assert.equal(create.thoughtTitle('```js\nconst x = 1'), 'const x = 1');
  });

  it('пустое выделение/без значимой строки — плана нет', () => {
    assert.equal(create.planFromSelection({ text: 'x', from: 2, to: 2 }), null);
    assert.equal(create.planFromSelection({ text: '   \n  ', from: 0, to: 7 }), null);
    assert.equal(create.planFromSelection({ text: '-\n-', from: 0, to: 3 }), null);
  });

  it('обрезка до 250 символов не разрывает entity markdown', () => {
    const uuid = '44444444-4444-4444-8444-444444444444';
    const text = `${'x'.repeat(245)} [[#${uuid}]]`;
    const title = create.thoughtTitle(text);
    assert.ok(title.length <= create.TITLE_MAX_LENGTH, 'не длиннее 250');
    assert.equal(title, 'x'.repeat(245), 'обрезка отступила до начала ссылки, без пробела');
    assert.ok(!title.includes('['), 'незакрытая ссылка не попала в название');

    const long = 'y'.repeat(400);
    assert.equal(create.thoughtTitle(long).length, create.TITLE_MAX_LENGTH);
  });

  it('«из раздела»: заголовок — в название, тело — без заголовка', () => {
    const text = '# Раздел A\n\nтекст раздела\n\nещё строка';
    const plan = create.planFromSection({ text, from: 5, to: 5 });
    assert.equal(plan?.title, 'Раздел A');
    assert.equal(plan?.bodyMd, 'текст раздела\n\nещё строка');
    assert.equal(plan?.start, 0);
    assert.equal(plan?.end, text.length);
  });

  it('«из раздела»: каретка вне раздела (до первого заголовка) — плана нет', () => {
    const text = 'просто текст\n\n# Раздел\n\nтело';
    assert.equal(create.planFromSection({ text, from: 3, to: 3 }), null);
  });

  it('«из раздела»: выделение за пределы раздела не проходит', () => {
    const text = '# A\n\nтело A\n\n# B\n\nтело B';
    const plan = create.planFromSection({ text, from: 5, to: text.length });
    assert.equal(plan, null);
  });
});

describe('команды: создание, родитель, замена трансклюзией', () => {
  it('обе команды зарегистрированы в реестре', () => {
    assert.equal(commands.hasCommentCommandRunner(create.CREATE_FROM_SECTION_COMMAND), true);
    assert.equal(commands.hasCommentCommandRunner(create.CREATE_FROM_SELECTION_COMMAND), true);
  });

  it('из выделенного: одна мысль, родитель — владелец, трансклюзия на месте', async () => {
    const text = 'до\n\nвыделение\n\nпосле';
    const from = text.indexOf('выделение');
    const to = from + 'выделение'.length;
    const editor = fakeEditor(text, from, to);
    const { port, created, resolved } = fakePort();
    create.setCommentThoughtCreatePort(port);

    const handled = commands.runCommentCommand(
      create.CREATE_FROM_SELECTION_COMMAND,
      host(editor),
    );
    assert.equal(handled, true);
    await flush();

    assert.deepEqual(resolved, [{ ownerType: 'thought', ownerId: PARENT_ID }]);
    assert.equal(created.length, 1, 'одна мысль из всего выделения');
    assert.equal(created[0]!.parentId, PARENT_ID);
    assert.equal(created[0]!.title, 'выделение');
    assert.equal(created[0]!.bodyMd, 'выделение');

    assert.equal(editor.edits.length, 1);
    const change = editor.edits[0].changes[0];
    assert.deepEqual(change, { from, to, insert: `![[#${NEW_ID}]]` });
    assert.equal(editor.edits[0].selection.anchor, from + `![[#${NEW_ID}]]`.length);
  });

  it('из раздела: каретка в разделе, замена всего раздела, тело без заголовка', async () => {
    const text = '# Раздел\n\nтело раздела';
    const caret = text.indexOf('тело') + 2;
    const editor = fakeEditor(text, caret);
    const { port, created } = fakePort();
    create.setCommentThoughtCreatePort(port);

    commands.runCommentCommand(create.CREATE_FROM_SECTION_COMMAND, host(editor));
    await flush();

    assert.equal(created.length, 1);
    assert.equal(created[0]!.title, 'Раздел');
    assert.equal(created[0]!.bodyMd, 'тело раздела');
    assert.deepEqual(editor.edits[0].changes[0], {
      from: 0,
      to: text.length,
      insert: `![[#${NEW_ID}]]`,
    });
  });

  it('тип не задаётся: запрос порта несёт только родителя/название/тело', async () => {
    const editor = fakeEditor('текст', 0, 5);
    const { port, created } = fakePort();
    create.setCommentThoughtCreatePort(port);
    commands.runCommentCommand(create.CREATE_FROM_SELECTION_COMMAND, host(editor));
    await flush();
    assert.deepEqual(Object.keys(created[0]!).sort(), ['bodyMd', 'parentId', 'title']);
  });

  it('родитель комментария-связи резолвится портом (не владелец напрямую)', async () => {
    const editor = fakeEditor('текст', 0, 5);
    const { port, created } = fakePort({
      resolveParent: async (owner: { ownerType: 'thought' | 'link'; ownerId: string }) => {
        assert.deepEqual(owner, { ownerType: 'link', ownerId: LINK_ID });
        return PARENT_ID;
      },
    });
    create.setCommentThoughtCreatePort(port);
    commands.runCommentCommand(
      create.CREATE_FROM_SELECTION_COMMAND,
      host(editor, { ownerType: 'link', ownerId: LINK_ID }),
    );
    await flush();
    assert.equal(created[0]!.parentId, PARENT_ID);
  });

  it('нет владельца комментария — команда не исполняется', async () => {
    const editor = fakeEditor('текст', 0, 5);
    const { port, created } = fakePort();
    create.setCommentThoughtCreatePort(port);
    const handled = commands.runCommentCommand(
      create.CREATE_FROM_SELECTION_COMMAND,
      host(editor, null),
    );
    assert.equal(handled, false);
    await flush();
    assert.equal(created.length, 0);
  });

  it('родитель не найден — мысль не создаётся, правок нет', async () => {
    const editor = fakeEditor('текст', 0, 5);
    const { port, created } = fakePort({ resolveParent: async () => null });
    create.setCommentThoughtCreatePort(port);
    commands.runCommentCommand(create.CREATE_FROM_SELECTION_COMMAND, host(editor));
    await flush();
    assert.equal(created.length, 0);
    assert.equal(editor.edits.length, 0);
  });
});

describe('доступность команд (требование 93c0eb7d)', () => {
  const text = 'просто\n\n# Раздел\n\nтело';

  it('«из выделенного» активна при непустом выделении', () => {
    const snap = { text, from: 0, to: 6 };
    assert.equal(commands.commentCommandState(create.CREATE_FROM_SELECTION_COMMAND, snap).disabled, false);
    assert.equal(
      commands.commentCommandState(create.CREATE_FROM_SELECTION_COMMAND, { text, from: 2, to: 2 }).disabled,
      true,
    );
  });

  it('«из раздела» активна по каретке в разделе и выделению внутри раздела', () => {
    const inside = text.indexOf('тело') + 1;
    assert.equal(
      commands.commentCommandState(create.CREATE_FROM_SECTION_COMMAND, { text, from: inside, to: inside }).disabled,
      false,
    );
    assert.equal(
      commands.commentCommandState(create.CREATE_FROM_SECTION_COMMAND, { text, from: 0, to: 3 }).disabled,
      true,
      'вне раздела команда неактивна',
    );
  });
});

describe('сборка ссылки трансклюзии (@etn/markdown)', () => {
  it('![[#<id>]] распознаётся парсером пакета', () => {
    const src = formatTransclusionRef(NEW_ID);
    assert.equal(src, `![[#${NEW_ID}]]`);
    const refs = parseTransclusions(src);
    assert.equal(refs.length, 1);
    assert.equal(refs[0]!.sourceId, NEW_ID);
    assert.equal(refs[0]!.section, null);
  });

  it('раздел — отдельная форма, id нормализуется к нижнему регистру', () => {
    assert.equal(
      formatTransclusionRef(NEW_ID.toUpperCase(), 'Раздел'),
      `![[#${NEW_ID}#Раздел]]`,
    );
  });
});

/* ------------------------------------------------------------------ *
 * Команда «Разделить выделение на мысли» (задача 578c8525).
 * ------------------------------------------------------------------ */

/** Порт с уникальным id на каждый вызов — для проверки родительства. */
function sequencePort() {
  const requests: CommentThoughtCreateRequest[] = [];
  let index = 0;
  const port: CommentThoughtCreatePort = {
    resolveParent: async () => PARENT_ID,
    create: async (request: CommentThoughtCreateRequest) => {
      requests.push(request);
      const id = UNIT_IDS[index++];
      if (id === undefined) throw new Error('слишком много единиц в тесте');
      return { id };
    },
  };
  return { port, requests };
}

describe('разделение: правило разбора единиц (требование f5695a1e)', () => {
  it('список: элемент — единица, вложенный — под-мысль', () => {
    const text = '- один\n- два\n  - вложенный';
    const plan = create.planSplitSelection({ text, from: 0, to: text.length });
    assert.equal(plan?.length, 2, 'два элемента верхнего уровня');
    assert.deepEqual(
      plan!.map((node) => node.title),
      ['один', 'два'],
    );
    assert.equal(plan![0]!.children.length, 0);
    assert.equal(plan![1]!.children.length, 1);
    assert.equal(plan![1]!.children[0]!.title, 'вложенный');
    // Тело — полный текст единицы (маркер сохранён).
    assert.equal(plan![1]!.bodyMd, '- два');
    assert.equal(plan![1]!.children[0]!.bodyMd, '  - вложенный');
    assert.equal(plan![1]!.children[0]!.start, text.indexOf('  - вложенный'));
  });

  it('разделы: заголовок — мысль, подраздел — под-мысль', () => {
    const text = '# A\nтело A\n## B\nтело B';
    const plan = create.planSplitSelection({ text, from: 0, to: text.length });
    assert.equal(plan?.length, 1, 'один раздел верхнего уровня');
    assert.equal(plan![0]!.title, 'A', 'символы # уходят из названия');
    // Тело раздела — без строки заголовка: заголовок ушёл в название, в
    // развёртке трансклюзии его нет (требование 23c11231).
    assert.equal(plan![0]!.bodyMd, 'тело A');
    assert.equal(plan![0]!.children.length, 1);
    assert.equal(plan![0]!.children[0]!.title, 'B');
    assert.equal(plan![0]!.children[0]!.bodyMd, 'тело B');
  });

  it('абзацы: без пустой строки блок кода — продолжение абзаца', () => {
    const cont = 'первый абзац\n\nвторой абзац\n```\nкод\n```';
    const plan = create.planSplitSelection({ text: cont, from: 0, to: cont.length });
    assert.equal(plan?.length, 2, 'код без пустой строки не открывает новую единицу');
    assert.equal(plan![1]!.title, 'второй абзац');
    assert.equal(plan![1]!.bodyMd, 'второй абзац\n```\nкод\n```');
  });

  it('абзацы: блок кода отделён пустой строкой — новая единица по первой строке блока', () => {
    const sep = 'абзац\n\n```\nкод\n```';
    const plan = create.planSplitSelection({ text: sep, from: 0, to: sep.length });
    assert.equal(plan?.length, 2);
    assert.equal(plan![1]!.title, 'код', 'ограждение блока пропущено');
    assert.equal(plan![1]!.bodyMd, '```\nкод\n```');
  });

  it('слова в одной строке — одна мысль', () => {
    assert.equal(
      create.planSplitSelection({ text: 'несколько слов в строке', from: 0, to: 23 }),
      null,
      'одна единица — команда недоступна',
    );
    const text = 'несколько слов в строке\n\nвторой абзац';
    const plan = create.planSplitSelection({ text, from: 0, to: text.length });
    assert.deepEqual(
      plan!.map((node) => node.title),
      ['несколько слов в строке', 'второй абзац'],
      'строка целиком — одна единица',
    );
  });

  it('комбинированное: до заголовка — абзацы/список, после — разделы', () => {
    const text = 'абзац до\n\n- пункт\n\n# Заголовок\nтело раздела';
    const plan = create.planSplitSelection({ text, from: 0, to: text.length });
    assert.deepEqual(
      plan!.map((node) => node.title),
      ['абзац до', 'пункт', 'Заголовок'],
    );
  });

  it('два абзаца — две единицы', () => {
    const text = 'абзац один\n\nабзац два';
    const plan = create.planSplitSelection({ text, from: 0, to: text.length });
    assert.deepEqual(
      plan!.map((node) => node.title),
      ['абзац один', 'абзац два'],
    );
  });
});

describe('разделение: доступность и исполнение', () => {
  it('доступна при ≥2 единицах, неактивна при 1 единице и без выделения', () => {
    const two = 'абзац один\n\nабзац два';
    assert.equal(
      commands.commentCommandState('comment.split', { text: two, from: 0, to: two.length }).disabled,
      false,
    );
    assert.equal(
      commands.commentCommandState('comment.split', { text: 'одна строка', from: 0, to: 10 }).disabled,
      true,
      'одна единица разбора',
    );
    assert.equal(
      commands.commentCommandState('comment.split', { text: 'одна строка', from: 0, to: 0 }).disabled,
      true,
      'выделения нет',
    );
  });

  it('создаёт мысль на единицу, вложенные — под-мысли, трансклюзии на месте', async () => {
    const text = '- один\n- два\n  - вложенный';
    const editor = fakeEditor(text, 0, text.length);
    const { port, requests } = sequencePort();
    create.setCommentThoughtCreatePort(port);

    const handled = commands.runCommentCommand('comment.split', host(editor));
    assert.equal(handled, true);
    await flush();

    assert.deepEqual(
      requests.map((request) => request.title),
      ['один', 'два', 'вложенный'],
      'порядок мысли как в документе',
    );
    assert.deepEqual(
      requests.map((request) => request.parentId),
      [PARENT_ID, PARENT_ID, UNIT_IDS[1]],
      'вложенная единица — под-мысль созданного родителя, не текущей мысли',
    );
    assert.deepEqual(
      requests.map((request) => request.bodyMd),
      ['- один', '- два', '  - вложенный'],
      'тело — единица целиком (требование f64f5893)',
    );

    assert.equal(editor.edits.length, 1, 'одна транзакция редактора');
    assert.deepEqual(editor.edits[0].changes, [
      { from: 0, to: 6, insert: `![[#${UNIT_IDS[0]}]]` },
      { from: 7, to: 12, insert: `![[#${UNIT_IDS[1]}]]` },
      { from: 13, to: 26, insert: `![[#${UNIT_IDS[2]}]]` },
    ]);
  });

  it('текст вне единиц (пустые строки между ними) остаётся на месте', async () => {
    const text = 'абзац один\n\nабзац два';
    const editor = fakeEditor(text, 0, text.length);
    const { port, requests } = sequencePort();
    create.setCommentThoughtCreatePort(port);
    commands.runCommentCommand('comment.split', host(editor));
    await flush();

    assert.equal(requests.length, 2);
    assert.deepEqual(editor.edits[0].changes, [
      { from: 0, to: 10, insert: `![[#${UNIT_IDS[0]}]]` },
      { from: 12, to: 21, insert: `![[#${UNIT_IDS[1]}]]` },
    ]);
    // Пустая строка `[10, 12)` не входит ни в одну правку.
    assert.ok(
      (editor.edits[0].changes as Array<{ from: number; to: number }>).every(
        (change) => change.to <= 10 || change.from >= 12,
      ),
    );
  });

  it('нет владельца комментария — мыслей не создаётся', async () => {
    const text = 'абзац один\n\nабзац два';
    const editor = fakeEditor(text, 0, text.length);
    const { port, requests } = sequencePort();
    create.setCommentThoughtCreatePort(port);
    const handled = commands.runCommentCommand('comment.split', host(editor, null));
    assert.equal(handled, false);
    await flush();
    assert.equal(requests.length, 0);
    assert.equal(editor.edits.length, 0);
  });

  it('родитель не найден — правок нет', async () => {
    const text = 'абзац один\n\nабзац два';
    const editor = fakeEditor(text, 0, text.length);
    const { port, requests } = sequencePort();
    create.setCommentThoughtCreatePort({ ...port, resolveParent: async () => null });
    commands.runCommentCommand('comment.split', host(editor));
    await flush();
    assert.equal(requests.length, 0);
    assert.equal(editor.edits.length, 0);
  });

  it('команда зарегистрирована в реестре', () => {
    assert.equal(commands.hasCommentCommandRunner(create.SPLIT_SELECTION_COMMAND), true);
  });
});


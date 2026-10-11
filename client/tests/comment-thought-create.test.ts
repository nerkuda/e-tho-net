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

/**
 * Редактор с изменяемым снимком: тест меняет документ/выделение из порта
 * создания, воспроизводя правку пользователя во время сетевого `await`
 * (ошибка `da5e74b0`).
 */
function mutableEditor(text: string, from: number, to: number = from) {
  const state = { text, from, to };
  const edits: any[] = [];
  return {
    snapshot: () => ({ ...state }),
    applyEdit: (edit: any) => {
      edits.push(edit);
    },
    set: (text2: string, from2: number, to2: number = from2): void => {
      state.text = text2;
      state.from = from2;
      state.to = to2;
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
  const picks: Array<{ anchorId: string; anchorTitle: string; prefillText: string }> = [];
  const basePick = overrides.pick ?? (async () => null);
  const port: CommentThoughtCreatePort = {
    resolveParent: async (owner: { ownerType: 'thought' | 'link'; ownerId: string }) => {
      resolved.push(owner);
      return PARENT_ID;
    },
    create: async (request: CommentThoughtCreateRequest) => {
      created.push(request);
      return { id: NEW_ID };
    },
    thoughtTitle: async (id: string) => `Заголовок ${id}`,
    // Дедуп по умолчанию выключен (нет кандидатов) — тесты, проверяющие
    // создание, не зависят от резолва 8e4e3dc5.
    candidates: async () => [],
    choose: async () => null,
    ...overrides,
    // Обёртка ПОСЛЕ `...overrides`: вызов диалога фиксируется всегда, даже
    // когда тест подменяет `pick`.
    pick: async (input) => {
      picks.push(input);
      return basePick(input);
    },
  };
  return { port, created, resolved, picks };
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

  it('закрывающая последовательность # заголовка уходит из названия', () => {
    assert.equal(create.thoughtTitle('## Раздел ##'), 'Раздел');
    assert.equal(create.thoughtTitle('# Заголовок #'), 'Заголовок');
    assert.equal(create.thoughtTitle('### A ### '), 'A');
    // `#` внутри слова — не закрывающая последовательность.
    assert.equal(create.thoughtTitle('## C#'), 'C#');
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

  it('«из раздела»: раздел без собственного текста даёт пустое тело', () => {
    const text = '# A\n## B\nтекст B';
    const plan = create.planFromSection({ text, from: 1, to: 1 });
    assert.equal(plan?.title, 'A');
    assert.equal(plan?.bodyMd, '', 'заголовок ушёл в название, тела нет');
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

  it('«из раздела»: каретка на хвостовой пустой строке в конце — раздел предыдущий', () => {
    // Ошибка 10aa8cd7: parseSelectionUnits обрезает завершающий `\n`, поэтому
    // каретка в самом конце документа выпадала из диапазона раздела.
    const text = '# Раздел\n\nтело\n';
    assert.equal(text.length, 15);
    for (const caret of [14, text.length]) {
      const plan = create.planFromSection({ text, from: caret, to: caret });
      assert.equal(plan?.title, 'Раздел', `каретка ${caret}: команда доступна`);
      assert.equal(plan?.bodyMd, 'тело');
      assert.equal(plan?.start, 0);
      assert.equal(plan?.end, 14, 'замена раздела без хвостового перевода строки');
    }
  });

  it('«из раздела»: каретка в конце документа относится к последнему подразделу', () => {
    const text = '# A\n\n## B\n\nтело B\n';
    const plan = create.planFromSection({ text, from: text.length, to: text.length });
    assert.equal(plan?.title, 'B', 'самый вложенный из последних разделов');
    assert.equal(plan?.bodyMd, 'тело B');
  });
});

describe('команды: создание, родитель, замена трансклюзией', () => {
  it('обе команды зарегистрированы в реестре', () => {
    assert.equal(commands.hasCommentCommandRunner(create.CREATE_FROM_SECTION_COMMAND), true);
    assert.equal(commands.hasCommentCommandRunner(create.CREATE_FROM_SELECTION_COMMAND), true);
  });

  it('из выделенного: диалог, новая мысль, родитель — владелец, ссылка на месте', async () => {
    const text = 'до\n\nвыделение\n\nпосле';
    const from = text.indexOf('выделение');
    const to = from + 'выделение'.length;
    const editor = fakeEditor(text, from, to);
    const { port, created, resolved, picks } = fakePort({
      pick: async () => ({ items: [{ kind: 'new', title: 'выделение', synonyms: [] }] }),
    });
    create.setCommentThoughtCreatePort(port);

    const handled = commands.runCommentCommand(
      create.CREATE_FROM_SELECTION_COMMAND,
      host(editor),
    );
    assert.equal(handled, true);
    await flush();

    assert.deepEqual(resolved, [{ ownerType: 'thought', ownerId: PARENT_ID }]);
    assert.equal(picks.length, 1, 'диалог открыт один раз');
    assert.equal(picks[0]!.anchorId, PARENT_ID);
    assert.equal(picks[0]!.prefillText, 'выделение', 'поле предзаполнено выделением');
    assert.equal(created.length, 1, 'одна мысль из выделения');
    assert.equal(created[0]!.parentId, PARENT_ID);
    assert.equal(created[0]!.title, 'выделение');
    assert.equal(created[0]!.bodyMd, '', 'короткое выделение — без тела');

    assert.equal(editor.edits.length, 1);
    const change = editor.edits[0].changes[0];
    assert.deepEqual(change, { from, to, insert: `[[#${NEW_ID}]]` });
    assert.equal(editor.edits[0].selection.anchor, from + `[[#${NEW_ID}]]`.length);
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
    const { port, created } = fakePort({
      pick: async () => ({ items: [{ kind: 'new', title: 'текст', synonyms: [] }] }),
    });
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
      pick: async () => ({ items: [{ kind: 'new', title: 'текст', synonyms: [] }] }),
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

  it('«из раздела» активна по каретке на завершающем переводе строки (ошибка 10aa8cd7)', () => {
    const doc = '# Раздел\n\nтело\n';
    assert.equal(
      commands.commentCommandState(create.CREATE_FROM_SECTION_COMMAND, {
        text: doc,
        from: doc.length,
        to: doc.length,
      }).disabled,
      false,
    );
  });

  it('«из выделенного» отключена для выделения без значимой строки (уточнение 93c0eb7d)', () => {
    // Осознанный контракт (ошибка 10aa8cd7): название обязательно (f64f5893),
    // поэтому выделение из одних пробелов или маркеров разметки мысли не даёт.
    for (const [label, doc, from, to] of [
      ['одни пробелы', '   \n  ', 0, 7],
      ['только маркеры списка', '-\n-', 0, 3],
      ['только ограждение кода', '```', 0, 3],
    ] as const) {
      assert.equal(create.planFromSelection({ text: doc, from, to }), null, `${label}: плана нет`);
      assert.equal(
        commands.commentCommandState(create.CREATE_FROM_SELECTION_COMMAND, { text: doc, from, to })
          .disabled,
        true,
        `${label}: команда отключена`,
      );
    }
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
    pick: async () => null,
    thoughtTitle: async (id: string) => `Заголовок ${id}`,
    candidates: async () => [],
    choose: async () => null,
  };
  return { port, requests };
}

describe('разделение: правило разбора единиц (требование f5695a1e)', () => {
  it('список: элемент — единица, вложенные входят в ТЕЛО, под-мыслей нет', () => {
    const text = '- один\n- два\n  - вложенный';
    const plan = create.planSplitSelection({ text, from: 0, to: text.length });
    assert.equal(plan?.length, 2, 'два элемента верхнего уровня');
    assert.deepEqual(
      plan!.map((node) => node.title),
      ['один', 'два'],
    );
    // Вложенные элементы списка под-мыслей НЕ создают (требование 45b53e11,
    // walkthrough 2026-10-12): их текст с маркерами — в ТЕЛЕ мысли-элемента.
    assert.equal(plan![0]!.children.length, 0);
    assert.equal(plan![1]!.children.length, 0);
    assert.equal(plan![1]!.bodyMd, '  - вложенный', 'строка ≤ 250 с подчинёнными → тело из вложенных');
    // Диапазон замены единицы целиком покрывает вложенный текст.
    assert.equal(plan![1]!.start, text.indexOf('- два'));
    assert.equal(plan![1]!.end, text.indexOf('- два') + '- два'.length);
    assert.equal(plan![1]!.fullEnd, text.length, 'замена целиком захватывает вложенные строки');
  });

  it('список: строка > 250 и есть подчинённые (комбинированный) — тело = текст + вложенные', () => {
    const long = `- ${'x'.repeat(300)}`;
    const text = `${long}\n  - вложенный`;
    // Одна единица верхнего уровня — «Разделить» недоступна (нужно ≥2), план
    // пакетного пути смотрим через planBatchSelection (список — пакетный путь).
    const plan = create.planBatchSelection({ text, from: 0, to: text.length });
    assert.equal(plan?.length, 1);
    assert.equal(plan![0]!.title.length, create.TITLE_MAX_LENGTH, 'название обрезано до 250');
    assert.equal(plan![0]!.bodyMd, `${long}\n  - вложенный`, 'весь текст строки + вложенные');
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

  it('раздел без собственного текста — мысль без тела, подраздел — под-мысль', () => {
    const text = '# A\n## B\nтекст B';
    const plan = create.planSplitSelection({ text, from: 0, to: text.length });
    assert.equal(plan?.length, 1);
    assert.equal(plan![0]!.title, 'A');
    assert.equal(plan![0]!.bodyMd, '', 'у раздела нет собственного текста');
    assert.equal(plan![0]!.children.length, 1);
    assert.equal(plan![0]!.children[0]!.title, 'B');
    assert.equal(plan![0]!.children[0]!.bodyMd, 'текст B');
  });

  it('последний подраздел без собственного текста — тоже пустое тело', () => {
    const text = '# A\nтело A\n## B';
    const plan = create.planSplitSelection({ text, from: 0, to: text.length });
    assert.equal(plan![0]!.bodyMd, 'тело A');
    assert.equal(plan![0]!.children.length, 1);
    assert.equal(plan![0]!.children[0]!.title, 'B');
    assert.equal(plan![0]!.children[0]!.bodyMd, '');
  });

  it('абзацы: без пустой строки блок кода — продолжение абзаца; тело = остаток', () => {
    const cont = 'первый абзац\n\nвторой абзац\n```\nкод\n```';
    const plan = create.planSplitSelection({ text: cont, from: 0, to: cont.length });
    assert.equal(plan?.length, 2, 'код без пустой строки не открывает новую единицу');
    assert.equal(plan![1]!.title, 'второй абзац');
    // Тело абзаца — остаток после заголовочной строки (требование 59ec432f).
    assert.equal(plan![1]!.bodyMd, '```\nкод\n```');
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

  it('создаёт мысль на единицу верхнего уровня; вложенные — в тело, не под-мысль', async () => {
    const text = '- один\n- два\n  - вложенный';
    const editor = fakeEditor(text, 0, text.length);
    const { port, requests } = sequencePort();
    create.setCommentThoughtCreatePort(port);

    const handled = commands.runCommentCommand('comment.split', host(editor));
    assert.equal(handled, true);
    await flush();

    assert.deepEqual(
      requests.map((request) => request.title),
      ['один', 'два'],
      'только элементы верхнего уровня — под-мыслей нет',
    );
    assert.deepEqual(
      requests.map((request) => request.parentId),
      [PARENT_ID, PARENT_ID],
      'все мысли — дети текущей (вложенные под-мыслей не создают)',
    );
    assert.deepEqual(
      requests.map((request) => request.bodyMd),
      ['', '  - вложенный'],
      'без тела; у второго — вложенные строки как текст с маркерами',
    );

    assert.equal(editor.edits.length, 1, 'одна транзакция редактора');
    assert.deepEqual(editor.edits[0].changes, [
      { from: 0, to: 6, insert: `[[#${UNIT_IDS[0]}]]` },
      { from: 7, to: 26, insert: `![[#${UNIT_IDS[1]}]]` },
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
    // Однострочный абзац: тело пусто (остаток после заголовка) → ссылка.
    assert.deepEqual(editor.edits[0].changes, [
      { from: 0, to: 10, insert: `[[#${UNIT_IDS[0]}]]` },
      { from: 12, to: 21, insert: `[[#${UNIT_IDS[1]}]]` },
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

  it('раздел без тела: мысль без comment → на месте ССЫЛКА; подраздел — трансклюзия', async () => {
    const text = '# A\n## B\nтекст B';
    const editor = fakeEditor(text, 0, text.length);
    const { port, requests } = sequencePort();
    create.setCommentThoughtCreatePort(port);

    const handled = commands.runCommentCommand('comment.split', host(editor));
    assert.equal(handled, true, 'команда доступна (2 единицы разбора)');
    await flush();

    assert.deepEqual(
      requests.map((request) => request.title),
      ['A', 'B'],
    );
    assert.deepEqual(
      requests.map((request) => request.bodyMd),
      ['', 'текст B'],
    );
    assert.deepEqual(
      requests.map((request) => request.parentId),
      [PARENT_ID, UNIT_IDS[0]],
      'подраздел B — под-мысль мысли A',
    );
    assert.equal(editor.edits.length, 1, 'правка применена, команда не упала');
    // A без тела → ссылка (требование 23c11231); B с телом → трансклюзия.
    assert.deepEqual(editor.edits[0].changes, [
      { from: 0, to: 3, insert: `[[#${UNIT_IDS[0]}]]` },
      { from: 4, to: 16, insert: `![[#${UNIT_IDS[1]}]]` },
    ]);
  });

  it('пустое тело — вход REST без поля comment; непустое — с comment', () => {
    const empty = create.buildCommentThoughtCreateInput({
      parentId: PARENT_ID,
      title: 'A',
      bodyMd: '',
    });
    assert.equal('comment' in empty, false, 'пустой body_md сервер отклоняет — поле не шлём');
    assert.deepEqual(empty.create_link, {
      direction: 'parent',
      target_thought_id: PARENT_ID,
    });

    const full = create.buildCommentThoughtCreateInput({
      parentId: PARENT_ID,
      title: 'B',
      bodyMd: 'текст B',
    });
    assert.deepEqual(full.comment, { body_md: 'текст B' });
  });
});

/* ------------------------------------------------------------------ *
 * Гонка позиций после асинхронного создания (ошибка da5e74b0).
 * ------------------------------------------------------------------ */

describe('перепрокладка правки после await создания (ошибка da5e74b0)', () => {
  it('из выделенного (диалог): правка уходит на сдвинутый диапазон, текст не портится', async () => {
    const text = 'до\n\nвыделение\n\nпосле';
    const from = text.indexOf('выделение');
    const to = from + 'выделение'.length;
    const editor = mutableEditor(text, from, to);
    const requests: CommentThoughtCreateRequest[] = [];
    create.setCommentThoughtCreatePort({
      resolveParent: async () => PARENT_ID,
      pick: async () => ({ items: [{ kind: 'new', title: 'выделение', synonyms: [] }] }),
      thoughtTitle: async () => 'выделение',
      candidates: async () => [],
      choose: async () => null,
      create: async (request) => {
        requests.push(request);
        // Пользователь вставил символ в начало — выделение (CM6) сдвинулось на +1.
        editor.set(`X${text}`, from + 1, to + 1);
        return { id: NEW_ID };
      },
    });

    commands.runCommentCommand(create.CREATE_FROM_SELECTION_COMMAND, host(editor));
    await flush();

    assert.equal(requests.length, 1);
    assert.deepEqual(editor.edits[0].changes[0], {
      from: from + 1,
      to: to + 1,
      insert: `[[#${NEW_ID}]]`,
    });
    assert.equal(editor.edits[0].selection.anchor, from + 1 + `[[#${NEW_ID}]]`.length);
  });

  it('из раздела: замена всего раздела по актуальным позициям', async () => {
    const text = '# Раздел\n\nтело';
    const caret = text.indexOf('тело') + 2;
    const editor = mutableEditor(text, caret);
    const requests: CommentThoughtCreateRequest[] = [];
    create.setCommentThoughtCreatePort({
      resolveParent: async () => PARENT_ID,
      create: async (request) => {
        requests.push(request);
        // Правка ДО раздела (целая строка) сдвигает и каретку, и границы
        // раздела на +2, не ломая заголовок.
        editor.set(`X\n${text}`, caret + 2);
        return { id: NEW_ID };
      },
      pick: async () => null,
      thoughtTitle: async () => 'Раздел',
      candidates: async () => [],
      choose: async () => null,
    });

    commands.runCommentCommand(create.CREATE_FROM_SECTION_COMMAND, host(editor));
    await flush();

    assert.equal(requests.length, 1);
    assert.deepEqual(editor.edits[0].changes[0], {
      from: 2,
      to: text.length + 2,
      insert: `![[#${NEW_ID}]]`,
    });
  });

  it('контекст изменился (правка внутри выделения) — правка отменяется', async () => {
    const text = 'до\n\nвыделение\n\nпосле';
    const from = text.indexOf('выделение');
    const to = from + 'выделение'.length;
    const editor = mutableEditor(text, from, to);
    create.setCommentThoughtCreatePort({
      resolveParent: async () => PARENT_ID,
      pick: async () => ({ items: [{ kind: 'new', title: 'выделение', synonyms: [] }] }),
      thoughtTitle: async () => 'выделение',
      candidates: async () => [],
      choose: async () => null,
      create: async () => {
        // Пользователь изменил сам выделенный текст — перепрокладка невозможна.
        editor.set(text.replace('выделение', 'ДРУГОЕ!!'), from, from + 'ДРУГОЕ!!'.length);
        return { id: NEW_ID };
      },
    });

    commands.runCommentCommand(create.CREATE_FROM_SELECTION_COMMAND, host(editor));
    await flush();

    assert.equal(editor.edits.length, 0, 'устаревшую правку не применяем');
  });
});

/* ------------------------------------------------------------------ *
 * Случаи 1–2 «Создать мысль из выделенного» (задача 785c7fac, 0.12.2).
 * ------------------------------------------------------------------ */

describe('случаи 1–2: план имени/тела (требование dc24a8b1)', () => {
  const snap = (text: string) => ({ text, from: 0, to: text.length });

  it('короткое однострочное (≤250) — без тела, предзаполнение = выделение', () => {
    const p = create.planSelectionCommand(snap('короткая заметка'));
    assert.equal(p?.short, true);
    assert.equal(p?.prefill, 'короткая заметка');
    assert.equal(p?.bodyMd, '');
    assert.equal(p?.batch, false);
  });

  it('ровно 250 символов — короткое (без тела)', () => {
    const text = 'x'.repeat(250);
    const p = create.planSelectionCommand(snap(text));
    assert.equal(p?.short, true);
    assert.equal(p?.bodyMd, '');
  });

  it('251 символ — длинное: тело = весь текст, предзаполнение обрезано до 250', () => {
    const text = 'y'.repeat(251);
    const p = create.planSelectionCommand(snap(text));
    assert.equal(p?.short, false);
    assert.equal(p?.prefill.length, create.TITLE_MAX_LENGTH);
    assert.equal(p?.bodyMd, text);
  });

  it('многострочное: заголовок — первая строка, тело — остаток', () => {
    const text = 'Первая строка\nвторой абзац';
    const p = create.planSelectionCommand(snap(text));
    assert.equal(p?.short, false);
    assert.equal(p?.prefill, 'Первая строка');
    assert.equal(p?.bodyMd, 'второй абзац');
  });

  it('первая строка >250 — тело = всё выделение', () => {
    const text = `${'z'.repeat(300)}\nхвост`;
    const p = create.planSelectionCommand(snap(text));
    assert.equal(p?.short, false);
    assert.equal(p?.prefill.length, create.TITLE_MAX_LENGTH);
    assert.equal(p?.bodyMd, text);
  });

  it('многострочное с пустым остатком (хвостовые пустые строки) — тело пусто', () => {
    const p = create.planSelectionCommand(snap('Заголовок края\n\n'));
    assert.equal(p?.short, false, 'есть перенос — не короткое');
    assert.equal(p?.prefill, 'Заголовок края');
    assert.equal(p?.bodyMd, '', 'остаток после первой строки пуст');
  });

  it('список и заголовок — пакетный путь (диалог не открывается)', () => {
    assert.equal(create.selectionUsesBatchPath('- пункт'), true);
    assert.equal(create.selectionUsesBatchPath('# Раздел\nтело'), true);
    assert.equal(create.selectionUsesBatchPath('обычный абзац'), false);
    assert.equal(create.planSelectionCommand(snap('- пункт'))?.batch, true);
  });

  it('пустое/без значимой строки — плана нет (команда недоступна)', () => {
    assert.equal(create.planSelectionCommand({ text: 'x', from: 2, to: 2 }), null);
    assert.equal(create.planSelectionCommand(snap('   ')), null);
  });
});

describe('случаи 1–2: команда (диалог, создание, вставка)', () => {
  it('S1: короткое → новая мысль без тела, ссылка [[#id]] на месте', async () => {
    const text = 'до заметка после';
    const from = text.indexOf('заметка');
    const to = from + 'заметка'.length;
    const editor = fakeEditor(text, from, to);
    const { port, created, picks } = fakePort({
      pick: async () => ({ items: [{ kind: 'new', title: 'заметка', synonyms: [] }] }),
    });
    create.setCommentThoughtCreatePort(port);

    commands.runCommentCommand(create.CREATE_FROM_SELECTION_COMMAND, host(editor));
    await flush();

    assert.equal(picks.length, 1);
    assert.equal(picks[0]!.prefillText, 'заметка');
    assert.equal(created.length, 1);
    assert.equal(created[0]!.bodyMd, '');
    assert.deepEqual(editor.edits[0].changes[0], { from, to, insert: `[[#${NEW_ID}]]` });
  });

  it('S2: длинное → заголовок/тело, трансклюзия на месте', async () => {
    const text = 'Заголовок\nдлинное тело мысли';
    const editor = fakeEditor(text, 0, text.length);
    const { port, created, picks } = fakePort({
      pick: async () => ({ items: [{ kind: 'new', title: 'Заголовок', synonyms: [] }] }),
    });
    create.setCommentThoughtCreatePort(port);

    commands.runCommentCommand(create.CREATE_FROM_SELECTION_COMMAND, host(editor));
    await flush();

    assert.equal(picks[0]!.prefillText, 'Заголовок');
    assert.equal(created[0]!.title, 'Заголовок');
    assert.equal(created[0]!.bodyMd, 'длинное тело мысли');
    assert.deepEqual(editor.edits[0].changes[0], {
      from: 0,
      to: text.length,
      insert: `![[#${NEW_ID}]]`,
    });
  });

  it('диалог свернул выделение (текст не менялся) — правка по исходным позициям', async () => {
    const text = 'до\n\nзаметка\n\nпосле';
    const from = text.indexOf('заметка');
    const to = from + 'заметка'.length;
    const editor = mutableEditor(text, from, to);
    create.setCommentThoughtCreatePort({
      resolveParent: async () => PARENT_ID,
      pick: async () => ({ items: [{ kind: 'new', title: 'заметка', synonyms: [] }] }),
      thoughtTitle: async () => 'заметка',
      candidates: async () => [],
      choose: async () => null,
      create: async () => {
        // Диалог увёл фокус — выделение в поле свернулось, текст не изменился.
        editor.set(text, to, to);
        return { id: NEW_ID };
      },
    });

    commands.runCommentCommand(create.CREATE_FROM_SELECTION_COMMAND, host(editor));
    await flush();

    assert.deepEqual(editor.edits[0].changes[0], { from, to, insert: `[[#${NEW_ID}]]` });
  });

  it('многострочное с пустым остатком (хвостовые пустые строки) → без тела и ССЫЛКА', async () => {
    // Блокер верификатора: форма вставки определяется непустотой ТЕЛА, а не
    // «короткостью» случая. server сохраняет «Заголовок края\n\n»; остаток после
    // первой строки пуст ⇒ мысль без тела ⇒ на месте обычная ссылка, не трансклюзия.
    const text = 'Заголовок края\n\n';
    const editor = fakeEditor(text, 0, text.length);
    const { port, created } = fakePort({
      pick: async () => ({ items: [{ kind: 'new', title: 'Заголовок края', synonyms: [] }] }),
    });
    create.setCommentThoughtCreatePort(port);

    commands.runCommentCommand(create.CREATE_FROM_SELECTION_COMMAND, host(editor));
    await flush();

    assert.equal(created[0]!.bodyMd, '', 'остаток пуст — тело не создаётся');
    assert.deepEqual(editor.edits[0].changes[0], {
      from: 0,
      to: text.length,
      insert: `[[#${NEW_ID}]]`,
    });
  });

  it('отказ от диалога — ничего не меняется', async () => {    const editor = fakeEditor('заметка', 0, 6);
    const { port, created } = fakePort(); // pick по умолчанию → null
    create.setCommentThoughtCreatePort(port);

    commands.runCommentCommand(create.CREATE_FROM_SELECTION_COMMAND, host(editor));
    await flush();

    assert.equal(created.length, 0);
    assert.equal(editor.edits.length, 0);
  });

  it('пакетный (список) путь: диалог не открывается, мысль на каждый элемент', async () => {
    const text = '- один\n- два';
    const editor = fakeEditor(text, 0, text.length);
    const { port, created, picks } = fakePort();
    create.setCommentThoughtCreatePort(port);

    commands.runCommentCommand(create.CREATE_FROM_SELECTION_COMMAND, host(editor));
    await flush();

    assert.equal(picks.length, 0, 'диалог не открывается');
    assert.deepEqual(
      created.map((request) => request.title),
      ['один', 'два'],
      'пакетно по элементам уровня первого выделенного (требование 45b53e11)',
    );
    assert.deepEqual(
      created.map((request) => request.bodyMd),
      ['', ''],
      'однострочные элементы без подчинённых — без тела',
    );
    // Без тела → на месте ссылка (требование 23c11231).
    assert.deepEqual(editor.edits[0].changes, [
      { from: 0, to: 6, insert: `[[#${NEW_ID}]]` },
      { from: 7, to: 12, insert: `[[#${NEW_ID}]]` },
    ]);
  });
});

describe('выбор существующей (требования ee64ce46, d4f3d8a0)', () => {
  it('частичная замена: литерально совпавшая с заголовком часть → ссылка', async () => {
    const text = 'Текст про Мысль тут';
    const editor = fakeEditor(text, 0, text.length);
    const at = text.indexOf('Мысль');
    const { port, created } = fakePort({
      pick: async () => ({ items: [{ kind: 'existing', id: LINK_ID }] }),
      thoughtTitle: async () => 'Мысль',
    });
    create.setCommentThoughtCreatePort(port);

    commands.runCommentCommand(create.CREATE_FROM_SELECTION_COMMAND, host(editor));
    await flush();

    assert.equal(created.length, 0, 'существующая мысль не создаётся');
    assert.deepEqual(editor.edits[0].changes, [
      { from: at, to: at + 'Мысль'.length, insert: `[[#${LINK_ID}]]` },
    ]);
  });

  it('нет совпадения — ссылка в НАЧАЛО, текст не меняется', async () => {
    const text = 'Совсем другой текст';
    const editor = fakeEditor(text, 0, text.length);
    const { port } = fakePort({
      pick: async () => ({ items: [{ kind: 'existing', id: LINK_ID }] }),
      thoughtTitle: async () => 'Иное',
    });
    create.setCommentThoughtCreatePort(port);

    commands.runCommentCommand(create.CREATE_FROM_SELECTION_COMMAND, host(editor));
    await flush();

    assert.deepEqual(editor.edits[0].changes, [{ from: 0, to: 0, insert: `[[#${LINK_ID}]]` }]);
  });

  it('совпадение регистронезависимо и по trim заголовка', async () => {
    const text = 'префикс мысль суффикс';
    const editor = fakeEditor(text, 0, text.length);
    const at = text.indexOf('мысль');
    const { port } = fakePort({
      pick: async () => ({ items: [{ kind: 'existing', id: LINK_ID }] }),
      thoughtTitle: async () => '  Мысль  ',
    });
    create.setCommentThoughtCreatePort(port);

    commands.runCommentCommand(create.CREATE_FROM_SELECTION_COMMAND, host(editor));
    await flush();

    assert.deepEqual(editor.edits[0].changes, [
      { from: at, to: at + 'мысль'.length, insert: `[[#${LINK_ID}]]` },
    ]);
  });
});

describe('перепрокладка разделения (ошибка da5e74b0)', () => {
  it('разделение: правки уезжают по сдвинутым позициям', async () => {
    const text = 'абзац один\n\nабзац два';
    const editor = mutableEditor(text, 0, text.length);
    let mutated = false;
    const { port } = sequencePort();
    create.setCommentThoughtCreatePort({
      ...port,
      create: async (request: CommentThoughtCreateRequest) => {
        if (!mutated) {
          mutated = true;
          // Первая из нескольких сетевых ступеней: сдвиг документа на +2.
          editor.set(`X ${text}`, 2, text.length + 2);
        }
        return (await port.create(request)) as { id: string };
      },
    });

    commands.runCommentCommand('comment.split', host(editor));
    await flush();

    // Однострочные абзацы без тела → ссылки на сдвинутых позициях.
    assert.deepEqual(editor.edits[0].changes, [
      { from: 2, to: 12, insert: `[[#${UNIT_IDS[0]}]]` },
      { from: 14, to: 23, insert: `[[#${UNIT_IDS[1]}]]` },
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * T2 (026241f2): тела абзацев/кода и пакетный дедуп (14539728).
 * ------------------------------------------------------------------ */

describe('T2: тело единиц-абзацев и блоков кода (требование 59ec432f)', () => {
  it('абзац: тело = остаток после заголовочной строки', () => {
    const text = 'Первая строка\nостаток тела\n\nвторой абзац';
    const plan = create.planSplitSelection({ text, from: 0, to: text.length });
    assert.equal(plan?.length, 2);
    assert.equal(plan![0]!.title, 'Первая строка');
    assert.equal(plan![0]!.bodyMd, 'остаток тела');
    assert.equal(plan![1]!.bodyMd, '', 'однострочный абзац — без тела');
  });

  it('абзац: первая строка > 250 — тело = весь текст единицы', () => {
    const text = `${'x'.repeat(300)}\nхвост\n\nвторой`;
    const plan = create.planSplitSelection({ text, from: 0, to: text.length });
    assert.equal(plan![0]!.bodyMd, `${'x'.repeat(300)}\nхвост`);
  });

  it('блок кода: название — первая непустая строка КАК ЕСТЬ, тело — весь блок', () => {
    const text = 'абзац\n\n```\n## foo\nbar\n```';
    const plan = create.planSplitSelection({ text, from: 0, to: text.length });
    assert.equal(plan![1]!.title, '## foo', '# внутри кода — контент, не снимается');
    assert.equal(plan![1]!.bodyMd, '```\n## foo\nbar\n```');
  });

  it('S9: смешанное выделение «абзац + список» — пакетный путь по единицам', async () => {
    const text = 'абзац\n\n- пункт';
    const editor = fakeEditor(text, 0, text.length);
    const { port, created, picks } = fakePort();
    create.setCommentThoughtCreatePort(port);

    commands.runCommentCommand(create.CREATE_FROM_SELECTION_COMMAND, host(editor));
    await flush();

    assert.equal(picks.length, 0, 'диалог не открывается — пакетный путь');
    assert.deepEqual(
      created.map((request) => request.title),
      ['абзац', 'пункт'],
      'абзац — по правилам абзаца, список — по правилам списка',
    );
    assert.deepEqual(editor.edits[0].changes, [
      { from: 0, to: 5, insert: `[[#${NEW_ID}]]` },
      { from: 7, to: 14, insert: `[[#${NEW_ID}]]` },
    ]);
  });
});

/** Хит кандидата нужной формы для портов дедупа. */
function hit(id: string, title: string, matchedOn: 'title' | 'synonym' = 'title'): any {
  return {
    id,
    title,
    synonyms: [],
    matched_on: matchedOn,
    type_id: null,
    icon: null,
    icon_kind: 'none',
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    parent_title: null,
  };
}

describe('T2: дедуп по точному названию/синониму (требование 14539728)', () => {
  it('ровно одно совпадение — используется существующая, дубль не создаётся', async () => {
    const text = '- один\n- два';
    const editor = fakeEditor(text, 0, text.length);
    const { port, created } = fakePort({
      candidates: async (title) => (title === 'один' ? [hit('EXIST-1', 'один')] : []),
      thoughtTitle: async (id) => (id === 'EXIST-1' ? 'один' : `Заголовок ${id}`),
    });
    create.setCommentThoughtCreatePort(port);

    commands.runCommentCommand(create.CREATE_FROM_SELECTION_COMMAND, host(editor));
    await flush();

    assert.deepEqual(created.map((request) => request.title), ['два'], 'дубль «один» не создан');
    assert.deepEqual(editor.edits[0].changes, [
      { from: 2, to: 6, insert: '[[#EXIST-1]]' },
      { from: 7, to: 12, insert: `[[#${NEW_ID}]]` },
    ]);
  });

  it('совпадение по wildcard-синониму учитывается (классификация сервера)', async () => {
    const text = '- исправленные ошибки';
    const editor = fakeEditor(text, 0, text.length);
    const { port, created } = fakePort({
      candidates: async () => [hit('WILD-1', 'Исправленные ошибки', 'synonym')],
      thoughtTitle: async () => 'другой заголовок',
    });
    create.setCommentThoughtCreatePort(port);

    commands.runCommentCommand(create.CREATE_FROM_SELECTION_COMMAND, host(editor));
    await flush();

    assert.equal(created.length, 0, 'wildcard-синоним — совпадение, дубль не создаётся');
    assert.deepEqual(editor.edits[0].changes, [{ from: 0, to: 0, insert: '[[#WILD-1]]' }]);
  });

  it('несколько совпадений — поповер у элемента с анкер-координатой; выбор → ссылка', async () => {
    const text = '- один\n- два';
    const edits: any[] = [];
    const choices: Array<{ x: number; y: number; name: string; count: number }> = [];
    const editor = {
      snapshot: () => ({ text, from: 0, to: text.length }),
      applyEdit: (edit: any) => edits.push(edit),
      pointAt: (pos: number) => ({ x: 100 + pos, y: 200 }),
    };
    const { port, created } = fakePort({
      candidates: async (title) => (title === 'один' ? [hit('A', 'один'), hit('B', 'один')] : []),
      choose: async (anchor, name, candidates) => {
        choices.push({ ...anchor, name, count: candidates.length });
        return 'B';
      },
      thoughtTitle: async () => 'один',
    });
    create.setCommentThoughtCreatePort(port);

    commands.runCommentCommand(create.CREATE_FROM_SELECTION_COMMAND, host(editor));
    await flush();

    assert.deepEqual(choices, [{ x: 100, y: 200, name: 'один', count: 2 }], 'анкер — координата элемента');
    assert.deepEqual(created.map((request) => request.title), ['два'], 'создан только элемент без кандидатов');
    assert.equal(edits[0].changes[0].insert, '[[#B]]', 'выбранная существующая → ссылка');
  });

  it('отказ от поповера — элемент остаётся без изменений', async () => {
    const text = '- один\n- два';
    const editor = fakeEditor(text, 0, text.length);
    const { port, created } = fakePort({
      candidates: async (title) => (title === 'один' ? [hit('A', 'один'), hit('B', 'один')] : []),
      choose: async () => null,
    });
    create.setCommentThoughtCreatePort(port);

    commands.runCommentCommand(create.CREATE_FROM_SELECTION_COMMAND, host(editor));
    await flush();

    assert.deepEqual(created.map((request) => request.title), ['два'], 'создан только элемент без кандидатов');
    assert.deepEqual(editor.edits[0].changes, [{ from: 7, to: 12, insert: `[[#${NEW_ID}]]` }]);
  });
});

describe('T2 S8: дедуп команды «Создать мысль из раздела» (14539728)', () => {
  it('ровно одно совпадение → существующая мысль, дубль не создаётся', async () => {
    const text = '# Раздел\n\nтело';
    const editor = fakeEditor(text, 0, 0); // каретка в разделе
    const { port, created } = fakePort({
      candidates: async () => [hit('EXIST-1', 'Раздел')],
      thoughtTitle: async (id) => (id === 'EXIST-1' ? 'Раздел' : `Заголовок ${id}`),
    });
    create.setCommentThoughtCreatePort(port);

    // Каретка в разделе: planFromSection нужен from внутри раздела.
    const caught = { text, from: 2, to: 2 };
    const ed = { ...editor, snapshot: () => caught };
    commands.runCommentCommand(create.CREATE_FROM_SECTION_COMMAND, host(ed));
    await flush();

    assert.equal(created.length, 0, 'существующая — дубль не создаётся');
    // Литеральное вхождение «Раздел» в «# Раздел…» заменяется ссылкой.
    assert.deepEqual(ed.edits[0].changes, [{ from: 2, to: 8, insert: '[[#EXIST-1]]' }]);
  });

  it('несколько совпадений → поповер; отказ → создание новой по штатным правилам', async () => {
    const text = '# Раздел\n\nтело';
    const edits: any[] = [];
    const ed = {
      snapshot: () => ({ text, from: 2, to: 2 }),
      applyEdit: (edit: any) => edits.push(edit),
      pointAt: () => ({ x: 5, y: 6 }),
    };
    const { port, created } = fakePort({
      candidates: async () => [hit('A', 'Раздел'), hit('B', 'Раздел')],
      choose: async () => null,
    });
    create.setCommentThoughtCreatePort(port);

    commands.runCommentCommand(create.CREATE_FROM_SECTION_COMMAND, host(ed));
    await flush();

    assert.equal(created.length, 1, 'отказ от поповера — прежнее поведение без дедупа');
    assert.equal(created[0]!.title, 'Раздел');
    assert.equal(created[0]!.bodyMd, 'тело');
    assert.deepEqual(edits[0].changes[0], {
      from: 0,
      to: text.length,
      insert: `![[#${NEW_ID}]]`,
    });
  });
});


/**
 * Unit tests of transclusion parsing and expansion in the single renderer
 * package (задача `8365f262`, ТП2; ADR `85a7a01e`, ADR `8c41387c`). Pure — no
 * DB, no DOM: the source texts are injected through a stub resolver.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TRANSCLUSION_MAX_DEPTH,
  TRANSCLUSION_MARKER_PREFIX,
  formatTransclusionRef,
  parseTransclusions,
  extractSection,
  expandTransclusions,
  renderMarkdown,
  type TransclusionResolver,
} from '../src/index.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';
const E = '55555555-5555-4555-8555-555555555555';
const F = '66666666-6666-4666-8666-666666666666';

/** Resolver over a plain id→body map; records the calls it received. */
function makeResolver(
  bodies: Record<string, string>,
  calls: Array<[string, string | undefined]> = [],
): TransclusionResolver {
  return (sourceId, sectionTitle) => {
    calls.push([sourceId, sectionTitle]);
    const body = bodies[sourceId];
    return body === undefined ? { found: false, body_md: '' } : { found: true, body_md: body };
  };
}

const PREFIX = `<!-- ${TRANSCLUSION_MARKER_PREFIX}`;

// ---------------------------------------------------------------------------
// Парсер ссылок
// ---------------------------------------------------------------------------

test('парсер: обе формы ссылки — полный комментарий и раздел', () => {
  const md = `до ![[#${A}]] и ![[#${B}#Раздел A]] после`;
  const refs = parseTransclusions(md);
  assert.equal(refs.length, 2);

  assert.deepEqual(
    { sourceId: refs[0]!.sourceId, section: refs[0]!.section, raw: refs[0]!.raw },
    { sourceId: A, section: null, raw: `![[#${A}]]` },
  );
  assert.deepEqual(
    { sourceId: refs[1]!.sourceId, section: refs[1]!.section, raw: refs[1]!.raw },
    { sourceId: B, section: 'Раздел A', raw: `![[#${B}#Раздел A]]` },
  );
  for (const ref of refs) {
    assert.equal(md.slice(ref.start, ref.end), ref.raw, 'диапазон указывает на исходный текст');
  }
});

test('парсер: id приводится к нижнему регистру, раздел с решёткой сохраняется', () => {
  const upper = A.toUpperCase();
  const refs = parseTransclusions(`![[#${upper}#C#2]]`);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.sourceId, A);
  assert.equal(refs[0]!.section, 'C#2');
  // Пустой раздел после `#` = весь комментарий.
  assert.equal(parseTransclusions(`![[#${A}#]]`)[0]!.section, null);
});

test('парсер: не-трансклюзии остаются литералом', () => {
  assert.equal(parseTransclusions(`[[#${A}]]`).length, 0, 'wiki-ссылка без `!`');
  assert.equal(parseTransclusions('![[#not-a-uuid]]').length, 0, 'не-UUID цель');
  assert.equal(parseTransclusions(`\\![[#${A}]]`).length, 0, 'экранированная ссылка');
  assert.equal(parseTransclusions(`![[#${A}\n#x]]`).length, 0, 'многострочная ссылка');
});

test('парсер: код (фенс и инлайн) не является трансклюзией', () => {
  assert.equal(parseTransclusions(`\`\`\`\n![[#${A}]]\n\`\`\``).length, 0, 'в фенс-блоке');
  assert.equal(parseTransclusions(`текст \`![[#${A}]]\` текст`).length, 0, 'в инлайн-коде');
  // Вне кода та же ссылка распознаётся.
  assert.equal(parseTransclusions(`\`\`\`\nкод\n\`\`\`\n![[#${A}]]`).length, 1);
});

// ---------------------------------------------------------------------------
// Извлечение раздела
// ---------------------------------------------------------------------------

test('extractSection: раздел с подразделами, граница — заголовок того же уровня', () => {
  const body = [
    '# Заголовок',
    '',
    '## Раздел',
    'текст',
    '',
    '### Подраздел',
    'под',
    '',
    '## Другой',
    'другое',
    '',
  ].join('\n');
  assert.equal(extractSection(body, 'Раздел'), '## Раздел\nтекст\n\n### Подраздел\nпод');
  // Одноимённых несколько — берётся первый.
  const dup = '## Раздел\nпервый\n## Раздел\nвторой\n';
  assert.equal(extractSection(dup, 'Раздел'), '## Раздел\nпервый');
  // Искомого заголовка нет.
  assert.equal(extractSection(body, 'Нет такого'), null);
  // Регистр и обрамляющие пробелы не важны.
  assert.equal(extractSection(body, '  раздел  '), '## Раздел\nтекст\n\n### Подраздел\nпод');
});

test('extractSection: заголовок внутри фенс-блока не считается', () => {
  const body = '```\n## Раздел\n```\nтекст\n';
  assert.equal(extractSection(body, 'Раздел'), null);
});

// ---------------------------------------------------------------------------
// Развёртка
// ---------------------------------------------------------------------------

test('развёртка: полный комментарий с маркерами begin/end нужного уровня', () => {
  const md = `текст\n![[#${A}]]\nконец`;
  const out = expandTransclusions(md, makeResolver({ [A]: 'тело A' }));
  assert.equal(
    out,
    `текст\n${PREFIX} begin source=${A} depth=1 -->\nтело A\n${PREFIX} end source=${A} depth=1 -->\nконец`,
  );
});

test('развёртка: резолвер получает sectionTitle только для раздела', () => {
  const calls: Array<[string, string | undefined]> = [];
  const resolve = makeResolver({ [A]: '## Раздел\nтело' }, calls);
  expandTransclusions(`![[#${A}]]`, resolve);
  expandTransclusions(`![[#${A}#Раздел]]`, resolve);
  assert.deepEqual(calls, [
    [A, undefined],
    [A, 'Раздел'],
  ]);
});

test('развёртка: раздел вырезается вместе с подразделами, section — в begin, не в end', () => {
  const body = '## Раздел\nтело\n### Под\nпод\n## Другой\nчужое\n';
  const out = expandTransclusions(`![[#${A}#Раздел]]`, makeResolver({ [A]: body }));
  assert.ok(out.includes(`${PREFIX} begin source=${A} section="Раздел" depth=1 -->`));
  assert.ok(out.includes(`${PREFIX} end source=${A} depth=1 -->`));
  assert.ok(out.includes('тело\n### Под\nпод'));
  assert.ok(!out.includes('чужое'), 'текст за границей раздела не попадает');
});

test('развёртка: неиспользуемый текст без ссылок не меняется, резолвер не зовётся', () => {
  const calls: Array<[string, string | undefined]> = [];
  const md = '# Заголовок\nобычный текст';
  assert.equal(expandTransclusions(md, makeResolver({}, calls)), md);
  assert.equal(calls.length, 0);
});

test('развёртка: код не разворачивается', () => {
  const calls: Array<[string, string | undefined]> = [];
  const md = `\`\`\`\n![[#${A}]]\n\`\`\``;
  assert.equal(expandTransclusions(md, makeResolver({ [A]: 'тело' }, calls)), md);
  assert.equal(calls.length, 0);
});

test('развёртка: вложенность до 5 уровней, на 6-м — skip depth_limit', () => {
  const ids = [A, B, C, D, E, F];
  const bodies: Record<string, string> = {};
  for (let i = 0; i < ids.length - 1; i++) {
    bodies[ids[i]!] = `уровень ${i + 1}\n![[#${ids[i + 1]}]]`;
  }
  bodies[F] = 'уровень 6';
  const out = expandTransclusions(`![[#${A}]]`, makeResolver(bodies));

  for (let i = 0; i < 5; i++) {
    assert.ok(
      out.includes(`${PREFIX} begin source=${ids[i]} depth=${i + 1} -->`),
      `begin уровня ${i + 1}`,
    );
  }
  assert.ok(out.includes(`${PREFIX} end source=${E} depth=5 -->`));
  assert.ok(out.includes(`${PREFIX} skip source=${F} depth=6 reason=depth_limit -->`));
  assert.ok(!out.includes(`begin source=${F}`), 'шестой уровень не разворачивается');
});

test('развёртка: цикл A→B→A не разворачивается', () => {
  const bodies = { [A]: `A\n![[#${B}]]`, [B]: `B\n![[#${A}]]` };
  const out = expandTransclusions(`![[#${A}]]`, makeResolver(bodies));
  assert.ok(out.includes(`${PREFIX} begin source=${A} depth=1 -->`));
  assert.ok(out.includes(`${PREFIX} begin source=${B} depth=2 -->`));
  assert.ok(out.includes(`${PREFIX} skip source=${A} depth=3 reason=cycle -->`));
});

test('развёртка: нет источника — missing с reason=source', () => {
  const out = expandTransclusions(`![[#${A}]]`, makeResolver({}));
  assert.ok(out.includes(`${PREFIX} missing source=${A} reason=source -->`));
  assert.ok(!out.includes('begin'));
});

test('развёртка: раздела нет в источнике — missing с section и reason=section', () => {
  const out = expandTransclusions(`![[#${A}#Раздел]]`, makeResolver({ [A]: '## Другой\nx' }));
  assert.ok(out.includes(`${PREFIX} missing source=${A} section="Раздел" reason=section -->`));
});

test('развёртка: нет источника со ссылкой на раздел — reason=source', () => {
  const out = expandTransclusions(`![[#${A}#Раздел]]`, makeResolver({}));
  assert.ok(out.includes(`${PREFIX} missing source=${A} section="Раздел" reason=source -->`));
});

test('развёртка: section экранируется в маркере', () => {
  const title = 'Раздел "X" \\ Y';
  const body = `## ${title}\nтело\n`;
  const out = expandTransclusions(`![[#${A}#${title}]]`, makeResolver({ [A]: body }));
  assert.ok(out.includes(`${PREFIX} begin source=${A} section="Раздел \\"X\\" \\\\ Y" depth=1 -->`));
});

test('развёртка: несколько ссылок разворачиваются подряд', () => {
  const out = expandTransclusions(
    `![[#${A}]] + ![[#${B}]]`,
    makeResolver({ [A]: 'AAA', [B]: 'BBB' }),
  );
  assert.ok(out.includes(`${PREFIX} begin source=${A} depth=1 -->\nAAA\n${PREFIX} end source=${A} depth=1 -->`));
  assert.ok(out.includes(`${PREFIX} begin source=${B} depth=1 -->\nBBB\n${PREFIX} end source=${B} depth=1 -->`));
});

test('развёртка: предел глубины — константа 5', () => {
  assert.equal(TRANSCLUSION_MAX_DEPTH, 5);
});

// ---------------------------------------------------------------------------
// Развёртка без маркеров — «как текст» (задача e9f553e5)
// ---------------------------------------------------------------------------

test('маркеры false: полный комментарий разворачивается без маркеров и без лишних строк', () => {
  const md = `текст\n![[#${A}]]\nконец`;
  const out = expandTransclusions(md, makeResolver({ [A]: 'тело A' }), { markers: false });
  assert.equal(out, 'текст\nтело A\nконец');
  assert.ok(!out.includes('etn:transclusion'), 'маркеры не просачиваются');
});

test('маркеры false: раздел разворачивается содержимым, ссылка проглатывается', () => {
  const body = '## Раздел\nтело\n### Под\nпод\n## Другой\nчужое\n';
  const out = expandTransclusions(`![[#${A}#Раздел]]`, makeResolver({ [A]: body }), { markers: false });
  assert.equal(out, '## Раздел\nтело\n### Под\nпод');
});

test('маркеры false: нет источника — пусто (ссылка удалена)', () => {
  const out = expandTransclusions(`до ![[#${A}]] после`, makeResolver({}), { markers: false });
  assert.equal(out, 'до  после');
});

test('маркеры false: нет раздела — пусто', () => {
  const out = expandTransclusions(`![[#${A}#Нет]]`, makeResolver({ [A]: '## Есть\nx' }), { markers: false });
  assert.equal(out, '');
});

test('маркеры false: вложенность разворачивается, цикл и предел глубины гаснут', () => {
  const nested = expandTransclusions(
    `![[#${A}]]`,
    makeResolver({ [A]: `A\n![[#${B}]]`, [B]: 'B' }),
    { markers: false },
  );
  assert.equal(nested, 'A\nB');

  const cyclic = expandTransclusions(
    `![[#${A}]]`,
    makeResolver({ [A]: `A\n![[#${B}]]`, [B]: `B\n![[#${A}]]` }),
    { markers: false },
  );
  assert.equal(cyclic, 'A\nB\n', 'повтор ссылки в цепочке не разворачивается');

  const ids = [A, B, C, D, E, F];
  const bodies: Record<string, string> = {};
  for (let i = 0; i < ids.length - 1; i++) bodies[ids[i]!] = `у${i + 1}\n![[#${ids[i + 1]}]]`;
  bodies[F] = 'у6';
  const deep = expandTransclusions(`![[#${A}]]`, makeResolver(bodies), { markers: false });
  assert.equal(deep, 'у1\nу2\nу3\nу4\nу5\n', 'шестой уровень за пределом не разворачивается');
});

test('маркеры по умолчанию: вывод прежний (с маркерами)', () => {
  const out = expandTransclusions(`![[#${A}]]`, makeResolver({ [A]: 'тело' }));
  assert.ok(out.includes(`${PREFIX} begin source=${A} depth=1 -->`));
});

// ---------------------------------------------------------------------------
// Блочная обёртка развёртки (задача a2b68d72, ADR c425202a)
// ---------------------------------------------------------------------------

const LABELS = { noSource: 'нет источника', noSection: 'нет раздела', skipped: 'не раскрыто' };

test('блоки: опция выключена — вывод прежний (маркеры скрыты)', () => {
  const out = expandTransclusions(`![[#${A}]]`, makeResolver({ [A]: 'тело' }));
  const html = renderMarkdown(out);
  assert.ok(!html.includes('md-transclusion'));
  assert.ok(!html.includes('etn:transclusion'));
  assert.match(html, /тело/);
});

test('блоки: опция включает обёртку с глубиной и источником', () => {
  const out = expandTransclusions(`![[#${A}]]`, makeResolver({ [A]: 'тело' }));
  const html = renderMarkdown(out, { transclusion: { labels: LABELS } });
  assert.match(
    html,
    new RegExp(`<div class="md-transclusion" data-transclusion-depth="1" data-transclusion-source="${A}">`),
  );
  assert.match(html, /<p>тело<\/p>/);
  assert.ok(html.includes('</div>'));
});

test('блоки: вложенность даёт глубину 2', () => {
  const out = expandTransclusions(`![[#${A}]]`, makeResolver({ [A]: `A ![[#${B}]]`, [B]: 'B' }));
  const html = renderMarkdown(out, { transclusion: { labels: LABELS } });
  assert.match(html, /data-transclusion-depth="1"[^>]*data-transclusion-source="[^"]+"/);
  assert.match(html, /data-transclusion-depth="2"/);
});

test('блоки: нет источника — контейнер ошибки с подписью', () => {
  const out = expandTransclusions(`![[#${A}]]`, makeResolver({}));
  const html = renderMarkdown(out, { transclusion: { labels: LABELS } });
  assert.match(html, /<div class="md-transclusion md-transclusion--missing"[^>]*>нет источника<\/div>/);
});

test('блоки: раздела нет — подпись раздела и атрибут section', () => {
  const out = expandTransclusions(`![[#${A}#Нет]]`, makeResolver({ [A]: '## Есть\nx' }));
  const html = renderMarkdown(out, { transclusion: { labels: LABELS } });
  assert.ok(html.includes('data-transclusion-section="Нет"'));
  assert.match(html, />нет раздела<\/div>/);
});

test('блоки: подписи экранируются', () => {
  const out = expandTransclusions(`![[#${A}]]`, makeResolver({}));
  const html = renderMarkdown(out, {
    transclusion: { labels: { ...LABELS, noSource: '<b>нет</b>' } },
  });
  assert.ok(html.includes('&lt;b&gt;нет&lt;/b&gt;'));
});

test('блоки: нет источника со ссылкой на раздел — подпись «нет источника»', () => {
  const out = expandTransclusions(`![[#${A}#Раздел]]`, makeResolver({}));
  const html = renderMarkdown(out, { transclusion: { labels: LABELS } });
  assert.ok(html.includes('md-transclusion--missing'));
  assert.ok(html.includes('data-transclusion-section="Раздел"'));
  assert.match(html, />нет источника<\/div>/);
  assert.ok(!html.includes('нет раздела'));
});

test('блоки: раздела нет — подпись «нет раздела»', () => {
  const out = expandTransclusions(`![[#${A}#Нет]]`, makeResolver({ [A]: '## Есть\nx' }));
  const html = renderMarkdown(out, { transclusion: { labels: LABELS } });
  assert.match(html, />нет раздела<\/div>/);
});

test('блоки: skip при пределе глубины клампится в 1..5', () => {
  const bodies: Record<string, string> = {
    [A]: `![[#${B}]]`,
    [B]: `![[#${C}]]`,
    [C]: `![[#${D}]]`,
    [D]: `![[#${E}]]`,
    [E]: `![[#${F}]]`,
  };
  const out = expandTransclusions(`![[#${A}]]`, makeResolver(bodies));
  const html = renderMarkdown(out, { transclusion: { labels: LABELS } });
  assert.ok(html.includes('md-transclusion--skipped'));
  assert.ok(html.includes('data-transclusion-depth="5"'));
  assert.ok(!html.includes('data-transclusion-depth="6"'));
});

test('formatTransclusionRef: прямая и обратная операция согласованы', () => {
  assert.equal(formatTransclusionRef(A), `![[#${A}]]`);
  assert.equal(formatTransclusionRef(A.toUpperCase()), `![[#${A}]]`, 'id нормализуется');
  assert.equal(formatTransclusionRef(A, 'Раздел'), `![[#${A}#Раздел]]`);
  assert.equal(formatTransclusionRef(A, '   '), `![[#${A}]]`, 'пустой раздел — полный комментарий');

  const ref = parseTransclusions(formatTransclusionRef(A, 'C# / заметки'))[0];
  assert.equal(ref?.sourceId, A);
  assert.equal(ref?.section, 'C# / заметки', 'решётка внутри раздела сохраняется');

  assert.throws(() => formatTransclusionRef('not-a-uuid'), /UUID/);
  assert.throws(() => formatTransclusionRef(A, 'две\nстроки'), /line break/);
});

/**
 * Реальные markdown-фикстуры из бэкапа сети `.etnx` (задача 35caade8).
 *
 * Фикстуры в `tests/fixtures/real-markdown/` — не рукодельные мини-сеты, а
 * СНИМКИ реальных данных тестовой мыслесети «Тест 1» (etn-dev, карточка
 * `a29fd66f`), нарезанные скриптом `client/scripts/fixture-slice.mjs` из
 * экспорта `.etnx`:
 *
 *   * `<base>.md`   — `body_md` реального комментария (байт-в-байт);
 *   * `<base>.html` — вывод единого рендерера `@etn/markdown`
 *                     (`renderMarkdown(<base>.md)`) на момент нарезки;
 *   * `<base>.json` — снимок мысли в конверте REST `{ data: <Thought> }`.
 *
 * Тест держит два инварианта планки тестов (стандарт cf236d42):
 *   1. единый рендерер воспроизводит снимок HTML на реальном markdown —
 *      регрессия рендеринга видна сразу (golden-снимок);
 *   2. конкретные конструкции реального корпуса (id-ссылка с алиасом,
 *      task-список, таблица, блок кода) действительно отрисованы — снимок
 *      не «случайно совпал» и не выродился.
 *
 * Фикстуры детерминированы (стабильная сортировка, без дат) — снимки можно
 * коммитить и сравнивать диффом; пере-нарезка даёт те же байты.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { renderMarkdown } from '@etn/markdown';

const FIXTURES_DIR = path.resolve(import.meta.dirname, 'fixtures', 'real-markdown');

/** Базовые имена фикстур (без расширения), стабильно отсортированы. */
function fixtureBases(): string[] {
  return fs
    .readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3))
    .sort();
}

/** Прочитать фикстуру по имени и расширению. */
function read(base: string, ext: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, `${base}.${ext}`), 'utf8');
}

describe('реальный markdown из .etnx: снимок единого рендерера (35caade8)', () => {
  it('нарезано нескольким фикстурам и найден каталог', () => {
    const bases = fixtureBases();
    assert.ok(bases.length >= 1, 'должна быть хотя бы одна нарезанная фикстура');
    for (const base of bases) {
      assert.ok(fs.existsSync(path.join(FIXTURES_DIR, `${base}.html`)), `${base}.html отсутствует`);
      assert.ok(fs.existsSync(path.join(FIXTURES_DIR, `${base}.json`)), `${base}.json отсутствует`);
    }
  });

  it('единый рендерер воспроизводит HTML-снимок для каждой реальной фикстуры', () => {
    for (const base of fixtureBases()) {
      const md = read(base, 'md');
      const expectedHtml = read(base, 'html');
      assert.equal(
        renderMarkdown(md),
        expectedHtml,
        `${base}: вывод @etn/markdown разошёлся со снимком реального рендеринга`,
      );
    }
  });

  it('wiki-link-alias: id-ссылка с алиасом отрисована span’ом с алиасом в теле', () => {
    const html = renderMarkdown(read('wiki-link-alias', 'md'));
    assert.match(
      html,
      /<span class="wiki-link" data-wiki-id="deef17eb-defb-430e-bcc1-99c2c9b270c5"[^>]*>первая мысль<\/span>/,
      'alias id-ссылки должен остаться видимым телом span’а',
    );
  });

  it('task-template: task-список, горизонтальная линия и код сохранены', () => {
    const html = renderMarkdown(read('task-template', 'md'));
    assert.match(html, /class="contains-task-list"/);
    assert.match(html, /class="task-list-item-checkbox" type="checkbox" disabled/);
    assert.match(html, /<hr>/);
    assert.match(html, /<code>property-manager\.ts<\/code>/);
  });

  it('etn-map-desktop: таблица, цитата и ограждённый код реального документа', () => {
    const html = renderMarkdown(read('etn-map-desktop', 'md'));
    assert.match(html, /<table>/);
    assert.match(html, /<blockquote>/);
    assert.match(html, /<pre><code/);
  });

  it('json-фикстуры: конверт { data: <Thought> } без «плавающих» полей', () => {
    const volatile = [
      'created_at',
      'updated_at',
      'created_at_ms',
      'updated_at_ms',
      'created_by',
      'updated_by',
      'version',
    ];
    for (const base of fixtureBases()) {
      const snapshot = JSON.parse(read(base, 'json')) as { data: Record<string, unknown> };
      assert.equal(typeof snapshot.data.id, 'string', `${base}: data.id обязателен`);
      assert.equal(typeof snapshot.data.title, 'string', `${base}: data.title обязателен`);
      assert.ok(Array.isArray(snapshot.data.synonyms), `${base}: synonyms — массив`);
      for (const key of volatile) {
        assert.ok(!(key in snapshot.data), `${base}: «плавающее» поле ${key} не должно попадать в снимок`);
      }
    }
  });
});

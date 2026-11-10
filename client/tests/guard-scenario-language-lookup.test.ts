/**
 * Сторож языка-независимых ожиданий GUI-сценариев стенда (0.15.4, ошибка
 * c73bcb60; продолжение 34077dcb/bfc8e6d6 — там закрыт класс вкладок).
 *
 * Правило 1. В сценариях, прошедших языковую зачистку, UI-подпись нельзя искать
 * литералом: подписи локализованы (ADR `daab6ac4`), сервер стенда по умолчанию
 * `en`, и русский литерал молча возвращает «нет элемента» (или валит ожидание).
 * Запрещены кириллические литералы в конструкциях поиска по подписи:
 *   - селектор по атрибуту-подписи `[title=…]`, `placeholder…`;
 *   - выбор пункта меню `.menu-item` по тексту;
 *   - заголовок группы `.group-header`/`.group-title` по тексту;
 *   - текст тоста `.notice-text`, плейсхолдера `span.muted`, пометки
 *     `.prop-unreadable`;
 *   - подпись кнопки `.ui-btn` и закладки экрана `.view-tab` по тексту.
 * Разрешённые способы: устойчивый признак (`data-group-id`, класс, индекс
 * фиксированного набора) либо подстановка словаря ожиданий `{{text:<ключ>}}`
 * (значения по языкам, выбор по `document.documentElement.lang`).
 *
 * Список {@link LANGUAGE_CLEAN_SCENARIOS} — реестр зачищенных файлов: он только
 * растёт (новый зачищенный файл добавляется в том же изменении) и не должен
 * сокращаться. Остальные сценарии — известный долг: подписей в них ещё много
 * (селекторы `button.view-tab[title=…]`, пункты меню и т.п.), он закрывается
 * отдельными работами, а не этой.
 *
 * `aria-label` в правило НЕ входит: им размечены названия СВОЙСТВ (данные,
 * созданные самим сценарием), а не подписи интерфейса.
 *
 * Правило 2. Словарь `texts` сценария обязан быть двуязычным (ru + en) и не
 * содержать «мёртвых» ключей: ожидание на языке, которого нет в словаре, — это
 * провал прогона на этом языке, а мёртвый ключ копится как долг.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const CLIENT_ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPTS_ROOT = path.join(CLIENT_ROOT, 'scripts');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');

/** Языки, на которых сценарии стенда обязаны быть зелёными (решение заказчика 2026-11-10). */
const REQUIRED_LANGS = ['ru', 'en'];

/**
 * Сценарии, прошедшие языковую зачистку (ошибка c73bcb60): UI-подписи в них
 * адресуются устойчивым признаком или словарём `texts`.
 */
const LANGUAGE_CLEAN_SCENARIOS = [
  'ui-probe.21b9d23b-type-change.scenario.json',
  'ui-probe.2e87285b-property-order.scenario.json',
  'ui-probe.42a7c0a1-graph-refresh-class.scenario.json',
  'ui-probe.42a7c0a1-mass-links.scenario.json',
  'ui-probe.42a7c0a1-trash-chip.scenario.json',
  'ui-probe.45248206-outside-removal.scenario.json',
  'ui-probe.626b29bd-properties-add.scenario.json',
  'ui-probe.92172035-property-lifecycle.scenario.json',
  'ui-probe.bfe1bc24-reload-window.scenario.json',
  'ui-probe.d720265c-properties-read-fail.scenario.json',
  'ui-probe.d9bc6012-bulk-reverse-side.scenario.json',
  'ui-probe.da7bbb53-clear-row.scenario.json',
  'ui-probe.f803afb6-definitions-read-fail.scenario.json',
  'ui-probe.f8f8fa49-link-target-type-restriction.scenario.json',
  'ui-probe.ffc173c9-links-sibling.scenario.json',
  'ui-probe.snippet-wiki-links.scenario.json',
];

const CYR = '[А-Яа-яЁё]';

/** Конструкции поиска по локализованной подписи: имя правила → регулярка по строке шага. */
const LABEL_LOOKUPS: Array<{ rule: string; pattern: RegExp }> = [
  { rule: 'title-attribute', pattern: new RegExp(`\\[\\s*title[^\\]]*${CYR}`) },
  { rule: 'placeholder-attribute', pattern: new RegExp(`placeholder[^\\]]{0,40}${CYR}`) },
  // Прямое сравнение подписи КНОПКИ/пункта меню с кириллическим литералом:
  // `x.textContent.trim() === 'Восстановить'`, `b.title === 'Очистить значение'`.
  // Сравнения текста данных (имена мыслей, значения свойств) правилом не
  // ловятся: они заданы сценарием, а не каталогом локализации.
  {
    rule: 'button-label-equality',
    pattern: new RegExp(
      `(?:button|\\.ui-btn|\\.menu-item)[^;]{0,160}` +
        `(?:textContent|innerText|title)(?:\\s*\\.\\s*[a-zA-Z]+\\(\\))?\\s*` +
        `(?:===|!==|==|!=)\\s*['"\`][^'"\`]*${CYR}`,
    ),
  },
  { rule: 'menu-item-label', pattern: new RegExp(`\\.menu-item[^;]{0,160}${CYR}`) },
  { rule: 'group-title-label', pattern: new RegExp(`\\.group-(header|title)[^;]{0,160}${CYR}`) },
  { rule: 'notice-text-label', pattern: new RegExp(`\\.notice-text[^;]{0,160}${CYR}`) },
  { rule: 'loading-placeholder-label', pattern: new RegExp(`span\\.muted[^;]{0,160}${CYR}`) },
  { rule: 'unreadable-mark-label', pattern: new RegExp(`\\.prop-unreadable[^;]{0,160}${CYR}`) },
  { rule: 'button-label', pattern: new RegExp(`\\.ui-btn[^;]{0,200}${CYR}`) },
  { rule: 'view-tab-label', pattern: new RegExp(`\\.view-tab[^;]{0,160}${CYR}`) },
];

/** Одно нарушение правила 1. */
interface LabelViolation {
  rule: string;
  step: string;
  text: string;
}

/** Обойти строки шага и собрать нарушения поиска по подписи. */
function labelLookupViolations(value: unknown, stepName: string): LabelViolation[] {
  const violations: LabelViolation[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      for (const { rule, pattern } of LABEL_LOOKUPS) {
        if (pattern.test(node)) violations.push({ rule, step: stepName, text: node.slice(0, 200) });
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const item of Object.values(node)) visit(item);
    }
  };
  visit(value);
  return violations;
}

/** Разобранный сценарий стенда. */
interface ScenarioJson {
  steps: Array<{ name?: string } & Record<string, unknown>>;
  texts?: Record<string, Record<string, string>>;
}

/** Прочитать сценарий (JSON без комментариев — разбор как есть). */
function readScenario(file: string): ScenarioJson {
  return JSON.parse(fs.readFileSync(path.join(SCRIPTS_ROOT, file), 'utf8')) as ScenarioJson;
}

/** Все сценарии стенда (кроме образца `*.example.json`). */
function scenarioFiles(): string[] {
  return fs
    .readdirSync(SCRIPTS_ROOT)
    .filter((file) => file.endsWith('.scenario.json') && !file.endsWith('.example.json'))
    .sort();
}

/** Ключи подстановок `{{text:<ключ>}}` из строк шагов. */
function usedTextKeys(scenario: ScenarioJson): Set<string> {
  const keys = new Set<string>();
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      for (const match of node.matchAll(/\{\{text:([^{}]+)\}\}/g)) keys.add(match[1]!.trim());
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const item of Object.values(node)) visit(item);
    }
  };
  visit(scenario.steps);
  return keys;
}

describe('guard: сценарии стенда не ищут интерфейс по русской подписи (c73bcb60)', () => {
  it('в зачищенных сценариях нет поиска UI-подписи кириллическим литералом', () => {
    const found: string[] = [];
    for (const file of LANGUAGE_CLEAN_SCENARIOS) {
      if (!fs.existsSync(path.join(SCRIPTS_ROOT, file))) {
        found.push(`${file}: файл из реестра не найден`);
        continue;
      }
      const scenario = readScenario(file);
      scenario.steps.forEach((step, index) => {
        for (const violation of labelLookupViolations(step, step.name ?? `#${index + 1}`)) {
          found.push(`${file} :: ${violation.step} :: [${violation.rule}] ${violation.text}`);
        }
      });
    }
    assert.deepEqual(
      found,
      [],
      'Подписи локализованы (ADR daab6ac4): адресуйте элемент устойчивым признаком ' +
        '(data-group-id, класс, индекс фиксированного набора) или подстановкой {{text:<ключ>}}:\n' +
        found.join('\n'),
    );
  });

  it('правило краснеет на умышленном нарушении', () => {
    const step = {
      name: 'menu',
      probe:
        "(() => [...document.querySelectorAll('.menu .menu-item')].find((b)=>b.textContent.includes('Очистить')))()",
      click: 'button[title="Меню пользователя"]',
      waitFor: 'document.querySelector("input[placeholder=\'Заголовок свойства\']") !== null',
      eval: "(() => { const b=[...document.querySelectorAll('.trash-toolbar button')].find((x)=>x.textContent.trim()==='Восстановить'); if(!b) return 'no-btn'; b.click(); return 'ok'; })()",
    };
    const violations = labelLookupViolations(step, 'menu');
    assert.ok(
      violations.some((v) => v.rule === 'menu-item-label'),
      'пункт меню по подписи — нарушение',
    );
    assert.ok(
      violations.some((v) => v.rule === 'title-attribute'),
      'селектор по title — нарушение',
    );
    assert.ok(
      violations.some((v) => v.rule === 'placeholder-attribute'),
      'селектор по placeholder — нарушение',
    );
    assert.ok(
      violations.some((v) => v.rule === 'button-label-equality'),
      'сравнение подписи кнопки с кириллическим литералом — нарушение',
    );
    // Подстановка словаря и устойчивый признак нарушением не считаются.
    assert.deepEqual(
      labelLookupViolations(
        {
          name: 'ok',
          probe:
            "[...document.querySelectorAll('.menu .menu-item')].find((b)=>b.textContent.includes('{{text:clearItem}}'))",
          waitFor:
            'document.querySelector(\'[data-group-id="properties.outside"] > .group-header\') !== null',
        },
        'ok',
      ),
      [],
    );
  });

  it('группы редактора несут data-group-id (устойчивый признак для сценариев)', () => {
    const collapsible = fs.readFileSync(
      path.join(RENDERER_ROOT, 'lib', 'ui', 'collapsible.ts'),
      'utf8',
    );
    assert.match(
      collapsible,
      /root\.dataset\.groupId = spec\.id/,
      'корень группы пишет data-group-id',
    );
    const group = fs.readFileSync(path.join(RENDERER_ROOT, 'editor', 'group.ts'), 'utf8');
    assert.match(group, /id: spec\.id/, 'groupSection передаёт id группы компоненту');
  });

  it('словари ожиданий двуязычны и не содержат мёртвых ключей', () => {
    const problems: string[] = [];
    let dictionaries = 0;
    for (const file of scenarioFiles()) {
      const scenario = readScenario(file);
      const used = usedTextKeys(scenario);
      if (scenario.texts === undefined) {
        if (used.size > 0) problems.push(`${file}: {{text:…}} без словаря texts`);
        continue;
      }
      dictionaries += 1;
      for (const [key, langs] of Object.entries(scenario.texts)) {
        for (const lang of REQUIRED_LANGS) {
          if (typeof langs[lang] !== 'string' || langs[lang]!.trim() === '') {
            problems.push(`${file}: texts.${key} — нет текста для языка «${lang}»`);
          }
        }
        if (!used.has(key)) problems.push(`${file}: texts.${key} — ключ нигде не используется`);
      }
      for (const key of used) {
        if (scenario.texts[key] === undefined)
          problems.push(`${file}: {{text:${key}}} — ключа нет в словаре`);
      }
    }
    assert.deepEqual(problems, [], `Словари ожиданий:\n${problems.join('\n')}`);
    // Вакуумный гейт: без словарей правило ничего не проверяет.
    assert.ok(
      dictionaries >= LANGUAGE_CLEAN_SCENARIOS.length - 3,
      `словари ожиданий должны использоваться большинством зачищенных сценариев (их ${dictionaries})`,
    );
  });
});

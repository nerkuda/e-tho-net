/**
 * Диагностика строк редактора отбора (задача c74f17a0 ТП 11b2509a; элемент
 * интерфейса 4e634c9a «Диагностика строк»; требования 44d61c8a «красная»,
 * 325efc13 «жёлтая», cf8fdd4d «проверки конструктора», 3e47f52a «сортировка»).
 *
 * Проверяется чистый модуль `lib/filter-diagnostics.ts`:
 *   • проверки конструктора — пустая группа, условие без значения, противоречие
 *     в пределах одного поля (и то, что пустой корень «без условий» — не ошибка);
 *   • сведение диагностики ядра (`details.diagnostics`, `meta.warnings`,
 *     `unresolved`, строковые предупреждения) в одну шкалу с адресами строк;
 *   • адреса строк (`filter.children[0]…`, `sort[i]`) и сводки: красное
 *     запрещает применение, записи без адреса уходят в тултип превью.
 *
 * jsdom в проекте нет — модуль чистый, DOM не нужен; импорт после минимального
 * шима, как в соседних тестах рендера.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { EtnError, type FilterDiagnostic } from '@etn/shared';

let mod: typeof import('../src/renderer/lib/filter-diagnostics.js');

const CITY = { kind: 'property', property_id: 'p-city' } as any;
const DATE = { kind: 'property', property_id: 'p-date' } as any;

function leaf(entity: any, operator: string, value: any = { kind: 'none' }): any {
  return { kind: 'leaf', entity, operator, value };
}

function group(op: string, children: any[]): any {
  return { kind: 'group', op, children };
}

function scalar(value: string | number | boolean): any {
  return { kind: 'scalar', value };
}

const DELETED: FilterDiagnostic = {
  severity: 'error',
  code: 'entity_deleted',
  path: 'filter.children[0].entity',
  label: 'Город',
  value_label: null,
  deleted_at: '2026-10-01T00:00:00.000Z',
  message: 'Свойство «Город» удалено из сети — отбор нельзя применить.',
};

describe('диагностика строк отбора: проверки конструктора (cf8fdd4d)', () => {
  before(async () => {
    mod = await import('../src/renderer/lib/filter-diagnostics.js');
  });

  it('пустая ВЛОЖЕННАЯ группа — красное, пустой КОРЕНЬ «без условий» — не ошибка', () => {
    const tree = group('and', [leaf(CITY, 'eq', scalar('Москва')), group('or', [])]);
    const issues = mod.constructorFilterIssues(tree);
    assert.equal(issues.length, 1);
    assert.deepEqual(
      { code: issues[0]!.code, severity: issues[0]!.severity, path: issues[0]!.path, source: issues[0]!.source },
      { code: 'empty_group', severity: 'error', path: 'filter.children[1]', source: 'constructor' },
    );
    assert.equal(
      mod.constructorFilterIssues(group('and', [])).length,
      0,
      'корень пустого дерева — законная модель «отбор без условий»',
    );
    assert.equal(mod.constructorFilterIssues(null).length, 0);
  });

  it('условие без значения — красное; у «заполнено/имеет свойство» значения нет по природе', () => {
    const tree = group('and', [leaf(CITY, 'eq'), leaf(DATE, 'is_empty'), leaf(CITY, 'has')]);
    const issues = mod.constructorFilterIssues(tree);
    assert.equal(issues.length, 1, 'только «eq» без значения — ошибка');
    assert.equal(issues[0]!.code, 'condition_without_value');
    assert.equal(issues[0]!.severity, 'error');
    assert.equal(issues[0]!.path, 'filter.children[0]');

    assert.equal(mod.filterOperatorNeedsValue('eq'), true);
    assert.equal(mod.filterOperatorNeedsValue('is_empty'), false);
    assert.equal(mod.filterOperatorNeedsValue('not_empty'), false);
    assert.equal(mod.filterOperatorNeedsValue('has'), false);
    assert.equal(mod.filterOperatorNeedsValue('not_has'), false);
  });

  it('противоречие «заполнено + не заполнено» — жёлтое с адресом второй строки', () => {
    const tree = group('and', [leaf(CITY, 'is_empty'), leaf(CITY, 'not_empty')]);
    const issues = mod.constructorFilterIssues(tree);
    assert.equal(issues.length, 1);
    assert.equal(issues[0]!.code, 'contradiction');
    assert.equal(issues[0]!.severity, 'warning', 'отбор исполняется — красным не запрещаем');
    assert.equal(issues[0]!.path, 'filter.children[1]', '«исправить» ведёт в правимую строку');
    assert.match(issues[0]!.message, /заполнено/);
  });

  it('противоречие по границам диапазона: перевёрнутые границы — жёлтое, касание включительно — нет', () => {
    const crossed = group('and', [leaf(CITY, 'gt', scalar(10)), leaf(CITY, 'lt', scalar(5))]);
    assert.equal(mod.constructorFilterIssues(crossed).length, 1);
    const touching = group('and', [leaf(CITY, 'gte', scalar(5)), leaf(CITY, 'lte', scalar(5))]);
    assert.equal(
      mod.constructorFilterIssues(touching).length,
      0,
      'включительные границы на равных значениях выполнимы',
    );
    const shifted = group('and', [leaf(CITY, 'gte', scalar(6)), leaf(CITY, 'lte', scalar(5))]);
    assert.equal(mod.constructorFilterIssues(shifted).length, 1);
    const dates = group('and', [
      leaf(DATE, 'gt', scalar('2026-03-01')),
      leaf(DATE, 'lt', scalar('2026-01-02')),
    ]);
    const dateIssues = mod.constructorFilterIssues(dates);
    assert.equal(dateIssues.length, 1, 'ISO-даты сравнимы лексикой');
    assert.equal(dateIssues[0]!.path, 'filter.children[1]');
    assert.equal(
      mod.constructorFilterIssues(group('and', [leaf(CITY, 'in', { kind: 'list', items: ['a', 'b'] })])).length,
      0,
      'списки и подвыборки редактор не судит',
    );
  });

  it('противоречие ищется только внутри конъюнкции: ИЛИ и разные поля — не противоречие', () => {
    assert.equal(
      mod.constructorFilterIssues(group('or', [leaf(CITY, 'is_empty'), leaf(CITY, 'not_empty')])).length,
      0,
      'под ИЛИ «пусто или не пусто» — не противоречие',
    );
    assert.equal(
      mod.constructorFilterIssues(group('and', [leaf(CITY, 'is_empty'), leaf(DATE, 'not_empty')])).length,
      0,
      'разные поля не противоречат друг другу',
    );
    const nested = group('and', [leaf(CITY, 'is_empty'), group('and', [leaf(CITY, 'not_empty')])]);
    const issues = mod.constructorFilterIssues(nested);
    assert.equal(issues.length, 1, 'конъюнкция сквозь вложенную группу И');
    assert.equal(issues[0]!.path, 'filter.children[1].children[0]');
  });
});

describe('диагностика строк отбора: данные ядра и адреса строк', () => {
  before(async () => {
    mod = await import('../src/renderer/lib/filter-diagnostics.js');
  });

  it('адрес строки: индексный путь модели → путь AST, ключ сортировки → sort[i]', () => {
    assert.equal(mod.filterIssueNodePath([]), 'filter');
    assert.equal(mod.filterIssueNodePath([0]), 'filter.children[0]');
    assert.equal(mod.filterIssueNodePath([0, 1]), 'filter.children[0].children[1]');
    assert.equal(mod.filterIssueSortPath(2), 'sort[2]');
  });

  it('диагностика ядра, неразрешимые токены и предупреждения сборки — одна шкала', () => {
    const issues = mod.filterIssuesFromPayload({
      diagnostics: [DELETED],
      warnings: [
        {
          severity: 'warning',
          code: 'property_detached',
          path: 'sort[0]',
          label: 'Дата',
          message: 'Свойство «Дата» сортировки больше не входит в набор свойств этого типа.',
        },
      ],
      unresolved: [
        { path: 'filter.children[1].value', token: '$now', reason: 'bad_token', message: 'токен не разобран' },
      ],
      messages: ['рецепт заголовков не исполнен'],
    });
    assert.equal(issues.length, 4);
    const [deleted, detached, token, build] = issues;
    assert.deepEqual(
      {
        severity: deleted!.severity,
        code: deleted!.code,
        path: deleted!.path,
        source: deleted!.source,
        label: deleted!.label,
        deletedAt: deleted!.deletedAt,
      },
      {
        severity: 'error',
        code: 'entity_deleted',
        path: 'filter.children[0].entity',
        source: 'server',
        label: 'Город',
        deletedAt: '2026-10-01T00:00:00.000Z',
      },
    );
    assert.equal(detached!.severity, 'warning');
    assert.equal(detached!.path, 'sort[0]');
    assert.equal(token!.severity, 'error', 'неразрешённый токен — применение невозможно');
    assert.equal(token!.code, 'token_unresolved');
    assert.equal(token!.path, 'filter.children[1].value');
    assert.equal(build!.code, 'build_warning');
    assert.equal(build!.path, '', 'у строкового предупреждения адреса строки нет');
  });

  it('красное из ошибки `EtnError` (details.diagnostics) и дедупликация записей', () => {
    const err = new EtnError('VALIDATION_ERROR', DELETED.message, { diagnostics: [DELETED, DELETED] });
    const issues = mod.filterIssuesFromError(err);
    assert.equal(issues.length, 1, 'дубль по (код, адрес, текст) схлопывается');
    assert.equal(issues[0]!.severity, 'error');
    assert.equal(mod.filterIssuesFromError(new Error('что-то ещё')).length, 0);
    assert.equal(mod.filterIssuesFromError(new EtnError('VALIDATION_ERROR', 'без деталей')).length, 0);
  });

  it('сводки: красное запрещает применение, записи без адреса — в тултип превью', () => {
    const warning = mod.filterIssuesFromPayload({
      warnings: [{ severity: 'warning', code: 'property_detached', path: 'filter.children[0]', label: null, message: 'жёлтое' }],
    });
    assert.equal(mod.hasBlockingIssues(warning), false);
    assert.equal(mod.hasBlockingIssues(mod.filterIssuesFromPayload({ diagnostics: [DELETED] })), true);
    assert.equal(mod.worstFilterIssueSeverity([]), null);
    assert.equal(mod.worstFilterIssueSeverity(warning), 'warning');
    assert.equal(mod.worstFilterIssueSeverity(mod.filterIssuesFromPayload({ diagnostics: [DELETED] })), 'error');

    const mixed = mod.mergeFilterIssues(warning, mod.filterIssuesFromPayload({ diagnostics: [DELETED] }));
    const byPath = mod.filterIssuesByPath([
      ...warning,
      ...mod.filterIssuesFromPayload({ diagnostics: [{ ...DELETED, path: 'filter.children[0]' }] }),
    ]);
    assert.equal(byPath.get('filter.children[0]')!.severity, 'error', 'при конфликте побеждает красное');
    assert.equal(byPath.size, 1);
    const unlocalized = mod.unlocalizedFilterIssues(
      mod.filterIssuesFromPayload({ messages: ['сборка не удалась'] }),
    );
    assert.equal(unlocalized.length, 1);
    assert.equal(mixed.length, 2);
  });

  it('причина строки: снапшот имени и дата добавляются, если ядро их не вписало', () => {
    const [deleted] = mod.filterIssuesFromPayload({ diagnostics: [DELETED] });
    assert.equal(
      mod.filterIssueReason(deleted!),
      'Свойство «Город» удалено из сети — отбор нельзя применить. · удалено 2026-10-01T00:00:00.000Z',
      'имя уже в тексте ядра — второй раз не дублируется, дата добавляется',
    );
    assert.equal(
      mod.filterIssueReason({
        severity: 'warning',
        source: 'server',
        code: 'property_detached',
        path: '',
        message: 'свойство отвязано',
        label: 'Дата',
        deletedAt: null,
      }),
      'свойство отвязано · «Дата»',
    );
  });

  it('запись адресует УЗЕЛ: поле листа — его строке, потомок — не предку', () => {
    const at = (path: string, severity: 'error' | 'warning' = 'error'): any => ({
      severity,
      source: 'server',
      code: 'entity_deleted',
      path,
      message: 'причина',
    });
    const warnings = mod.filterIssuesFromPayload({
      warnings: [{ severity: 'warning', code: 'property_detached', path: 'filter.children[0].entity', label: null, message: 'жёлтое' }],
    });
    // Поле листа (`…entity`) принадлежит самой строке, а не «никуда».
    assert.equal(mod.filterIssueForNode(warnings, 'filter.children[0]')!.severity, 'warning');
    // Корень не забирает диагностику потомков (иначе красная строка красила бы всё дерево).
    assert.equal(mod.filterIssueForNode([at('filter.children[0].entity')], 'filter'), null);
    // Путь УЗЛА-потомка не принадлежит предку-группе.
    assert.equal(mod.filterIssueForNode([at('filter.children[0].children[1].entity')], 'filter.children[0]'), null);
    // Подвыборка в значении — часть своей строки.
    assert.equal(mod.filterIssueForNode([at('filter.children[0].value.query.entity')], 'filter.children[0]')!.path, 'filter.children[0].value.query.entity');
    // При двух записях побеждает красная.
    assert.equal(
      mod.filterIssueForNode([at('filter.children[0].entity', 'warning'), at('filter.children[0].operator')], 'filter.children[0]')!.severity,
      'error',
    );
    assert.equal(mod.filterIssueForNode([at('', 'error')], 'filter'), null, 'запись без адреса строке не принадлежит');
  });

  it('ключ операнда различает прямое и обратное свойство-связь', () => {
    assert.equal(mod.filterEntityKey(CITY), 'property:p-city:out');
    assert.equal(mod.filterEntityKey({ kind: 'property', property: 'Покупки здесь', direction: 'in' } as any), 'property:Покупки здесь:in');
    assert.equal(mod.filterEntityKey({ kind: 'keywords' } as any), 'keywords');
  });

  it('firstLocalizedErrorIssue: цель перехода «исправить» — красное с адресом строки', () => {
    const issue = (severity: 'error' | 'warning', path: string): any => ({
      severity,
      source: 'server',
      code: severity === 'error' ? 'entity_deleted' : 'property_detached',
      path,
      message: 'причина',
    });
    assert.equal(mod.firstLocalizedErrorIssue([]), null, 'пусто — переходить некуда');
    assert.equal(
      mod.firstLocalizedErrorIssue([issue('warning', 'filter.children[0]')]),
      null,
      'жёлтое применение не запрещает — перехода нет',
    );
    assert.equal(
      mod.firstLocalizedErrorIssue([issue('error', '')]),
      null,
      'красное без адреса строки локализовать нельзя',
    );
    const target = mod.firstLocalizedErrorIssue([
      issue('warning', 'sort[0]'),
      issue('error', ''),
      issue('error', 'filter.children[1].entity'),
      issue('error', 'filter.children[2].entity'),
    ]);
    assert.equal(target?.path, 'filter.children[1].entity', 'берётся первая локализованная красная');
  });
});

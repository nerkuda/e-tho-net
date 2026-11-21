/**
 * Сторож единой компоненты списка задач (0.16.1, задача `7446eb25`, ревизия
 * компонентности `5450b7c3`).
 *
 * **Причина.** Рендер панели был общим (`lib/ui/task-panel.ts`), а экранные
 * контроллеры «Дневника» и карточки мысли дублировали слой «загрузка →
 * операции → устаревание → realtime → кэш субъектов» (~450–500 строк каждый) и
 * разошлись: в карточке мысли не было вложенных строк, «сегодня», «Отменить» и
 * переключателя выполненных. Единый контроллер — `lib/ui/task-list.ts`; экраны
 * обязаны оставаться тонкими обвязками.
 *
 * **Что проверяется.**
 *  1. Оба экрана импортируют ОДИН модуль (`mountTaskList`) и не содержат
 *     контроллерных признаков (сеть задач/комментариев, realtime, устаревание,
 *     персист настроек) — новая копипаста покраснеет сразу.
 *  2. Обвязки короткие (порог — 220 строк): рост кода в экране означает, что
 *     логика снова переехала в обвязку.
 *  3. Признаки замечаний пользователя 2026-11-18 живут в компоненте/рендере, а
 *     не в экранах: живые облачка с действиями (п.5), хит-зона слайдера (п.1),
 *     блочная правка (п.3), чек-лист-пункт (п.4).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it } from 'node:test';

const RENDERER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'renderer',
);

const DIARY = 'screens/chronicle/tasks-panel.ts';
const EDITOR = 'editor/tasks-panel.ts';
const COMPONENT = 'lib/ui/task-list.ts';
const RENDER = 'lib/ui/task-panel.ts';
const MODEL = 'lib/ui/task-panel-model.ts';

/** Исходник модуля рендерера (UTF-8). */
function source(rel: string): string {
  return readFileSync(path.join(RENDERER, rel), 'utf8');
}

/** Число строк модуля. */
function lineCount(rel: string): number {
  return source(rel).split('\n').length;
}

/**
 * Признаки слойного контроллера: сеть, realtime, устаревание, персист. В
 * обвязке экрана их быть не должно — иначе экран снова ведёт панель сам.
 */
const CONTROLLER_MARKERS: ReadonlyArray<{ marker: string; why: string }> = [
  { marker: 'etn.tasks.list(', why: 'загрузку строк ведёт компонента' },
  { marker: 'etn.tasks.patch(', why: 'операции строк ведёт компонента' },
  { marker: 'etn.comments.get(', why: 'правки источника ведёт компонента' },
  { marker: 'etn.comments.update(', why: 'запись источника ведёт компонента' },
  { marker: 'onRoutedRealtimeEvent', why: 'realtime-маркер ведёт компонента' },
  { marker: 'panelNeedsRefresh', why: 'устаревание считает модель внутри компоненты' },
  { marker: 'staleRows', why: 'точечные серые строки — состояние компоненты' },
  { marker: 'ownOpTokens', why: 'токены своих операций — состояние компоненты' },
  { marker: '.setState(', why: 'персист настроек панели — забота компоненты' },
  { marker: 'replaceTaskLine(', why: 'правка `body_md` — компонента, не экран' },
];

describe('сторож: единая компонента списка задач (7446eb25)', () => {
  it('оба экрана используют одну компоненту, а не свой контроллер', () => {
    for (const rel of [DIARY, EDITOR]) {
      const text = source(rel);
      assert.ok(
        /import\s*\{[^}]*\bmountTaskList\b[^}]*\}\s*from\s*'[^']*lib\/ui\/task-list\.js'/.test(
          text,
        ),
        `${rel}: панель обязан монтировать общий \`mountTaskList\` из lib/ui/task-list.ts`,
      );
      for (const { marker, why } of CONTROLLER_MARKERS) {
        assert.ok(
          !text.includes(marker),
          `${rel}: найден контроллерный признак «${marker}» — ${why} (ревизия ` +
            'компонентности 5450b7c3, задача 7446eb25). Логика живёт в lib/ui/task-list.ts.',
        );
      }
    }
  });

  it('обвязки экранов остаются тонкими (порог 220 строк)', () => {
    for (const rel of [DIARY, EDITOR]) {
      const count = lineCount(rel);
      assert.ok(
        count <= 220,
        `${rel}: ${count} строк — обвязка разрослась, значит панель снова ведёт экран. ` +
          'Переносите слой в lib/ui/task-list.ts (задача 7446eb25).',
      );
    }
  });

  it('единый контроллер держит загрузку, операции, realtime и правки источника', () => {
    const text = source(COMPONENT);
    for (const { marker } of CONTROLLER_MARKERS) {
      assert.ok(
        text.includes(marker.replace(/\($/, '(')),
        `${COMPONENT}: контроллер обязан содержать «${marker}» — иначе слой разъехался по экранам`,
      );
    }
  });

  it('живые облачка субъектов — эталон мысли с действиями, а не подпись (замечание 5)', () => {
    const text = source(COMPONENT);
    assert.ok(
      /createThoughtCloud\(/.test(text),
      `${COMPONENT}: облачко мысли собирает эталон \`createThoughtCloud\` (lib/thought-cloud)`,
    );
    assert.ok(
      /onClick:\s*\(/.test(text) && /onContextMenu:\s*\(/.test(text),
      `${COMPONENT}: облачку переданы действия — клик открывает мысль, правый клик — меню`,
    );
    const css = source('lib/ui/task-panel.css');
    assert.match(
      css,
      /\.ui-task-subgroup-subject\s*\{[^}]*cursor:\s*pointer/,
      'облачко-заголовок группы-мысли обязано показывать кликабельность (cursor: pointer)',
    );
  });

  it('правка строки и чек-лист-пункт реализованы в рендере, компоненте и модели (пункты 1, 3, 4)', () => {
    const render = source(RENDER);
    assert.ok(
      render.includes('options.createRowEditor'),
      'правка строки — поле КОМПОНЕНТЫ РЕДАКТИРОВАНИЯ КОММЕНТАРИЯ, фабрику даёт экран (пункт 1)',
    );
    assert.ok(
      render.includes("'ui-task-row-edit'") && render.includes('ui-task-row-block-edit'),
      'строка и блок правки помечены своими классами',
    );
    assert.ok(
      !render.includes('defineKeyContext'),
      'панель не объявляет своих хорд: Ctrl+Enter/Enter/Tab принадлежат полю',
    );
    const editor = source('editor/task-row-editor.ts');
    assert.ok(
      editor.includes('ctrlKey') && editor.includes('stopPropagation'),
      'Ctrl/Cmd+Enter погашается в capture-фазе до keymap CM6 (пункт 1)',
    );
    assert.ok(
      editor.includes('markdownFieldValue'),
      'сохраняется текст поля компоненты, а не снапшот строки',
    );
    assert.ok(
      render.includes("choiceControl('checkbox'") && render.includes('toggleChild'),
      'пункт чек-листа — настоящий чекбокс с командой экрану',
    );
    const model = source(MODEL);
    assert.ok(model.includes('replaceTaskLineRange'), 'модель умеет заменять диапазон строк блока');
    assert.ok(
      model.includes('setChecklistLineDone'),
      'модель умеет ставить/снимать отметку пункта',
    );
    assert.ok(
      model.includes('doneKeys'),
      'модель несёт отметки вхождений напоминаний до «Обновить» (пункт 7)',
    );
  });
});

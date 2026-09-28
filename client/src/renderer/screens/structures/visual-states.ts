/**
 * Точечный патч визуальных состояний облачков дерева «Структур» без пересборки
 * строк (задача 1a0a607d, уровень 0 тех.проекта `1d48df6d`).
 *
 * Полная пересборка (`structures.ts::renderTree`) остаётся путём для изменений
 * ДАННЫХ (результаты отбора, раскрытие, справочники типов). Изменения только
 * ВИЗУАЛЬНОГО слоя (выборка Ctrl+клик, текущая мысль/гало, цель редактора,
 * фокус холста) не должны пересоздавать DOM: пересборка сбрасывает прокрутку,
 * hover и клавиатурный курсор. {@link patchCloudVisualStates} проходит по уже
 * нарисованным `.st-cloud` и переставляет классы по `data-id`, не трогая узлы.
 *
 * Модуль намеренно изолирован от экрана: `structures.ts` тянет весь DOM-слой
 * (`app.js`, холст, редактор) и не поднимается в node-тестах, поэтому сама
 * механика патча вынесена сюда и покрыта юнит-тестом на DOM-шиме.
 */

/** CSS-класс одного дерева-облачка (совпадает с классом из `structures.ts`). */
export const CLOUD_SELECTOR = '.st-cloud';

/** Визуальные классы облачка: общая выборка и гало текущей мысли. */
export interface CloudVisualState {
  /** Мысль входит в общую выборку (Ctrl+клик) — класс `selected`. */
  selected: boolean;
  /** Мысль текущая (открыта в редакторе / фокус холста) — класс `halo`. */
  halo: boolean;
}

/**
 * Переставляет классы `.selected`/`.halo` на облачках под `root` по их
 * `data-id`. Узлы не пересоздаются и не перемещаются — только `classList`,
 * поэтому позиция прокрутки, hover и DOM-identity строк сохраняются.
 *
 * `stateOf` вычисляет желаемое состояние по id мысли; идёт от той же единственной
 * функции «кто текущий», что и первичная сборка (`structures.ts::cloudVisualState`),
 * чтобы начальная отрисовка и точечный патч не разошлись.
 *
 * Облачко без `data-id` пропускается (не должно случаться, но патч — не место
 * падать). `classList.toggle(name, force)` снимает класс, когда состояние ложно.
 */
export function patchCloudVisualStates(
  root: ParentNode,
  stateOf: (thoughtId: string) => CloudVisualState,
): void {
  for (const cloud of root.querySelectorAll<HTMLElement>(CLOUD_SELECTOR)) {
    const id = cloud.dataset['id'];
    if (id === undefined) continue;
    const state = stateOf(id);
    cloud.classList.toggle('selected', state.selected);
    cloud.classList.toggle('halo', state.halo);
  }
}

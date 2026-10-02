/**
 * Мастер создания публикации (0.11.1, задача a3cfc018; элемент интерфейса
 * ebfa93f3). Три шага: (1) название/подзаголовок/автор, (2) отбор заголовков
 * (общий конструктор отбора), (3) свойства текстов (мульти-выбор общим пикером
 * сущностей, можно пропустить). Кнопка «Создать» делает POST и передаёт id
 * созданной публикации вызывающему — тот открывает черновик в карточке.
 *
 * Диалог построен фасадом `lib/dialog.ts`; шаги — вкладки `lib/ui/tabs.ts`
 * (единый диалог со вкладками, требование 13464c39). Полей «на 20 штук» нет —
 * остальное донастраивается во вкладках карточки публикации.
 */

import type { PublicationCreateInput, SavedFilterDefinition, Shelf } from '@etn/shared';

import { showDialog } from '../../lib/dialog.js';
import { t } from '../../lib/i18n.js';
import { div, el } from '../../lib/dom.js';
import { etn } from '../../lib/etn.js';
import { footerErrorLine } from '../../lib/ui/messages.js';
import { fieldInput, fieldRow } from '../../lib/ui/field.js';
import { buildEntityChipField, filterEntityOptions, type EntityOption } from '../../lib/entity-picker.js';
import { loadingState, errorState } from '../../lib/ui/empty-state.js';
import { store } from '../../state.js';
import { wizardShelfChoice } from './model.js';
import { buildRecipeBuilder, loadPropertyRegistry, loadPropertyRows, propertyEntityOptions } from './recipe.js';

/** Опции мастера. */
export interface PublicationWizardOptions {
  /** Вызывается после успешного создания с id новой публикации. */
  onCreated: (id: string) => void;
  /** Живые полки для выбора полки назначения (задача 55ee3c85). */
  shelves?: readonly Shelf[];
  /** Полка, предвыбранная в мастере (например, из меню полки) или `null`. */
  initialShelfId?: string | null;
}

/** Открывает мастер создания публикации. */
export function openPublicationWizard(opts: PublicationWizardOptions): void {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const netId = networkId;
  const shelves = opts.shelves ?? [];
  /** Полка назначения: явно выбранная (если жива) либо `null` — «без полки». */
  let selectedShelfId = wizardShelfChoice(shelves, opts.initialShelfId ?? null);

  // --- Шаг 1: титульные данные -----------------------------------------------
  const titleInput = fieldInput({ id: 'pub-wizard-title' });
  const subtitleInput = fieldInput({ id: 'pub-wizard-subtitle' });
  const authorInput = fieldInput({ id: 'pub-wizard-author' });
  const metaBody = div('form-stack');
  metaBody.append(
    fieldRow({ label: t('publications.wizard.fTitle'), control: titleInput, id: 'pub-wizard-title' }),
    fieldRow({
      label: t('publications.wizard.fSubtitle'),
      control: subtitleInput,
      id: 'pub-wizard-subtitle',
    }),
    fieldRow({ label: t('publications.wizard.fAuthor'), control: authorInput, id: 'pub-wizard-author' }),
  );
  // Выбор полки назначения — только когда полки есть. Контрол — нативный
  // `select` с общим классом `select-input` (фасада-селекта в `lib/ui` нет;
  // та же практика, что в `editor/style-dialog.ts`, `editor/value-editor.ts`).
  if (shelves.length > 0) {
    const shelfSelect = el('select', 'select-input') as HTMLSelectElement;
    shelfSelect.id = 'pub-wizard-shelf';
    const none = el('option', undefined, t('publications.wizard.noShelf')) as HTMLOptionElement;
    none.value = '';
    shelfSelect.append(none);
    for (const shelf of shelves) {
      const option = el('option', undefined, shelf.title) as HTMLOptionElement;
      option.value = shelf.id;
      shelfSelect.append(option);
    }
    shelfSelect.value = selectedShelfId ?? '';
    shelfSelect.addEventListener('change', () => {
      selectedShelfId = shelfSelect.value === '' ? null : shelfSelect.value;
    });
    metaBody.append(
      fieldRow({
        label: t('publications.wizard.fShelf'),
        control: shelfSelect,
        id: 'pub-wizard-shelf',
      }),
    );
  }

  // --- Шаг 2: рецепт заголовков (registry грузится заранее) ------------------
  const recipeBody = div('pub-wizard-recipe');
  const recipeLoading = loadingState();
  const recipeHost = div('pub-recipe-host');
  recipeBody.append(recipeLoading, recipeHost);

  // --- Шаг 3: свойства текстов (мульти-выбор общим пикером сущностей) --------
  const textsBody = div('form-stack');
  const hint = el('p', 'dialog-text', t('publications.wizard.fTextsHint'));
  const textsHost = div('pub-wizard-texts');
  textsBody.append(hint, textsHost);

  const error = footerErrorLine();
  let titleRecipe: SavedFilterDefinition | null = null;
  let textSources: string[] = [];
  let recipeState: ReturnType<typeof buildRecipeBuilder> | null = null;

  void Promise.all([loadPropertyRows(netId), loadPropertyRegistry(netId)]).then(
    ([rows, registry]) => {
      const choices: EntityOption[] = propertyEntityOptions(rows);
      const field = buildEntityChipField({
        getValues: () => textSources,
        onChange: (values) => {
          textSources = values;
        },
        loadOptions: (query) => filterEntityOptions(choices, query),
        initialOptions: choices,
        optionsHeader: t('publication.field.texts'),
        placeholder: t('typeEditor.addProperty'),
        addPlaceholder: t('typeEditor.addProperty'),
        reorderable: true,
      });
      textsHost.append(field.root);

      const recipe = buildRecipeBuilder({ registry, initial: null });
      recipeLoading.remove();
      recipeHost.append(recipe.root);
      recipeState = recipe;
    },
    () => {
      recipeLoading.remove();
      recipeHost.append(errorState(t('publications.error')));
    },
  );

  const close = showDialog({
    title: t('publications.wizard.title'),
    size: 'l',
    tabs: [
      { id: 'meta', label: t('publications.wizard.meta'), content: metaBody },
      { id: 'recipe', label: t('publications.wizard.recipe'), content: recipeBody },
      { id: 'texts', label: t('publications.wizard.texts'), content: textsBody },
    ],
    footerError: error,
    buttons: [
      { label: t('actions.cancel') },
      {
        label: t('publications.wizard.create'),
        primary: true,
        keepOpen: true,
        onClick: (done) => {
          void create(done);
        },
      },
    ],
  });

  async function create(done: () => void): Promise<void> {
    error.textContent = '';
    const title = titleInput.value.trim();
    if (title === '') {
      error.textContent = t('publications.wizard.titleRequired');
      titleInput.focus();
      return;
    }
    if (recipeState !== null) titleRecipe = recipeState.getDefinition();
    const input: PublicationCreateInput = {
      title,
      subtitle: subtitleInput.value.trim() === '' ? null : subtitleInput.value.trim(),
      authorship: authorInput.value.trim() === '' ? null : authorInput.value.trim(),
      title_recipe: titleRecipe,
      text_sources: textSources,
    };
    try {
      const created = await etn.publications.create(netId, input);
      // Полка назначения (задача 55ee3c85): серверный create её не принимает,
      // поэтому публикацию сразу ставим на выбранную полку. Сбой постановки на
      // полку не отменяет создание — добавить можно из контекстного меню.
      if (selectedShelfId !== null) {
        try {
          await etn.publications.addShelfItem(netId, selectedShelfId, created.id);
        } catch {
          // Публикация создана; полку можно выбрать позже в меню публикации.
        }
      }
      done();
      close();
      opts.onCreated(created.id);
    } catch (err) {
      error.textContent = err instanceof Error ? err.message : t('publication.error');
    }
  }
}

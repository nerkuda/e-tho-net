/**
 * Общий компонент выбора вложения (задача 0f6c3e39) — ЕДИНСТВЕННАЯ реализация
 * вкладки «Вложения»: список картинок сети с поиском, загрузкой из файла,
 * отметкой текущего и фиксированным предпросмотром. Используется диалогом
 * обложки публикации и диалогом выбора иконки; второй похожий список заводить
 * нельзя (сторож `client/tests/guard-resource-picker.test.ts`).
 *
 * Устройство панели (layout-фикс ошибки 3250096a):
 *  • строка поиска закреплена СВЕРХУ (не прокручивается вместе со списком);
 *  • правая часть с предпросмотром выбранного ЗАФИКСИРОВАНА — не растягивается
 *    по всей длине списка и не уезжает при прокрутке (сплит занимает остаток
 *    высоты панели, список прокручивается ВНУТРИ себя);
 *  • при нескольких тысячах вложений список подгружается страницами
 *    (пагинация по `limit`/`offset` эндпоинта `GET /attachments`, серверный
 *    предел страницы — 200) кнопкой «Показать ещё».
 *
 * Компонент отдаёт вызывающему {@link AttachmentPick}: выбранную запись
 * вложения, загруженный локальный файл (куда его сохранить, решает вызывающий)
 * либо восстановленное текущее `data:`-превью. Вёрстка — фасады `lib/ui`
 * (поле, кнопка, сплиттер, список); строки — из словаря `t()`.
 *
 * Переименование прямо в строке списка (требование fabc1231): заголовок
 * вложения ОБЩИЙ для всех владельцев, правится `PATCH /attachments/{id} {title}`
 * (кнопка-карандаш в строке, Enter/потеря фокуса — запись, Esc — отмена).
 */

import type { Attachment } from '@etn/shared';
import { div, errText, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { t } from '../lib/i18n.js';
import { defineKeyContext, pushKeyContext } from '../lib/keymap.js';
import { modifierChordVariants } from '../lib/keymap-chords.js';
import { notice } from '../lib/notice.js';
import { iconButton, uiButton } from '../lib/ui/button.js';
import { fieldInput } from '../lib/ui/field.js';
import { svgIcon } from '../lib/ui/icon.js';
import { reconcileKeyed } from '../lib/ui/keyed-list.js';
import { createListNav } from '../lib/ui/list.js';
import { uiSplitter } from '../lib/ui/splitter.js';
import { store } from '../state.js';
import { etnimgUrl } from './markdown-field.js';
import type {
  ResourceFileSource,
  ResourceSourceContext,
  ResourceSourceTab,
} from './resource-picker.js';

/** Предел страницы поиска вложений на сервере (`GET /attachments`). */
const PAGE_SIZE = 200;

/** Задержка живого поиска (мс): не бьём LIKE-поиском по сети на каждое нажатие. */
const SEARCH_DEBOUNCE_MS = 200;

/** Строка списка — носитель, схлопнутый по физическому файлу/ссылке. */
export interface AttachmentPickerRow {
  /** Ключ носителя (`kind` + путь/URL). */
  key: string;
  /** Заголовок строки. */
  title: string;
  /** Строки-владельцы носителя (по одной на владельца). */
  attachments: Attachment[];
  /** Представитель носителя (превью/выбор/применение). */
  representative: Attachment;
}

/** Что компонент отдаёт вызывающему при выборе/применении. */
export interface AttachmentPick {
  /** Выбранная запись вложения из списка (нет — загруженный файл/текущее). */
  attachment?: Attachment;
  /** Строка-носитель выбранного вложения (владельцы; у обложки — выбор «своего»). */
  row?: AttachmentPickerRow;
  /** Новый локальный файл из системного диалога (вызывающий решает, куда его). */
  source?: ResourceFileSource;
  /** `data:`- или `etnimg:`-превью выбранного (для превью/иконки). */
  preview: string;
  /** id уже сохранённого вложения (из списка/текущее) — сохранить как есть. */
  attachmentId?: string | null;
}

/** Утилиты строки, отдаваемые декоратору {@link AttachmentPickerOptions.renderRowExtra}. */
export interface AttachmentPickerRowApi {
  /** Перечитать список (после снятия владельца и т.п.). */
  refresh: () => void;
}

/** Параметры {@link attachmentPickerSourceTab}. */
export interface AttachmentPickerOptions {
  /** Метка вкладки каркаса выбора ресурса. */
  label: string;
  /**
   * Текущий выбор при открытии: сохранённое вложение (`attachmentId`) либо
   * самодостаточное `data:`-превью (картинка типа мысли) — отмечается, если
   * найдено в списке, иначе показывается в предпросмотре как текущее.
   */
  current?: { attachmentId?: string | null; preview: string } | null;
  /** Авто-выбор первой строки при открытии (диалог обложки). */
  autoSelectFirst?: boolean;
  /**
   * Дополнительное содержимое строки (облачка владельцев у диалога обложки).
   * Компонент рисует заголовок, декоратор — остальное.
   */
  renderRowExtra?: (
    row: AttachmentPickerRow,
    api: AttachmentPickerRowApi,
  ) => HTMLElement | null;
  /** Выбор/применение: вызывающий решает, что делать с выбранным. */
  onPick: (pick: AttachmentPick, ctx: ResourceSourceContext) => void | Promise<void>;
}

/** Ссылка на предпросмотр носителя: файл — через `etnimg`, иначе URL. */
function attachmentPreviewSrc(a: Attachment): string {
  if (a.kind === 'file' && a.file_path !== null) return etnimgUrl(a.file_path);
  return a.url ?? '';
}

/** Только картинки (серверный поиск возвращает вложения всех видов). */
function isImageAttachment(a: Attachment): boolean {
  if (a.kind === 'url') {
    return /\.(png|jpe?g|gif|webp|svg|bmp|avif)(\?.*)?$/i.test(a.url ?? '') || a.icon !== null;
  }
  return (
    (a.mime_type ?? '').startsWith('image/') ||
    /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(a.file_path ?? '')
  );
}

/** Ключ носителя (схлопывание строк-владельцев одного файла/ссылки). */
function carrierKey(a: Attachment): string {
  return `${a.kind}\u0000${a.file_path ?? a.url ?? a.id}`;
}

/** Заголовок строки-носителя: заголовок первого владельца или путь/URL. */
function rowTitle(attachments: readonly Attachment[]): string {
  const first = attachments[0];
  if (first === undefined) return '';
  return first.title ?? first.file_path ?? first.url ?? first.id;
}

/** Текущий выбор компонента. */
type Selection =
  | { kind: 'row'; row: AttachmentPickerRow }
  | { kind: 'file'; preview: string; source: ResourceFileSource }
  | { kind: 'current'; preview: string; attachmentId: string | null };

/**
 * Источник «Вложения» — общий список картинок сети с поиском, загрузкой и
 * фиксированным предпросмотром. Возвращается как `ResourceSourceTab` каркасу
 * `createResourcePicker`.
 */
export function attachmentPickerSourceTab(opts: AttachmentPickerOptions): ResourceSourceTab {
  const holder: { run: ResourceSourceTab['apply'] } = { run: undefined };
  return {
    id: 'attachments',
    label: opts.label,
    build: (ctx) => {
      const root = div('att-pick-pane');
      const top = div('att-pick-top');
      const search = fieldInput({ extraClass: 'att-pick-search' });
      search.placeholder = t('attachments.picker.search');
      const uploadButton = uiButton({
        label: t('attachments.picker.upload'),
        role: 'secondary',
        size: 's',
        onClick: () => void uploadFromFile(),
      });
      top.append(search, uploadButton);

      const split = div('att-pick-split');
      const listBox = div('att-pick-list-box');
      const listHost = div('att-pick-list');
      // Корень навигации принимает программный фокус: без него стрелки и
      // Home/End ядра навигации не доходят.
      listHost.tabIndex = 0;
      const emptyHint = span(t('attachments.picker.empty'), 'muted att-pick-empty hidden');
      const moreRow = div('att-pick-more hidden');
      moreRow.append(
        uiButton({
          label: t('attachments.picker.more'),
          role: 'secondary',
          size: 's',
          onClick: () => void loadMore(),
        }),
      );
      listBox.append(listHost, emptyHint, moreRow);

      const previewHost = div('att-pick-preview');
      previewHost.style.width = '260px';
      previewHost.style.flexBasis = '260px';
      // Сплиттер ширины предпросмотра — общий фасад `lib/ui/splitter.ts`.
      const splitter = uiSplitter({
        extraClass: 'att-pick-splitter',
        title: t('splitter.resizeHint'),
        ariaLabel: t('splitter.resizeAriaHorizontal'),
        plan: () => ({
          axis: 'x' as const,
          sign: -1 as const,
          start: previewHost.getBoundingClientRect().width || 260,
          min: 120,
          max: 640,
        }),
        apply: (value) => {
          previewHost.style.width = `${value}px`;
          previewHost.style.flexBasis = `${value}px`;
        },
      });
      split.append(listBox, splitter, previewHost);
      root.append(top, split);

      /** Все загруженные записи (дедуп по id) — база группировки по носителю. */
      const loaded = new Map<string, Attachment>();
      let rows: AttachmentPickerRow[] = [];
      const rowEls = new Map<string, HTMLElement>();
      let hasMore = false;

      let selection: Selection | null = null;
      /** id текущего вложения — ищем его строку, чтобы отметить в списке. */
      const currentId = opts.current?.attachmentId ?? null;
      const currentPreview = opts.current?.preview ?? null;
      /** Авто-выбор первой строки выполняется один раз, при первой загрузке. */
      let autoSelectDone = false;

      const api: AttachmentPickerRowApi = { refresh: () => void runSearch(0) };

      /** Счётчик правок — ключ активного клавиатурного контекста строки. */
      let renameSeq = 0;
      /** Снятие клавиатурного контекста текущей правки (закрыть прошлую). */
      let releaseRename: (() => void) | null = null;

      /**
       * Встроенное переименование вложения прямо в строке списка
       * (требование fabc1231): заголовок общий для ВСЕХ владельцев, поэтому
       * это `PATCH /attachments/{id} {title}`, а не операция владения. Enter/
       * потеря фокуса — запись, Esc — отмена. Клавиатура — через общеклиентский
       * диспетчер (ADR b420b08c); локальный `keydown`-слушатель запрещён.
       */
      function startRename(row: AttachmentPickerRow, titleEl: HTMLElement): void {
        const networkId = store.state.networkId;
        if (networkId === null) return;
        const attachment = row.representative;
        releaseRename?.();
        releaseRename = null;
        const input = fieldInput({ maxLength: 300 });
        input.value = row.title;
        titleEl.replaceWith(input);
        let done = false;
        const release = (): void => {
          releaseRename?.();
          releaseRename = null;
        };
        const restore = (): void => {
          if (done) return;
          done = true;
          release();
          input.replaceWith(titleEl);
        };
        const commit = async (): Promise<void> => {
          if (done) return;
          done = true;
          release();
          const next = input.value.trim();
          input.replaceWith(titleEl);
          if (next === '' || next === (attachment.title ?? '')) return;
          try {
            await etn.attachments.update(networkId, attachment.id, { title: next });
            api.refresh();
          } catch (err) {
            notice(`${t('attachments.rename.failed')}: ${errText(err)}`, 'error');
          }
        };
        const contextId = `att-pick-rename-${(renameSeq += 1)}`;
        defineKeyContext({
          id: contextId,
          bindings: [
            ...modifierChordVariants('Enter').map((chord) => ({
              command: 'att.pick.rename.commit',
              chord,
              run: (event: KeyboardEvent) => {
                if (event.key !== 'Enter') return false;
                void commit();
                return true;
              },
            })),
            {
              command: 'att.pick.rename.cancel',
              chord: 'Escape',
              run: (event: KeyboardEvent) => {
                if (event.key !== 'Escape') return false;
                restore();
                return true;
              },
            },
          ],
        });
        releaseRename = pushKeyContext(contextId);
        input.addEventListener('blur', () => void commit());
        input.focus();
        input.select();
      }

      /** Превью выбранного/текущего; `null` — подсказка. */
      const renderPreview = (): void => {
        while (previewHost.firstChild !== null) previewHost.removeChild(previewHost.firstChild);
        previewHost.classList.remove('att-pick-preview-current');
        if (selection === null) {
          previewHost.append(span(t('attachments.picker.preview'), 'muted'));
          return;
        }
        let src: string;
        let current = false;
        if (selection.kind === 'row') {
          src = attachmentPreviewSrc(selection.row.representative);
        } else if (selection.kind === 'file') {
          src = selection.preview;
        } else {
          src = selection.preview;
          current = true;
        }
        if (src === '') {
          previewHost.append(span(t('attachments.picker.preview'), 'muted'));
          return;
        }
        const img = document.createElement('img');
        img.className = 'att-pick-preview-img';
        img.alt = '';
        if (current) previewHost.classList.add('att-pick-preview-current');
        img.addEventListener('error', () => {
          while (previewHost.firstChild !== null) previewHost.removeChild(previewHost.firstChild);
          previewHost.append(span(t('attachments.picker.preview'), 'muted'));
        });
        img.src = src;
        previewHost.append(img);
      };

      const nav = createListNav<AttachmentPickerRow>(listHost, {
        entries: () => rows,
        tokenOf: (row) => row.key,
        elementOf: (row) => rowEls.get(row.key) ?? null,
        applyHighlight: (row) => {
          for (const [key, node] of rowEls) {
            node.classList.toggle('att-pick-item-current', row !== null && key === row.key);
          }
        },
        // Единый источник выбора: стрелки/Home/End, клик, dblclick и сброс
        // после перерисовки идут через `setCurrent`.
        onSelectionChange: (row) => {
          // Сброс подсветки строки не отменяет выбор файла/текущего превью.
          if (row === null && selection !== null && selection.kind !== 'row') return;
          selection = row === null ? null : { kind: 'row', row };
          renderPreview();
          ctx.setReady(row !== null);
        },
        onActivate: (row) => {
          nav.setCurrent(row);
          void applySelection(ctx);
        },
        // Ctrl+Enter в списке — «выбрать и применить, закрыв диалог».
        onKey: (key, event) => {
          if (key !== 'Enter' || event.ctrlKey !== true) return false;
          event.preventDefault?.();
          void applySelection(ctx);
          return true;
        },
        onClick: (target) => {
          const row = closestRow(target);
          const key = row?.getAttribute('data-key') ?? '';
          const found = rows.find((r) => r.key === key);
          if (found !== undefined) nav.setCurrent(found);
        },
      });

      /** Ближайшая строка-вложение от узла клика. */
      function closestRow(target: HTMLElement): HTMLElement | null {
        let cursor: HTMLElement | null = target;
        while (cursor !== null && cursor !== listHost) {
          if (cursor.parentElement === listHost) return cursor;
          cursor = cursor.parentElement;
        }
        return null;
      }

      /** Устанавливает выбор вне строки списка (файл/текущее) или сбрасывает. */
      const setSelection = (next: Selection | null): void => {
        selection = next;
        if (next !== null && next.kind !== 'row') nav.setCurrent(null);
        renderPreview();
        ctx.setReady(next !== null);
      };

      /** Заполняет один узел списка (заголовок с правкой + декор строки). */
      const fillRow = (node: HTMLElement, row: AttachmentPickerRow): void => {
        // Точечная пересборка ОДНОЙ строки (не коллекции): состав её частей
        // (заголовок + облачка владельцев) меняется вслед за данными.
        while (node.firstChild !== null) node.removeChild(node.firstChild);
        const head = div('att-pick-item-head');
        const title = span(row.title, 'att-pick-item-title');
        head.append(title);
        // Переименование самогó вложения (общий заголовок, fabc1231) — кнопкой
        // строки; клик по ней не выбирает строку (гасим всплытие к списку).
        head.append(
          iconButton({
            icon: svgIcon('pencil', 14),
            title: t('attachments.row.rename'),
            role: 'ghost',
            size: 's',
            onClick: (event) => {
              event.stopPropagation();
              startRename(row, title);
            },
          }),
        );
        node.append(head);
        const extra = opts.renderRowExtra?.(row, api);
        if (extra !== null && extra !== undefined) node.append(extra);
      };

      const renderRows = (): void => {
        reconcileKeyed(listHost, rows, {
          key: (row) => row.key,
          build: (row) => {
            const node = div('att-pick-item');
            fillRow(node, row);
            // Двойной клик — выбрать и применить, закрыв диалог.
            node.addEventListener('dblclick', () => {
              nav.setCurrent(row);
              void applySelection(ctx);
            });
            return node;
          },
          update: (node, row) => fillRow(node, row),
        });
        rowEls.clear();
        for (const child of Array.from(listHost.children)) {
          const key = (child as HTMLElement).getAttribute('data-key');
          if (key !== null && key !== '') rowEls.set(key, child as HTMLElement);
        }
        emptyHint.classList.toggle('hidden', rows.length > 0);
        moreRow.classList.toggle('hidden', !hasMore);
        nav.refresh();
      };

      /** Группирует накопленные записи по носителю. */
      const regroup = (): void => {
        const groups = new Map<string, Attachment[]>();
        for (const a of loaded.values()) {
          if (!isImageAttachment(a)) continue;
          const key = carrierKey(a);
          const list = groups.get(key);
          if (list === undefined) groups.set(key, [a]);
          else list.push(a);
        }
        rows = [];
        for (const [key, list] of groups) {
          rows.push({ key, title: rowTitle(list), attachments: list, representative: list[0]! });
        }
      };

      /** Загружает страницу поиска; `offset` — с какой записи начать. */
      async function runSearch(offset: number): Promise<void> {
        const networkId = store.state.networkId;
        if (networkId === null) return;
        // Ключ текущей строки переживает перечитывание списка: переименование
        // вложения дергает `refresh` → пересборку строк, и без этого выбор
        // сбрасывался (ошибка ac449f1c). Снимаем ДО очистки списка, пока
        // `selection` ещё несёт прежнюю строку.
        const restoreKey = selection !== null && selection.kind === 'row' ? selection.row.key : null;
        const query = search.value.trim() === '' ? '*' : search.value.trim();
        if (offset === 0) {
          loaded.clear();
          rows = [];
          renderRows();
        }
        let page: Attachment[];
        try {
          page = await etn.attachments.search(networkId, { q: query, limit: PAGE_SIZE, offset });
        } catch {
          page = [];
        }
        for (const a of page) loaded.set(a.id, a);
        hasMore = page.length === PAGE_SIZE;
        regroup();
        renderRows();
        // Восстановление выбора: строка с прежним ключом (носителя) снова стала
        // текущей — подсветка/фокус остаются на переименованной записи.
        if (restoreKey !== null) {
          const restored = rows.find((row) => row.key === restoreKey);
          if (restored !== undefined) nav.setCurrent(restored);
        }
        // Отметка текущего: появилась строка с нужным id — выделяем её (смена
        // выбора на строку списка); не нашлась — остаётся текущее превью,
        // выставленное при открытии.
        if (currentId !== null && (selection === null || selection.kind === 'current')) {
          const hit = rows.find((row) => row.representative.id === currentId);
          if (hit !== undefined) nav.setCurrent(hit);
        }
        // Авто-выбор первой строки (диалог обложки) — один раз, при первой
        // загрузке и только без текущего выбора.
        if (!autoSelectDone) {
          autoSelectDone = true;
          if (opts.autoSelectFirst === true && selection === null && currentId === null) {
            const first = rows[0];
            if (first !== undefined) {
              nav.setCurrent(first);
              nav.focusNavigation();
            }
          }
        }
      }

      /** Догружает следующую страницу. */
      async function loadMore(): Promise<void> {
        await runSearch(loaded.size);
      }

      /** «Загрузить из файла»: системный выбор картинки → локальное превью. */
      async function uploadFromFile(): Promise<void> {
        const picked = await etn.system.pickImage();
        if (picked.status === 'cancel') return;
        if (picked.status === 'error') return;
        setSelection({
          kind: 'file',
          preview: picked.dataUrl,
          source: { dataUrl: picked.dataUrl, mime: picked.mime, name: picked.name },
        });
      }

      /** Применение текущего выбора нижней «Применить»/двойным кликом/Ctrl+Enter. */
      async function applySelection(c: ResourceSourceContext): Promise<void> {
        if (selection === null) return;
        if (selection.kind === 'row') {
          const a = selection.row.representative;
          await opts.onPick(
            { attachment: a, row: selection.row, preview: attachmentPreviewSrc(a), attachmentId: a.id },
            c,
          );
          return;
        }
        if (selection.kind === 'file') {
          await opts.onPick(
            { preview: selection.preview, source: selection.source, attachmentId: null },
            c,
          );
          return;
        }
        await opts.onPick({ preview: selection.preview, attachmentId: selection.attachmentId }, c);
      }

      holder.run = (c) => applySelection(c);

      // Текущий выбор (сохранённое вложение или data:-превью типа) отмечается
      // СРАЗУ при открытии: «Применить» активна, картинка видна, пока список
      // грузится; найдётся строка — выбор перейдёт на неё.
      if (currentPreview !== null || currentId !== null) {
        setSelection({
          kind: 'current',
          preview: currentPreview ?? '',
          attachmentId: currentId,
        });
      }
      // Живой поиск с задержкой: поиск вложений — LIKE по всей сети, и запрос
      // на каждое нажатие нещадящ при тысячах записей. Первая загрузка списка
      // (ниже) идёт сразу; пагинация debounce не касается.
      let searchTimer: ReturnType<typeof setTimeout> | null = null;
      search.addEventListener('input', () => {
        if (searchTimer !== null) clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          searchTimer = null;
          void runSearch(0);
        }, SEARCH_DEBOUNCE_MS);
      });
      void runSearch(0);
      return root;
    },
    apply: (ctx) => holder.run?.(ctx),
  };
}

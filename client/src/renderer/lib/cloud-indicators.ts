/**
 * Счётчики-индикаторы облачков (📝/📅/📎) — единый владелец подписок на
 * запросы слоя `indicators:@id` для холста и дерева «Структур»
 * (08-ui-spec.md §15.4: облачка дерева повторяют холст 1-в-1, индикаторы
 * включительно).
 *
 * Правило — «подписка = видимость»: экран объявляет НАБОР мыслей, чьи облачка
 * сейчас в DOM ({@link setCloudIndicatorInterest}), модуль подписывает новые и
 * снимает ушедшие. До ошибки 46bda0e8 подписки копились за сессию: облачко,
 * ушедшее из видимой зоны виртуализированного холста (скролл, смена фокуса,
 * смена отбора) или из свёрнутого дерева, оставалось подписанным навсегда, и
 * каждая волна `indicatorsAll` (ресинк после смены слоя,
 * `comment.updated`/`attachment.updated`) перечитывала пару
 * comments.list+attachments.list на КАЖДУЮ когда-либо показанную мысль — за
 * день диагностики 2505+2437 запросов при 1:1.
 *
 * Параллелизм ограничен ({@link INDICATOR_MAX_CONCURRENT_FETCHES}): каждый
 * счётчик — два HTTP-чтения, а серверный пул тяжёлых чтений держит 1–3
 * воркера; неограниченная волна ставит их в очередь и выстраивает «лестницу»
 * длительностей (та же ошибка).
 *
 * Кэш и коалесинг — на реестре живого слоя (`query-registry.ts`): подписка
 * «зажигает» запрос, отписка последнего наблюдателя его усыпляет, инвалидация
 * ключа перечитывает только записи с наблюдателями.
 */

import { etn } from './etn.js';
import { getQueryState, queryKeys, subscribeQuery } from './live/index.js';
import { store } from '../state.js';
import { t } from './i18n.js';

/** Владелец видимого набора индикаторов: холст или дерево «Структур». */
export type CloudIndicatorOwner = 'canvas' | 'structures';

/** Comment/attachment counts shown in the cloud indicators row. */
export interface IndicatorInfo {
  permanent: boolean;
  chrono: number;
  attachments: number;
}

/**
 * Максимум одновременных пар чтений счётчиков (комментарии + вложения).
 * Согласован с серверным пулом reader-воркеров (1–3): больше — очередь на
 * сервере и та же «лестница», меньше — медленный первый показ расклада.
 */
export const INDICATOR_MAX_CONCURRENT_FETCHES = 4;

/** Видимые наборы по владельцам; объединение задаёт живые подписки. */
const interest = new Map<CloudIndicatorOwner, Set<string>>();
/** id → отписка от запроса слоя `indicators:@id`. */
const subscriptions = new Map<string, () => void>();
/** Сеть, в контексте которой созданы подписки (смена сети → полный сброс). */
let indicatorNetworkId: string | null = null;

/** Очередь ожидания слота параллелизма. */
const waitingFetches: Array<() => void> = [];
let activeFetches = 0;
/** Пик одновременных пар — тестовый шов сторожа лимита. */
let maxActiveFetches = 0;

/** Выполнить задачу в пределах лимита одновременных чтений счётчиков. */
function limitIndicatorFetch<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const launch = (): void => {
      activeFetches += 1;
      if (activeFetches > maxActiveFetches) maxActiveFetches = activeFetches;
      void task()
        .then(resolve, reject)
        .finally(() => {
          activeFetches -= 1;
          waitingFetches.shift()?.();
        });
    };
    if (activeFetches < INDICATOR_MAX_CONCURRENT_FETCHES) launch();
    else waitingFetches.push(launch);
  });
}

/** Fetches comment/attachment counts for one thought (fetcher слоя). */
async function fetchIndicatorCounts(id: string): Promise<IndicatorInfo> {
  const networkId = store.state.networkId;
  if (networkId === null) throw new Error('network is not open');
  const [comments, attachments] = await Promise.all([
    etn.comments.list(networkId, 'thought', id),
    etn.attachments.list(networkId, 'thought', id),
  ]);
  return {
    permanent: comments.some((c) => c.kind === 'permanent'),
    chrono: comments.filter((c) => c.kind === 'chronological').length,
    attachments: attachments.length,
  };
}

/**
 * Patches indicator cells of every rendered cloud with this id, on the canvas
 * AND the structures tree (both render the same `.cloud`/`.cloud-ind` markup,
 * 08-ui-spec.md §15.4) — queried document-wide, not scoped to a screen host.
 */
function applyIndicators(id: string, info: IndicatorInfo): void {
  for (const cloud of document.querySelectorAll<HTMLElement>(`.cloud[data-id="${id}"]`)) {
    const cells = cloud.querySelectorAll<HTMLElement>('.cloud-ind .ind');
    const perm = cells[0];
    const chrono = cells[1];
    const att = cells[2];
    if (perm === undefined || chrono === undefined || att === undefined) continue;
    if (info.permanent) {
      perm.textContent = '📝';
      perm.classList.remove('dim');
      perm.classList.add('active');
      perm.title = t('cloud.hasPostoyannyyKommentariy');
    } else {
      // Explicitly dim: this may re-patch a previously active cell (the
      // permanent comment was deleted while the cloud stayed rendered).
      perm.classList.add('dim');
      perm.classList.remove('active');
      perm.title = t('cloud.postoyannogoKommentariyaNo');
    }
    chrono.textContent = `📅${info.chrono}`;
    chrono.classList.toggle('dim', info.chrono === 0);
    chrono.classList.toggle('active', info.chrono > 0);
    chrono.title = t('cloud.hronologicheskihKommentariev', info.chrono);
    att.textContent = `📎${info.attachments}`;
    att.classList.toggle('dim', info.attachments === 0);
    att.classList.toggle('active', info.attachments > 0);
    att.title = t('cloud.attachments', info.attachments);
  }
}

/** Подписать одну мысль на её запрос счётчиков. */
function subscribeIndicator(id: string): void {
  const unsubscribe = subscribeQuery<IndicatorInfo>(
    queryKeys.indicators(id),
    () => limitIndicatorFetch(() => fetchIndicatorCounts(id)),
    (state) => {
      if (state.data !== undefined) applyIndicators(id, state.data);
    },
  );
  subscriptions.set(id, unsubscribe);
}

/**
 * Привести подписки к объединению видимых наборов: снять ушедшие, подписать
 * новые, а уже подписанным — переприменить кэш к пересобранному DOM (облачко
 * могло быть пересоздано виртуализацией; без этого свежий узел остался бы с
 * пустыми ячейками).
 */
function reconcileSubscriptions(): void {
  const union = new Set<string>();
  for (const visible of interest.values()) for (const id of visible) union.add(id);
  for (const [id, unsubscribe] of [...subscriptions]) {
    if (union.has(id)) continue;
    unsubscribe();
    subscriptions.delete(id);
  }
  for (const id of union) {
    if (!subscriptions.has(id)) {
      subscribeIndicator(id);
      continue;
    }
    const state = getQueryState<IndicatorInfo>(queryKeys.indicators(id));
    if (state.data !== undefined) applyIndicators(id, state.data);
  }
}

/** Снять все подписки и видимые наборы (смена сети/тесты). */
function resetAll(): void {
  for (const unsubscribe of subscriptions.values()) unsubscribe();
  subscriptions.clear();
  interest.clear();
  indicatorNetworkId = null;
  // Очередь не чистится: её задачи принадлежат фетчерам записей слоя, и
  // брошенное обещание навсегда заблокировало бы перечитывание этих ключей.
}

/**
 * Объявить видимый набор индикаторов владельца. Вызов идемпотентен: повтор
 * того же набора не идёт в сеть, меняются только ушедшие/новые мысли.
 */
export function setCloudIndicatorInterest(
  owner: CloudIndicatorOwner,
  ids: Iterable<string>,
): void {
  const networkId = store.state.networkId;
  if (networkId === null) {
    interest.delete(owner);
    reconcileSubscriptions();
    return;
  }
  // Смена сети обнуляет реестр запросов — старые подписки «повисают» на
  // записях прежнего контекста. Пересоздаём их в контексте новой сети.
  if (indicatorNetworkId !== networkId) resetAll();
  indicatorNetworkId = networkId;
  interest.set(owner, new Set(ids));
  reconcileSubscriptions();
}

/** Снять видимый набор владельца (экран размонтирован/скрыт). */
export function releaseCloudIndicatorInterest(owner: CloudIndicatorOwner): void {
  interest.delete(owner);
  reconcileSubscriptions();
}

/** Полный сброс подписок (смена сети/размонтирование всех экранов/тесты). */
export function resetCloudIndicatorSubscriptions(): void {
  resetAll();
}

/** Test seam for unit tests. */
export const cloudIndicatorInternals = {
  /** Число живых подписок (по одной на видимую мысль объединения). */
  subscriberCount: (): number => subscriptions.size,
  /** id живых подписок (сортированы). */
  subscribedIds: (): string[] => [...subscriptions.keys()].sort(),
  /** Пик одновременных пар чтений с прошлого сброса метрики. */
  maxConcurrentFetches: (): number => maxActiveFetches,
  /** Сбросить пик одновременных чтений (тесты лимита). */
  resetConcurrencyMetric: (): void => {
    maxActiveFetches = activeFetches;
  },
};

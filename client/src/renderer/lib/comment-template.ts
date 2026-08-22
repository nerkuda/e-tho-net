/**
 * Шаблон постоянного комментария для типов мыслей
 * (08-ui-spec.md §8.1, 02-data-model.md §3.3).
 *
 * Назначение: при создании мысли с типом или при назначении/смене типа
 * у существующей мысли клиент проверяет, что у выбранного типа есть
 * непустой `comment_template_md` И у мысли ещё нет постоянного
 * комментария. Если оба условия выполнены — клиент создаёт постоянный
 * комментарий с текстом шаблона. Это побочный эффект основной операции:
 * ошибки автозаполнения НЕ прерывают создание/обновление мысли и не
 * блокируют UI; они тихо проглатываются (комментарий можно добавить
 * позже вручную).
 */

import { store } from '../state.js';
import { etn } from './etn.js';

/**
 * Применяет шаблон комментария типа к пустому постоянному комментарию
 * мысли, если условия выполнены (см. шапку модуля). Никогда не бросает.
 *
 * @param networkId id сети
 * @param thoughtId id мысли
 * @param typeId назначаемый тип мысли; `null` — снятие типа, шаблон не применяется
 */
export async function applyCommentTemplateIfEmpty(
  networkId: string,
  thoughtId: string,
  typeId: string | null,
): Promise<void> {
  if (typeId === null) return;
  const type = store.state.thoughtTypes.find((t) => t.id === typeId);
  if (type === undefined) return;
  const template = (type.comment_template_md ?? '').trim();
  if (template === '') return;

  try {
    const comments = await etn.comments.list(networkId, 'thought', thoughtId);
    if (comments.some((c) => c.kind === 'permanent')) return;
    await etn.comments.create(networkId, 'thought', thoughtId, {
      kind: 'permanent',
      body_md: template,
    });
  } catch {
    // Побочный эффект: ошибки не должны блокировать основной поток
    // (создание/обновление мысли). Шаблон можно применить вручную.
  }
}

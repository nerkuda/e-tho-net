/**
 * Защита ролей сети для типов (ошибка d4802371, версия 0.16.1).
 *
 * `type_roles` сети живут в системной БД и домену типов недоступны, поэтому
 * проверку делает транспорт — REST `DELETE /thought-types/{id}` и MCP
 * `etn.ontology.delete` — и передаёт сюда словарь `role → type_id`.
 *
 * До этой ошибки каждый транспорт проверял только ЗАПРОШЕННЫЙ тип. С
 * каскадным удалением поддерева (`force`) проверять нужно каждый тип
 * поддерева: роль на дочернем типе так же не должна теряться. Чтобы правило
 * не расходилось между REST и MCP, оно живёт здесь одним хелпером.
 */

import { EtnError } from '@etn/shared';

/** Словарь ролей сети (`PATCH /networks/{id}` → `type_roles`). */
export type NetworkTypeRoles = Readonly<Record<string, string | null>>;

/** Роль, в которой сеть использует тип, или `undefined`, если роль свободна. */
export function findTypeRole(
  networkRoles: NetworkTypeRoles | undefined,
  typeId: string,
): string | undefined {
  if (networkRoles === undefined) return undefined;
  for (const [role, value] of Object.entries(networkRoles)) {
    if (value === typeId) return role;
  }
  return undefined;
}

/**
 * Отвергнуть удаление, если ЛЮБОЙ из типов занят в роли сети (даже с
 * `force`). `extraDetails` добавляет к `details` транспортные поля (REST
 * кладёт `network_id`); `requestId` — для журнала ошибок.
 *
 * Сообщение и форма `details` (`entity`, `id`, `role`) совпадают с прежней
 * проверкой одного типа, поэтому клиенты и тесты видят тот же контракт.
 */
export function assertTypesFreeOfRoles(
  networkRoles: NetworkTypeRoles | undefined,
  entity: 'thought_type' | 'link_type',
  typeIds: readonly string[],
  extraDetails: Record<string, unknown> = {},
  requestId?: string,
): void {
  for (const typeId of typeIds) {
    const role = findTypeRole(networkRoles, typeId);
    if (role === undefined) continue;
    throw new EtnError(
      'VALIDATION_ERROR',
      `The type is used by the network in the "${role}" role; remove the role via PATCH /networks/{id} first.`,
      { entity, id: typeId, ...extraDetails, role },
      requestId,
    );
  }
}

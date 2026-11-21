/**
 * Единственная точка системного выбора изображения в рендерере (0.16.1, задача
 * 80324150; правило сторожа `guard-resource-picker.test.ts` — «второй вызов
 * `pickImage` = вторая реализация выбора картинки»).
 *
 * Диалог выбора файла открывает главный процесс (`system.pickImage`), читает
 * файл и отдаёт `data:`-URL. Потребители:
 *   * `editor/attachment-picker.ts` — вложение/иконка/обложка из файла;
 *   * `screens/settings.ts` — фоновая картинка карты (свой потолок исходника:
 *     фото даунскейлится клиентом перед отправкой).
 *
 * Имя функции намеренно не содержит `pickImage`: сторож ищет второй ВЫЗОВ
 * канала, а дублировать имя канала в рендерере незачем.
 */

import type { PickImageResult } from '../../main/ipc/contract.js';
import { etn } from './etn.js';

/**
 * Выбрать изображение через системный диалог. `maxBytes` — потолок размера
 * ИСХОДНОГО файла (по умолчанию — лимит вложения в главном процессе).
 */
export async function chooseImageFile(options?: { maxBytes?: number }): Promise<PickImageResult> {
  return etn.system.pickImage(options);
}

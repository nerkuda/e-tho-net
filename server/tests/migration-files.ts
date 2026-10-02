/**
 * Общий хелпер тестов миграций: ожидание вычисляется из каталога, а не
 * переписывается вручную (задача 8816c01f, версия 0.11.1).
 *
 * До этого перечни сетевых миграций были захардкожены в нескольких тестах
 * (`network-migrations`, `layers-s2`, `migrations-type-properties-unique`,
 * `guard-comments-time`): при выпуске новой миграции кандидаты забывались,
 * тесты краснели на расхождении ожидания с каталогом — или, хуже, молча
 * теряли покрытие. `runMigrations` (server/src/db/migrator.ts) применяет
 * каталог целиком в алфавитном порядке, поэтому корректное ожидание
 * выводится прямо из файловой системы.
 *
 * Здесь остаётся только то, что из каталога вывести нельзя, — смысловые
 * «якоря» конкретной версии (например, состояние «до миграции 025»): их
 * тесты передают строками-именами файлов явно, по месту.
 */

import { readdirSync } from 'node:fs';

import { networkMigrationsDir } from '../src/paths.js';

/**
 * Все `*.sql` каталога сетевых миграций в порядке применения (алфавитном —
 * ровно так их читает {@link runMigrations}); дубли префиксов нумерации не
 * исключаются и разрешаются алфавитом (`016_saved_filters.sql` <
 * `016_thought_icon_attachment.sql`).
 */
export function networkMigrationFiles(): string[] {
  return readdirSync(networkMigrationsDir())
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/**
 * Файлы каталога, которые `runMigrations` применит после состояния, доведённого
 * ровно до `through` включительно, — то есть строго большие по алфавиту
 * (порядок применения). Подходит для ожиданий вида «первый прогон из состояния
 * „после NN“»: `networkMigrationFilesAfter('031_layer_colors.sql')`.
 */
export function networkMigrationFilesAfter(through: string): string[] {
  return networkMigrationFiles().filter((f) => f > through);
}

/**
 * Файлы каталога, начиная с `from` включительно, — ожидание первого прогона из
 * состояния «строго до `from`».
 */
export function networkMigrationFilesFrom(from: string): string[] {
  return networkMigrationFiles().filter((f) => f >= from);
}

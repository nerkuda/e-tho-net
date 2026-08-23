/**
 * @etn/shared — public entry point.
 *
 * Common types, enumerations, constants, the error contract and the structures
 * keywords parser shared between @etn/server and @etn/client. Runtime logic is
 * limited to value constants, {@link EtnError} and the pure string helpers of
 * `keywords.ts`/`mentions.ts`.
 *
 * Sources of truth: docs/02-data-model.md, docs/03-server-api.md,
 * docs/04-realtime.md, docs/05-mcp-server.md, docs/06-auth.md,
 * docs/11-settings-and-state.md.
 */

export * from './enums.js';
export * from './constants.js';
export * from './errors.js';
export * from './keywords.js';
export * from './mentions.js';
export * from './deep-link.js';
export * from './types/index.js';

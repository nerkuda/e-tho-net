/**
 * @etn/shared — public entry point.
 *
 * Common types, enumerations, constants and error contract shared between
 * @etn/server and @etn/client. Contains no runtime logic beyond the value
 * constants and the {@link EtnError} class.
 *
 * Sources of truth: docs/02-data-model.md, docs/03-server-api.md,
 * docs/04-realtime.md, docs/05-mcp-server.md, docs/06-auth.md,
 * docs/11-settings-and-state.md.
 */

export * from './enums.js';
export * from './constants.js';
export * from './errors.js';
export * from './types/index.js';

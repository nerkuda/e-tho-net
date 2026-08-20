/**
 * IPC error unwrapping (preload).
 *
 * Electron prefixes every promise rejected by `ipcMain.handle` with
 * `Error invoking remote method 'etn:invoke': ` and, when the thrown error
 * has a `name` (our `EtnError`), renders the message as `<Name>: <message>`.
 * Without unwrapping the UI would show
 * `Error invoking remote method 'etn:invoke': EtnError: …` — technical noise
 * around an already user-facing message.
 *
 * Exported separately so it can be unit-tested without pulling in `electron`.
 */

/** How Electron renders a rejected `ipcRenderer.invoke` promise. */
const INVOKE_PREFIX = `Error invoking remote method 'etn:invoke': `;

/** Known error names Electron interpolates between the prefix and the message. */
const ERROR_NAME_PREFIXES = [
  'EtnError: ',
  'Error: ',
  'TypeError: ',
  'RangeError: ',
  'SyntaxError: ',
  'ReferenceError: ',
];

/**
 * Strip Electron's IPC wrapper from a rejected invoke promise, leaving the
 * original message. Unknown shapes (not wrapped) are returned unchanged.
 */
export function cleanIpcError(err: unknown): Error {
  const base = err instanceof Error ? err : new Error(String(err));
  let message = base.message;
  if (message.startsWith(INVOKE_PREFIX)) {
    message = message.slice(INVOKE_PREFIX.length);
    for (const name of ERROR_NAME_PREFIXES) {
      if (message.startsWith(name)) {
        message = message.slice(name.length);
        break;
      }
    }
  }
  const clean = new Error(message);
  // Keep the original stack for the console — only the message is cosmetic.
  clean.stack = base.stack;
  return clean;
}

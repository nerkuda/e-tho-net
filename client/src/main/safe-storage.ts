/**
 * OS-level encryption helper for the ETN API-key (docs/06-auth.md §7,
 * docs/07-client-electron.md §3.1).
 *
 * Uses Electron `safeStorage`, which delegates to the platform keychain:
 * DPAPI on Windows, Keychain on macOS, libsecret on Linux. The plaintext key
 * is therefore never written to disk in the clear — only the opaque ciphertext
 * `Buffer` produced by {@link encryptApiKey} is persisted (into the
 * `server_profiles.api_key_encrypted` BLOB column, task G3).
 *
 * Decryption stays inside the main process: the renderer never sees the key and
 * reaches the network only through IPC (task G7).
 */
import { safeStorage } from 'electron';

/**
 * Thrown when the platform cannot provide secure storage, e.g. a headless
 * Linux box without libsecret or a keyring daemon. The UI must surface this as
 * a hard blocker for saving a server profile.
 */
export class SafeStorageUnavailableError extends Error {
  public constructor(message = 'Безопасное хранилище (safeStorage) недоступно.') {
    super(message);
    this.name = 'SafeStorageUnavailableError';
  }
}

/**
 * Verifies that the platform keychain is usable. Throws a descriptive
 * {@link SafeStorageUnavailableError} otherwise so callers can distinguish this
 * condition from generic I/O failures.
 */
function assertAvailable(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new SafeStorageUnavailableError();
  }
}

/**
 * Encrypts an API-key string for at-rest storage.
 *
 * @param plain The plaintext API-key (`etn_<32hex>`). Must be non-empty.
 * @returns Opaque ciphertext `Buffer` to persist in
 *   `server_profiles.api_key_encrypted`.
 * @throws {SafeStorageUnavailableError} when `safeStorage` cannot encrypt.
 */
export function encryptApiKey(plain: string): Buffer {
  assertAvailable();
  return safeStorage.encryptString(plain);
}

/**
 * Decrypts a previously stored API-key ciphertext back to its plaintext form.
 *
 * Intended to run in the main process immediately before use (e.g. building a
 * `Bearer` header in G5); the result must not be forwarded to the renderer.
 *
 * @param enc The ciphertext `Buffer` read from `server_profiles.api_key_encrypted`.
 * @returns The plaintext API-key.
 * @throws {SafeStorageUnavailableError} when `safeStorage` cannot decrypt.
 */
export function decryptApiKey(enc: Buffer): string {
  assertAvailable();
  return safeStorage.decryptString(enc);
}

/**
 * Non-throwing variant of {@link assertAvailable} for UI status checks.
 *
 * @returns `true` if API-keys can be encrypted/decrypted on this machine.
 */
export function isApiKeyStorageAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

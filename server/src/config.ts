/**
 * Server configuration: reads and validates the `ETN_*` environment variables.
 *
 * Required: `ETN_DATA_DIR` (absolute path to the data root). Optional: `ETN_HOST`,
 * `ETN_PORT`, `ETN_TLS_CERT`/`ETN_TLS_KEY` (both-or-neither), `ETN_LOG_LEVEL`,
 * `ETN_MCP_ENABLED`, `ETN_MCP_PORT`.
 *
 * A bad configuration raises {@link ConfigError} with a human-readable message;
 * the CLI/server entry point surfaces it to the operator at startup.
 *
 * See docs/01-architecture.md §4 and task B1.
 */

import path from 'node:path';

/** TLS material pair (both fields required when TLS is enabled). */
export interface TlsConfig {
  /** Path to the PEM certificate file. */
  cert: string;
  /** Path to the PEM private key file. */
  key: string;
}

/** MCP (Model Context Protocol) endpoint configuration (docs/05-mcp-server.md §2). */
export interface McpConfig {
  /**
   * Whether the StreamableHTTP MCP endpoint (`/mcp`) is mounted on the HTTP
   * server (`ETN_MCP_ENABLED=1`). When disabled, MCP agents still work through
   * the stdio CLI command `etn mcp`.
   */
  enabled: boolean;
  /**
   * Dedicated TCP port for the MCP HTTP endpoint (`ETN_MCP_PORT`). When set,
   * a second plain-HTTP listener is started on this port serving only `/mcp`
   * (isolating agent traffic from the REST API); when `null` the endpoint is
   * served on the main `ETN_PORT` listener.
   */
  port: number | null;
}

/** Fully-validated server configuration. */
export interface ServerConfig {
  /** Absolute path to the data directory (`ETN_DATA_DIR`). */
  dataDir: string;
  /** Bind address (`ETN_HOST`). */
  host: string;
  /** TCP port (`ETN_PORT`). */
  port: number;
  /** TLS configuration, or `null` for plain HTTP. */
  tls: TlsConfig | null;
  /** pino log level (`ETN_LOG_LEVEL`). */
  logLevel: string;
  /** MCP endpoint configuration (`ETN_MCP_ENABLED`, `ETN_MCP_PORT`). */
  mcp: McpConfig;
}

/**
 * Error raised when the environment does not yield a valid configuration.
 * Carries an operator-friendly message with no internal details leaked.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Default bind address when `ETN_HOST` is unset (loopback, safe default). */
const DEFAULT_HOST = '127.0.0.1';
/** Default TCP port when `ETN_PORT` is unset. */
const DEFAULT_PORT = 3000;
/** Lowest valid TCP port. */
const PORT_MIN = 1;
/** Highest valid TCP port. */
const PORT_MAX = 65535;
/** Default pino log level when `ETN_LOG_LEVEL` is unset. */
const DEFAULT_LOG_LEVEL = 'info';

/** pino log levels accepted by `ETN_LOG_LEVEL`. */
const VALID_LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;
type LogLevel = (typeof VALID_LOG_LEVELS)[number];

/** Type guard: is `value` one of the accepted pino levels? */
function isLogLevel(value: string): value is LogLevel {
  return (VALID_LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * Read and validate configuration from `env` (defaults to `process.env`).
 *
 * @throws {ConfigError} when a required variable is missing or a value is invalid.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  // --- ETN_DATA_DIR (required) ---
  const dataDirRaw = env.ETN_DATA_DIR;
  if (dataDirRaw === undefined || dataDirRaw.trim() === '') {
    throw new ConfigError(
      'Environment variable ETN_DATA_DIR is required (absolute path to the server data directory).',
    );
  }
  const dataDir = path.resolve(dataDirRaw.trim());

  // --- ETN_HOST (optional) ---
  const host = env.ETN_HOST?.trim() || DEFAULT_HOST;

  // --- ETN_PORT (optional) ---
  const portRaw = env.ETN_PORT?.trim() ?? String(DEFAULT_PORT);
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX) {
    throw new ConfigError(
      `ETN_PORT must be an integer in [${PORT_MIN}, ${PORT_MAX}], got: ${JSON.stringify(portRaw)}`,
    );
  }

  // --- ETN_LOG_LEVEL (optional) ---
  const logLevel = (env.ETN_LOG_LEVEL?.trim() || DEFAULT_LOG_LEVEL).toLowerCase();
  if (!isLogLevel(logLevel)) {
    throw new ConfigError(
      `ETN_LOG_LEVEL must be one of ${VALID_LOG_LEVELS.join(', ')}, got: ${JSON.stringify(logLevel)}`,
    );
  }

  // --- ETN_TLS_CERT / ETN_TLS_KEY (both-or-neither) ---
  const tlsCert = env.ETN_TLS_CERT?.trim() || null;
  const tlsKey = env.ETN_TLS_KEY?.trim() || null;
  let tls: TlsConfig | null = null;
  if (tlsCert !== null || tlsKey !== null) {
    if (tlsCert === null || tlsKey === null) {
      throw new ConfigError(
        'ETN_TLS_CERT and ETN_TLS_KEY must be set together — provide both for HTTPS/WSS, or neither for plain HTTP.',
      );
    }
    tls = { cert: tlsCert, key: tlsKey };
  }

  // --- ETN_MCP_ENABLED / ETN_MCP_PORT (docs/05-mcp-server.md §2) ---
  const mcpEnabledRaw = env.ETN_MCP_ENABLED?.trim().toLowerCase() ?? '';
  const mcpEnabled = ['1', 'true', 'yes', 'on'].includes(mcpEnabledRaw);
  let mcpPort: number | null = null;
  const mcpPortRaw = env.ETN_MCP_PORT?.trim();
  if (mcpPortRaw !== undefined && mcpPortRaw !== '') {
    const parsed = Number.parseInt(mcpPortRaw, 10);
    if (!Number.isInteger(parsed) || parsed < PORT_MIN || parsed > PORT_MAX) {
      throw new ConfigError(
        `ETN_MCP_PORT must be an integer in [${PORT_MIN}, ${PORT_MAX}], got: ${JSON.stringify(mcpPortRaw)}`,
      );
    }
    mcpPort = parsed;
  }

  return { dataDir, host, port, tls, logLevel, mcp: { enabled: mcpEnabled, port: mcpPort } };
}

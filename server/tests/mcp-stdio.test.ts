/**
 * MCP stdio end-to-end test (F1): spawns the real CLI (`etn mcp`) as a child
 * process, performs the initialize handshake over stdin/stdout and verifies
 * the process stays alive for the session (regression for the "CLI exited
 * right after connect" bug). Also checks that an invalid key aborts with
 * exit code 1.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { nativeAvailable } from './mcp-helpers.js';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI_FILE = path.join(SERVER_DIR, '..', 'src', 'cli.ts');

/** Run `etn init` in a temp data dir and return the printed primary API-key. */
function initServer(dataDir: string): string {
  const run = spawnSync(
    process.execPath,
    ['--import', 'tsx', CLI_FILE, 'init', '--username', 'stdio-admin'],
    { env: { ...process.env, ETN_DATA_DIR: dataDir }, encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
  const match = /^\s{2}(etn_[0-9a-f]{32})\s*$/m.exec(run.stdout);
  assert.ok(match !== null, `no API key in init output: ${run.stdout}`);
  return match[1] as string;
}

/** Feed one JSON-RPC line and collect the first initialize response. */
function handshake(dataDir: string, key: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI_FILE, 'mcp'], {
      env: { ...process.env, ETN_DATA_DIR: dataDir, ETN_API_KEY: key },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let response: string | null = null;
    const exited = new Promise<void>((res) => child.on('exit', () => res()));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out waiting for initialize response; got: ${out}`));
    }, 10_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
      if (response === null && out.includes('"serverInfo"')) {
        response = out;
        clearTimeout(timer);
        child.kill();
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', () => {
      // Resolve only after the child released its SQLite handles, so the
      // caller can remove the data dir on Windows.
      if (response !== null) {
        void exited.then(() => resolve(response as string));
      }
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'stdio-test', version: '0.0.1' },
        },
      }) + '\n',
    );
  });
}

describe('MCP stdio transport (F1)', { skip: !nativeAvailable() }, () => {
  it('answers initialize over stdin and keeps the session alive', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-stdio-'));
    try {
      const key = initServer(dataDir);
      const response = await handshake(dataDir, key);
      assert.match(response, /"serverInfo":\{"name":"etn-mcp-server"/);
      assert.match(response, /"tools"/);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('exits with code 1 on an invalid API key', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-stdio-'));
    try {
      initServer(dataDir);
      const run = spawnSync(process.execPath, ['--import', 'tsx', CLI_FILE, 'mcp'], {
        env: {
          ...process.env,
          ETN_DATA_DIR: dataDir,
          ETN_API_KEY: 'etn_deadbeef000000000000000000000000',
        },
        encoding: 'utf8',
      });
      assert.equal(run.status, 1);
      assert.match(run.stderr, /API-key/);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

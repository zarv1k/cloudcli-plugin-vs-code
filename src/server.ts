/**
 * Backend for the CloudCLI "VS Code" plugin.
 *
 * The heavy lifting is done by code-server itself, which the browser reaches
 * directly over a same-origin path (see README). This process only answers
 * control-plane questions the frontend cannot answer on its own:
 *
 *   - is code-server actually up? (checked over loopback, which the browser
 *     cannot reach — that is what separates "service is down" from
 *     "reverse proxy route is missing")
 *   - which base path / upstream is configured?
 *
 * Deliberately dependency-free: the CloudCLI host installs plugins with
 * `npm install --ignore-scripts`, so native modules would not build.
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

import type { VsCodeConfig, VsCodeStatus } from './types.js';

const PLUGIN_NAME = process.env.PLUGIN_NAME || 'vs-code';

const HOME = process.env.HOME || os.homedir();

const DEFAULTS: VsCodeConfig = {
  basePath: '/vscode/',
  upstream: 'http://127.0.0.1:8080',
  serviceName: 'code-server@' + (os.userInfo().username || 'root'),
  serviceControl: false,
  syncTheme: true,
  // code-server's default --user-data-dir.
  settingsPath: path.join(HOME, '.local', 'share', 'code-server', 'User', 'settings.json'),
  darkTheme: 'Default Dark Modern',
  lightTheme: 'Default Light Modern',
};

const CONFIG_PATH = path.join(HOME, '.config', 'cloudcli-plugin-vs-code', 'config.json');

/** systemd unit names, kept strict so a bad config cannot smuggle in argv. */
const SERVICE_NAME_RE = /^[A-Za-z0-9@._-]+$/;

/** Theme names end up inside a JSON string literal; keep them boring. */
const THEME_NAME_RE = /^[A-Za-z0-9 ()+._'-]+$/;

function log(message: string): void {
  // stdout is reserved for the host's ready-line protocol; logs go to stderr,
  // where the host prefixes them with [Plugin:<name>].
  console.error(`[${PLUGIN_NAME}] ${message}`);
}

// ── Config ────────────────────────────────────────────────────────────────────

/**
 * Read config afresh on every request. The file is tiny, and re-reading means
 * the user does not have to restart CloudCLI after editing it.
 */
function loadConfig(): VsCodeConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log(`ignoring unreadable config at ${CONFIG_PATH}: ${(err as Error).message}`);
    }
    return { ...DEFAULTS };
  }

  const file = (raw && typeof raw === 'object' ? raw : {}) as Partial<VsCodeConfig>;
  const str = (value: unknown, fallback: string): string =>
    typeof value === 'string' && value.trim() ? value : fallback;

  const cfg: VsCodeConfig = {
    basePath: str(file.basePath, DEFAULTS.basePath),
    upstream: str(file.upstream, DEFAULTS.upstream),
    serviceName: str(file.serviceName, DEFAULTS.serviceName),
    serviceControl: file.serviceControl === true,
    syncTheme: file.syncTheme !== false,
    settingsPath: str(file.settingsPath, DEFAULTS.settingsPath),
    darkTheme: str(file.darkTheme, DEFAULTS.darkTheme),
    lightTheme: str(file.lightTheme, DEFAULTS.lightTheme),
  };

  // A base path must be absolute and end with "/" so the frontend can append
  // "?folder=..." and relative asset URLs resolve the way code-server expects.
  if (!cfg.basePath.startsWith('/')) cfg.basePath = '/' + cfg.basePath;
  if (!cfg.basePath.endsWith('/')) cfg.basePath += '/';

  cfg.upstream = cfg.upstream.replace(/\/+$/, '');

  if (!SERVICE_NAME_RE.test(cfg.serviceName)) {
    log(`ignoring unsafe serviceName ${JSON.stringify(cfg.serviceName)}`);
    cfg.serviceName = DEFAULTS.serviceName;
  }
  for (const key of ['darkTheme', 'lightTheme'] as const) {
    if (!THEME_NAME_RE.test(cfg[key])) {
      log(`ignoring unsafe ${key} ${JSON.stringify(cfg[key])}`);
      cfg[key] = DEFAULTS[key];
    }
  }

  return cfg;
}

// ── Theme sync ────────────────────────────────────────────────────────────────

const COLOR_THEME_RE = /("workbench\.colorTheme"\s*:\s*)"(?:[^"\\]|\\.)*"/;

/**
 * Point code-server's `workbench.colorTheme` at `name`.
 *
 * The edit is surgical rather than parse-modify-stringify: settings.json is
 * JSONC, so round-tripping it through JSON.parse would either throw on the
 * user's comments or silently strip them. Replacing just the value leaves the
 * rest of the file — comments, ordering, formatting — exactly as it was.
 *
 * VS Code watches this file, so the running workbench re-themes without a
 * reload.
 */
function writeColorTheme(settingsPath: string, name: string): { changed: boolean } {
  const literal = JSON.stringify(name);

  let text: string;
  try {
    text = fs.readFileSync(settingsPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    atomicWrite(settingsPath, `{\n  "workbench.colorTheme": ${literal}\n}\n`);
    return { changed: true };
  }

  let next: string;
  if (COLOR_THEME_RE.test(text)) {
    next = text.replace(COLOR_THEME_RE, `$1${literal}`);
  } else {
    const open = text.indexOf('{');
    if (open < 0) {
      next = `{\n  "workbench.colorTheme": ${literal}\n}\n`;
    } else {
      const rest = text.slice(open + 1);
      const empty = /^\s*\}/.test(rest);
      // No comma when the object is otherwise empty, or we would emit a
      // trailing comma into a file the user may later parse strictly.
      const separator = empty ? '\n' : ',';
      // An empty object carries no useful whitespace; keeping it would put the
      // closing brace on the same line as the entry we just added.
      const tail = empty ? rest.trimStart() : rest;
      next = `${text.slice(0, open + 1)}\n  "workbench.colorTheme": ${literal}${separator}${tail}`;
    }
  }

  if (next === text) return { changed: false };
  atomicWrite(settingsPath, next);
  return { changed: true };
}

/** Rename-into-place, so VS Code's watcher never observes a half-written file. */
function atomicWrite(target: string, contents: string): void {
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, contents, { encoding: 'utf8', mode: 0o644 });
  fs.renameSync(tmp, target);
}

// ── code-server health ────────────────────────────────────────────────────────

interface HealthResult {
  running: boolean;
  status: number | null;
  error: string | null;
}

function checkCodeServer(upstream: string, timeoutMs = 2500): Promise<HealthResult> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL('/healthz', upstream + '/');
    } catch {
      resolve({ running: false, status: null, error: `invalid upstream: ${upstream}` });
      return;
    }

    const req = http.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: 'GET',
        timeout: timeoutMs,
      },
      (res) => {
        // Drain so the socket can be reused/closed cleanly.
        res.resume();
        const status = res.statusCode ?? 0;
        resolve({
          running: status >= 200 && status < 400,
          status,
          error: status >= 400 ? `code-server answered HTTP ${status}` : null,
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error(`no answer within ${timeoutMs}ms`));
    });
    req.on('error', (err) => {
      resolve({ running: false, status: null, error: (err as Error).message });
    });
    req.end();
  });
}

/** `code-server --version` is slow-ish, so the result is cached for the process. */
let versionCache: string | null | undefined;

function codeServerVersion(): Promise<string | null> {
  if (versionCache !== undefined) return Promise.resolve(versionCache);
  return new Promise((resolve) => {
    execFile('code-server', ['--version'], { timeout: 5000 }, (err, stdout) => {
      versionCache = err ? null : (stdout.split('\n')[0] || '').trim() || null;
      resolve(versionCache);
    });
  });
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readJsonBody(req: http.IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err as Error);
      }
    });
    req.on('error', reject);
  });
}

function restartService(serviceName: string): Promise<{ ok: boolean; error: string | null }> {
  return new Promise((resolve) => {
    execFile(
      'sudo',
      ['-n', 'systemctl', 'restart', serviceName],
      { timeout: 20000 },
      (err, _stdout, stderr) => {
        if (err) {
          resolve({ ok: false, error: (stderr || '').trim() || (err as Error).message });
        } else {
          resolve({ ok: true, error: null });
        }
      },
    );
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const route = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'GET' && (route === '/' || route === '/health')) {
    sendJson(res, 200, { ok: true, name: PLUGIN_NAME });
    return;
  }

  if (req.method === 'GET' && route === '/config') {
    sendJson(res, 200, { ok: true, config: loadConfig(), configPath: CONFIG_PATH });
    return;
  }

  if (req.method === 'GET' && route === '/status') {
    const config = loadConfig();
    void Promise.all([checkCodeServer(config.upstream), codeServerVersion()]).then(
      ([health, version]) => {
        const payload: VsCodeStatus & { version: string | null } = {
          ok: health.running,
          config,
          codeServer: health,
          configPath: CONFIG_PATH,
          version,
        };
        // Always 200: the host proxy collapses non-2xx into an opaque
        // "RPC error <status>", which would hide the diagnostics below.
        sendJson(res, 200, payload);
      },
    );
    return;
  }

  if (req.method === 'POST' && route === '/theme') {
    const config = loadConfig();
    void readJsonBody(req)
      .then((body) => {
        const theme = (body as { theme?: unknown })?.theme;
        if (theme !== 'dark' && theme !== 'light') {
          sendJson(res, 200, { ok: false, error: 'theme must be "dark" or "light"' });
          return;
        }
        if (!config.syncTheme) {
          sendJson(res, 200, { ok: false, skipped: true, error: 'syncTheme is disabled' });
          return;
        }
        const name = theme === 'light' ? config.lightTheme : config.darkTheme;
        const { changed } = writeColorTheme(config.settingsPath, name);
        if (changed) log(`colorTheme -> ${name}`);
        sendJson(res, 200, { ok: true, theme, name, changed });
      })
      .catch((err: Error) => {
        log(`theme sync failed: ${err.message}`);
        sendJson(res, 200, { ok: false, error: err.message });
      });
    return;
  }

  if (req.method === 'POST' && route === '/service/restart') {
    const config = loadConfig();
    if (!config.serviceControl) {
      sendJson(res, 200, {
        ok: false,
        error: `serviceControl is disabled; enable it in ${CONFIG_PATH} to allow this`,
      });
      return;
    }
    void restartService(config.serviceName).then((result) => {
      log(
        result.ok
          ? `restarted ${config.serviceName}`
          : `failed to restart ${config.serviceName}: ${result.error}`,
      );
      sendJson(res, 200, result);
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: `no route for ${req.method} ${route}` });
});

server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  if (addr && typeof addr !== 'string') {
    // The host waits up to 10s for exactly this line on stdout.
    process.stdout.write(JSON.stringify({ ready: true, port: addr.port }) + '\n');
    log(`listening on 127.0.0.1:${addr.port}`);
  }
});

function shutdown(): void {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

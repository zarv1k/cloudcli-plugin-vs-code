/**
 * Frontend for the CloudCLI "VS Code" plugin.
 *
 * Two constraints shape this file:
 *
 * 1. The host fetches this module as text, wraps it in a Blob and imports the
 *    blob URL. Relative and bare imports would resolve against `blob:` and
 *    fail, so everything lives here and the only import is type-only.
 *
 * 2. The host conditionally renders the plugin tab, so mount()/unmount() run on
 *    every tab switch. A naively nested <iframe> would therefore reload VS Code
 *    each time. Instead the UI lives in a single fixed-position element parked
 *    on document.body, kept aligned with the host container's bounding box and
 *    merely hidden on unmount. Moving an iframe in the DOM reloads it;
 *    hiding one does not.
 */

import type { PluginAPI, PluginContext, VsCodeConfig } from './types.js';

const STYLE_ID = 'ccvscode-css';
const LS_BASE_PATH = 'ccvscode-base-path';

const DEFAULT_BASE_PATH = '/vscode/';

type Stage = 'loading' | 'ready' | 'no-project' | 'server-down' | 'route-missing' | 'rpc-failed';

interface VsCodeState {
  host: HTMLDivElement;
  pathLabel: HTMLSpanElement;
  stage: HTMLDivElement;
  panel: HTMLDivElement;
  iframe: HTMLIFrameElement | null;
  maxButton: HTMLButtonElement;
  /** Folder currently loaded in the iframe, not the one merely selected. */
  folder: string | null;
  basePath: string;
  config: VsCodeConfig | null;
  version: string | null;
  maximized: boolean;
  theme: 'dark' | 'light';
  /** Last theme the backend confirmed, so idle mounts do not re-send it. */
  syncedTheme: 'dark' | 'light' | null;
  /**
   * Bound from the per-mount api object. Parked on the state because panel
   * buttons can trigger refresh() long after mount() returned.
   */
  rpc: PluginAPI['rpc'] | null;
}

declare global {
  interface Window {
    __ccVsCode?: VsCodeState;
  }
}

// ── Small DOM helpers ─────────────────────────────────────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string | null,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function icon(paths: string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '15');
  svg.setAttribute('height', '15');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

const IC = {
  reload: [
    'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8',
    'M21 3v5h-5',
    'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16',
    'M8 16H3v5',
  ],
  newTab: ['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
  maximize: ['M8 3H5a2 2 0 0 0-2 2v3', 'M21 8V5a2 2 0 0 0-2-2h-3', 'M3 16v3a2 2 0 0 0 2 2h3', 'M16 21h3a2 2 0 0 0 2-2v-3'],
  restore: ['M8 3v3a2 2 0 0 1-2 2H3', 'M21 8h-3a2 2 0 0 1-2-2V3', 'M3 16h3a2 2 0 0 1 2 2v3', 'M16 21v-3a2 2 0 0 1 2-2h3'],
  fullscreen: ['M15 3h6v6', 'M9 21H3v-6', 'M21 3l-7 7', 'M3 21l7-7'],
};

function button(title: string, paths: string[], onClick: () => void): HTMLButtonElement {
  const b = el('button', 'ccvscode-btn');
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.appendChild(icon(paths));
  b.addEventListener('click', onClick);
  return b;
}

// ── Styles ────────────────────────────────────────────────────────────────────

/**
 * Everything is prefixed with `ccvscode-`: the plugin shares `document` with
 * the host's Tailwind stylesheet, and these rules are never torn down.
 */
function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = el('style');
  style.id = STYLE_ID;
  style.textContent = `
.ccvscode-host {
  position: fixed;
  display: flex;
  flex-direction: column;
  z-index: 30;
  overflow: hidden;
  background: #1f1f1f;
  color: #cccccc;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --ccvscode-border: rgba(255, 255, 255, 0.09);
  --ccvscode-btn: rgba(255, 255, 255, 0.06);
  --ccvscode-btn-hover: rgba(255, 255, 255, 0.14);
  --ccvscode-muted: rgba(255, 255, 255, 0.55);
}
.ccvscode-host.ccvscode-light {
  background: #f8f8f8;
  color: #3b3b3b;
  --ccvscode-border: rgba(0, 0, 0, 0.11);
  --ccvscode-btn: rgba(0, 0, 0, 0.05);
  --ccvscode-btn-hover: rgba(0, 0, 0, 0.12);
  --ccvscode-muted: rgba(0, 0, 0, 0.55);
}
/* Maximized: cover the whole viewport but stay under the host's own modals,
   which sit at z-index 9999. */
.ccvscode-host.ccvscode-maximized {
  top: 0 !important;
  left: 0 !important;
  width: 100vw !important;
  height: 100dvh !important;
  z-index: 9998;
}
/* Native fullscreen must win over the inline geometry set by the sync loop. */
.ccvscode-host:fullscreen {
  top: 0 !important;
  left: 0 !important;
  width: 100vw !important;
  height: 100vh !important;
}
.ccvscode-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  padding: 5px 8px;
  border-bottom: 1px solid var(--ccvscode-border);
  min-height: 34px;
  box-sizing: border-box;
}
.ccvscode-path {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--ccvscode-muted);
  direction: rtl;
  text-align: left;
}
.ccvscode-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: var(--ccvscode-btn);
  color: inherit;
  cursor: pointer;
  transition: background 120ms ease;
}
.ccvscode-btn:hover { background: var(--ccvscode-btn-hover); }
.ccvscode-btn:focus-visible { outline: 2px solid #4ec9b0; outline-offset: 1px; }
.ccvscode-stage { position: relative; flex: 1 1 auto; min-height: 0; }
.ccvscode-frame { display: block; width: 100%; height: 100%; border: 0; }
.ccvscode-panel {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px;
  text-align: center;
  overflow: auto;
  box-sizing: border-box;
}
.ccvscode-panel-title { font-size: 15px; font-weight: 600; }
.ccvscode-panel-text { font-size: 13px; color: var(--ccvscode-muted); max-width: 62ch; line-height: 1.5; }
.ccvscode-panel-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  text-align: left;
  white-space: pre-wrap;
  word-break: break-all;
  padding: 10px 12px;
  border-radius: 6px;
  border: 1px solid var(--ccvscode-border);
  background: var(--ccvscode-btn);
  max-width: 100%;
  box-sizing: border-box;
}
.ccvscode-panel-action {
  padding: 7px 14px;
  border: 0;
  border-radius: 6px;
  background: var(--ccvscode-btn);
  color: inherit;
  font-size: 13px;
  cursor: pointer;
}
.ccvscode-panel-action:hover { background: var(--ccvscode-btn-hover); }
.ccvscode-spinner {
  width: 22px;
  height: 22px;
  border: 2px solid var(--ccvscode-border);
  border-top-color: #4ec9b0;
  border-radius: 50%;
  animation: ccvscode-spin 0.8s linear infinite;
}
@keyframes ccvscode-spin { to { transform: rotate(360deg); } }
`;
  document.head.appendChild(style);
}

// ── Base path ─────────────────────────────────────────────────────────────────

function normalizeBasePath(value: string): string {
  let p = value.trim();
  if (!p) return DEFAULT_BASE_PATH;
  if (!p.startsWith('/')) p = '/' + p;
  if (!p.endsWith('/')) p += '/';
  return p;
}

function storedBasePath(): string | null {
  try {
    const raw = localStorage.getItem(LS_BASE_PATH);
    return raw ? normalizeBasePath(raw) : null;
  } catch {
    return null;
  }
}

function folderUrl(basePath: string, folder: string | null): string {
  return folder ? `${basePath}?folder=${encodeURIComponent(folder)}` : basePath;
}

// ── Persistent host element ───────────────────────────────────────────────────

function createState(): VsCodeState {
  const host = el('div', 'ccvscode-host');
  host.style.display = 'none';

  const toolbar = el('div', 'ccvscode-toolbar');
  // direction:rtl on the label keeps the tail of a long path visible, which is
  // the useful half; the LRM stops the leading slash from being reordered.
  const pathLabel = el('span', 'ccvscode-path', '‎');

  const stage = el('div', 'ccvscode-stage');
  const panel = el('div', 'ccvscode-panel');
  stage.appendChild(panel);

  const maxButton = button('Maximize', IC.maximize, () => toggleMaximized());

  toolbar.appendChild(pathLabel);
  toolbar.appendChild(button('Reload', IC.reload, () => reload()));
  toolbar.appendChild(button('Open in new tab', IC.newTab, () => openInNewTab()));
  toolbar.appendChild(maxButton);
  toolbar.appendChild(button('Fullscreen', IC.fullscreen, () => toggleFullscreen()));

  host.appendChild(toolbar);
  host.appendChild(stage);
  document.body.appendChild(host);

  return {
    host,
    pathLabel,
    stage,
    panel,
    iframe: null,
    maxButton,
    folder: null,
    basePath: storedBasePath() || DEFAULT_BASE_PATH,
    config: null,
    version: null,
    maximized: false,
    theme: 'dark',
    syncedTheme: null,
    rpc: null,
  };
}

function getState(): VsCodeState {
  if (!window.__ccVsCode || !window.__ccVsCode.host.isConnected) {
    window.__ccVsCode = createState();
  }
  return window.__ccVsCode;
}

// ── Toolbar actions ───────────────────────────────────────────────────────────

function reload(): void {
  const state = getState();
  if (!state.iframe) return;
  // Reassigning src rather than calling contentWindow.location.reload() keeps
  // the ?folder= query authoritative even if the user navigated inside VS Code.
  state.iframe.src = folderUrl(state.basePath, state.folder);
}

function openInNewTab(): void {
  const state = getState();
  window.open(folderUrl(state.basePath, state.folder), '_blank', 'noopener');
}

function applyMaximized(state: VsCodeState): void {
  state.host.classList.toggle('ccvscode-maximized', state.maximized);
  const label = state.maximized ? 'Restore' : 'Maximize';
  state.maxButton.title = label;
  state.maxButton.setAttribute('aria-label', label);
  state.maxButton.replaceChildren(icon(state.maximized ? IC.restore : IC.maximize));
}

function toggleMaximized(): void {
  const state = getState();
  state.maximized = !state.maximized;
  applyMaximized(state);
}

function isFullscreen(state: VsCodeState): boolean {
  return document.fullscreenElement === state.host;
}

function toggleFullscreen(): void {
  const state = getState();
  if (isFullscreen(state)) {
    void document.exitFullscreen().catch(() => undefined);
    return;
  }
  if (typeof state.host.requestFullscreen !== 'function') {
    // Safari on iOS has no element fullscreen; maximizing is the fallback.
    if (!state.maximized) toggleMaximized();
    return;
  }
  state.host.requestFullscreen().catch(() => {
    if (!state.maximized) toggleMaximized();
  });
}

// ── Diagnostics panel ─────────────────────────────────────────────────────────

interface PanelSpec {
  title: string;
  text: string;
  command?: string;
  action?: { label: string; run: () => void };
  spinner?: boolean;
}

function renderPanel(state: VsCodeState, spec: PanelSpec): void {
  const panel = state.panel;
  panel.replaceChildren();

  if (spec.spinner) panel.appendChild(el('div', 'ccvscode-spinner'));
  panel.appendChild(el('div', 'ccvscode-panel-title', spec.title));
  panel.appendChild(el('div', 'ccvscode-panel-text', spec.text));
  if (spec.command) panel.appendChild(el('pre', 'ccvscode-panel-code', spec.command));
  if (spec.action) {
    const btn = el('button', 'ccvscode-panel-action', spec.action.label);
    btn.type = 'button';
    btn.addEventListener('click', spec.action.run);
    panel.appendChild(btn);
  }

  panel.style.display = 'flex';
  if (state.iframe) state.iframe.style.display = 'none';
}

function showIframe(state: VsCodeState): void {
  state.panel.style.display = 'none';
  if (state.iframe) state.iframe.style.display = 'block';
}

// ── Health checks ─────────────────────────────────────────────────────────────

/**
 * Verify the same-origin route actually reaches code-server.
 *
 * CloudCLI is a SPA: an unknown path returns index.html with HTTP 200, so a
 * bare `res.ok` check would pass even when the reverse-proxy rule is missing.
 * code-server's /healthz answers JSON with a `status` field — that is the
 * signal we look for.
 */
async function probeRoute(basePath: string): Promise<boolean> {
  try {
    const res = await fetch(basePath + 'healthz', {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!res.ok) return false;
    const body: unknown = await res.json();
    return !!body && typeof body === 'object' && 'status' in (body as Record<string, unknown>);
  } catch {
    return false;
  }
}

/**
 * Drop anything under the base path from CloudCLI's service-worker cache.
 *
 * The host's sw.js caches cache-first, forever, for any URL merely *containing*
 * "/assets/" — a substring test against the whole URL, not a prefix test on the
 * host's own asset directory. code-server ships paths that match (its bundled
 * Copilot extension has an assets/ folder), so after a code-server upgrade the
 * browser could keep serving the previous build's files indefinitely.
 *
 * Best-effort: the Cache API is unavailable over plain HTTP on some browsers.
 */
async function pruneStaleCache(basePath: string): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        if (new URL(request.url).pathname.startsWith(basePath)) {
          await cache.delete(request);
        }
      }
    }
  } catch {
    /* nothing to do — a stale cache is a degradation, not a failure */
  }
}

interface BackendStatus {
  ok: boolean;
  config: VsCodeConfig;
  codeServer: { running: boolean; status: number | null; error: string | null };
  configPath: string;
  version: string | null;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function setStage(state: VsCodeState, stage: Stage, detail?: string): void {
  switch (stage) {
    case 'loading':
      renderPanel(state, {
        title: 'Connecting to VS Code…',
        text: 'Checking that code-server is running and reachable on this origin.',
        spinner: true,
      });
      break;

    case 'no-project':
      renderPanel(state, {
        title: 'No project selected',
        text: 'Pick a project in the CloudCLI sidebar and VS Code will open its folder.',
      });
      break;

    case 'server-down':
      renderPanel(state, {
        title: 'code-server is not running',
        text:
          detail ||
          'The plugin backend could not reach code-server on its loopback address.',
        command: `sudo systemctl start ${state.config?.serviceName || 'code-server@' + '$USER'}\nsudo systemctl status ${state.config?.serviceName || 'code-server@' + '$USER'}`,
        action: { label: 'Check again', run: () => void refresh(state) },
      });
      break;

    case 'route-missing':
      renderPanel(state, {
        title: 'Route not configured',
        text:
          `code-server is running, but it is not reachable at ${state.basePath} on this origin. ` +
          'Make sure your reverse proxy forwards this path to code-server.',
        command: `# after adding the location block, reload your reverse proxy\nnginx -t && nginx -s reload\n\n# check the route\ncurl -s ${location.origin}${state.basePath}healthz`,
        action: { label: 'Check again', run: () => void refresh(state) },
      });
      break;

    case 'rpc-failed':
      renderPanel(state, {
        title: 'Plugin backend unavailable',
        text: detail || 'Could not get a status from the plugin backend.',
        command:
          '# CloudCLI logs, if it runs as the systemd unit cloudcli\n' +
          'sudo journalctl -u cloudcli -n 50 | grep -i "Plugin:vs-code"',
        action: { label: 'Check again', run: () => void refresh(state) },
      });
      break;

    case 'ready':
      showIframe(state);
      break;
  }
}

function ensureIframe(state: VsCodeState): HTMLIFrameElement {
  if (state.iframe) return state.iframe;
  const frame = el('iframe', 'ccvscode-frame');
  frame.setAttribute('allow', 'clipboard-read; clipboard-write; fullscreen');
  frame.setAttribute('title', 'VS Code');
  // No sandbox attribute: code-server is same-origin here and needs full
  // access to storage, service workers and the clipboard to function.
  frame.src = folderUrl(state.basePath, state.folder);
  state.stage.appendChild(frame);
  state.iframe = frame;
  return frame;
}

function setFolder(state: VsCodeState, folder: string | null): void {
  const label = folder || 'no project selected';
  state.pathLabel.textContent = '‎' + label;
  state.pathLabel.title = label;

  if (state.folder === folder) return;
  state.folder = folder;
  if (state.iframe) state.iframe.src = folderUrl(state.basePath, folder);
}

function applyTheme(state: VsCodeState, theme: 'dark' | 'light'): void {
  state.theme = theme;
  state.host.classList.toggle('ccvscode-light', theme === 'light');
}

/**
 * Mirror CloudCLI's light/dark choice into code-server.
 *
 * VS Code has no way to take a theme from the embedder, so the backend writes
 * `workbench.colorTheme` into settings.json; VS Code's own file watcher then
 * re-themes the running workbench without a reload. Failures are cosmetic, so
 * they never block the iframe.
 */
async function pushTheme(state: VsCodeState, theme: 'dark' | 'light'): Promise<void> {
  if (!state.rpc || state.syncedTheme === theme) return;
  try {
    await state.rpc('POST', 'theme', { theme });
    state.syncedTheme = theme;
  } catch {
    /* leave syncedTheme unset so the next mount retries */
  }
}

/** Re-run every check and put the stage into the right state. */
async function refresh(state: VsCodeState): Promise<void> {
  if (!state.folder) {
    setStage(state, 'no-project');
    return;
  }

  // On a return visit the iframe is already live; swapping in the loading panel
  // would make it blink for the duration of the checks. Re-verify silently and
  // only take the screen if something is actually broken.
  if (!state.iframe) setStage(state, 'loading');

  const rpc = state.rpc;
  if (!rpc) {
    setStage(state, 'rpc-failed', 'The plugin is not mounted yet.');
    return;
  }

  let status: BackendStatus;
  try {
    status = (await rpc('GET', 'status')) as BackendStatus;
  } catch (err) {
    setStage(state, 'rpc-failed', (err as Error).message);
    return;
  }

  state.config = status.config;
  state.version = status.version;

  // A stored override wins over the backend default: it is how the user points
  // the plugin at a different deployment without touching the server config.
  const override = storedBasePath();
  state.basePath = override || normalizeBasePath(status.config.basePath);

  if (!status.codeServer.running) {
    setStage(state, 'server-down', status.codeServer.error || undefined);
    return;
  }

  if (!(await probeRoute(state.basePath))) {
    setStage(state, 'route-missing');
    return;
  }

  // Both of these must land before the iframe's first load: the cache prune so
  // it cannot pick up stale entries, the theme so VS Code boots with the right
  // one instead of flashing its default.
  if (!state.iframe) {
    await pruneStaleCache(state.basePath);
    await pushTheme(state, state.theme);
  }

  ensureIframe(state);
  setStage(state, 'ready');
}

// ── Geometry sync ─────────────────────────────────────────────────────────────

/**
 * Keep the parked host element glued to the host container's bounding box.
 *
 * A zero-sized container means the tab panel is hidden (CloudCLI does this when
 * the side code editor is expanded), so the overlay hides with it.
 */
function syncGeometry(state: VsCodeState, container: HTMLElement): void {
  if (state.maximized || isFullscreen(state)) {
    state.host.style.display = 'flex';
    return;
  }
  const r = container.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) {
    state.host.style.display = 'none';
    return;
  }
  state.host.style.display = 'flex';
  state.host.style.top = `${r.top}px`;
  state.host.style.left = `${r.left}px`;
  state.host.style.width = `${r.width}px`;
  state.host.style.height = `${r.height}px`;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

interface Cleanup {
  (): void;
}

export function mount(container: HTMLElement, api: PluginAPI): void {
  injectStyles();

  const state = getState();
  state.rpc = api.rpc.bind(api);

  const ctx: PluginContext = api.context;
  applyTheme(state, ctx.theme);
  applyMaximized(state);
  setFolder(state, ctx.project?.path || null);

  const sync = () => syncGeometry(state, container);
  sync();

  const observer = new ResizeObserver(sync);
  observer.observe(container);
  window.addEventListener('resize', sync);
  window.addEventListener('scroll', sync, true);
  document.addEventListener('fullscreenchange', sync);
  // Cheap safety net for layout changes no observer reports (CSS transitions
  // on the sidebar, host-driven class flips).
  const timer = window.setInterval(sync, 400);

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    if (isFullscreen(state)) return; // the browser handles Esc itself
    if (state.maximized) {
      e.preventDefault();
      toggleMaximized();
      sync();
    }
  };
  document.addEventListener('keydown', onKeyDown);

  const unsubscribe = api.onContextChange((next) => {
    if (next.theme !== state.theme) {
      applyTheme(state, next.theme);
      void pushTheme(state, next.theme);
    }
    const folder = next.project?.path || null;
    if (folder !== state.folder) {
      setFolder(state, folder);
      void refresh(state);
    }
  });

  void refresh(state);

  const cleanup: Cleanup = () => {
    observer.disconnect();
    window.removeEventListener('resize', sync);
    window.removeEventListener('scroll', sync, true);
    document.removeEventListener('fullscreenchange', sync);
    document.removeEventListener('keydown', onKeyDown);
    window.clearInterval(timer);
    unsubscribe();

    if (isFullscreen(state)) void document.exitFullscreen().catch(() => undefined);
    // Hide, never detach: detaching would reload VS Code on the next visit.
    state.host.style.display = 'none';
  };

  (container as unknown as { _ccVsCodeCleanup?: Cleanup })._ccVsCodeCleanup = cleanup;
}

export function unmount(container: HTMLElement): void {
  const holder = container as unknown as { _ccVsCodeCleanup?: Cleanup };
  holder._ccVsCodeCleanup?.();
  delete holder._ccVsCodeCleanup;
}

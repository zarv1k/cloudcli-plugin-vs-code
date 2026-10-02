/**
 * CloudCLI Plugin API type definitions.
 *
 * These types describe the API object passed to your plugin's mount() function
 * by the CloudCLI UI host. Copy this file into your own plugin to get full
 * type-safety and editor autocomplete.
 */

/** Current application context provided to the plugin. */
export interface PluginContext {
  /** Active UI theme. */
  theme: 'dark' | 'light';
  /** Currently selected project, or null if none. */
  project: { name: string; path: string } | null;
  /** Currently active session, or null if none. */
  session: { id: string; title: string } | null;
}

/** The API object received in mount(container, api). */
export interface PluginAPI {
  /** Current context snapshot (always returns the latest values). */
  readonly context: PluginContext;

  /**
   * Subscribe to context changes (theme, project, session).
   * @returns An unsubscribe function.
   */
  onContextChange(callback: (ctx: PluginContext) => void): () => void;

  /**
   * Call the plugin's backend server through the host proxy.
   * @param method  HTTP method (GET, POST, PUT, DELETE, etc.)
   * @param path    Request path on the plugin server (leading "/" is optional)
   * @param body    Optional JSON-serializable request body
   * @returns Parsed JSON response from the server
   */
  rpc(method: string, path: string, body?: unknown): Promise<unknown>;
}

/** Shape a plugin entry module must satisfy. */
export interface PluginModule {
  mount(container: HTMLElement, api: PluginAPI): void | Promise<void>;
  unmount?(container: HTMLElement): void;
}

/** Resolved plugin configuration, as returned by the backend's /status. */
export interface VsCodeConfig {
  /** Same-origin path the browser uses to reach code-server, e.g. "/vscode/". */
  basePath: string;
  /** Loopback origin the backend health-checks, e.g. "http://127.0.0.1:8080". */
  upstream: string;
  /** systemd unit managing code-server, used for diagnostics messages. */
  serviceName: string;
  /** Whether POST /service/restart is permitted. Off by default. */
  serviceControl: boolean;
  /** Mirror CloudCLI's light/dark choice into code-server's settings.json. */
  syncTheme: boolean;
  /** code-server's settings.json, patched when syncTheme is on. */
  settingsPath: string;
  /** Theme applied when CloudCLI is dark. */
  darkTheme: string;
  /** Theme applied when CloudCLI is light. */
  lightTheme: string;
}

/** Backend /status payload. */
export interface VsCodeStatus {
  ok: boolean;
  config: VsCodeConfig;
  codeServer: {
    running: boolean;
    status: number | null;
    error: string | null;
  };
  configPath: string;
}

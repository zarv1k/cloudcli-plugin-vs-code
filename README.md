# cloudcli-plugin-vs-code

A [CloudCLI](https://github.com/siteboon/claudecodeui) plugin that adds a **VS Code** tab, opening
the currently selected CloudCLI project in a browser-based VS Code
([code-server](https://github.com/coder/code-server)) — with a maximize and a true fullscreen mode.

- The tab follows CloudCLI's project selection: pick a project in the sidebar and VS Code opens that
  folder. Switch projects and it reopens the new one.
- VS Code follows CloudCLI's light/dark theme, live.
- **Switching CloudCLI tabs does not reload VS Code.** Open editors, terminals and unsaved buffers
  survive going to Chat and back.
- Two levels of "bigger": maximize over the whole CloudCLI viewport, or native browser fullscreen.

## How it works

CloudCLI plugins are ES modules mounted into a tab; they cannot proxy a whole web application
(the host's RPC channel is JSON-only, strips headers and has no HTTP upgrade). So code-server is
reached **directly by the browser**, over a path on the same origin as CloudCLI:

```
Browser ──> reverse proxy ──┬── /         ──> CloudCLI      (:3001)
                            └── /vscode/  ──> code-server   (:8080)
                 │
                 └─ CloudCLI SPA
                      └─ "VS Code" tab (this plugin)
                           ├─ <iframe src="/vscode/?folder=<project path>">
                           └─ api.rpc(...) ─> plugin backend ─> health-check 127.0.0.1:8080
```

Same-origin is the load-bearing choice: no mixed content, no second TLS certificate, no second DNS
record, and an existing client-certificate (mTLS) setup keeps working untouched, because the browser
has already authenticated to that origin.

Two implementation details worth knowing:

**The iframe is parked on `document.body`, not nested in the tab panel.** CloudCLI renders plugin
tabs conditionally, so `mount()`/`unmount()` run on every tab switch. Moving an iframe within the DOM
reloads its document; hiding one does not. The plugin therefore keeps a single fixed-position element
glued to the tab container's bounding box (via `ResizeObserver`) and merely hides it on unmount. A
zero-sized container — which is how CloudCLI hides the panel when the side editor is expanded — hides
the overlay too.

**The backend exists to tell two failures apart.** The browser cannot reach loopback, so it cannot
distinguish "code-server is stopped" from "the reverse-proxy route is missing". The plugin's Node
backend health-checks `127.0.0.1:8080` directly; the frontend separately probes the same-origin path.
Each failure gets its own diagnostic panel with the command that fixes it.

## Requirements

- CloudCLI v1.0.0+ and Node 18+
- A reverse proxy in front of CloudCLI that you can add one `location` block to
- Linux host with systemd, and `sudo` for the setup script

## Install

### 1. Host setup

```bash
./scripts/setup-host.sh --dry-run   # review first
./scripts/setup-host.sh
```

This installs code-server, writes a systemd drop-in binding it to `0.0.0.0:8080`, adds firewall rules
so that port is reachable only from loopback and Docker bridges, and adds the `/vscode/` location to
the reverse proxy. Every step is idempotent and backs up any file it edits.

Defaults are overridable by environment variable — see `--help`. The nginx step runs only when you
point it at your proxy config; otherwise it is skipped:

```bash
# nginx on the host
NGINX_CONF=/etc/nginx/sites-available/cloudcli ./scripts/setup-host.sh

# nginx in a Docker container (reaches code-server via host.docker.internal)
NGINX_CONF=/path/to/proxy.conf NGINX_CONTAINER=<container> ./scripts/setup-host.sh
```

`UPSTREAM_HOST` overrides how nginx reaches code-server. Or add this block by hand, **before** your
catch-all `location /`:

```nginx
location = /vscode { return 301 /vscode/; }

location /vscode/ {
    # 127.0.0.1 for nginx on the host; host.docker.internal for nginx in a container.
    # $connection_upgrade needs the usual `map $http_upgrade $connection_upgrade` in the http block.
    proxy_pass http://127.0.0.1:8080/;   # trailing slash strips the prefix
    proxy_http_version 1.1;

    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;

    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Accept-Encoding   gzip;

    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_buffering    off;
}
```

code-server generates only relative asset URLs, so it needs no extra flags to run under a path prefix.

The code-server login password is generated on first run and stored in
`~/.config/code-server/config.yaml`. You log in once per browser.

### 2. Plugin install

From CloudCLI: **Settings → Plugins**, paste this repository's URL. CloudCLI clones it, runs
`npm install --ignore-scripts` and `npm run build`, and starts the backend.

Or manually:

```bash
git clone <this repo> ~/.claude-code-ui/plugins/cloudcli-plugin-vs-code
cd ~/.claude-code-ui/plugins/cloudcli-plugin-vs-code
npm install && npm run build
sudo systemctl restart cloudcli   # or however you run CloudCLI
```

Here and below, `cloudcli` is the systemd unit CloudCLI runs as — substitute your own unit name or
process manager.

## Configuration

Optional, `~/.config/cloudcli-plugin-vs-code/config.json` — re-read on every request, no restart
needed:

```json
{
  "basePath": "/vscode/",
  "upstream": "http://127.0.0.1:8080",
  "serviceName": "code-server@yourname",
  "serviceControl": false,
  "syncTheme": true,
  "darkTheme": "Default Dark Modern",
  "lightTheme": "Default Light Modern"
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `basePath` | `/vscode/` | Same-origin path the browser uses to reach code-server |
| `upstream` | `http://127.0.0.1:8080` | Loopback origin the backend health-checks |
| `serviceName` | `code-server@$USER` | systemd unit, quoted in diagnostic messages |
| `serviceControl` | `false` | Allows `POST /service/restart` to run `sudo -n systemctl restart` |
| `syncTheme` | `true` | Mirror CloudCLI's light/dark choice into code-server |
| `settingsPath` | `~/.local/share/code-server/User/settings.json` | File patched when `syncTheme` is on |
| `darkTheme` / `lightTheme` | `Default Dark Modern` / `Default Light Modern` | Themes to apply |

A per-browser override of the base path can be set in `localStorage` under `ccvscode-base-path`; it
takes precedence over the backend value.

### Theme sync

VS Code has no way to accept a theme from whatever embeds it, so the plugin's backend writes
`workbench.colorTheme` into code-server's `settings.json`. VS Code watches that file, so the running
workbench re-themes without a reload.

The edit is surgical — the value is replaced in place rather than round-tripping the file through
`JSON.parse`/`stringify`, so comments, key order and formatting all survive. The write is atomic
(write-then-rename), so VS Code's watcher never sees a half-written file.

The trade-off: picking a theme inside VS Code sticks only until CloudCLI's theme next changes. Set
`"syncTheme": false` to own the theme yourself.

## Development

A symlink into the plugins directory **will not work** — CloudCLI's scanner uses
`Dirent.isDirectory()`, which is `false` for a symlink, so the directory is silently skipped. Use a
bind mount:

```bash
./scripts/dev-mount.sh            # bind-mount this working copy into ~/.claude-code-ui/plugins/
./scripts/dev-mount.sh --persist  # ...and survive a reboot via /etc/fstab
./scripts/dev-mount.sh --umount   # undo
```

Then:

```bash
npm run dev                       # tsc --watch
```

- **Frontend changes**: leave the tab and come back. The host fetches the entry with
  `Cache-Control: no-store` and re-imports it on every mount.
- **Backend changes**: `sudo systemctl restart cloudcli`.

Constraints the build must respect: the frontend entry is fetched as text, wrapped in a `Blob` and
imported from a `blob:` URL, so it must be a **single self-contained ES module** — relative and bare
imports would resolve against `blob:` and fail. Verify with:

```bash
npm run build && grep -E "^\s*import |require\(" dist/index.js   # must print nothing
```

## Troubleshooting

The tab shows a diagnostic panel naming the failing layer. Beyond that:

```bash
# code-server itself
systemctl status code-server@$USER
curl -s http://127.0.0.1:8080/healthz

# the same-origin route, through your reverse proxy (add --cert/--key if it requires a client cert)
curl -s https://<your-cloudcli-host>/vscode/healthz
# ...or from inside a proxy container, which bypasses any client-cert requirement
sudo docker exec <container> wget -qO- http://127.0.0.1/vscode/healthz

# the plugin backend
sudo journalctl -u cloudcli -n 50 | grep -i "plugin:vs-code"
```

**"Plugin failed to load" in the tab.** Almost always a stray import in `dist/index.js` — see the
grep above.

**The tab does not appear at all.** CloudCLI skipped the directory. Check it is a real directory (not
a symlink), contains `manifest.json`, and that `manifest.name` does not collide with another plugin.

**Stale VS Code assets after upgrading code-server.** CloudCLI's service worker caches cache-first and
permanently for any URL *containing* `/assets/` — a substring test against the whole URL, which
code-server paths can match. The plugin prunes its own base path from that cache before creating the
iframe; if you still see stale files, clear site data for the CloudCLI origin.

## Security

code-server is a full shell as the user running it — the same level of access CloudCLI's own Shell tab
already grants. The setup keeps that surface no wider than CloudCLI's:

- code-server binds `0.0.0.0` only so the proxy container can reach it through the host gateway;
  firewall rules drop everything not arriving on loopback or a Docker bridge.
- Password auth stays on as a second layer, since containers on those bridges can still reach the port.
- The plugin backend binds `127.0.0.1`, has no runtime dependencies, and receives only
  `PATH`/`HOME`/`NODE_ENV`/`PLUGIN_NAME` from the host.
- `sudo systemctl restart` from the backend is off unless `serviceControl` is explicitly enabled, and
  the unit name is validated against a strict pattern.

Put whatever authentication you use for CloudCLI in front of `/vscode/` as well — being on the same
origin, it usually already is.

## License

MIT

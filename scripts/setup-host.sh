#!/usr/bin/env bash
#
# Host-side setup for the CloudCLI "VS Code" plugin.
#
# The plugin itself is only a tab that frames code-server. This script prepares
# what the plugin cannot: the code-server service, the firewall rule that keeps
# its port off the public interface, and the reverse-proxy route that puts it on
# the same origin as CloudCLI.
#
# Every step is idempotent and re-running is safe. Use --dry-run first.

set -euo pipefail

PORT="${PORT:-8080}"
BASE_PATH="${BASE_PATH:-/vscode/}"
SERVICE_USER="${SERVICE_USER:-$(id -un)}"
# No defaults for the proxy: its layout is entirely deployment-specific. With
# NGINX_CONF unset the nginx step is skipped and the README block is added by hand.
NGINX_CONF="${NGINX_CONF:-}"
# Set when nginx runs in a Docker container; empty means nginx runs on the host.
NGINX_CONTAINER="${NGINX_CONTAINER:-}"
# A containerised proxy reaches the host through the Docker host gateway.
if [ -n "$NGINX_CONTAINER" ]; then
  UPSTREAM_HOST="${UPSTREAM_HOST:-host.docker.internal}"
else
  UPSTREAM_HOST="${UPSTREAM_HOST:-127.0.0.1}"
fi
NFT_CONF="${NFT_CONF:-/etc/nftables.conf}"

DRY_RUN=0
DO_CODE_SERVER=1
DO_NFTABLES=1
DO_NGINX=1

usage() {
  cat <<EOF
Usage: $0 [options]

Options:
  --dry-run            Print what would change, touch nothing.
  --skip-code-server   Do not install or configure code-server.
  --skip-nftables      Do not touch \$NFT_CONF.
  --skip-nginx         Do not touch \$NGINX_CONF.
  -h, --help           This text.

Environment overrides (current values):
  PORT=$PORT
  BASE_PATH=$BASE_PATH
  SERVICE_USER=$SERVICE_USER
  NGINX_CONF=$NGINX_CONF
      nginx config file holding the CloudCLI server block. If empty, the
      nginx step is skipped.
  NGINX_CONTAINER=$NGINX_CONTAINER
      Docker container running that nginx. If empty, nginx is assumed to
      run on the host.
  UPSTREAM_HOST=$UPSTREAM_HOST
      How nginx reaches code-server: host.docker.internal when
      NGINX_CONTAINER is set, 127.0.0.1 otherwise.
  NFT_CONF=$NFT_CONF

Example (nginx in a Docker container):
  NGINX_CONF=/srv/proxy/nginx.conf NGINX_CONTAINER=proxy $0 --dry-run
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --skip-code-server) DO_CODE_SERVER=0 ;;
    --skip-nftables) DO_NFTABLES=0 ;;
    --skip-nginx) DO_NGINX=0 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m warn:\033[0m %s\n' "$*" >&2; }
skip() { printf '     %s\n' "$*"; }

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '     [dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

need_sudo() {
  if ! sudo -n true 2>/dev/null; then
    echo "This script needs non-interactive sudo (sudo -n). Run 'sudo -v' first." >&2
    exit 1
  fi
}

# Config files often live in root-only directories, so a plain `[ -f ... ]`
# would wrongly report them missing.
file_exists() {
  [ -f "$1" ] || sudo -n test -f "$1" 2>/dev/null
}

SERVICE_NAME="code-server@${SERVICE_USER}"

# ── 1. code-server ────────────────────────────────────────────────────────────

setup_code_server() {
  if command -v code-server >/dev/null 2>&1; then
    skip "code-server already installed ($(code-server --version 2>/dev/null | head -1))"
  else
    say "Installing code-server"
    if [ "$DRY_RUN" -eq 1 ]; then
      skip "[dry-run] curl -fsSL https://code-server.dev/install.sh | sh"
    else
      curl -fsSL https://code-server.dev/install.sh | sh
    fi
  fi

  local dropin_dir="/etc/systemd/system/${SERVICE_NAME}.service.d"
  say "Writing systemd drop-in ${dropin_dir}/override.conf"

  # bind-addr is overridden here rather than in ~/.config/code-server/config.yaml
  # so the file holding the password is never rewritten by this script.
  local content
  content=$(cat <<EOF
# Managed by cloudcli-plugin-vs-code — see scripts/setup-host.sh.
[Service]
ExecStart=
ExecStart=/usr/bin/code-server --bind-addr 0.0.0.0:${PORT} --disable-telemetry --disable-update-check
EOF
)

  if [ "$DRY_RUN" -eq 1 ]; then
    skip "[dry-run] would write:"
    printf '%s\n' "$content" | sed 's/^/       | /'
  else
    sudo mkdir -p "$dropin_dir"
    printf '%s\n' "$content" | sudo tee "$dropin_dir/override.conf" >/dev/null
    sudo chmod 644 "$dropin_dir/override.conf"
    sudo systemctl daemon-reload
  fi

  if [ -f "$HOME/.config/code-server/config.yaml" ]; then
    run chmod 600 "$HOME/.config/code-server/config.yaml"
  fi

  say "Enabling ${SERVICE_NAME}"
  run sudo systemctl enable --now "$SERVICE_NAME"
}

# ── 2. nftables ───────────────────────────────────────────────────────────────

setup_nftables() {
  if ! file_exists "$NFT_CONF"; then
    warn "$NFT_CONF not found — skipping firewall step. Make sure port $PORT is not reachable from outside."
    return
  fi

  if grep -q "dport ${PORT}" "$NFT_CONF" 2>/dev/null ||
     sudo grep -q "dport ${PORT}" "$NFT_CONF" 2>/dev/null; then
    skip "nftables already has a rule for port ${PORT}"
    return
  fi

  say "Adding lockdown rules for port ${PORT} to ${NFT_CONF}"
  if [ "$DRY_RUN" -eq 1 ]; then
    skip "[dry-run] would append accept lo/docker0/br-* + drop for dport ${PORT}"
    return
  fi

  sudo cp -a "$NFT_CONF" "${NFT_CONF}.bak-$(date +%Y%m%d-%H%M%S)"
  sudo NFT_CONF="$NFT_CONF" PORT="$PORT" python3 <<'PY'
import os, re, sys

path = os.environ.get("NFT_CONF", "/etc/nftables.conf")
port = os.environ["PORT"]

with open(path, encoding="utf-8") as fh:
    text = fh.read()

block = (
    f"\n\t\t# code-server:{port} — reachable only from loopback and docker bridges.\n"
    f'\t\ttcp dport {port} iifname "lo" counter accept\n'
    f'\t\ttcp dport {port} iifname "docker0" counter accept\n'
    f'\t\ttcp dport {port} iifname "br-*" counter accept\n'
    f"\t\ttcp dport {port} counter drop\n"
)

# If the input chain already locks other ports down with "tcp dport N counter
# drop", append after the last such rule to keep similar rules together;
# otherwise insert at the top of the chain.
matches = list(re.finditer(r"^\t\ttcp dport \d+ counter drop\n", text, re.M))
if matches:
    at = matches[-1].end()
    text = text[:at] + block + text[at:]
else:
    at = text.find("chain input {")
    if at < 0:
        sys.exit("no 'chain input' block found — patch %s by hand" % path)
    at = text.index("\n", text.index("type filter hook input", at)) + 1
    text = text[:at] + block + text[at:]

with open(path, "w", encoding="utf-8") as fh:
    fh.write(text)
print("patched", path)
PY

  sudo nft -f "$NFT_CONF"
  say "Active rules for port ${PORT}:"
  sudo nft list chain inet filter input | grep "dport ${PORT}" | sed 's/^/     /'
}

# ── 3. nginx ──────────────────────────────────────────────────────────────────

setup_nginx() {
  if [ -z "$NGINX_CONF" ]; then
    warn "NGINX_CONF is not set — skipping nginx step. Add the ${BASE_PATH} location by hand (see README) or re-run with NGINX_CONF=/path/to/your.conf."
    return
  fi

  if ! file_exists "$NGINX_CONF"; then
    warn "$NGINX_CONF not found — add the ${BASE_PATH} location to your reverse proxy by hand (see README)."
    return
  fi

  if sudo grep -q "location ${BASE_PATH}" "$NGINX_CONF" 2>/dev/null; then
    skip "nginx already proxies ${BASE_PATH}"
    return
  fi

  say "Adding 'location ${BASE_PATH}' to ${NGINX_CONF}"
  if [ "$DRY_RUN" -eq 1 ]; then
    skip "[dry-run] would proxy ${BASE_PATH} -> http://${UPSTREAM_HOST}:${PORT}/"
    return
  fi

  sudo cp -a "$NGINX_CONF" "${NGINX_CONF}.bak-$(date +%Y%m%d-%H%M%S)"
  sudo NGINX_CONF="$NGINX_CONF" BASE_PATH="$BASE_PATH" \
       UPSTREAM_HOST="$UPSTREAM_HOST" PORT="$PORT" python3 <<'PY'
import os, sys

path = os.environ["NGINX_CONF"]
base = os.environ["BASE_PATH"]
upstream = "http://%s:%s/" % (os.environ["UPSTREAM_HOST"], os.environ["PORT"])
bare = base.rstrip("/")

with open(path, encoding="utf-8") as fh:
    text = fh.read()

anchor = "    location / {\n"
if anchor not in text:
    sys.exit("anchor 'location / {' not found in %s — patch it by hand" % path)

block = f"""    # code-server on the same origin as CloudCLI, so the VS Code plugin's
    # iframe hits neither mixed content nor a second client certificate.
    location = {bare} {{ return 301 {base}; }}

    location {base} {{
        # trailing slash strips the prefix before proxying upstream
        proxy_pass {upstream};
        proxy_http_version 1.1;

        # VS Code is a WebSocket application end to end
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Accept-Encoding   gzip;

        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering    off;
    }}

"""

with open(path, "w", encoding="utf-8") as fh:
    fh.write(text.replace(anchor, block + anchor, 1))
print("patched", path)
PY

  if [ -n "$NGINX_CONTAINER" ]; then
    if command -v docker >/dev/null 2>&1 &&
       sudo docker ps --format '{{.Names}}' | grep -qx "$NGINX_CONTAINER"; then
      say "Reloading nginx in container ${NGINX_CONTAINER}"
      sudo docker exec "$NGINX_CONTAINER" nginx -t
      sudo docker exec "$NGINX_CONTAINER" nginx -s reload
    else
      warn "container ${NGINX_CONTAINER} not running — reload your proxy manually"
    fi
  elif command -v nginx >/dev/null 2>&1; then
    say "Reloading nginx"
    sudo nginx -t
    sudo nginx -s reload
  else
    warn "nginx not found on the host — reload your proxy manually"
  fi
}

# ── main ──────────────────────────────────────────────────────────────────────

# Note the `if` blocks: under `set -e` a bare `[ ... ] && fn` would abort the
# script the moment a step is skipped.
if [ "$DRY_RUN" -eq 1 ]; then
  say "DRY RUN — nothing will be changed"
else
  need_sudo
fi

if [ "$DO_CODE_SERVER" -eq 1 ]; then setup_code_server; fi
if [ "$DO_NFTABLES" -eq 1 ]; then setup_nftables; fi
if [ "$DO_NGINX" -eq 1 ]; then setup_nginx; fi

say "Done."
cat <<EOF

Verify:
  curl -s http://127.0.0.1:${PORT}/healthz
  systemctl is-active ${SERVICE_NAME}
  curl -s https://<your-cloudcli-host>${BASE_PATH}healthz

The code-server password lives in ~/.config/code-server/config.yaml.
EOF

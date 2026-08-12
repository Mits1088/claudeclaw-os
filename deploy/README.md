# VPS deploy (Hostinger + Tailscale)

One-shot, mostly-unattended deploy of ClaudeClaw OS onto a fresh Debian/Ubuntu VPS.
The bot runs as a hardened `systemd` service, and the dashboard is reachable **only**
by devices on your Tailscale network — over real HTTPS, on top of the existing
`DASHBOARD_TOKEN` gate.

> ClaudeClaw isn't officially "cloud supported" (see the main README's *Cloud
> deployment* section). This path automates the supported-on-Linux pieces and the
> two things that otherwise break headless: Claude auth and persistent storage.

## What you get

- Node 20 + build tools, a dedicated unprivileged `claudeclaw` user, repo cloned +
  built, `.env` generated non-interactively.
- Dashboard bound to `127.0.0.1` (never on a public interface) and published to your
  tailnet at `https://<host>.<tailnet>.ts.net` via **Tailscale Serve**.
- `systemd` service with auto-restart + sandboxing.
- `ufw` (deny incoming, dashboard port never opened publicly), `fail2ban`,
  `unattended-upgrades`, and key-only SSH.

## Prerequisites

1. **A VPS** running Ubuntu 22.04+ or Debian 12+ with root SSH.
2. **Tailscale tailnet** with, in the admin console (`login.tailscale.com`):
   - **MagicDNS** enabled, and
   - **HTTPS certificates** enabled (Settings → Feature previews / DNS).
   Generate a **pre-auth key** (Settings → Keys) for an unattended join.
3. **Telegram bot**: create one with [@BotFather](https://t.me/BotFather), and get your
   numeric chat ID (e.g. via [@userinfobot](https://t.me/userinfobot)).
4. **Claude auth** — pick one:
   - **Max plan:** run `claude setup-token` on your laptop → long-lived OAuth token.
   - **Pay-per-token:** an `ANTHROPIC_API_KEY` from [console.anthropic.com](https://console.anthropic.com).
5. **Repo clone token** (the upstream `earlyaidopters/claudeclaw-os` repo is private):
   open the members token site, which shows a clone command like
   `git clone https://x-access-token:ghs_XXXX@github.com/...`. Copy the `ghs_...`
   token and set `REPO_CLONE_TOKEN` in the conf. Tokens expire in ~1h; regenerate and
   re-run if the clone step fails. (Skip if you point `REPO_URL` at a public repo.)

## Quickstart

From your laptop:

```bash
# Grab just the two files you need (or scp them from a local clone of the branch)
scp deploy/install-vps.sh deploy/claudeclaw-deploy.conf.example root@YOUR_VPS:/root/
ssh root@YOUR_VPS
```

On the VPS:

```bash
cp claudeclaw-deploy.conf.example claudeclaw-deploy.conf
nano claudeclaw-deploy.conf      # fill in the secrets
bash install-vps.sh
```

When it finishes it prints your dashboard URL, e.g.:

```
https://claudeclaw.tailXXXX.ts.net/?token=...&chatId=...
```

Open it on any device that's signed in to your tailnet. Then send a message from your
allowed Telegram chat to confirm the bot replies.

> Testing a feature branch before it's merged? Set `REPO_BRANCH=<your-branch>` in your conf so
> the VPS clones the same branch you're testing. Push the branch first — the installer clones
> from the remote, so uncommitted local work won't be deployed.

## Security model

| Layer | What it does |
|-------|--------------|
| Tailscale Serve | Only tailnet devices can reach the dashboard; valid HTTPS cert. |
| Loopback bind | Dashboard listens on `127.0.0.1` only — nothing on the public IP. |
| `DASHBOARD_TOKEN` | Per-request token (constant-time compared) even within the tailnet. |
| `ufw` | Deny incoming; dashboard port never opened; only SSH + `tailscale0` allowed. |
| `fail2ban` + key-only SSH | Brute-force protection on the one public service (SSH). |
| Unprivileged user + systemd sandbox | The bot (which spawns Claude Code) never runs as root. |

Nothing is exposed to the public internet — a public tunnel or an open port would weaken the
"authorized devices only" goal.

### SSH lockdown (optional)

`SSH_HARDENING=tailscale-only` blocks public port 22 so SSH only works over the tailnet.
Strongest, but only enable it once you've:

- **Disabled key expiry** on this node in the Tailscale admin console (otherwise the node
  drops off the tailnet after ~90 days and you lose SSH), and
- **Confirmed Hostinger's browser/VNC console** (hPanel → your VPS) works — it bypasses
  `ufw`/Tailscale entirely, so you can always recover with `ufw allow OpenSSH`.

## Running it day to day

Your install is finished — these are the commands you'll use from now on. Re-running the
installer is only for upgrading to newer code; it is never a required second step.

```bash
systemctl status claudeclaw          # service state
journalctl -u claudeclaw -f          # live logs
tailscale serve status               # confirm dashboard is published
systemctl restart claudeclaw         # restart after .env changes
```

Update to the latest code: re-run `bash install-vps.sh` (it `git reset --hard`s to the
configured branch, rebuilds, and restarts — `store/` is untouched).

`.env` is **rewritten** from the template on every run. Carried across: `DASHBOARD_TOKEN`,
`DB_ENCRYPTION_KEY`, and every per-agent `*_BOT_TOKEN` the dashboard's New Agent wizard
added. Any *other* key you hand-edited into `.env` is lost.

Settings the installer supports belong in `claudeclaw-deploy.conf`. Note that the conf is
not a general passthrough: it is sourced, but only the variables the installer explicitly
supports are written into the generated `.env`. A custom runtime key placed there does not
reach `.env` either, and needs a separately supported persistence mechanism.

Rotate the dashboard token:

```bash
sudo sed -i "s/^DASHBOARD_TOKEN=.*/DASHBOARD_TOKEN=$(openssl rand -hex 24)/" \
  /opt/claudeclaw/claudeclaw-os/.env
sudo systemctl restart claudeclaw
```

### Starting and stopping agents

Only the main bot is a systemd service. Other agents are started and stopped from the
dashboard's Agents page — Start spawns a detached child of the main process, Stop kills it.
No SSH, no root, no per-agent unit files, same as the macOS and Windows installs.

Agents are stopped whenever the main service stops, and are **not** brought back
automatically. Press Start again after any of these:

- a host **reboot**;
- `systemctl restart claudeclaw`, including every installer re-run.

That is deliberate. Agents join the main unit's cgroup, so systemd's default
`KillMode=control-group` stops them alongside main. Letting them survive would leave them
running the *previous* build after an update — a Node process loads its code at spawn, so a
rebuilt `dist/` never reaches an already-running agent — giving you a mixed-version fleet
until each one was restarted by hand. Being stopped and restarted deliberately is the
cheaper failure.

Agent logs are `logs/<agent-id>.log` in the install directory, not `journalctl` — agents
aren't systemd units.

If you previously hand-wrote `claudeclaw-agent-*.service` units to work around agent Start
being broken, remove them, or systemd and the dashboard will fight over the same PID file.
Note that `disable` takes no glob, so name each unit:

```bash
for a in <your-agent-ids>; do
  systemctl disable --now "claudeclaw-agent-$a" 2>/dev/null || true
done
rm -f /etc/systemd/system/claudeclaw-agent-*.service
rm -f /etc/systemd/system/multi-user.target.wants/claudeclaw-agent-*.service
systemctl daemon-reload
```

## Troubleshooting

- **`tailscale serve failed`** — HTTPS certs aren't enabled for your tailnet. Enable them
  in the admin console, then re-run the script.
- **Bot keeps restarting / Claude auth errors** — check the OAuth token / API key in
  `.env`; `journalctl -u claudeclaw -n 100`.
- **`better-sqlite3` build failure** — ensure `build-essential` + `python3` installed
  (the script installs them; on minimal images double-check apt succeeded).
- **A feature needs to write outside the install dir** — relax the systemd hardening
  (e.g. add a `ReadWritePaths=` entry) in `/etc/systemd/system/claudeclaw.service`,
  then `systemctl daemon-reload && systemctl restart claudeclaw`.

## Not covered (yet)

Multi-agent fan-out (extra Telegram tokens + per-agent units), War Room voice
(`WARROOM_ENABLED`, needs a Python venv + `GOOGLE_API_KEY`), and non-Debian distros.

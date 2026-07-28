# deploy/windows/ — Windows parity for the oh-my-opencode-pms harness

These scripts bring Windows to parity with the Linux `install.sh` + systemd +
cron setup. The harness plugin code is already cross-platform; these cover the
*environment* and *automation* gaps (and one opencode-on-Windows plugin bug).

## One-time setup (new Windows machine)

```powershell
# 0. Clone the repo (per ~/.claude/CLAUDE.md migration steps), then:
cd ~\Code\oh-my-opencode-pms

# 1. Deploy config trees (~/.claude, ~/.config/opencode, clone agent-memory).
#    Re-run after every `git pull` unless Developer Mode (symlinks) is on.
powershell -File deploy\install.ps1

# 2. Install runtime prerequisites (user scope, no admin):
#    memsearch backend, PATH, bun cache health.
powershell -File deploy\windows\setup-prereqs.ps1

# 3. (admin) Stand up the webui as a service, via the launch wrapper:
powershell -File deploy\windows\install-webui-service.ps1 -ServerPassword '<pw>'

# 4. (admin) Register the scheduled jobs (15-min memory sync, etc.):
powershell -File deploy\windows\register-tasks.ps1
```

Prerequisites you must install yourself: `bun`, `gh`, `nssm`
(`winget install NSSM.NSSM`), `python`, `git`, and `opencode`
(`npm i -g opencode-ai`). `setup-prereqs.ps1` reports what's missing.

## What each script does

| Script | Elevation | Purpose |
|---|---|---|
| `setup-prereqs.ps1` | user | Install `memsearch[onnx]`, put its Scripts dir on PATH, redirect/verify the bun cache, presence-check tools. |
| `fix-pms-cache.ps1` | user | Dereference the pms plugin in opencode's cache (see bug note below). Idempotent. |
| `opencode-webui-launch.ps1` | (service) | NSSM service entry: set PATH, run `fix-pms-cache.ps1`, launch `opencode web`. |
| `install-webui-service.ps1` | **admin** | Create/reconfigure the `OpenCodeWebUI` NSSM service to use the wrapper. |
| `register-tasks.ps1` | **admin** | Task Scheduler jobs mirroring the Linux cron table. |
| `sync-memory.ps1` | user | Windows port of `scripts/sync-memory.sh` (git push agent-memory). |

## Known opencode-on-Windows bug (the pantheon "server entry" rejection)

opencode auto-installs the bare-name plugin `oh-my-opencode-pms` into
`~/.cache/opencode/packages/oh-my-opencode-pms@latest/` via a `file:` dependency
on the local repo. On **Windows**, bun installs `file:` deps by **symlinking**
individual files (`dist/index.js`, `package.json`) back to the repo. opencode
resolves the plugin's server entry with `realpathSync`, which follows that
symlink **out of** the plugin directory; its containment check
(`packages/opencode/src/util/filesystem.ts` `contains()` over `path.relative`)
then rejects it:

```
Plugin oh-my-opencode-pms resolved server entry outside plugin directory
```

On Linux the same `file:` install copies real files, so it passes.

**Workaround (this repo):** `fix-pms-cache.ps1` replaces the symlinked cache
copy with a real, dereferenced copy so every path resolves inside the plugin
dir. The webui launch wrapper runs it on every start (survives opencode
reinstalling the plugin).

**Durable fix (upstream):** opencode's `Filesystem.resolve`/`contains` should
not reject a plugin whose entry realpaths outside the install dir via a `file:`
symlink (or should compare pre-realpath). Tracked for an upstream PR.

## Machine-local config

`~/.config/opencode/opencode.json` (NOT in this repo) holds per-machine settings
like the webui `server` block:

```json
{ "$schema": "https://opencode.ai/config.json",
  "server": { "port": 4096, "hostname": "0.0.0.0" } }
```

opencode merges it over the shared `opencode.jsonc`. `install.ps1` never
overwrites it.

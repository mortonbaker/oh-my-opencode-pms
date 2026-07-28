# Cross-platform parity rule (Linux ↔ Windows)

The deploy story has **two installers that must stay in lockstep**:

- `deploy/install.sh` — Linux/macOS (symlinks; cron via `scripts/*.sh`; systemd
  via `deploy/systemd-user/*`).
- `deploy/install.ps1` — Windows (symlink-or-copy; Task Scheduler + NSSM via
  `deploy/windows/*`).

Both deploy the **same three trees** from `deploy/`:

1. `.claude/` → `~/.claude/` (+ `~/AGENTS.md` alias)
2. `.config/opencode/` → `~/.config/opencode/` (shared config; machine-local
   `opencode.json` preserved)
3. clone `agent-memory` → `~/.local/share/agent-memory/`

## The rule

> Any change that affects deployed config or scheduled automation **must update
> both OSes in the same commit.** Adding it to only one side is a parity
> regression.

### Checklist when you change…

- **A plugin / agent / mcp / skill in `deploy/.config/opencode/`** → nothing
  extra; both installers deploy the whole tree. But keep config values
  **OS-portable**: use bare binary names (PATH-resolved) or `{env:VAR}` rather
  than hardcoded POSIX paths (e.g. `mem0` `command` is `["mem0-mcp"]`, not
  `/home/...`).
- **A scheduled job** → add the `scripts/*.sh` + cron entry (Linux) **and** a
  `deploy/windows/*.ps1` + a `register-tasks.ps1` entry (Windows).
- **A long-running service** → add `deploy/systemd-user/*.service` (Linux)
  **and** a `deploy/windows/*-service.ps1` NSSM definition (Windows).
- **A runtime dependency** (a tool the harness shells out to) → ensure it's on
  PATH on both, and add presence/install handling to `deploy/windows/setup-prereqs.ps1`.

## Quick verification

```bash
# Linux
diff <(grep -o '"[a-z-]*"' deploy/.config/opencode/opencode.jsonc) ...   # config sanity
```
```powershell
# Windows, after install.ps1:
Test-Path ~\.config\opencode\opencode.jsonc            # shared deployed
Test-Path ~\.config\opencode\opencode.json             # machine-local preserved
Test-Path ~\.local\share\agent-memory\.git             # memory cloned
Get-ScheduledTask -TaskName omopms-*                    # tasks registered
Get-Service OpenCodeWebUI                               # webui service
memsearch --version                                     # memory backend
```

A CI check (`.github/workflows/parity.yml`, optional) can fail a PR when the
plugin list in `opencode.jsonc` changes without a corresponding touch to both
installers — see that workflow for the exact diff logic.

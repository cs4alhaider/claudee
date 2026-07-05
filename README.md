# claudee

A tiny, zero-dependency **interactive launcher for [Claude Code](https://claude.com/claude-code)**.

Type `claudee` and a fast, full-width arrow-key wizard lets you choose **where** to run (current directory, a new git worktree, or an existing one), then group all the launch options — skip-permissions, model, reasoning effort, and which past conversation to resume — on one screen. Hit `Enter` and it execs `claude` with the right flags.

Run it with arguments (`claudee -c "fix the bug"`) and it skips the menu entirely, passing straight through to `claude --dangerously-skip-permissions`.

> One executable. No npm install, no dependencies — just Node and the `claude` CLI you already have.

---

## Demo

**Step 1 — where should this session run?** (existing worktrees show a clean/dirty marker)

```
  ╭──────────────────────────────────────────────────────────────╮
  │ ◆ claudee                              my-app · main  +1 ~2  │
  ╰──────────────────────────────────────────────────────────────╯

  Step 1 of 2   ● ○

  Where should this session run?
  Pick the working tree. Existing worktrees launch in place.

  ‣ ◉ Current directory   run here — no worktree
    ○ New worktree…       new worktree + branch
    ○ feature/checkout    ~1  …/my-app/.worktrees/checkout
    ○ feature/search      ✓   …/my-app/.worktrees/search

  ↑↓ move · Enter next · Tab launch now · Esc quit
```

**Final — options grouped on one screen; `Enter` launches:**

```
  Options   — tweak with ←→, or Enter to launch

  Worktree  Current directory

  ‣ Skip permissions  ‹ Yes ›
    Model             default
    Effort            default
    Resume            Fix the checkout race  3h ago
    Fork session      No
    Open in Cursor    No
    Session name      (none)

  → claude --dangerously-skip-permissions --resume 4f1c…

  ↑↓ field · ←→ change · Enter launch · Esc back
```

**Delete a worktree** — press `d` on an existing one, then a deliberate confirm (default **No**):

```
  Delete this worktree?

    claude/checkout-fix
    …/my-app/.worktrees/checkout-fix

  Removes the worktree folder and deletes its branch. This cannot be undone.

    ‹ No ›   Yes

  ←→ choose · Enter confirm · Esc cancel
```

---

## Features

- **Worktree-first.** Launch in the current directory, spin up a **new git worktree** (`claude --worktree`), or jump into an **existing worktree** — launched in place. Manage them without leaving the wizard: **rename** (branch + folder) or **delete** (`d`) — with a deliberate confirm that force-removes dirty worktrees behind a second prompt and cleans up the branch.
- **Resume by title.** Instead of a blind "continue last", pick from your recent conversations shown by their **AI-generated title + relative time** (reads `~/.claude/projects`). Maps to `claude --resume <id>` or `-c`, and can **fork** into a fresh session (`--fork-session`).
- **Grouped options.** Skip-permissions, model, reasoning effort, resume, and session name on one screen with sensible defaults — accept them all with a single `Enter`, or tweak inline with `←/→`. Context-aware extras appear only when relevant: **Fork session** (when resuming), **Open in Cursor** (opens the launch directory in the Cursor editor), and **tmux** (new worktree in iTerm2).
- **Git status at a glance.** The header shows the current repo's state (`✓` clean, `+N` staged, `~N` unstaged); each existing worktree shows its own marker.
- **Fast passthrough.** `claudee <args>` behaves exactly like `claude --dangerously-skip-permissions <args>`, so your muscle memory and scripts keep working. Subcommands (`claudee auth`, `claudee mcp …`) pass through untouched.
- **Remembers you.** Persists your last model / effort / skip choice to `~/.config/claudee/state.json`.
- **Responsive & themeable.** Fills the terminal width, re-flows on resize, and honors `NO_COLOR`.

---

## Requirements

- [**Claude Code**](https://claude.com/claude-code) — the `claude` CLI on your `PATH`.
- **Node.js ≥ 18** — or **[Bun](https://bun.sh)**, which `claudee` auto-detects and prefers for a faster launch (~25–30% quicker startup). Only runtime built-ins are used; no packages.
- **git** — for worktree features (optional; the tool works fine outside a repo).

> **Runtime:** `claudee` ships a tiny `sh`/JS polyglot shebang — it runs on **Bun if installed, otherwise Node**, with no configuration. Nothing to set up either way.

---

## Install

### Homebrew

```sh
brew install cs4alhaider/tap/claudee
```

### From source

```sh
git clone https://github.com/cs4alhaider/claudee.git
cd claudee
./install.sh
```

`install.sh` symlinks `bin/claudee` into `~/.local/bin` (override with `PREFIX=/usr/local ./install.sh`). Because it's a symlink, `git pull` updates your installed command instantly.

Make sure the target dir is on your `PATH`:

```sh
export PATH="$HOME/.local/bin:$PATH"   # add to ~/.zshrc or ~/.bashrc
```

If you previously had `alias claudee=...` in your shell rc, remove it so the executable takes precedence.

### Manual

```sh
ln -sf "$PWD/bin/claudee" ~/.local/bin/claudee
```

---

## Usage

```sh
claudee                 # open the interactive wizard
claudee -c              # passthrough: claude --dangerously-skip-permissions -c
claudee "explain this"  # passthrough with a prompt
claudee auth            # subcommands pass straight through (no skip-perms)
```

### Keys

| Key | Action |
| --- | --- |
| `↑` `↓` | move between choices / fields |
| `←` `→` | change the selected value |
| `Enter` | next step · launch on the final screen |
| `Tab` | launch immediately with current + default answers |
| `d` | on an existing worktree: delete it (opens a confirm) |
| `Esc` | back · cancel a confirm (quit on the first screen) |
| `Ctrl-C` | quit |

---

## Configuration

Environment variables:

| Variable | Effect |
| --- | --- |
| `CLAUDEE_DRYRUN=1` | print the assembled `claude …` command instead of running it |
| `CLAUDEE_NO_STATUS=1` | skip git-status checks for a faster launch |
| `CLAUDEE_CLAUDE_BIN` | path/name of the `claude` binary (default: `claude`) |
| `CLAUDEE_COLS` | force a fixed layout width (otherwise the terminal width) |
| `NO_COLOR` | disable ANSI colors |

State (last model / effort / skip) is stored at `~/.config/claudee/state.json`.

---

## How it works

`claudee` never reimplements Claude Code — it just assembles flags and execs `claude`:

- **New worktree** → `claude --worktree [name]` (Claude creates the worktree/branch).
- **Existing worktree** → runs `claude` with its working directory set to that worktree.
- **Resume** → reads session transcripts under `~/.claude/projects/<slug>/*.jsonl`, extracts each conversation's `ai-title`, and launches `claude --resume <id>` (or `-c` for the most recent). **Fork session** adds `--fork-session` so you branch into a new session id.
- **Rename** → `git branch -m` + `git worktree move`, best-effort with inline error reporting.
- **Delete** → `git worktree remove` (adds `--force` for dirty worktrees, behind a second confirm) + `git branch -D`, all behind a default-No prompt.
- **Open in Cursor** → runs `cursor <launch-dir>` detached alongside the launch (no-op if the `cursor` CLI isn't installed).

---

## Project layout

Zero-dependency CommonJS modules — no build step, no bundler. `bin/claudee` is a thin entry point; the implementation is split by concern:

```
claudee/
├── bin/claudee     # entry: polyglot shebang · fast-path passthrough · boots the wizard
└── lib/
    ├── format.js   # pure text/color helpers + the git-status badge
    ├── git.js      # git + session-history helpers (worktrees, status, resume list)
    ├── claude.js   # the `claude` CLI interface: build args, run / dry-run
    └── wizard.js   # the interactive TUI: state, screens, rendering, key input
```

The install is a symlink into your `PATH`, so `require('../lib/…')` resolves against the repo — a `git pull` updates everything live, no rebuild.

---

## Uninstall

```sh
rm ~/.local/bin/claudee
rm -rf ~/.config/claudee   # optional: remove saved preferences
```

---

## License

[Apache-2.0](./LICENSE) © cs4alhaider

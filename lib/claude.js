'use strict';
/*
 * claude.js — the interface to the `claude` CLI.
 *
 * Owns the binary name, the set of subcommands that must pass through
 * untouched, turning the wizard's answers into a flag list, and actually
 * executing (or dry-running) the command.
 */
const { spawnSync } = require('child_process');
const { on } = require('./format');

// The claude binary (overridable for testing or alternate installs).
const CLAUDE_BIN = process.env.CLAUDEE_CLAUDE_BIN || 'claude';

// Subcommands that must pass through verbatim — never prefixed with
// --dangerously-skip-permissions (e.g. `claudee auth`, `claudee mcp list`).
const SUBCOMMANDS = new Set([
  'agents', 'auth', 'doctor', 'gateway', 'install', 'mcp',
  'update', 'config', 'migrate-installer', 'setup-token', 'plugin',
]);

// Turn the wizard's answers `v` into a claude argument list. Pure function —
// also exercised directly by the CLAUDEE_TEST hook in bin/claudee.
function buildArgs(v) {
  const a = [];
  if (on(v.skip)) a.push('--dangerously-skip-permissions');
  if (v.wtKind === 'new') {
    a.push('--worktree');
    if (v.wtName) a.push(v.wtName);
    if (on(v.tmux)) a.push('--tmux');
  }
  if (v.model && v.model !== 'default') a.push('--model', v.model);
  if (v.effort && v.effort !== 'default') a.push('--effort', v.effort);
  const r = v.resume || { kind: 'new' };
  if (r.kind === 'continue') a.push('-c');
  else if (r.kind === 'resume') a.push('--resume', r.id);
  if (v.name) a.push('-n', v.name);
  return a;
}

// Exec `claude` with `args` in `cwd`, inheriting the terminal. In dry-run mode
// (CLAUDEE_DRYRUN) it prints the command instead. Never returns — exits the process.
function runClaudeIn(args, cwd) {
  if (process.env.CLAUDEE_DRYRUN) {
    const tail = cwd && cwd !== process.cwd() ? `  # cwd=${cwd}` : '';
    process.stdout.write([CLAUDE_BIN, ...args].join(' ') + tail + '\n');
    process.exit(0);
  }
  const r = spawnSync(CLAUDE_BIN, args, { stdio: 'inherit', cwd: cwd || process.cwd() });
  process.exit(r.status == null ? 1 : r.status);
}

module.exports = { CLAUDE_BIN, SUBCOMMANDS, buildArgs, runClaudeIn };

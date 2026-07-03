'use strict';
/*
 * git.js — git and session-history helpers.
 *
 * Each function takes an explicit directory (rather than reading a shared
 * "current directory"), so this module holds no state. Used by the wizard for
 * repo context, worktree listing, dirty-status badges, and the resume picker.
 */
const { spawnSync, spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { relTime } = require('./format');

// Whether to compute git status at all (CLAUDEE_NO_STATUS disables it for speed).
const STATUS = !process.env.CLAUDEE_NO_STATUS;

// Run a command and return trimmed stdout, or '' on any failure.
const sh = (cmd, a) => { try { return execFileSync(cmd, a, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } };

// Run git and report success plus stdout/stderr (for mutating ops like rename).
const git = (a) => { const r = spawnSync('git', a, { encoding: 'utf8' }); return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }; };

// Make a string safe to use as a git branch name.
const sanitizeBranch = (s) => (s || '').trim().replace(/\s+/g, '-').replace(/[~^:?*[\]\\]/g, '').replace(/\.\.+/g, '.').replace(/\/+/g, '/').replace(/^[-/]+/, '');

// Count staged / unstaged / untracked files from `git status --porcelain` output.
function parseStatus(text) {
  const lines = (text || '').split('\n').filter(Boolean);
  let staged = 0, unstaged = 0, untracked = 0;
  for (const ln of lines) {
    const x = ln[0], y = ln[1];
    if (x === '?' && y === '?') { untracked++; continue; }
    if (x !== ' ' && x !== '?') staged++;
    if (y !== ' ' && y !== '?') unstaged++;
  }
  return { staged, unstaged, untracked, dirty: lines.length > 0 };
}

// Synchronous status (used by the one-shot preview renderer).
function gitStatus(dir) {
  if (!STATUS) return null;
  const r = spawnSync('git', ['-C', dir || '.', 'status', '--porcelain'], { encoding: 'utf8', timeout: 800 });
  return (r.error || r.status !== 0) ? null : parseStatus(r.stdout);
}

// Non-blocking status; several of these run in parallel after the first paint.
function gitStatusAsync(dir) {
  return new Promise((resolve) => {
    if (!STATUS) return resolve(null);
    let out = '';
    const p = spawn('git', ['-C', dir || '.', 'status', '--porcelain'], { stdio: ['ignore', 'pipe', 'ignore'] });
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve(code === 0 ? parseStatus(out) : null));
    p.on('error', () => resolve(null));
  });
}

// Linked worktrees of the repo containing `cwd`, excluding `cwd` itself.
// Returns [{ name, path, st:null }] — `st` is filled in later, async.
function listWorktrees(cwd) {
  const out = sh('git', ['worktree', 'list', '--porcelain']);
  if (!out) return [];
  const list = []; let cur = null;
  out.split('\n').forEach((line) => {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9) }; list.push(cur); }
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace('refs/heads/', '');
    else if (cur && line.startsWith('detached')) cur.branch = '(detached)';
    else if (cur && line.startsWith('bare')) cur.bare = true;
  });
  return list
    .filter((w) => !w.bare && path.resolve(w.path) !== path.resolve(cwd))
    .map((w) => ({ name: w.branch || path.basename(w.path), path: w.path, st: null }));
}

// Recent Claude sessions recorded for `dir` (newest first, max 6), each with an
// AI-generated title (falling back to the first user message) and an "ago" label.
function sessionsFor(dir) {
  try {
    const slug = dir.replace(/[^a-zA-Z0-9]/g, '-');
    const pdir = path.join(os.homedir(), '.claude', 'projects', slug);
    return fs.readdirSync(pdir).filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f, m: fs.statSync(path.join(pdir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m).slice(0, 6)
      .map(({ f, m }) => {
        const id = f.replace(/\.jsonl$/, '');
        let title = '';
        try {
          const lines = fs.readFileSync(path.join(pdir, f), 'utf8').split('\n').filter(Boolean);
          // Prefer the most recent AI-generated title.
          for (let i = lines.length - 1; i >= 0 && !title; i--) {
            if (lines[i].includes('"ai-title"')) { try { title = JSON.parse(lines[i]).aiTitle || ''; } catch {} }
          }
          // Otherwise fall back to the first real user message.
          for (let i = 0; i < lines.length && !title; i++) {
            if (lines[i].includes('"type":"user"')) {
              try {
                const o = JSON.parse(lines[i]);
                if (o.isMeta) continue;
                let c = o.message && o.message.content;
                if (Array.isArray(c)) { const t = c.find((x) => x.type === 'text'); c = t && t.text; }
                if (typeof c === 'string') title = c.replace(/\s+/g, ' ').trim();
              } catch {}
            }
          }
        } catch {}
        return { id, title: title || id.slice(0, 8), ago: relTime(m) };
      });
  } catch { return []; }
}

module.exports = { STATUS, sh, git, sanitizeBranch, parseStatus, gitStatus, gitStatusAsync, listWorktrees, sessionsFor };

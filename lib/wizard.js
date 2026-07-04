'use strict';
/*
 * wizard.js — the interactive TUI.
 *
 * Holds all mutable session state (chosen worktree, form field values, cursor
 * positions), renders the screens (worktree → name/rename → options), handles
 * key input, and finally launches claude.
 *
 * This is deliberately one module: the render code and the input code share a
 * lot of mutable state, so splitting them further would add coupling, not
 * remove it. The pure/stateless pieces live in format.js, git.js and claude.js.
 *
 * Sections below: persistence · context · state · screens · rendering ·
 * navigation/input · run() (the entry called by bin/claudee).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  on, clamp, stripAnsi, trunc, truncL, yn, wrap,
  bold, dim, cyan, gray, green, yellow, badge,
} = require('./format');
const {
  STATUS, sh, git, sanitizeBranch, gitStatus, gitStatusAsync, listWorktrees, sessionsFor,
} = require('./git');
const { CLAUDE_BIN, buildArgs, runClaudeIn } = require('./claude');

// ---------- persistence (remembers last model / effort / skip) ----------
const CFG_DIR = path.join(os.homedir(), '.config', 'claudee');
const CFG_FILE = path.join(CFG_DIR, 'state.json');
const loadState = () => { try { return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch { return {}; } };
const saveState = (s) => { try { fs.mkdirSync(CFG_DIR, { recursive: true }); fs.writeFileSync(CFG_FILE, JSON.stringify(s, null, 2)); } catch {} };

// ---------- context (computed once for this invocation) ----------
const CWD = process.cwd();
const folder = path.basename(CWD);
const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
const inRepo = !!branch;
const isITerm = process.env.TERM_PROGRAM === 'iTerm.app';
const saved = loadState();
let headStatus = null; // current-repo status; filled asynchronously after first paint

// ---------- state ----------
const state = {
  wtKind: 'current', wtPath: '', wtName: '', wtBranch: '', wtRename: '', wtRenameError: '', wtMoveNote: '', tmux: 'no',
  skip: on(saved.skip) ? 'yes' : (saved.skip ? 'no' : 'yes'),
  model: saved.model || 'default',
  effort: saved.effort || 'default',
  name: '', cursor: 'no', fork: 'no', wtDeleteError: '',
  resumeOptions: [{ kind: 'new', label: 'New session' }],
  resumeSel: 0,
};
// Worktree pick-list: current dir, "new", then each existing linked worktree.
const wtOptions = [
  { kind: 'current', label: 'Current directory', sub: inRepo ? 'run here — no worktree' : CWD },
  ...(inRepo ? [{ kind: 'new', label: 'New worktree…', sub: 'new worktree + branch' }] : []),
  ...listWorktrees(CWD).map((w) => ({ kind: 'existing', label: w.name, sub: w.path, path: w.path, branch: w.name, st: w.st })),
];
let wtSel = 0, formSel = 0;
let confirming = null; // wtOptions index being confirmed for delete, else null
let confirmSel = 0;    // highlighted button: 0 = No, 1 = Yes
let confirmStep = 1;   // 1 = first confirm · 2 = extra force confirm (dirty worktrees)

// Resume list depends on the launch directory; recompute only when it changes.
let resumeCacheDir = '__none__';
function ensureResume() {
  const dir = state.wtKind === 'new' ? null : (state.wtKind === 'existing' ? state.wtPath : CWD);
  if (resumeCacheDir === dir) return;
  resumeCacheDir = dir;
  const ss = dir ? sessionsFor(dir) : [];
  state.resumeOptions = [{ kind: 'new', label: 'New session' }]
    .concat(ss.length ? [{ kind: 'continue', label: 'Continue last' }] : [])
    .concat(ss.map((s) => ({ kind: 'resume', id: s.id, label: s.title, ago: s.ago })));
  state.resumeSel = clamp(state.resumeSel, 0, state.resumeOptions.length - 1);
}
const curResume = () => state.resumeOptions[state.resumeSel] || { kind: 'new' };
const snapshot = () => Object.assign({}, state, { resume: curResume() });
const launchDir = () => (state.wtKind === 'existing' ? state.wtPath : CWD);

// ---------- screens ----------
const SCREENS = [
  { id: 'worktree', type: 'radio', showIf: () => inRepo },
  { id: 'wtname', type: 'text', showIf: () => inRepo && state.wtKind === 'new' },
  { id: 'wtrename', type: 'text', showIf: () => inRepo && state.wtKind === 'existing' },
  { id: 'options', type: 'form' },
];
const active = () => SCREENS.filter((s) => !s.showIf || s.showIf());
let curId = active()[0].id;
const jIdx = () => active().findIndex((s) => s.id === curId);

// Fields on the grouped "options" screen (tmux only appears for a new worktree in iTerm2).
function formFields() {
  const f = [
    { key: 'skip', label: 'Skip permissions', type: 'choice', options: ['yes', 'no'], disp: yn },
    { key: 'model', label: 'Model', type: 'choice', options: ['default', 'opus', 'sonnet', 'haiku', 'fable'] },
    { key: 'effort', label: 'Effort', type: 'choice', options: ['default', 'low', 'medium', 'high', 'xhigh', 'max'] },
    { key: 'resume', label: 'Resume', type: 'resume' },
  ];
  // "Fork session" only applies when resuming — start a fresh session id from the picked one.
  const rk = curResume().kind;
  if (rk === 'continue' || rk === 'resume') f.push({ key: 'fork', label: 'Fork session', type: 'choice', options: ['no', 'yes'], disp: yn });
  if (state.wtKind === 'new' && isITerm) f.push({ key: 'tmux', label: 'Open in tmux', type: 'choice', options: ['no', 'yes'], disp: yn });
  f.push({ key: 'cursor', label: 'Open in Cursor', type: 'choice', options: ['no', 'yes'], disp: yn });
  f.push({ key: 'name', label: 'Session name', type: 'text', placeholder: '(none)' });
  return f;
}

// ---------- rendering ----------
const MARGIN = '  ';
// Panel width tracks the terminal, leaving a 1-col gutter so no line ever wraps.
const computeInner = () => Math.max(44, (Number(process.env.CLAUDEE_COLS) || process.stdout.columns || 80) - 5);
let INNER = computeInner();
const out = (s) => process.stdout.write(s);
let lastLines = 0; // physical rows printed last frame, for the cursor-up redraw

function headerBox() {
  const leftPlain = ' ◆ claudee';
  const leftColored = ' ◆ ' + bold(cyan('claudee'));
  let ctxPlain, ctxColored;
  if (inRepo) {
    const b = badge(headStatus);
    ctxPlain = `${folder} · ${branch}` + (b.plain ? '  ' + b.plain : '');
    ctxColored = dim(`${folder} · ${branch}`) + (b.plain ? '  ' + b.colored : '');
  } else { ctxPlain = folder; ctxColored = dim(folder); }
  let space = INNER - leftPlain.length - ctxPlain.length - 1;
  if (space < 1) {
    const plain = truncL(`${folder} · ${branch}`, INNER - leftPlain.length - 2);
    ctxPlain = plain; ctxColored = dim(plain);
    space = INNER - leftPlain.length - ctxPlain.length - 1;
  }
  const mid = leftColored + ' '.repeat(Math.max(1, space)) + ctxColored + ' ';
  return [
    MARGIN + gray('╭' + '─'.repeat(INNER) + '╮'),
    MARGIN + gray('│') + mid + gray('│'),
    MARGIN + gray('╰' + '─'.repeat(INNER) + '╯'),
  ];
}
function progress(n, j) {
  let dots = '';
  for (let k = 0; k < n; k++) dots += (k === j ? cyan('●') : k < j ? gray('●') : gray('○')) + ' ';
  return MARGIN + dim(`Step ${j + 1} of ${n}`) + '   ' + dots.trimEnd();
}
function inputBox(value, placeholder) {
  const inner = value ? value + cyan('▌') : dim(placeholder) + cyan('▌');
  const used = value ? value.length : placeholder.length;
  return [
    MARGIN + gray('╭' + '─'.repeat(INNER) + '╮'),
    MARGIN + gray('│ ') + inner + ' '.repeat(Math.max(1, INNER - used - 2)) + gray('│'),
    MARGIN + gray('╰' + '─'.repeat(INNER) + '╯'),
  ];
}
// Render one field's value (with ‹ › brackets when it is the selected field).
function fieldValue(f, sel) {
  if (f.type === 'resume') {
    const r = curResume();
    const label = trunc(r.label, r.ago ? Math.max(16, INNER - 30) : Math.max(20, INNER - 22));
    const ago = r.ago ? dim('  ' + r.ago) : '';
    return sel ? cyan('‹ ') + bold(label) + ago + cyan(' ›') : label + ago;
  }
  if (f.type === 'text') { const v = state[f.key]; return v ? v : dim(f.placeholder); }
  const raw = f.disp ? f.disp(state[f.key]) : state[f.key];
  return sel ? cyan('‹ ') + bold(raw) + cyan(' ›') : raw;
}
// Horizontal button row (e.g. No / Yes) with the chosen option bracketed.
function choiceLine(options, sel) {
  return MARGIN + '  ' + options.map((o, i) => (i === sel ? cyan('‹ ') + bold(o) + cyan(' ›') : dim(o))).join('   ');
}

// Build the whole frame into an array of lines, then blit it by moving the
// cursor up over the previous frame and clearing. `lastLines` counts *physical*
// rows (accounting for any wrapping) so the redraw never drifts.
function render() {
  INNER = computeInner();
  const a = active();
  let j = jIdx(); if (j < 0) { j = 0; curId = a[0].id; }
  const scr = a[j];
  const L = [''];
  headerBox().forEach((x) => L.push(x));
  L.push('');
  L.push(progress(a.length, j));
  L.push('');

  if (scr.type === 'radio' && confirming !== null) {
    // Screen 1 (delete confirm) — deliberate Yes/No, with a second step for dirty worktrees.
    const o = wtOptions[confirming];
    if (confirmStep === 2) {
      L.push(MARGIN + yellow('⚠ This worktree has uncommitted changes.'));
      L.push('');
      wrap('Deleting it force-removes the folder and permanently loses that work.', INNER - 2).forEach((ln) => L.push(MARGIN + dim(ln)));
      L.push('');
      L.push(choiceLine(['No', 'Yes, force delete'], confirmSel));
    } else {
      L.push(MARGIN + bold('Delete this worktree?'));
      L.push('');
      L.push(MARGIN + '  ' + bold(o.branch || o.label));
      L.push(MARGIN + dim('  ' + truncL(o.path, INNER - 6)));
      L.push('');
      wrap('Removes the worktree folder and deletes its branch. This cannot be undone.', INNER - 2).forEach((ln) => L.push(MARGIN + dim(ln)));
      L.push('');
      L.push(choiceLine(['No', 'Yes'], confirmSel));
    }
    if (state.wtDeleteError) L.push(MARGIN + '⚠ ' + trunc(state.wtDeleteError, INNER - 6));
  } else if (scr.type === 'radio') {
    // Screen 1 — where to run: current dir / new worktree / existing worktrees.
    L.push(MARGIN + bold('Where should this session run?'));
    L.push(MARGIN + dim('Pick the working tree. Existing worktrees launch in place.'));
    L.push('');
    const labelW = clamp(Math.max(...wtOptions.map((o) => o.label.length)), 14, INNER - 24);
    const subW = Math.max(10, INNER - labelW - 6);
    wtOptions.forEach((o, k) => {
      const sel = k === wtSel;
      const ptr = sel ? cyan('‣') : ' ';
      const mark = sel ? cyan('◉') : gray('○');
      const lab = trunc(o.label, labelW).padEnd(labelW);
      let sub;
      if (o.kind === 'existing') {
        const b = badge(o.st);
        const bw = b.plain ? b.plain.length + 2 : 0;
        sub = (b.plain ? b.colored + '  ' : '') + dim(truncL(o.sub, Math.max(6, subW - bw)));
      } else {
        sub = dim(trunc(o.sub, subW));
      }
      L.push(MARGIN + `${ptr} ${mark} ${sel ? bold(lab) : lab}  ${sub}`);
    });
  } else if (scr.id === 'wtname') {
    // Screen 2a — name a brand-new worktree.
    L.push(MARGIN + bold('Worktree name'));
    wrap('Name for the new worktree and its branch. Leave blank to let Claude choose one.', INNER - 2).forEach((ln) => L.push(MARGIN + dim(ln)));
    L.push('');
    inputBox(state.wtName, 'auto — Claude picks a name').forEach((x) => L.push(x));
  } else if (scr.id === 'wtrename') {
    // Screen 2b — optionally rename an existing worktree before launching.
    L.push(MARGIN + bold('Rename worktree') + dim('   — optional'));
    wrap('Give this worktree a memorable name, or leave it as-is to launch.', INNER - 2).forEach((ln) => L.push(MARGIN + dim(ln)));
    L.push('');
    inputBox(state.wtRename, state.wtBranch).forEach((x) => L.push(x));
    L.push('');
    L.push(MARGIN + dim('Current  ') + state.wtBranch);
    const target = sanitizeBranch(state.wtRename);
    if (target && target !== state.wtBranch) L.push(MARGIN + green('→ ') + dim('rename branch to ') + target + dim('  + move folder'));
    if (state.wtRenameError) L.push(MARGIN + '⚠ ' + trunc(state.wtRenameError, INNER - 6));
  } else {
    // Screen 3 — grouped options + live command preview.
    L.push(MARGIN + bold('Options') + dim('   — tweak with ←→, or Enter to launch'));
    L.push('');
    let wsum;
    if (state.wtKind === 'new') wsum = 'New worktree — ' + (state.wtName || 'auto');
    else if (state.wtKind === 'existing') {
      const vw = INNER - 10;
      const nm = trunc(state.wtBranch || path.basename(state.wtPath), Math.min(30, vw));
      const rest = vw - nm.length - 2;
      wsum = nm + (rest >= 8 ? '  ' + dim(truncL(state.wtPath, rest)) : '');
    } else wsum = 'Current directory';
    L.push(MARGIN + dim('Worktree  ') + wsum);
    if (state.wtKind === 'existing' && state.wtMoveNote) L.push(MARGIN + dim('          ' + trunc(state.wtMoveNote, INNER - 12)));
    L.push('');
    const fields = formFields();
    fields.forEach((f, i) => {
      const sel = i === formSel;
      const ptr = sel ? cyan('‣') : ' ';
      const pad = ' '.repeat(Math.max(1, 18 - f.label.length));
      L.push(MARGIN + `${ptr} ${sel ? bold(f.label) : f.label}${pad}${fieldValue(f, sel)}`);
    });
    L.push('');
    const cmd = [CLAUDE_BIN, ...buildArgs(snapshot())].join(' ');
    wrap(cmd, INNER - 2).forEach((ln, i) => L.push(MARGIN + (i === 0 ? green('→ ') : '  ') + dim(ln)));
    if (state.wtKind === 'existing') L.push(MARGIN + dim('  in ' + truncL(state.wtPath, INNER - 6)));
    if (on(state.cursor)) L.push(MARGIN + dim('  + open the directory in Cursor'));
  }

  L.push('');
  const back = j === 0 ? 'Esc quit' : 'Esc back';
  if (scr.type === 'radio' && confirming !== null) L.push(MARGIN + dim('←→ choose · Enter confirm · Esc cancel'));
  else if (scr.type === 'radio') {
    const del = wtOptions[wtSel] && wtOptions[wtSel].kind === 'existing' ? ' · d delete' : '';
    L.push(MARGIN + dim(`↑↓ move · Enter next · Tab launch now${del} · ${back}`));
  } else if (scr.id === 'wtrename') L.push(MARGIN + dim(`type to rename · Enter apply · Tab launch as-is · ${back}`));
  else if (scr.type === 'text') L.push(MARGIN + dim(`type to edit · Enter next · Tab launch now · ${back}`));
  else L.push(MARGIN + dim(`↑↓ field · ←→ change · Enter ${bold('launch')} · ${back}`));
  L.push('');

  const cols = Number(process.env.CLAUDEE_COLS) || process.stdout.columns || (INNER + 4);
  if (lastLines) { out(`\x1b[${lastLines}A`); out('\x1b[0J'); }
  out(L.join('\n') + '\n');
  lastLines = L.reduce((n, ln) => n + Math.max(1, Math.ceil(stripAnsi(ln).length / cols)), 0);
}

// ---------- navigation / input ----------
let alive = true; // false once we hand off to claude, so async repaints are dropped
function cleanup() { alive = false; out('\x1b[?25h'); try { process.stdin.setRawMode(false); } catch {} process.stdin.pause(); }

// Fetch git-status for the repo + each worktree in parallel, then repaint.
async function loadStatuses() {
  if (!STATUS || !inRepo) return;
  const existing = wtOptions.filter((o) => o.kind === 'existing');
  const [head, ...rest] = await Promise.all([gitStatusAsync(CWD), ...existing.map((o) => gitStatusAsync(o.path))]);
  headStatus = head;
  existing.forEach((o, i) => { o.st = rest[i]; });
  if (alive) render();
}

function quit() { cleanup(); out(dim('  canceled') + '\n'); process.exit(130); }

// Commit the highlighted worktree choice into state (called when leaving screen 1).
function commitWorktree() {
  const o = wtOptions[wtSel];
  state.wtKind = o.kind; state.wtPath = o.path || ''; state.wtBranch = o.branch || '';
  state.wtRename = state.wtBranch; state.wtRenameError = ''; state.wtMoveNote = '';
  if (o.kind !== 'new') state.wtName = '';
  resumeCacheDir = '__none__'; state.resumeSel = 0;
}
function advanceToOptions() { curId = 'options'; ensureResume(); formSel = 0; render(); }

// Rename an existing worktree's branch (and move its folder to match), then advance.
function doRename() {
  state.wtRenameError = ''; state.wtMoveNote = '';
  const target = sanitizeBranch(state.wtRename);
  if (!target || target === state.wtBranch) return advanceToOptions();
  const r = git(['-C', state.wtPath, 'branch', '-m', target]);
  if (!r.ok) { state.wtRenameError = (r.err || 'rename failed').split('\n').pop(); return render(); }
  state.wtBranch = target;
  const leaf = target.split('/').pop().replace(/[^A-Za-z0-9._-]/g, '-');
  const newPath = path.join(path.dirname(state.wtPath), leaf);
  if (path.resolve(newPath) !== path.resolve(state.wtPath)) {
    const m = git(['worktree', 'move', state.wtPath, newPath]);
    if (m.ok) state.wtPath = newPath;
    else state.wtMoveNote = 'branch renamed; folder unchanged';
  }
  const o = wtOptions[wtSel];
  if (o && o.kind === 'existing') { o.label = target; o.branch = target; o.sub = state.wtPath; o.path = state.wtPath; }
  resumeCacheDir = '__none__';
  advanceToOptions();
}

function cancelConfirm() { confirming = null; confirmSel = 0; confirmStep = 1; state.wtDeleteError = ''; }

// Remove the highlighted existing worktree (force if dirty) and delete its branch.
function doDelete() {
  const o = wtOptions[confirming];
  state.wtDeleteError = '';
  const force = o.st && o.st.dirty ? ['--force'] : [];
  const r = git(['worktree', 'remove', ...force, o.path]);
  if (!r.ok) { state.wtDeleteError = (r.err || 'remove failed').split('\n').pop(); return render(); }
  if (o.branch && o.branch !== '(detached)') git(['branch', '-D', o.branch]); // best-effort
  wtOptions.splice(confirming, 1);
  confirming = null; confirmSel = 0; confirmStep = 1;
  wtSel = clamp(wtSel, 0, wtOptions.length - 1);
  render();
}

// Open `dir` in the Cursor editor. Detached and best-effort: if the `cursor`
// CLI isn't on PATH the error is swallowed so the launch still proceeds.
function openInCursor(dir) {
  try {
    const c = spawn('cursor', [dir], { stdio: 'ignore', detached: true });
    c.on('error', () => {});
    c.unref();
  } catch {}
}

// Persist prefs, print the final command, and hand off to claude (never returns).
function launch() {
  saveState({ skip: state.skip, model: state.model, effort: state.effort });
  cleanup();
  const args = buildArgs(snapshot());
  const dir = launchDir();
  out('\n' + MARGIN + green('→ ') + dim([CLAUDE_BIN, ...args].join(' ')) + '\n');
  if (dir !== CWD) out(MARGIN + dim('  in ' + dir) + '\n');
  out('\n');
  if (on(state.cursor) && !process.env.CLAUDEE_DRYRUN) openInCursor(dir);
  runClaudeIn(args, dir);
}

function next() {
  const scr = active()[jIdx()];
  if (scr.id === 'worktree') commitWorktree();
  if (scr.id === 'wtrename') return doRename();
  if (scr.id === 'options') return launch();
  const a = active(); const j = a.findIndex((s) => s.id === curId);
  curId = a[Math.min(j + 1, a.length - 1)].id;
  if (curId === 'options') { ensureResume(); formSel = 0; }
  render();
}
function back() {
  const a = active(); const j = a.findIndex((s) => s.id === curId);
  if (j <= 0) return quit();
  curId = a[j - 1].id; render();
}
// Tab — launch immediately with current selections + defaults for the rest.
function quickLaunch() {
  const scr = active()[jIdx()];
  if (scr.id === 'worktree') commitWorktree();
  ensureResume();
  launch();
}
// ←/→ on the options screen: change a choice field or step through resume options.
function changeField(f, dir) {
  if (f.type === 'choice') {
    let i = f.options.indexOf(state[f.key]); if (i < 0) i = 0;
    state[f.key] = f.options[clamp(i + dir, 0, f.options.length - 1)];
  } else if (f.type === 'resume') {
    state.resumeSel = clamp(state.resumeSel + dir, 0, state.resumeOptions.length - 1);
  } else return;
  render();
}

// Raw-mode key handler. Global keys first, then per-screen behavior.
function onData(buf) {
  const s = buf.toString('utf8');
  const scr = active()[jIdx()];

  // Delete-confirm sub-mode (worktree screen): ←→ choose No/Yes, Enter confirms.
  if (confirming !== null) {
    if (s === '\x03') return quit();
    if (s === '\x1b') { cancelConfirm(); return render(); }
    if (s === '\x1b[D' || s === '\x1b[A') { confirmSel = 0; return render(); }
    if (s === '\x1b[C' || s === '\x1b[B') { confirmSel = 1; return render(); }
    if (s === '\r' || s === '\n') {
      if (confirmSel !== 1) { cancelConfirm(); return render(); } // No → cancel
      const o = wtOptions[confirming];
      if (confirmStep === 1 && o.st && o.st.dirty) { confirmStep = 2; confirmSel = 0; return render(); } // extra force confirm
      return doDelete();
    }
    return;
  }

  if (s === '\x03') return quit();       // Ctrl-C
  if (s === '\x1b') return back();       // Esc
  if (s === '\t') return quickLaunch();  // Tab
  if (s === '\r' || s === '\n') return next(); // Enter

  if (scr.type === 'radio') {
    if (s === 'd' || s === 'D') { // request delete of the highlighted existing worktree
      if (wtOptions[wtSel] && wtOptions[wtSel].kind === 'existing') { confirming = wtSel; confirmSel = 0; confirmStep = 1; state.wtDeleteError = ''; return render(); }
      return;
    }
    if (s === '\x1b[A' || s === '\x1b[D') { wtSel = clamp(wtSel - 1, 0, wtOptions.length - 1); return render(); }
    if (s === '\x1b[B' || s === '\x1b[C') { wtSel = clamp(wtSel + 1, 0, wtOptions.length - 1); return render(); }
    return;
  }
  if (scr.type === 'text') {
    const key = scr.id === 'wtrename' ? 'wtRename' : 'wtName';
    if (s === '\x7f' || s === '\b') { state[key] = (state[key] || '').slice(0, -1); return render(); }
    if (/^[\x20-\x7e]+$/.test(s)) { state[key] = (state[key] || '') + s; return render(); }
    return;
  }
  // options form
  const fields = formFields();
  const f = fields[formSel];
  if (s === '\x1b[A') { formSel = clamp(formSel - 1, 0, fields.length - 1); return render(); }
  if (s === '\x1b[B') { formSel = clamp(formSel + 1, 0, fields.length - 1); return render(); }
  if (s === '\x1b[D') return changeField(f, -1);
  if (s === '\x1b[C') return changeField(f, +1);
  if (f.type === 'text') {
    if (s === '\x7f' || s === '\b') { state[f.key] = (state[f.key] || '').slice(0, -1); return render(); }
    if (/^[\x20-\x7e]+$/.test(s)) { state[f.key] = (state[f.key] || '') + s; return render(); }
  }
}

// ---------- entry point ----------
// Boots the interactive wizard, or renders a single frame for CLAUDEE_PREVIEW.
function run() {
  // One-shot frame preview (docs/testing): CLAUDEE_PREVIEW="<screenId>[,new|existing]"
  if (process.env.CLAUDEE_PREVIEW) {
    const [id, mode] = process.env.CLAUDEE_PREVIEW.split(',');
    if (mode === 'new') { state.wtKind = 'new'; state.wtName = 'feature-api'; }
    if (mode === 'existing') { const e = wtOptions.find((o) => o.kind === 'existing'); if (e) { state.wtKind = 'existing'; state.wtPath = e.path; state.wtBranch = e.branch; state.wtRename = e.branch; } }
    if (process.env.CLAUDEE_RENAME) state.wtRename = process.env.CLAUDEE_RENAME;
    if (id === 'options') ensureResume();
    if (process.env.CLAUDEE_RSEL) state.resumeSel = clamp(+process.env.CLAUDEE_RSEL, 0, state.resumeOptions.length - 1);
    if (STATUS && inRepo) { headStatus = gitStatus(CWD); wtOptions.forEach((o) => { if (o.kind === 'existing') o.st = gitStatus(o.path); }); }
    if (mode === 'del' || mode === 'delforce') { const i = wtOptions.findIndex((o) => o.kind === 'existing'); if (i >= 0) { wtSel = i; confirming = i; if (mode === 'delforce') confirmStep = 2; } }
    if (id) curId = id;
    render();
    process.exit(0);
  }

  out('\x1b[?25l'); // hide cursor
  if (curId === 'options') ensureResume();
  render();
  loadStatuses(); // non-blocking: badges appear a moment after the first paint
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', onData);
  process.stdout.on('resize', render);
}

module.exports = { run };

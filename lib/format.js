'use strict';
/*
 * format.js — pure presentation helpers.
 *
 * Text utilities, ANSI colors, and the git-status badge. Everything here is
 * side-effect free and stateless, so it is safe to require from anywhere.
 */

// Truthiness for the "yes"/"on"/true tri-state values used across the wizard.
const on = (x) => x === 'yes' || x === 'on' || x === true;

// Clamp `v` into the inclusive range [a, b].
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Strip ANSI SGR color codes so a string's *visible* width can be measured.
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

// Truncate to `n` visible chars with an ellipsis — at the end / at the start.
const trunc = (s, n) => { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const truncL = (s, n) => { s = String(s); return s.length > n ? '…' + s.slice(-(n - 1)) : s; };

// "Yes"/"No" for a boolean-ish value.
const yn = (v) => (on(v) ? 'Yes' : 'No');

// Human relative time from an epoch-ms timestamp ("3h ago").
function relTime(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 604800) return Math.floor(s / 86400) + 'd ago';
  return Math.floor(s / 604800) + 'w ago';
}

// Word-wrap `t` into lines no wider than `w` visible chars.
function wrap(t, w) {
  const words = t.split(/\s+/); const lines = []; let cur = '';
  for (const word of words) {
    if ((cur + ' ' + word).trim().length > w) { if (cur) lines.push(cur); cur = word; }
    else cur = (cur ? cur + ' ' : '') + word;
  }
  if (cur) lines.push(cur);
  return lines;
}

// ---------- colors (honor NO_COLOR) ----------
const NC = !!process.env.NO_COLOR;
const paint = (code) => (s) => (NC ? s : `\x1b[${code}m${s}\x1b[0m`);
const bold = paint('1'), dim = paint('2'), cyan = paint('36'), gray = paint('90'), green = paint('32'), yellow = paint('33');

// Clean/dirty git badge → { plain, colored } with matching visible widths.
//   clean → "✓"   ·   staged → "+N" (green)   ·   unstaged+untracked → "~N" (yellow)
// `plain` is used to measure width; `colored` is what actually prints.
function badge(st) {
  if (!st) return { plain: '', colored: '' };
  if (!st.dirty) return { plain: '✓', colored: green('✓') };
  const p = [], c = [];
  if (st.staged) { p.push('+' + st.staged); c.push(green('+' + st.staged)); }
  const u = st.unstaged + st.untracked;
  if (u) { p.push('~' + u); c.push(yellow('~' + u)); }
  return { plain: p.join(' '), colored: c.join(' ') };
}

module.exports = {
  on, clamp, stripAnsi, trunc, truncL, yn, relTime, wrap,
  NC, paint, bold, dim, cyan, gray, green, yellow, badge,
};

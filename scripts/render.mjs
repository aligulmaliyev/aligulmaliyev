#!/usr/bin/env node
// Renders the profile cards in assets/ from profile.config.json + the GitHub GraphQL API.
//
//   node scripts/render.mjs                live data (needs GH_TOKEN and GH_LOGIN)
//   node scripts/render.mjs --demo         sample data, for tweaking the design locally
//   node scripts/render.mjs --placeholder  "waiting for first run" cards
//
// No dependencies: Node 18+ (global fetch) is enough.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets');
const argv = process.argv.slice(2);
const MODE = argv.includes('--demo') ? 'demo' : argv.includes('--placeholder') ? 'placeholder' : 'live';

const W = 880;
const FONT = `ui-monospace,'SF Mono',SFMono-Regular,'JetBrains Mono','Cascadia Code',Menlo,Consolas,'Liberation Mono',monospace`;
const ADV = 0.62; // generous monospace advance (em) — layout must survive any fallback font

// ── palette ──────────────────────────────────────────────────────────────────
const THEMES = {
  dark: {
    panel: '#1c1b18', chrome: '#24231f', tile: '#22211d', border: '#36342e',
    text: '#ece8df', muted: '#a19c90', faint: '#69655b',
    accent: '#d97757', sand: '#dcae78', sage: '#97b583',
    heat: ['#2a2824', '#5e3626', '#924b30', '#c6623c', '#f08b62'],
    series: ['#d97757', '#dcae78', '#97b583', '#88abd0', '#c49bc0', '#a19c90'],
  },
  light: {
    panel: '#fbfaf6', chrome: '#f1efe7', tile: '#f5f3ec', border: '#e2ddd0',
    text: '#23221e', muted: '#6c685f', faint: '#a8a396',
    accent: '#c25f3a', sand: '#ad7a35', sage: '#5d7f47',
    heat: ['#ece8dd', '#f3cbb6', '#e89e7c', '#d27450', '#a94d2c'],
    series: ['#c25f3a', '#c08e45', '#6b8f54', '#5885b3', '#9d6d99', '#8c877b'],
  },
};

// ── helpers ──────────────────────────────────────────────────────────────────
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const cut = (s, n) => (s && s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s || '');
const r1 = (n) => Math.round(n * 10) / 10;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const asDate = (iso) => new Date(iso.slice(0, 10) + 'T00:00:00Z');
const shortDate = (iso) => { const d = asDate(iso); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`; };
const longDate = (iso) => { const d = asDate(iso); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`; };
const dayKey = (d) => d.toISOString().slice(0, 10);

function range(a, b) {
  if (!a) return '';
  const ya = a.slice(0, 4), yb = b.slice(0, 4), thisYear = String(new Date().getUTCFullYear());
  const fa = ya === yb && ya === thisYear ? shortDate(a) : longDate(a);
  const fb = ya === yb ? shortDate(b) : longDate(b);
  return a === b ? fa : `${fa} – ${fb}`;
}

function ago(iso) {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 864e5);
  if (days < 1) return 'today';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

const baseCss = (t) => `
text{font-family:${FONT};fill:${t.text}}
.mu{fill:${t.muted}}.fa{fill:${t.faint}}.ac{fill:${t.accent}}.sa{fill:${t.sand}}.sg{fill:${t.sage}}.b{font-weight:700}
.fi{animation:fi .55s ease-out both}
.dr{stroke-dasharray:1;animation:dr 1.3s cubic-bezier(.3,.7,.2,1) both}
@keyframes fi{from{opacity:0}}
@keyframes dr{from{stroke-dashoffset:1}}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}`;

const delay = (s) => `style="animation-delay:${Math.round(s * 100) / 100}s"`;

function frame(t, h, body, label, css = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(label)}">
<title>${esc(label)}</title>
<style>${baseCss(t)}${css}</style>
<rect x=".5" y=".5" width="${W - 1}" height="${h - 1}" rx="14" fill="${t.panel}" stroke="${t.border}"/>
${body}
</svg>
`;
}

function toolHead(x, y, tool, args, d = 0) {
  return `<text x="${x}" y="${y}" font-size="14" class="fi" ${delay(d)}><tspan class="ac">●</tspan> <tspan class="b">${esc(tool)}</tspan><tspan class="mu">(${esc(args)})</tspan></text>`;
}
const rightNote = (text, x = W - 28) => `<text x="${x}" y="40" font-size="12" text-anchor="end" class="mu fi">${esc(text)}</text>`;
const elbow = (x = 34, y = 80) => `<text x="${x}" y="${y}" font-size="13" class="fa fi">⎿</text>`;

function waiting(t, tool, args, label) {
  const body = `${toolHead(28, 40, tool, args)}
${elbow(34, 74)}
<text x="58" y="74" font-size="13" class="mu">waiting for the first run of .github/workflows/profile.yml…</text>`;
  return frame(t, 100, body, label);
}

// ── header: a terminal session ───────────────────────────────────────────────
function header(t, p) {
  const fs = 14.5, cw = fs * ADV, x0 = 32, x1 = x0 + 2 * cw;
  const css = [];
  const out = [];

  out.push(`<path d="M.5 14.5a14 14 0 0 1 14-14h${W - 29}a14 14 0 0 1 14 14v24h-${W - 1}z" fill="${t.chrome}"/>`);
  out.push(`<path d="M.5 38.5h${W - 1}" stroke="${t.border}"/>`);
  [t.accent, t.sand, t.sage].forEach((c, i) => out.push(`<circle cx="${22 + i * 18}" cy="19.5" r="5.5" fill="${c}" opacity=".9"/>`));
  out.push(`<text x="${W / 2}" y="24" font-size="12" text-anchor="middle" class="mu">${esc(p.login)} — ~/products — claude</text>`);

  let y = 74;
  out.push(`<text x="${x0}" y="${y}" font-size="${fs}" class="fi" ${delay(0.15)}><tspan class="sg">~/products</tspan><tspan class="fa"> on main</tspan></text>`);
  y += 26;
  const cmd = p.prompt;
  const chars = [...cmd].length;
  const typed = chars * cw;
  const tDelay = 0.7, tDur = Math.min(2.2, chars * 0.04);
  out.push(`<text x="${x0}" y="${y}" font-size="${fs}" class="ac b fi" ${delay(0.4)}>❯</text>`);
  out.push(`<text x="${x1}" y="${y}" font-size="${fs}">${esc(cmd)}</text>`);
  out.push(`<clipPath id="tc"><rect x="${x1}" y="${y - fs - 3}" width="${typed + cw + 2}" height="${fs + 9}"/></clipPath>`);
  out.push(`<g clip-path="url(#tc)"><g class="ty" transform="translate(${typed} 0)">`
    + `<rect x="${x1}" y="${y - fs - 3}" width="${typed + cw + 6}" height="${fs + 9}" fill="${t.panel}"/>`
    + `<rect class="cu" x="${x1}" y="${y - fs + 1}" width="${cw}" height="${fs + 3}" fill="${t.text}" opacity="0"/></g></g>`);
  css.push(`.ty{animation:ty ${tDur}s steps(${chars}) ${tDelay}s both}@keyframes ty{from{transform:translateX(0)}to{transform:translateX(${typed}px)}}`);
  css.push(`.cu{animation:cu .01s linear ${r1(tDelay + tDur + 0.3)}s both}@keyframes cu{from{opacity:1}to{opacity:0}}`);

  let d = tDelay + tDur + 0.45;
  const step = 0.13;
  y += 36;
  out.push(`<text x="${x0}" y="${y}" font-size="${fs}" class="fi" ${delay(d)}><tspan class="ac">●</tspan></text>`);
  out.push(`<text x="${x1}" y="${y}" font-size="16" class="b fi" ${delay(d)}>${esc(p.name)}</text>`);
  d += step; y += 25;
  out.push(`<text x="${x1}" y="${y}" font-size="${fs}" class="fi" ${delay(d)}>${esc([p.role, p.location].filter(Boolean).join(' · '))}</text>`);
  if (p.tagline) { d += step; y += 24; out.push(`<text x="${x1}" y="${y}" font-size="${fs}" class="mu fi" ${delay(d)}>${esc(p.tagline)}</text>`); }

  y += 12;
  p.facts.forEach((f, i) => {
    d += step; y += 24;
    out.push(`<g class="fi" ${delay(d)}>`
      + (i === 0 ? `<text x="${x1}" y="${y}" font-size="${fs}" class="fa">⎿</text>` : '')
      + `<text x="${x1 + 2.5 * cw}" y="${y}" font-size="${fs}" class="sa">${esc(f.key)}</text>`
      + `<text x="${x1 + 12.5 * cw}" y="${y}" font-size="${fs}">${esc(f.value)}</text></g>`);
  });

  d += 0.35; y += 38;
  out.push(`<g class="fi" ${delay(d)}><text x="${x0}" y="${y}" font-size="${fs}" class="ac b">❯</text>`
    + `<rect class="bl" x="${x1}" y="${y - fs + 1}" width="${cw}" height="${fs + 3}" fill="${t.text}"/></g>`);
  css.push(`.bl{animation:bl 1.1s step-end infinite}@keyframes bl{50%{opacity:0}}`);

  const h = y + 30;
  out.push(`<text x="${W - 24}" y="${h - 18}" font-size="11" text-anchor="end" class="fa">${esc(p.stamp)}</text>`);

  const label = `${p.name} — ${[p.role, p.location].filter(Boolean).join(', ')}. ${p.tagline || ''}`;
  return frame(t, h, out.join('\n'), label, css.join(''));
}

// ── stats tiles (all time) ───────────────────────────────────────────────────
function sparkline(t, series, sx, sy, sw, sh, d) {
  if (series.length < 2) return '';
  const max = Math.max(1, ...series);
  const pts = series.map((v, k) => [sx + (k / (series.length - 1)) * sw, sy + sh - (v / max) * sh]);
  const line = pts.map(([px, py]) => `${r1(px)},${r1(py)}`).join(' ');
  return `<polygon points="${r1(sx)},${sy + sh} ${line} ${r1(sx + sw)},${sy + sh}" fill="${t.accent}" opacity=".13"/>`
    + `<polyline points="${line}" fill="none" stroke="${t.accent}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" pathLength="1" class="dr" ${delay(d)}/>`;
}

function statsCard(t, s) {
  const x0 = 58, y0 = 58, gap = 12, cols = 3;
  const tw = Math.floor((W - x0 - 28 - gap * (cols - 1)) / cols), th = 88;
  const yr = s.thisYear;
  const top = s.topRepo;
  const tiles = [
    { label: 'contributions', value: fmt(s.total), spark: s.monthly },
    { label: 'commits', value: fmt(s.commits), cap: `${fmt(yr.commits)} in ${yr.year}` },
    { label: 'pull requests', value: fmt(s.prs), cap: `${fmt(s.issues)} issues opened` },
    { label: 'code reviews', value: fmt(s.reviews), cap: `${fmt(yr.reviews)} in ${yr.year}` },
    { label: 'public repos', value: fmt(s.repoCount), cap: `${s.langCount} languages` },
    { label: 'stars earned', value: fmt(s.stars), cap: top ? `top: ${cut(top.name, 14)}` : '' },
  ];
  const note = [s.firstDay ? `since ${s.firstDay.slice(0, 4)}` : null, s.restricted ? `incl. ${fmt(s.restricted)} private` : null].filter(Boolean).join(' · ');
  const out = [toolHead(28, 40, 'Bash', 'gh stats --all-time'), elbow(), rightNote(note || 'all time')];
  tiles.forEach((tile, i) => {
    const x = x0 + (i % cols) * (tw + gap), y = y0 + Math.floor(i / cols) * (th + gap);
    const g = [`<rect x="${x + .5}" y="${y + .5}" width="${tw - 1}" height="${th - 1}" rx="10" fill="${t.tile}" stroke="${t.border}"/>`,
      `<text x="${x + 16}" y="${y + 26}" font-size="11" letter-spacing=".08em" class="mu">${esc(tile.label.toUpperCase())}</text>`,
      `<text x="${x + 16}" y="${y + 67}" font-size="28" class="b">${esc(tile.value)}</text>`];
    if (tile.cap) g.push(`<text x="${x + tw - 16}" y="${y + 66}" font-size="11.5" text-anchor="end" class="mu">${esc(tile.cap)}</text>`);
    if (tile.spark) g.push(sparkline(t, tile.spark, x + tw - 16 - 112, y + 34, 112, 34, 0.5));
    out.push(`<g class="fi" ${delay(0.1 + i * 0.08)}>${g.join('')}</g>`);
  });
  const h = y0 + 2 * th + gap + 28;
  return frame(t, h, out.join('\n'), `All-time GitHub stats: ${fmt(s.total)} contributions, ${fmt(s.commits)} commits, ${fmt(s.prs)} pull requests, ${fmt(s.reviews)} code reviews, ${fmt(s.stars)} stars.`);
}

// ── streak (all time) ────────────────────────────────────────────────────────
function streakCard(t, s) {
  const h = 214, cx = [190, 455, 720], css = [];
  const out = [toolHead(28, 40, 'Bash', 'streak --all-time'), elbow(), rightNote(s.firstDay ? `first contribution ${longDate(s.firstDay)}` : 'no contributions yet')];
  out.push(`<path d="M322.5 72v112M587.5 72v112" stroke="${t.border}"/>`);

  const col = (x, value, unit, label, sub, d, accent = false) =>
    `<g class="fi" ${delay(d)}>`
    + `<text x="${x}" y="126" font-size="30" text-anchor="middle" class="b">${esc(value)}${unit ? `<tspan font-size="14" class="mu" dx="3">${unit}</tspan>` : ''}</text>`
    + `<text x="${x}" y="160" font-size="12.5" text-anchor="middle" class="${accent ? 'ac b' : ''}">${esc(label)}</text>`
    + `<text x="${x}" y="181" font-size="11" text-anchor="middle" class="fa">${esc(sub)}</text></g>`;

  const best = s.bestYear;
  out.push(col(cx[0], best ? fmt(best.total) : '0', '', best ? `best year · ${best.year}` : 'best year', best ? `${fmt(best.commits)} commits · ${fmt(best.prs)} PRs` : '—', 0.15));

  // current streak: ring shows progress towards the longest streak
  const r = 30, cy = 104, p = s.longest.len ? Math.max(s.current.len ? 0.04 : 0, Math.min(1, s.current.len / s.longest.len)) : 0;
  out.push(`<circle cx="${cx[1]}" cy="${cy}" r="${r}" fill="none" stroke="${t.border}" stroke-width="5"/>`);
  if (p > 0) {
    out.push(`<circle class="rg" cx="${cx[1]}" cy="${cy}" r="${r}" fill="none" stroke="${t.accent}" stroke-width="5" stroke-linecap="round" pathLength="1" stroke-dasharray="${r1(p * 100) / 100} 1" transform="rotate(-90 ${cx[1]} ${cy})"/>`);
    css.push(`.rg{animation:rg 1.4s cubic-bezier(.3,.7,.2,1) .35s both}@keyframes rg{from{stroke-dashoffset:${r1(p * 100) / 100}}}`);
  }
  out.push(`<g class="fi" ${delay(0.25)}><text x="${cx[1]}" y="${cy + 9}" font-size="26" text-anchor="middle" class="b">${s.current.len}</text>`
    + `<text x="${cx[1]}" y="160" font-size="12.5" text-anchor="middle" class="ac b">current streak</text>`
    + `<text x="${cx[1]}" y="181" font-size="11" text-anchor="middle" class="fa">${esc(s.current.len ? range(s.current.start, s.current.end) : 'no active streak')}</text></g>`);

  out.push(col(cx[2], s.longest.len, s.longest.len === 1 ? 'day' : 'days', 'longest streak', s.longest.len ? range(s.longest.start, s.longest.end) : '—', 0.35));
  return frame(t, h, out.join('\n'), `Streaks: current ${s.current.len} days, longest ${s.longest.len} days.`, css.join(''));
}

// ── contribution heatmap (last 52 weeks) + years ─────────────────────────────
function activityCard(t, s) {
  const gx = 92, gy = 84, cell = 11, step = 14;
  const out = [toolHead(28, 40, 'Fetch', 'contribution-calendar --last 52w'), elbow(), rightNote(`${fmt(s.windowTotal)} in the last year`)];

  const nz = s.window.map((d) => d.count).filter((c) => c > 0).sort((a, b) => a - b);
  const q = (p) => nz.length ? nz[Math.min(nz.length - 1, Math.floor(p * nz.length))] : 0;
  const [q1, q2, q3] = [q(0.25), q(0.5), q(0.75)];
  const level = (c) => (c === 0 ? 0 : c <= q1 ? 1 : c <= q2 ? 2 : c <= q3 ? 3 : 4);

  const offset = asDate(s.window[0].date).getUTCDay();
  const cols = new Map();
  let lastLabelCol = -9;
  s.window.forEach((d, i) => {
    const idx = i + offset, col = Math.floor(idx / 7), row = idx % 7;
    if (!cols.has(col)) cols.set(col, []);
    cols.get(col).push(`<rect x="${gx + col * step}" y="${gy + row * step}" width="${cell}" height="${cell}" rx="2.5" fill="${t.heat[level(d.count)]}"><title>${d.date}: ${d.count}</title></rect>`);
    const dt = asDate(d.date);
    if (dt.getUTCDate() === 1 && col - lastLabelCol >= 3 && col <= 51) {
      out.push(`<text x="${gx + col * step}" y="${gy - 9}" font-size="10.5" class="fa">${MONTHS[dt.getUTCMonth()]}</text>`);
      lastLabelCol = col;
    }
  });
  [[1, 'Mon'], [3, 'Wed'], [5, 'Fri']].forEach(([r, n]) => out.push(`<text x="${gx - 10}" y="${gy + r * step + 9}" font-size="10" text-anchor="end" class="fa">${n}</text>`));
  for (const [col, rects] of cols) out.push(`<g class="fi" ${delay(0.15 + col * 0.016)}>${rects.join('')}</g>`);

  let by = gy + 7 * step + 26;
  const facts = [`active ${s.windowActive} of ${s.window.length} days`];
  if (s.windowTotal) facts.push(`busiest on ${s.busiestDay}s`);
  if (s.windowPeak.count) facts.push(`peak ${s.windowPeak.count} on ${shortDate(s.windowPeak.date)}`);
  out.push(`<text x="${gx}" y="${by}" font-size="11.5" class="mu fi" ${delay(1.1)}>${esc(facts.join(' · '))}</text>`);
  const lx = W - 28 - 5 * 14 - 30;
  out.push(`<g class="fi" ${delay(1.1)}><text x="${lx - 8}" y="${by}" font-size="10.5" text-anchor="end" class="fa">less</text>`
    + t.heat.map((c, i) => `<rect x="${lx + i * 14}" y="${by - 10}" width="${cell}" height="${cell}" rx="2.5" fill="${c}"/>`).join('')
    + `<text x="${lx + 5 * 14 + 4}" y="${by}" font-size="10.5" class="fa">more</text></g>`);

  // year-by-year totals
  const years = s.years.slice(-7);
  if (years.length > 1) {
    by += 34;
    out.push(`<path d="M${gx} ${by - 22}.5H${W - 28}" stroke="${t.border}" stroke-dasharray="2 4"/>`);
    out.push(`<text x="${gx - 10}" y="${by}" font-size="10" text-anchor="end" class="fa">year</text>`);
    const max = Math.max(1, ...years.map((y) => y.total));
    const slot = Math.min(110, (W - 28 - gx) / years.length);
    years.forEach((y, i) => {
      const x = gx + i * slot, bw = Math.max(2, (y.total / max) * (slot - 86));
      out.push(`<g class="fi" ${delay(1.2 + i * 0.06)}><text x="${x}" y="${by}" font-size="10.5" class="mu">${y.year}</text>`
        + `<rect x="${x + 32}" y="${by - 7}" width="${r1(bw)}" height="6" rx="3" fill="${y === s.bestYear ? t.accent : t.heat[2]}"/>`
        + `<text x="${r1(x + 36 + bw)}" y="${by}" font-size="10.5">${fmt(y.total)}</text></g>`);
    });
  }
  return frame(t, by + 26, out.join('\n'), `Contribution calendar for the last 52 weeks: ${fmt(s.windowTotal)} contributions. By year: ${s.years.map((y) => `${y.year} ${y.total}`).join(', ')}.`);
}

// ── when I commit ────────────────────────────────────────────────────────────
function rhythmCard(t, s) {
  const R = s.rhythm;
  const out = [toolHead(28, 40, 'Bash', 'git log --author=me --date=format:%H'), elbow(), rightNote(`${fmt(R.count)} commits · ${R.tz}`)];
  if (R.count < 10) {
    out.push(`<text x="58" y="80" font-size="13" class="mu">not enough commits yet to read a rhythm</text>`);
    return frame(t, 106, out.join('\n'), 'Commit rhythm: not enough commits yet.');
  }
  const bucketColor = [t.series[3], t.series[1], t.series[0], t.series[4]]; // night, morning, daytime, evening
  const bucketOf = (h) => Math.floor(h / 6);
  const hx = 58, hw = 470, base = 176, hh = 92, slot = hw / 24, max = Math.max(1, ...R.hours);
  R.hours.forEach((n, h) => {
    const bh = Math.max(n ? 3 : 1.5, (n / max) * hh);
    out.push(`<rect class="fi" ${delay(0.2 + h * 0.025)} x="${r1(hx + h * slot + 2)}" y="${r1(base - bh)}" width="${r1(slot - 4)}" height="${r1(bh)}" rx="2" fill="${n ? bucketColor[bucketOf(h)] : t.border}"><title>${String(h).padStart(2, '0')}:00 — ${n} commits</title></rect>`);
  });
  [0, 6, 12, 18, 23].forEach((h) => out.push(`<text x="${r1(hx + h * slot + slot / 2)}" y="${base + 18}" font-size="10" text-anchor="middle" class="fa">${String(h).padStart(2, '0')}</text>`));

  const names = ['night', 'morning', 'daytime', 'evening'], spans = ['00–06', '06–12', '12–18', '18–24'];
  const order = [1, 2, 3, 0];
  const rx = 566, bx = 700, bw = 100;
  order.forEach((b, i) => {
    const y = 84 + i * 26, pct = R.buckets[b] / R.count;
    out.push(`<g class="fi" ${delay(0.3 + i * 0.08)}><text x="${rx}" y="${y}" font-size="12.5">${names[b]}</text>`
      + `<text x="${rx + 72}" y="${y}" font-size="10.5" class="fa">${spans[b]}</text>`
      + `<rect x="${bx}" y="${y - 7}" width="${bw}" height="6" rx="3" fill="${t.border}"/>`
      + `<rect x="${bx}" y="${y - 7}" width="${r1(Math.max(pct ? 3 : 0, pct * bw))}" height="6" rx="3" fill="${bucketColor[b]}"/>`
      + `<text x="${W - 28}" y="${y}" font-size="11.5" text-anchor="end" class="mu">${Math.round(pct * 100)}%</text></g>`);
  });
  const owl = R.buckets[3] + R.buckets[0] > R.buckets[1] + R.buckets[2];
  out.push(`<text x="${rx}" y="${84 + 4 * 26 + 6}" font-size="13.5" class="ac b fi" ${delay(0.75)}>→ ${owl ? 'night owl' : 'early bird'}</text>`);
  out.push(`<text x="${rx}" y="${84 + 4 * 26 + 28}" font-size="11.5" class="mu fi" ${delay(0.8)}>peaks at ${String(R.peakHour).padStart(2, '0')}:00 · most on ${R.topWeekday}s</text>`);
  return frame(t, 222, out.join('\n'), `Commit rhythm (${R.tz}): ${owl ? 'night owl' : 'early bird'}, peaks at ${R.peakHour}:00, most commits on ${R.topWeekday}s.`);
}

// ── languages + recent repos ─────────────────────────────────────────────────
function codeCard(t, s) {
  const out = [];
  const L = { x: 28, in: 58, end: 410 }, R = { x: 468, in: 494, end: W - 28 };
  out.push(toolHead(L.x, 40, 'Grep', 'languages --by-bytes'));
  out.push(rightNote(`${s.langRepoCount} ${s.langRepoCount === 1 ? 'repo' : 'repos'}${s.privateLangRepos ? ' · incl. private' : ''}`, L.end));
  out.push(elbow());
  if (!s.languages.length) out.push(`<text x="${L.in}" y="80" font-size="13" class="mu">nothing to grep yet</text>`);
  s.languages.forEach((l, i) => {
    const y = 80 + i * 30, color = t.series[i % t.series.length];
    const len = Math.max(0.012, l.pct / 100) * (L.end - L.in);
    out.push(`<g class="fi" ${delay(0.15 + i * 0.08)}>`
      + `<text x="${L.in}" y="${y}" font-size="13">${esc(l.name)}</text>`
      + `<text x="${L.end}" y="${y}" font-size="12" text-anchor="end" class="mu">${l.pct.toFixed(1)}%</text>`
      + `<line x1="${L.in + 2}" y1="${y + 10}" x2="${L.end - 2}" y2="${y + 10}" stroke="${t.border}" stroke-width="4" stroke-linecap="round"/>`
      + `<line x1="${L.in + 2}" y1="${y + 10}" x2="${r1(L.in + 2 + Math.max(0, len - 4))}" y2="${y + 10}" stroke="${color}" stroke-width="4" stroke-linecap="round" pathLength="1" class="dr" ${delay(0.3 + i * 0.08)}/></g>`);
  });

  const rows = Math.max(s.languages.length * 30 - 16, s.repos.length * 46 - 14, 24);
  const h = 80 + rows + 30;
  out.push(`<path d="M440.5 58V${h - 26}" stroke="${t.border}"/>`);

  out.push(toolHead(R.x, 40, 'Read', 'repos --recent', 0.1));
  out.push(rightNote(`★ ${fmt(s.stars)}`));
  out.push(elbow(R.x + 6));
  if (!s.repos.length) out.push(`<text x="${R.in}" y="80" font-size="13" class="mu">no public repos yet</text>`);
  const langIdx = new Map(s.languages.map((l, i) => [l.name, i]));
  s.repos.forEach((r, i) => {
    const y = 80 + i * 46;
    const dot = langIdx.has(r.lang) ? t.series[langIdx.get(r.lang) % t.series.length] : t.faint;
    const meta = [r.lang, r.stars ? `★ ${r.stars}` : null, ago(r.pushedAt)].filter(Boolean).join(' · ');
    out.push(`<g class="fi" ${delay(0.25 + i * 0.1)}>`
      + `<text x="${R.in}" y="${y}" font-size="13.5" class="b">${esc(cut(r.name, 22))}</text>`
      + `<text x="${R.end}" y="${y}" font-size="11.5" text-anchor="end" class="mu">${r.lang ? `<tspan fill="${dot}">● </tspan>` : ''}${esc(meta)}</text>`
      + `<text x="${R.in}" y="${y + 19}" font-size="12" class="mu">${esc(cut(r.description || 'no description', 46))}</text></g>`);
  });

  return frame(t, h, out.join('\n'), `Top languages: ${s.languages.map((l) => `${l.name} ${l.pct.toFixed(0)}%`).join(', ')}. Recently pushed: ${s.repos.map((r) => r.name).join(', ')}.`);
}

// ── data ─────────────────────────────────────────────────────────────────────
async function gql(token, query, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'profile-cards' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors) throw new Error(`GitHub GraphQL ${res.status}: ${JSON.stringify(json.errors || json.message || json)}`);
  return json.data;
}

const BASE_Q = `query($login:String!){user(login:$login){id login name createdAt contributionsCollection{contributionYears}}}`;

const yearsQuery = (years, nowIso) => `query($login:String!){user(login:$login){${years.map((y) => {
  const to = y === Number(nowIso.slice(0, 4)) ? nowIso : `${y}-12-31T23:59:59Z`;
  return `y${y}:contributionsCollection(from:"${y}-01-01T00:00:00Z",to:"${to}"){...C}`;
}).join(' ')}}}
fragment C on ContributionsCollection{totalCommitContributions totalPullRequestContributions totalPullRequestReviewContributions
  totalIssueContributions restrictedContributionsCount
  contributionCalendar{totalContributions weeks{contributionDays{date contributionCount}}}}`;

const REPO_Q = `query($login:String!,$after:String){user(login:$login){repositories(first:100,after:$after,
  ownerAffiliations:OWNER,isFork:false,orderBy:{field:PUSHED_AT,direction:DESC}){
  pageInfo{hasNextPage endCursor}
  nodes{name description stargazerCount isArchived isPrivate pushedAt primaryLanguage{name}
    languages(first:10,orderBy:{field:SIZE,direction:DESC}){edges{size node{name}}}}}}}`;

// commit timestamps only (no repo names leave this script), private repos included when the token can see them
const HIST_Q = `query($login:String!,$uid:ID!,$after:String){user(login:$login){repositories(first:50,after:$after,
  ownerAffiliations:OWNER,isFork:false,orderBy:{field:PUSHED_AT,direction:DESC}){
  pageInfo{hasNextPage endCursor}
  nodes{defaultBranchRef{target{...on Commit{history(first:100,author:{id:$uid}){nodes{authoredDate}}}}}}}}}`;

async function liveData() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const login = process.env.GH_LOGIN;
  if (!token || !login) throw new Error('GH_TOKEN and GH_LOGIN must be set (or run with --demo / --placeholder)');
  const nowIso = new Date().toISOString();

  const { user } = await gql(token, BASE_Q, { login });
  if (!user) throw new Error(`GitHub user "${login}" not found`);
  const thisYear = Number(nowIso.slice(0, 4));
  const firstYear = Math.max(Number(user.createdAt.slice(0, 4)), Math.min(thisYear - 1, ...user.contributionsCollection.contributionYears));
  const yearList = [];
  for (let y = firstYear; y <= thisYear; y++) yearList.push(y);
  const yd = (await gql(token, yearsQuery(yearList, nowIso), { login })).user;
  const years = yearList.map((y) => {
    const c = yd[`y${y}`];
    return {
      year: y, total: c.contributionCalendar.totalContributions, commits: c.totalCommitContributions,
      prs: c.totalPullRequestContributions, reviews: c.totalPullRequestReviewContributions,
      issues: c.totalIssueContributions, restricted: c.restrictedContributionsCount,
      days: c.contributionCalendar.weeks.flatMap((w) => w.contributionDays).map((d) => ({ date: d.date, count: d.contributionCount })),
    };
  });

  const repos = [];
  let after = null;
  for (let page = 0; page < 5; page++) {
    const { user: u } = await gql(token, REPO_Q, { login, after });
    repos.push(...u.repositories.nodes);
    if (!u.repositories.pageInfo.hasNextPage) break;
    after = u.repositories.pageInfo.endCursor;
  }

  const commitTimes = [];
  try {
    after = null;
    for (let page = 0; page < 4; page++) {
      const { user: u } = await gql(token, HIST_Q, { login, uid: user.id, after });
      u.repositories.nodes.forEach((r) => (r.defaultBranchRef?.target?.history?.nodes || []).forEach((c) => commitTimes.push(c.authoredDate)));
      if (!u.repositories.pageInfo.hasNextPage) break;
      after = u.repositories.pageInfo.endCursor;
    }
  } catch (e) {
    console.warn(`commit history skipped: ${e.message}`);
  }

  return {
    login: user.login, name: user.name || user.login, years, commitTimes,
    repos: repos.map((r) => ({
      name: r.name, description: r.description, stars: r.stargazerCount, archived: r.isArchived, private: r.isPrivate,
      pushedAt: r.pushedAt, lang: r.primaryLanguage?.name || null,
      languages: r.languages.edges.map((e) => ({ name: e.node.name, size: e.size })),
    })),
  };
}

function demoData() {
  let seed = 20261019;
  const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const thisYear = today.getUTCFullYear();
  const intensity = { [thisYear - 5]: 0.25, [thisYear - 4]: 0.55, [thisYear - 3]: 0.9, [thisYear - 2]: 0.7, [thisYear - 1]: 1.1, [thisYear]: 1 };
  const years = [];
  for (let y = thisYear - 5; y <= thisYear; y++) {
    const days = [];
    for (let d = new Date(Date.UTC(y, 0, 1)); d <= today && d.getUTCFullYear() === y; d = new Date(d.getTime() + 864e5)) {
      const i = Math.round((today - d) / 864e5), wd = d.getUTCDay(), k = intensity[y];
      const w = [0.35, 1, 1.25, 1.15, 1, 0.8, 0.3][wd];
      let c = rnd() < (wd % 6 === 0 ? 0.35 : 0.75) * Math.min(1, k + 0.15) ? Math.round(rnd() * 7 * w * k + w * 1.5) : 0;
      if (i > 150 && i < 163) c = 0;
      if (i < 13) c = Math.max(c, 1 + Math.round(rnd() * 6));
      if (i === 13) c = 0;
      if (y === thisYear - 1 && d.getUTCMonth() === 2 && d.getUTCDate() >= 2 && d.getUTCDate() <= 30) c = Math.max(c, 2);
      days.push({ date: dayKey(d), count: c });
    }
    const total = days.reduce((a, d) => a + d.count, 0);
    years.push({ year: y, total, commits: Math.round(total * 0.7), prs: Math.round(total * 0.09), reviews: Math.round(total * 0.15), issues: Math.round(total * 0.03), restricted: 0, days });
  }
  const commitTimes = [];
  for (let i = 0; i < 640; i++) {
    const hourW = [3, 2, 1, 0.5, 0.2, 0.2, 0.5, 1, 2, 4, 6, 6, 4, 5, 6, 6, 5, 4, 5, 7, 8, 9, 8, 5];
    let pick = rnd() * hourW.reduce((a, b) => a + b, 0), h = 0;
    while ((pick -= hourW[h]) > 0) h++;
    const d = new Date(today.getTime() - Math.floor(rnd() * 900) * 864e5 + (h - 4) * 36e5 + Math.floor(rnd() * 60) * 6e4);
    commitTimes.push(d.toISOString());
  }
  const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();
  const L = (pairs) => pairs.map(([name, size]) => ({ name, size }));
  return {
    login: 'ali', name: 'Ali', years, commitTimes,
    repos: [
      { name: 'kampus-landing', description: 'Marketing site for kampus.az', stars: 6, pushedAt: daysAgo(1), lang: 'TypeScript', languages: L([['TypeScript', 182000], ['CSS', 41000], ['HTML', 9000]]) },
      { name: 'camunda-worker-starter', description: 'Spring Boot starter for Camunda external task workers', stars: 14, pushedAt: daysAgo(4), lang: 'Java', languages: L([['Java', 260000], ['Shell', 3000]]) },
      { name: 'livekit-playground', description: 'Experiments with realtime voice agents', stars: 3, pushedAt: daysAgo(11), lang: 'Python', languages: L([['Python', 88000], ['TypeScript', 30000]]) },
      { name: 'feign-retry-kit', description: 'Opinionated retry + circuit-breaker defaults for Feign clients', stars: 9, pushedAt: daysAgo(37), lang: 'Java', languages: L([['Java', 120000]]) },
      { name: 'dotfiles', description: 'zsh, git and editor setup', stars: 1, pushedAt: daysAgo(80), lang: 'Shell', languages: L([['Shell', 12000], ['Lua', 8000]]) },
    ],
  };
}

function runs(days) {
  let longest = { len: 0 }, cur = null;
  for (const d of days) {
    if (d.count > 0) {
      cur = cur ? { ...cur, len: cur.len + 1, end: d.date } : { len: 1, start: d.date, end: d.date };
      if (cur.len > longest.len) longest = cur;
    } else cur = null;
  }
  let i = days.length - 1;
  if (i >= 0 && days[i].count === 0) i--; // today isn't over yet
  const endIdx = i;
  while (i >= 0 && days[i].count > 0) i--;
  const current = endIdx > i ? { len: endIdx - i, start: days[i + 1].date, end: days[endIdx].date } : { len: 0 };
  return { longest, current };
}

function rhythm(times, tz) {
  let zone = tz || 'UTC';
  let f;
  try { f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23', weekday: 'long' }); }
  catch { zone = 'UTC'; f = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hour: 'numeric', hourCycle: 'h23', weekday: 'long' }); }
  const hours = Array(24).fill(0), wd = {};
  for (const iso of times) {
    const parts = f.formatToParts(new Date(iso));
    const h = Number(parts.find((p) => p.type === 'hour').value) % 24;
    const w = parts.find((p) => p.type === 'weekday').value;
    hours[h]++; wd[w] = (wd[w] || 0) + 1;
  }
  const buckets = [0, 1, 2, 3].map((b) => hours.slice(b * 6, b * 6 + 6).reduce((a, n) => a + n, 0));
  return {
    tz: zone, count: times.length, hours, buckets,
    peakHour: hours.indexOf(Math.max(...hours)),
    topWeekday: Object.entries(wd).sort((a, b) => b[1] - a[1])[0]?.[0] || '—',
  };
}

function summarize(raw, cfg) {
  const sum = (k) => raw.years.reduce((a, y) => a + (y[k] || 0), 0);
  const byDate = new Map();
  raw.years.forEach((y) => y.days.forEach((d) => byDate.set(d.date, d.count)));
  const today = dayKey(new Date());
  let all = [...byDate.entries()].filter(([d]) => d <= today).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, count]) => ({ date, count }));
  const firstIdx = all.findIndex((d) => d.count > 0);
  const firstDay = firstIdx >= 0 ? all[firstIdx].date : null;
  const history = firstIdx >= 0 ? all.slice(firstIdx) : [];

  const window = all.slice(-365);
  const perWd = Array(7).fill(0);
  window.forEach((d) => { perWd[asDate(d.date).getUTCDay()] += d.count; });
  const windowPeak = window.reduce((a, d) => (d.count > a.count ? d : a), { count: 0, date: window[0]?.date });

  const monthly = new Map();
  history.forEach((d) => monthly.set(d.date.slice(0, 7), (monthly.get(d.date.slice(0, 7)) || 0) + d.count));

  const years = raw.years.filter((y) => !firstDay || y.year >= Number(firstDay.slice(0, 4)));
  const bestYear = years.reduce((a, y) => (!a || y.total > a.total ? y : a), null);
  const thisYear = raw.years.find((y) => y.year === new Date().getUTCFullYear()) || { year: new Date().getUTCFullYear(), commits: 0, reviews: 0 };

  const exRepos = new Set([(raw.login || '').toLowerCase(), ...(cfg.repos?.exclude || []).map((s) => s.toLowerCase())]);
  const mine = raw.repos.filter((r) => !exRepos.has(r.name.toLowerCase()));
  const own = mine.filter((r) => !r.private); // only public repos are ever named or counted on cards
  const langRepos = cfg.languages?.includePrivate ? mine : own;
  const exLang = new Set((cfg.languages?.exclude || []).map((s) => s.toLowerCase()));
  const bytes = new Map();
  langRepos.forEach((r) => r.languages.forEach((l) => { if (!exLang.has(l.name.toLowerCase())) bytes.set(l.name, (bytes.get(l.name) || 0) + l.size); }));
  const total = [...bytes.values()].reduce((a, b) => a + b, 0) || 1;
  const sorted = [...bytes.entries()].sort((a, b) => b[1] - a[1]).map(([name, size]) => ({ name, pct: (size / total) * 100 }));
  const maxLangs = cfg.languages?.count || 6;
  let langs = sorted.filter((l, i) => l.pct >= 1 && i < maxLangs - 1);
  const rest = 100 - langs.reduce((a, l) => a + l.pct, 0);
  if (sorted.length > langs.length && rest > 0.05) langs.push({ name: 'Other', pct: rest });
  const topRepo = own.reduce((a, r) => (r.stars > (a?.stars || 0) ? r : a), null);

  return {
    total: sum('total'), commits: sum('commits'), prs: sum('prs'), reviews: sum('reviews'), issues: sum('issues'), restricted: sum('restricted'),
    firstDay, monthly: [...monthly.values()], years, bestYear: bestYear && bestYear.total ? bestYear : null, thisYear,
    ...runs(history),
    window, windowTotal: window.reduce((a, d) => a + d.count, 0), windowActive: window.filter((d) => d.count > 0).length,
    windowPeak, busiestDay: WEEKDAYS[perWd.indexOf(Math.max(...perWd))],
    rhythm: rhythm(raw.commitTimes, cfg.timezone),
    stars: own.reduce((a, r) => a + (r.stars || 0), 0), topRepo,
    repoCount: own.length, langRepoCount: langRepos.length, privateLangRepos: langRepos.length - own.length, langCount: sorted.length,
    languages: langs,
    repos: own.filter((r) => !r.archived).slice(0, cfg.repos?.count || 4),
  };
}

// ── main ─────────────────────────────────────────────────────────────────────
const cfg = JSON.parse(await readFile(join(ROOT, 'profile.config.json'), 'utf8'));
await mkdir(OUT, { recursive: true });

let raw = null;
if (MODE === 'live') raw = await liveData();
if (MODE === 'demo') raw = demoData();

const today = new Date().toISOString().slice(0, 10);
const person = {
  login: raw?.login || process.env.GH_LOGIN || 'you',
  name: cfg.name || raw?.name || process.env.GH_LOGIN || 'hello, world',
  role: cfg.role, location: cfg.location, tagline: cfg.tagline,
  prompt: cfg.prompt || 'claude "introduce yourself"',
  facts: cfg.facts || [],
  stamp: MODE === 'placeholder' ? 'refreshes every 6h' : `rendered ${today} · refreshes every 6h`,
};
const stats = raw ? summarize(raw, cfg) : null;

const cards = [
  ['stats', statsCard, ['Bash', 'gh stats --all-time', 'GitHub stats']],
  ['streak', streakCard, ['Bash', 'streak --all-time', 'Contribution streaks']],
  ['activity', activityCard, ['Fetch', 'contribution-calendar --last 52w', 'Contribution calendar']],
  ['rhythm', rhythmCard, ['Bash', 'git log --author=me --date=format:%H', 'Commit rhythm']],
  ['code', codeCard, ['Grep', 'languages --by-bytes', 'Languages and recent repositories']],
];
for (const [mode, t] of Object.entries(THEMES)) {
  await writeFile(join(OUT, `header-${mode}.svg`), header(t, person));
  for (const [name, render, ph] of cards) {
    await writeFile(join(OUT, `${name}-${mode}.svg`), stats ? render(t, stats) : waiting(t, ...ph));
  }
}
console.log(`rendered ${MODE} cards → assets/`);

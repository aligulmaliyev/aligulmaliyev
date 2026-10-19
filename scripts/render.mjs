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
const shortDate = (iso) => { const d = new Date(iso + 'T00:00:00Z'); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`; };

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

const delay = (s) => `style="animation-delay:${r1(s * 100) / 100}s"`;

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

function waiting(t, tool, args, label) {
  const body = `${toolHead(28, 40, tool, args)}
<text x="34" y="74" font-size="13" class="fa">⎿</text>
<text x="58" y="74" font-size="13" class="mu">waiting for the first run of .github/workflows/profile.yml…</text>`;
  return frame(t, 100, body, label);
}

// ── header: a terminal session ───────────────────────────────────────────────
function header(t, p) {
  const fs = 14.5, cw = fs * ADV, x0 = 32, x1 = x0 + 2 * cw;
  const css = [];
  const out = [];

  // window chrome
  out.push(`<path d="M.5 14.5a14 14 0 0 1 14-14h${W - 29}a14 14 0 0 1 14 14v24h-${W - 1}z" fill="${t.chrome}"/>`);
  out.push(`<path d="M.5 38.5h${W - 1}" stroke="${t.border}"/>`);
  [t.accent, t.sand, t.sage].forEach((c, i) => out.push(`<circle cx="${22 + i * 18}" cy="19.5" r="5.5" fill="${c}" opacity=".9"/>`));
  out.push(`<text x="${W / 2}" y="24" font-size="12" text-anchor="middle" class="mu">${esc(p.login)} — ~/products — claude</text>`);

  // shell prompt + typed command
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
  css.push(`.cu{animation:cu .01s linear ${r1((tDelay + tDur + 0.3) * 10) / 10}s both}@keyframes cu{from{opacity:1}to{opacity:0}}`);

  // streamed answer
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

  // idle prompt
  d += 0.35; y += 38;
  out.push(`<g class="fi" ${delay(d)}><text x="${x0}" y="${y}" font-size="${fs}" class="ac b">❯</text>`
    + `<rect class="bl" x="${x1}" y="${y - fs + 1}" width="${cw}" height="${fs + 3}" fill="${t.text}"/></g>`);
  css.push(`.bl{animation:bl 1.1s step-end infinite}@keyframes bl{50%{opacity:0}}`);

  const h = y + 30;
  out.push(`<text x="${W - 24}" y="${h - 18}" font-size="11" text-anchor="end" class="fa">${esc(p.stamp)}</text>`);

  const label = `${p.name} — ${[p.role, p.location].filter(Boolean).join(', ')}. ${p.tagline || ''}`;
  return frame(t, h, out.join('\n'), label, css.join(''));
}

// ── stats tiles ──────────────────────────────────────────────────────────────
function statsCard(t, s) {
  const x0 = 58, y0 = 58, gap = 12, cols = 3;
  const tw = Math.floor((W - x0 - 28 - gap * (cols - 1)) / cols), th = 88;
  const tiles = [
    { label: 'contributions', value: fmt(s.total), spark: s.weekly },
    { label: 'active days', value: fmt(s.activeDays), cap: `of ${s.days}` },
    { label: 'current streak', value: s.streak, unit: 'd', cap: `best ${s.longest}d` },
    { label: 'commits', value: fmt(s.commits), cap: s.activeDays ? `~${r1(s.commits / s.activeDays)} per active day` : '' },
    { label: 'pull requests', value: fmt(s.prs), cap: `${fmt(s.issues)} issues opened` },
    { label: 'code reviews', value: fmt(s.reviews), cap: `~${r1(s.reviews / 52)} per week` },
  ];
  const out = [toolHead(28, 40, 'Bash', 'gh stats --since 365d'), `<text x="34" y="80" font-size="13" class="fa fi">⎿</text>`];
  out.push(`<text x="${W - 28}" y="40" font-size="12" text-anchor="end" class="mu fi">last 12 months</text>`);
  tiles.forEach((tile, i) => {
    const x = x0 + (i % cols) * (tw + gap), y = y0 + Math.floor(i / cols) * (th + gap);
    const g = [`<rect x="${x + .5}" y="${y + .5}" width="${tw - 1}" height="${th - 1}" rx="10" fill="${t.tile}" stroke="${t.border}"/>`,
      `<text x="${x + 16}" y="${y + 26}" font-size="11" letter-spacing=".08em" class="mu">${esc(tile.label.toUpperCase())}</text>`,
      `<text x="${x + 16}" y="${y + 67}" font-size="28" class="b">${esc(tile.value)}${tile.unit ? `<tspan font-size="16" class="mu" dx="2">${tile.unit}</tspan>` : ''}</text>`];
    if (tile.cap) g.push(`<text x="${x + tw - 16}" y="${y + 66}" font-size="11.5" text-anchor="end" class="mu">${esc(tile.cap)}</text>`);
    if (tile.spark && tile.spark.length > 1) {
      const sx = x + tw - 16 - 118, sw = 118, sy = y + 34, sh = 34;
      const max = Math.max(1, ...tile.spark);
      const pts = tile.spark.map((v, k) => [sx + (k / (tile.spark.length - 1)) * sw, sy + sh - (v / max) * sh]);
      const line = pts.map(([px, py]) => `${r1(px)},${r1(py)}`).join(' ');
      g.push(`<polygon points="${r1(sx)},${sy + sh} ${line} ${r1(sx + sw)},${sy + sh}" fill="${t.accent}" opacity=".13"/>`);
      g.push(`<polyline points="${line}" fill="none" stroke="${t.accent}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" pathLength="1" class="dr" ${delay(0.5)}/>`);
    }
    out.push(`<g class="fi" ${delay(0.1 + i * 0.08)}>${g.join('')}</g>`);
  });
  const h = y0 + 2 * th + gap + 28;
  return frame(t, h, out.join('\n'), `GitHub stats for the last 12 months: ${fmt(s.total)} contributions, ${fmt(s.commits)} commits, ${fmt(s.prs)} pull requests, ${fmt(s.reviews)} code reviews, current streak ${s.streak} days.`);
}

// ── contribution heatmap ─────────────────────────────────────────────────────
function activityCard(t, s) {
  const gx = 92, gy = 84, cell = 11, step = 14;
  const out = [toolHead(28, 40, 'Fetch', 'contribution-calendar --last 52w'), `<text x="34" y="80" font-size="13" class="fa fi">⎿</text>`];
  out.push(`<text x="${W - 28}" y="40" font-size="12" text-anchor="end" class="mu fi">${fmt(s.total)} contributions</text>`);

  const nz = s.calendar.map((d) => d.count).filter((c) => c > 0).sort((a, b) => a - b);
  const q = (p) => nz.length ? nz[Math.min(nz.length - 1, Math.floor(p * nz.length))] : 0;
  const [q1, q2, q3] = [q(0.25), q(0.5), q(0.75)];
  const level = (c) => (c === 0 ? 0 : c <= q1 ? 1 : c <= q2 ? 2 : c <= q3 ? 3 : 4);

  const offset = new Date(s.calendar[0].date + 'T00:00:00Z').getUTCDay();
  const cols = new Map();
  let lastLabelCol = -9;
  s.calendar.forEach((d, i) => {
    const idx = i + offset, col = Math.floor(idx / 7), row = idx % 7;
    if (!cols.has(col)) cols.set(col, []);
    cols.get(col).push(`<rect x="${gx + col * step}" y="${gy + row * step}" width="${cell}" height="${cell}" rx="2.5" fill="${t.heat[level(d.count)]}"><title>${d.date}: ${d.count}</title></rect>`);
    const dom = new Date(d.date + 'T00:00:00Z').getUTCDate();
    if (dom === 1 && col - lastLabelCol >= 3 && col <= 51) {
      out.push(`<text x="${gx + col * step}" y="${gy - 9}" font-size="10.5" class="fa">${MONTHS[new Date(d.date + 'T00:00:00Z').getUTCMonth()]}</text>`);
      lastLabelCol = col;
    }
  });
  [[1, 'Mon'], [3, 'Wed'], [5, 'Fri']].forEach(([r, n]) => out.push(`<text x="${gx - 10}" y="${gy + r * step + 9}" font-size="10" text-anchor="end" class="fa">${n}</text>`));
  for (const [col, rects] of cols) out.push(`<g class="fi" ${delay(0.15 + col * 0.016)}>${rects.join('')}</g>`);

  const by = gy + 7 * step + 26;
  const facts = [`busiest on ${s.busiestDay}s`];
  if (s.peak.count) facts.push(`peak ${s.peak.count} on ${shortDate(s.peak.date)}`);
  facts.push(`longest streak ${s.longest}d`);
  out.push(`<text x="${gx}" y="${by}" font-size="11.5" class="mu fi" ${delay(1.1)}>${esc(facts.join(' · '))}</text>`);
  const lx = W - 28 - 5 * 14 - 30;
  out.push(`<g class="fi" ${delay(1.1)}><text x="${lx - 8}" y="${by}" font-size="10.5" text-anchor="end" class="fa">less</text>`
    + t.heat.map((c, i) => `<rect x="${lx + i * 14}" y="${by - 10}" width="${cell}" height="${cell}" rx="2.5" fill="${c}"/>`).join('')
    + `<text x="${lx + 5 * 14 + 4}" y="${by}" font-size="10.5" class="fa">more</text></g>`);
  return frame(t, by + 26, out.join('\n'), `Contribution calendar for the last 52 weeks: ${fmt(s.total)} contributions, busiest on ${s.busiestDay}s.`);
}

// ── languages + recent repos ─────────────────────────────────────────────────
function codeCard(t, s) {
  const out = [];
  const L = { x: 28, in: 58, end: 410 }, R = { x: 468, in: 494, end: W - 28 };
  out.push(toolHead(L.x, 40, 'Grep', 'languages --by-bytes'));
  out.push(`<text x="${L.end}" y="40" font-size="12" text-anchor="end" class="mu fi">${s.repoCount} repos</text>`);
  out.push(`<text x="34" y="80" font-size="13" class="fa fi">⎿</text>`);
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
  out.push(`<text x="${R.end}" y="40" font-size="12" text-anchor="end" class="mu fi">★ ${fmt(s.stars)}</text>`);
  out.push(`<text x="${R.x + 6}" y="80" font-size="13" class="fa fi">⎿</text>`);
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

const USER_Q = `query($login:String!,$from:DateTime!,$to:DateTime!){user(login:$login){
  login name
  contributionsCollection(from:$from,to:$to){
    totalCommitContributions totalPullRequestContributions totalPullRequestReviewContributions
    totalIssueContributions restrictedContributionsCount
    contributionCalendar{totalContributions weeks{contributionDays{date contributionCount}}}}}}`;

const REPO_Q = `query($login:String!,$after:String){user(login:$login){repositories(first:100,after:$after,
  ownerAffiliations:OWNER,isFork:false,privacy:PUBLIC,orderBy:{field:PUSHED_AT,direction:DESC}){
  pageInfo{hasNextPage endCursor}
  nodes{name description stargazerCount isArchived pushedAt primaryLanguage{name}
    languages(first:10,orderBy:{field:SIZE,direction:DESC}){edges{size node{name}}}}}}}`;

async function liveData() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const login = process.env.GH_LOGIN;
  if (!token || !login) throw new Error('GH_TOKEN and GH_LOGIN must be set (or run with --demo / --placeholder)');
  const to = new Date(), from = new Date(to.getTime() - 364 * 864e5);
  const { user } = await gql(token, USER_Q, { login, from: from.toISOString(), to: to.toISOString() });
  if (!user) throw new Error(`GitHub user "${login}" not found`);
  const repos = [];
  let after = null;
  for (let page = 0; page < 5; page++) {
    const { user: u } = await gql(token, REPO_Q, { login, after });
    repos.push(...u.repositories.nodes);
    if (!u.repositories.pageInfo.hasNextPage) break;
    after = u.repositories.pageInfo.endCursor;
  }
  const c = user.contributionsCollection;
  return {
    login: user.login,
    name: user.name || user.login,
    calendar: c.contributionCalendar.weeks.flatMap((w) => w.contributionDays).map((d) => ({ date: d.date, count: d.contributionCount })),
    total: c.contributionCalendar.totalContributions,
    commits: c.totalCommitContributions,
    prs: c.totalPullRequestContributions,
    reviews: c.totalPullRequestReviewContributions,
    issues: c.totalIssueContributions,
    repos: repos.map((r) => ({
      name: r.name, description: r.description, stars: r.stargazerCount, archived: r.isArchived,
      pushedAt: r.pushedAt, lang: r.primaryLanguage?.name || null,
      languages: r.languages.edges.map((e) => ({ name: e.node.name, size: e.size })),
    })),
  };
}

function demoData() {
  let seed = 20261019;
  const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const calendar = [];
  for (let i = 364; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 864e5), wd = d.getUTCDay();
    const w = [0.35, 1, 1.25, 1.15, 1, 0.8, 0.3][wd];
    let c = rnd() < (wd % 6 === 0 ? 0.4 : 0.8) ? Math.round(rnd() * 8 * w + w * 1.5) : 0;
    if (i > 150 && i < 163) c = 0;
    if (i < 13) c = Math.max(c, 1 + Math.round(rnd() * 6));
    if (i === 13) c = 0;
    calendar.push({ date: d.toISOString().slice(0, 10), count: c });
  }
  const total = calendar.reduce((a, d) => a + d.count, 0);
  const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();
  const L = (pairs) => pairs.map(([name, size]) => ({ name, size }));
  return {
    login: 'ali', name: 'Ali', calendar, total,
    commits: Math.round(total * 0.7), prs: Math.round(total * 0.09), reviews: Math.round(total * 0.16), issues: Math.round(total * 0.03),
    repos: [
      { name: 'kampus-landing', description: 'Marketing site for kampus.az', stars: 6, pushedAt: daysAgo(1), lang: 'TypeScript', languages: L([['TypeScript', 182000], ['CSS', 41000], ['HTML', 9000]]) },
      { name: 'camunda-worker-starter', description: 'Spring Boot starter for Camunda external task workers', stars: 14, pushedAt: daysAgo(4), lang: 'Java', languages: L([['Java', 260000], ['Shell', 3000]]) },
      { name: 'livekit-playground', description: 'Experiments with realtime voice agents', stars: 3, pushedAt: daysAgo(11), lang: 'Python', languages: L([['Python', 88000], ['TypeScript', 30000]]) },
      { name: 'feign-retry-kit', description: 'Opinionated retry + circuit-breaker defaults for Feign clients', stars: 9, pushedAt: daysAgo(37), lang: 'Java', languages: L([['Java', 120000]]) },
      { name: 'dotfiles', description: 'zsh, git and editor setup', stars: 1, pushedAt: daysAgo(80), lang: 'Shell', languages: L([['Shell', 12000], ['Lua', 8000]]) },
    ],
  };
}

function summarize(raw, cfg) {
  const calendar = raw.calendar.slice(-371);
  const counts = calendar.map((d) => d.count);
  let longest = 0, run = 0;
  for (const c of counts) { run = c > 0 ? run + 1 : 0; longest = Math.max(longest, run); }
  let i = counts.length - 1;
  if (counts[i] === 0) i--; // today isn't over yet
  let streak = 0;
  while (i >= 0 && counts[i] > 0) { streak++; i--; }
  const perWd = Array(7).fill(0);
  calendar.forEach((d) => { perWd[new Date(d.date + 'T00:00:00Z').getUTCDay()] += d.count; });
  const peak = calendar.reduce((a, d) => (d.count > a.count ? d : a), { count: 0, date: calendar[0]?.date });
  const weekly = [];
  for (let k = 0; k < counts.length; k += 7) weekly.push(counts.slice(k, k + 7).reduce((a, b) => a + b, 0));

  const exRepos = new Set([(raw.login || '').toLowerCase(), ...(cfg.repos?.exclude || []).map((s) => s.toLowerCase())]);
  const own = raw.repos.filter((r) => !exRepos.has(r.name.toLowerCase()));
  const exLang = new Set((cfg.languages?.exclude || []).map((s) => s.toLowerCase()));
  const bytes = new Map();
  own.forEach((r) => r.languages.forEach((l) => { if (!exLang.has(l.name.toLowerCase())) bytes.set(l.name, (bytes.get(l.name) || 0) + l.size); }));
  const sum = [...bytes.values()].reduce((a, b) => a + b, 0) || 1;
  let langs = [...bytes.entries()].sort((a, b) => b[1] - a[1]).map(([name, size]) => ({ name, pct: (size / sum) * 100 }));
  const maxLangs = cfg.languages?.count || 6;
  if (langs.length > maxLangs) {
    const rest = langs.slice(maxLangs - 1).reduce((a, l) => a + l.pct, 0);
    langs = [...langs.slice(0, maxLangs - 1), { name: 'Other', pct: rest }];
  }

  return {
    calendar, days: calendar.length, total: raw.total, commits: raw.commits, prs: raw.prs, reviews: raw.reviews, issues: raw.issues,
    activeDays: counts.filter((c) => c > 0).length, streak, longest, weekly, peak,
    busiestDay: WEEKDAYS[perWd.indexOf(Math.max(...perWd))],
    stars: own.reduce((a, r) => a + (r.stars || 0), 0),
    repoCount: own.length,
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

for (const [mode, t] of Object.entries(THEMES)) {
  await writeFile(join(OUT, `header-${mode}.svg`), header(t, person));
  await writeFile(join(OUT, `stats-${mode}.svg`), stats ? statsCard(t, stats) : waiting(t, 'Bash', 'gh stats --since 365d', 'GitHub stats'));
  await writeFile(join(OUT, `activity-${mode}.svg`), stats ? activityCard(t, stats) : waiting(t, 'Fetch', 'contribution-calendar --last 52w', 'Contribution calendar'));
  await writeFile(join(OUT, `code-${mode}.svg`), stats ? codeCard(t, stats) : waiting(t, 'Grep', 'languages --by-bytes', 'Languages and recent repositories'));
}
console.log(`rendered ${MODE} cards → assets/`);

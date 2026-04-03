const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const API_KEY       = process.env.COMMODITY_API_KEY || '';
const NEWSDATA_KEY  = process.env.NEWSDATA_API_KEY || '';
const RESEND_KEY    = process.env.RESEND_API_KEY || '';
const WATCH_FILE    = path.join(__dirname, 'watch_state.json');
const LEADERS_FILE  = path.join(__dirname, 'leaders.json');
const NEWS_FILE     = path.join(__dirname, 'news.json');

// ── HELPERS ──
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch(e) { return fallback; }
}
function writeJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); return true; }
  catch(e) { return false; }
}
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

// ── SAFE ISO DATE — never returns Invalid Date ──
function safeISODate(raw) {
  if (!raw) return new Date().toISOString();
  // GDELT seendate format: YYYYMMDDHHmmSS (14 chars)
  if (typeof raw === 'string' && raw.length === 14 && /^\d{14}$/.test(raw)) {
    return `${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}T${raw.slice(8,10)}:${raw.slice(10,12)}:${raw.slice(12,14)}Z`;
  }
  // Already ISO or parseable
  const d = new Date(raw);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

// ── LEADERS ENDPOINT ──
app.get('/api/leaders', (req, res) => {
  const leaders = readJSON(LEADERS_FILE, []);
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({ leaders, ts: new Date().toISOString() });
});

// ── NEWS FEED ENDPOINT ──
// Serves news.json written by GitHub Action (update-news.js)
app.get('/api/news', (req, res) => {
  if (!fs.existsSync(NEWS_FILE)) {
    return res.status(404).json({
      error: 'news.json not found — GitHub Action has not run yet',
      items: [],
      live_variables: {}
    });
  }
  const news = readJSON(NEWS_FILE, { items: [], live_variables: {} });
  res.set('Cache-Control', 'public, max-age=300'); // 5-min cache
  res.set('Access-Control-Allow-Origin', '*');
  res.json(news);
});

// ── WATCH STATE ENDPOINT ──
app.get('/api/watch', (req, res) => {
  const state = readJSON(WATCH_FILE, { leaders: {}, vars: {} });
  res.json(state);
});

// ── MARK REVIEWED ENDPOINT ──
app.post('/api/mark-reviewed', (req, res) => {
  const { type, key, ts } = req.body;
  if (!type || !key) return res.status(400).json({ error: 'Missing type or key' });
  const state = readJSON(WATCH_FILE, { leaders: {}, vars: {} });
  const now = ts || new Date().toISOString();
  if (type === 'leader') {
    if (!state.leaders[key]) state.leaders[key] = {};
    state.leaders[key].lastRefresh = now;
    state.leaders[key].flags = {};
  } else if (type === 'var') {
    if (!state.vars[key]) state.vars[key] = {};
    state.vars[key].lastRefresh = now;
    state.vars[key].flag = {};
  }
  writeJSON(WATCH_FILE, state);
  res.json({ ok: true, ts: now });
});

// ── GDELT QUERY ──
async function gdeltQuery(terms) {
  try {
    const q = encodeURIComponent(terms.join(' OR '));
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=artlist&maxrecords=10&format=json&timespan=24h&sourcelang=english`;
    const data = await httpsGet(url);
    const articles = data.articles || [];
    const tone = articles.reduce((sum, a) => sum + (parseFloat(a.tone) || 0), 0) / Math.max(articles.length, 1);
    const sources = new Set(articles.map(a => a.domain || '')).size;
    return { count: articles.length, tone, sources, articles };
  } catch(e) { return { count: 0, tone: 0, sources: 0, articles: [] }; }
}

// ── ESTIMATE IMPACT ──
function estimateImpact(gdeltResult, dimWeight) {
  const { count, tone, sources } = gdeltResult;
  if (count === 0) return 0;
  const freqScore = Math.min(8, count * 0.8);
  const consScore = Math.min(8, Math.abs(tone) * 1.5);
  const corrScore = Math.min(8, sources * 2);
  const totalIntensity = (freqScore + consScore + corrScore) / 24;
  const weightMultiplier = dimWeight / 18;
  return Math.round(totalIntensity * 15 * weightMultiplier * 10) / 10;
}

// ── WATCH MONITORING ──
async function runWatchMonitoring() {
  const leaders = readJSON(LEADERS_FILE, []);
  const state = readJSON(WATCH_FILE, { leaders: {}, vars: {} });
  const DIM_THRESHOLDS = { narcissism: 2.5, impulsivity: 2.8, values: 3.0, survival: 2.0, accountability: 2.3 };
  const DIM_WEIGHTS = { narcissism: 20, impulsivity: 18, values: 15, survival: 25, accountability: 22 };
  let newFlags = 0;

  for (const leader of leaders) {
    if (!state.leaders[leader.n]) state.leaders[leader.n] = { flags: {}, lastRefresh: null };
    const ls = state.leaders[leader.n];
    const watchTerms = leader.watch || [];
    if (!watchTerms.length) continue;
    const gdelt = await gdeltQuery(watchTerms);
    for (const dim of Object.keys(DIM_THRESHOLDS)) {
      const thresh = DIM_THRESHOLDS[dim];
      const wt = (leader.weights && leader.weights[dim]) || DIM_WEIGHTS[dim] || 18;
      const impact = estimateImpact(gdelt, wt);
      if (impact >= thresh) {
        const existing = ls.flags[dim] || {};
        if (!existing.triggered || existing.impact < impact) {
          ls.flags[dim] = {
            triggered: true,
            level: impact >= thresh * 2 ? 'critical' : 'flagged',
            reason: `${gdelt.count} article${gdelt.count !== 1 ? 's' : ''} detected matching watch terms for ${dim} — tone ${gdelt.tone.toFixed(1)}, ${gdelt.sources} sources`,
            impact: impact,
            sources: gdelt.sources,
            ts: new Date().toISOString()
          };
          newFlags++;
        }
      }
    }
  }

  const VAR_WATCH = [
    { k: 'nuclearSignalling',        name: 'Nuclear Signalling',        watch: ['nuclear doctrine India', 'nuclear Pakistan', 'LoC violations', 'nuclear signalling'] },
    { k: 'congressConstraint',       name: 'Congressional Constraint',  watch: ['War Powers', 'AUMF', 'Congress vote Iran', 'congressional authorisation'] },
    { k: 'diplomaticChannels',       name: 'Diplomatic Channels',       watch: ['Iran ceasefire', 'diplomacy Iran', 'Oman talks', 'back channel Iran'] },
    { k: 'armsControlArchitecture',  name: 'Arms Control Architecture', watch: ['New START', 'arms control treaty', 'nuclear treaty'] },
    { k: 'trumpDomesticPressure',    name: 'Trump Domestic Pressure',   watch: ['Trump approval', 'FiveThirtyEight poll', 'Trump impeach'] },
    { k: 'netanyahuLegalJeopardy',   name: 'Netanyahu Legal Jeopardy',  watch: ['Netanyahu trial', 'Netanyahu ICC', 'Netanyahu coalition', 'corruption Israel'] },
    { k: 'pakistanEconomicStress',   name: 'Pakistan Economic Stress',  watch: ['IMF Pakistan', 'Pakistan rupee', 'Pakistan economy'] },
    { k: 'iranRegimeCohesion',       name: 'Iran Regime Cohesion',      watch: ['IRGC split', 'Iran leadership', 'Iran protest'] }
  ];

  for (const v of VAR_WATCH) {
    if (!state.vars[v.k]) state.vars[v.k] = { flag: {}, lastRefresh: null };
    const gdelt = await gdeltQuery(v.watch);
    const impact = estimateImpact(gdelt, 18);
    if (impact >= 2) {
      const existing = state.vars[v.k].flag || {};
      if (!existing.triggered || existing.impact < impact) {
        state.vars[v.k].flag = {
          triggered: true,
          level: impact >= 4 ? 'critical' : 'flagged',
          reason: `${gdelt.count} article${gdelt.count !== 1 ? 's' : ''} detected — tone ${gdelt.tone.toFixed(1)}, ${gdelt.sources} sources`,
          impact: impact,
          sources: gdelt.sources,
          ts: new Date().toISOString()
        };
        newFlags++;
      }
    }
  }

  writeJSON(WATCH_FILE, state);
  console.log(`Watch monitoring complete — ${newFlags} new flags`);
  return newFlags;
}

// ── EMAIL DIGEST VIA RESEND ──
async function sendEmailDigest() {
  if (!RESEND_KEY) { console.log('No RESEND_KEY — skipping email'); return; }
  const state = readJSON(WATCH_FILE, { leaders: {}, vars: {} });
  const leaders = readJSON(LEADERS_FILE, []);
  const lines = [];

  for (const leader of leaders) {
    const ls = state.leaders[leader.n];
    if (!ls || !ls.flags) continue;
    const triggered = Object.keys(ls.flags).filter(f => ls.flags[f] && ls.flags[f].triggered);
    if (!triggered.length) continue;
    lines.push(`<h3 style="color:#E8F5EC;font-family:Georgia,serif;margin:16px 0 8px">${leader.n}</h3>`);
    triggered.forEach(dim => {
      const flag = ls.flags[dim];
      lines.push(`<p style="color:#A8C4B0;font-size:14px;margin:4px 0"><strong style="color:#E8C96A">${dim.toUpperCase()}</strong> — Est. impact: <strong>${flag.impact} pts</strong><br><span style="color:#5A8068;font-size:12px">${flag.reason}</span></p>`);
    });
  }

  const VAR_NAMES = { nuclearSignalling: 'Nuclear Signalling', congressConstraint: 'Congressional Constraint', diplomaticChannels: 'Diplomatic Channels', armsControlArchitecture: 'Arms Control Architecture', trumpDomesticPressure: 'Trump Domestic Pressure', netanyahuLegalJeopardy: 'Netanyahu Legal Jeopardy', pakistanEconomicStress: 'Pakistan Economic Stress', iranRegimeCohesion: 'Iran Regime Cohesion' };
  const varFlagged = [];
  Object.keys(state.vars || {}).forEach(k => {
    const vs = state.vars[k];
    if (vs && vs.flag && vs.flag.triggered) varFlagged.push({ k, name: VAR_NAMES[k] || k, flag: vs.flag });
  });
  if (varFlagged.length) {
    lines.push('<h3 style="color:#E8F5EC;font-family:Georgia,serif;margin:16px 0 8px">Dashboard Variables</h3>');
    varFlagged.forEach(v => {
      lines.push(`<p style="color:#A8C4B0;font-size:14px;margin:4px 0"><strong style="color:#C9A84C">${v.name}</strong> — Est. impact: <strong>${v.flag.impact} pts</strong><br><span style="color:#5A8068;font-size:12px">${v.flag.reason}</span></p>`);
    });
  }

  if (!lines.length) { console.log('No flags to email'); return; }

  const html = `
    <div style="background:#080F0A;color:#E8F5EC;font-family:DM Sans,Arial,sans-serif;padding:32px;max-width:600px">
      <div style="border-bottom:1px solid rgba(255,255,255,0.1);padding-bottom:16px;margin-bottom:24px">
        <h1 style="font-family:Georgia,serif;font-size:24px;color:#E8F5EC;margin:0">Assessment Watch Digest</h1>
        <p style="color:#5A8068;font-size:12px;margin:6px 0 0;font-family:monospace">${new Date().toLocaleDateString('en-SG', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · 08:00 SGT</p>
      </div>
      <p style="color:#A8C4B0;font-size:14px;margin-bottom:20px">The following assessment dimensions have triggered review flags. Review the evidence and update scores in leaders.json if the documented evidence materially changes the assessment.</p>
      ${lines.join('\n')}
      <div style="border-top:1px solid rgba(255,255,255,0.1);padding-top:16px;margin-top:24px">
        <a href="https://accidental-geopolitical-tracker.surge.sh" style="color:#5DCAA5;font-family:monospace;font-size:11px">OPEN TRACKER ↗</a>
        <span style="color:#3A5C45;font-size:11px;margin-left:16px">accidentalgeopoliticaltracker.com</span>
      </div>
    </div>`;

  try {
    const payload = JSON.stringify({
      from: 'Accidental Geopolitical Tracker <watch@accidentalgeopoliticaltracker.com>',
      to: ['subhaimtiaz@gmail.com'],
      subject: `Assessment Watch — ${lines.length > 3 ? 'Multiple Flags' : 'Review Required'} · ${new Date().toLocaleDateString('en-SG')}`,
      html
    });
    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.resend.com', path: '/emails', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Length': Buffer.byteLength(payload) }
      }, res => { let d = ''; res.on('data', chunk => d += chunk); res.on('end', () => { console.log('Email sent:', d); resolve(d); }); });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  } catch(e) { console.error('Email error:', e.message); }
}

// ── CRON: 8AM SGT (00:00 UTC) ──
function scheduleDailyDigest() {
  const now = new Date();
  const nextRun = new Date();
  nextRun.setUTCHours(0, 0, 0, 0);
  if (nextRun <= now) nextRun.setUTCDate(nextRun.getUTCDate() + 1);
  const msUntil = nextRun - now;
  console.log(`Daily digest scheduled in ${Math.round(msUntil/1000/60)} minutes`);
  setTimeout(async () => {
    console.log('Running daily watch monitoring + email digest...');
    const flags = await runWatchMonitoring();
    if (flags > 0) await sendEmailDigest();
    scheduleDailyDigest();
  }, msUntil);
}

// ── LIVE DATA ENDPOINT ──
app.get('/api/live', async (req, res) => {
  try {
    let oil = null;

    // ── PRIMARY: read live Brent price from news.json (written by GitHub Action) ──
    // The Action already fetches from Commodity API and stores the real price.
    // This is more reliable than calling the Commodity API directly from Railway.
    if (fs.existsSync(NEWS_FILE)) {
      const news = readJSON(NEWS_FILE, {});
      if (news.live_variables && news.live_variables.oilPrice && news.live_variables.oilPrice > 0) {
        oil = { price: news.live_variables.oilPrice, source: 'CommodityPriceAPI', change_pct: '' };
        console.log(`Oil from news.json: $${oil.price}/bbl (stress: ${news.live_variables.oilStress})`);
      }
    }

    // ── SECONDARY: call Commodity API directly if news.json unavailable ──
    if (!oil && API_KEY) {
      try {
        const d = await httpsGet(`https://commoditypriceapi.com/api/latest?access_key=${API_KEY}&base=USD&symbols=BRENT`);
        if (d && d.rates && d.rates.BRENT && d.rates.BRENT > 0) {
          const rawRate = parseFloat(d.rates.BRENT);
          const pricePerBarrel = rawRate < 1
            ? Math.round((1 / rawRate) * 100) / 100
            : Math.round(rawRate * 100) / 100;
          oil = { price: pricePerBarrel, source: 'CommodityPriceAPI', change_pct: '' };
          console.log(`Oil from Commodity API: $${pricePerBarrel}/bbl`);
        }
      } catch(e) { console.warn('Commodity API error:', e.message); }
    }

    // ── LAST RESORT: use a reasonable war-context estimate ──
    if (!oil) {
      oil = { price: 97 + (Math.random() - 0.5) * 4, source: 'Estimated', change_pct: '' };
      console.warn('Using estimated oil price — all sources unavailable');
    }

    // ── GDELT INTELLIGENCE FEED ──
    let alerts = [], conflicts = [];
    try {
      const gdelt = await httpsGet('https://api.gdeltproject.org/api/v2/doc/doc?query=Iran+war+OR+Strait+Hormuz+OR+Pakistan+India+LoC+OR+Ukraine+ceasefire&mode=artlist&maxrecords=20&format=json&timespan=6h&sourcelang=english');
      if (gdelt.articles) {
        const nonLatin = /[\u0600-\u06FF\u0900-\u097F\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF\u0400-\u04FF\u0A80-\u0AFF]/;
        alerts = gdelt.articles
          .filter(a => a.title && !nonLatin.test(a.title))
          .slice(0, 8)
          .map(a => ({
            type:  parseFloat(a.tone) < -5 ? 'critical' : parseFloat(a.tone) < -2 ? 'warning' : 'info',
            title: a.title || '',
            time:  safeISODate(a.seendate)
          }));
      }
    } catch(e) { console.warn('GDELT alerts error:', e.message); }

    const theatreQueries = [
      { name: 'Iran',               q: 'Iran war OR Strait Hormuz OR Tehran strikes' },
      { name: 'Pakistan/Afghanistan', q: 'Pakistan India LoC OR Pakistan Afghanistan border' },
      { name: 'Israel/Lebanon',     q: 'Israel Lebanon OR Gaza ceasefire' },
      { name: 'Yemen',              q: 'Houthi OR Yemen strikes' },
      { name: 'Ukraine',            q: 'Ukraine ceasefire OR Ukraine Russia' }
    ];
    try {
      for (const t of theatreQueries) {
        const g = await httpsGet(`https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(t.q)}&mode=artlist&maxrecords=5&format=json&timespan=24h&sourcelang=english`);
        const count = (g.articles || []).length;
        const tone  = (g.articles || []).reduce((s, a) => s + (parseFloat(a.tone) || 0), 0) / Math.max((g.articles || []).length, 1);
        const base  = { Iran: 75, 'Pakistan/Afghanistan': 65, 'Israel/Lebanon': 65, Yemen: 55, Ukraine: 50 }[t.name] || 50;
        conflicts.push({ name: t.name, status: 'Active', level: Math.min(95, Math.round(base + count * 1.5 + Math.abs(tone) * 0.5)) });
      }
    } catch(e) { conflicts = []; }

    // ── OIL STRESS ──
    const oilStress = Math.round(Math.max(0, Math.min(100, (oil.price - 67) / (130 - 67) * 100)));

    // ── ALL COMPUTED VARIABLES from calculation engine ──
    let allVars = { oilPrice: oilStress };
    try {
      const computed = computeVariables();
      allVars = { ...computed, oilPrice: oilStress }; // oil stress always from live price
    } catch(e) { console.warn('Variable computation failed:', e.message); }

    res.json({ oil, alerts, conflicts, computedVars: allVars });

  } catch(e) {
    console.error('/api/live error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── SUBSTACK FEED ──
app.get('/api/substack', async (req, res) => {
  const FALLBACK = [
    { title: 'I Was On Instagram. Then America Went To War.', link: 'https://subhaimtiaz.substack.com/p/i-was-on-instagram-then-america-went', date: '28 Feb 2026', excerpt: 'I was posting a Spider-Man meme about AI ethics on Friday night. By Saturday morning America had launched strikes on Iran.' },
    { title: 'Oh, Those Iranians. Bless Their Hearts.', link: 'https://subhaimtiaz.substack.com/p/oh-those-iranians-bless-their-hearts', date: '2 Mar 2026', excerpt: 'You picked their king. You funded his torture. You shot their plane. No punchline. That is it. That is the joke.' },
    { title: 'Oh Sure, It Was Definitely Just One Very Lucky Sad Man With A Gun', link: 'https://subhaimtiaz.substack.com/p/oh-sure-it-was-definitely-just-one', date: '4 Mar 2026', excerpt: 'A completely uncontroversial retelling of totally unrelated historical events.' },
    { title: 'The Whitmores: A Family of Great Values', link: 'https://subhaimtiaz.substack.com/p/the-whitmores-a-family-of-great-values', date: '19 Mar 2026', excerpt: 'IBM billed for the Holocaust. Quarterly. The Whitmores are still billing.' },
    { title: "Israel Has No Choice — It's Fighting The Brother It Made", link: 'https://subhaimtiaz.substack.com/p/israel-has-no-choice', date: '22 Mar 2026', excerpt: 'Hamas, Hezbollah, Loki, and a completely serious Marvel guide to the Middle East.' }
  ];
  try {
    await httpsGet('https://subhaimtiaz.substack.com/feed');
    res.json({ articles: FALLBACK, source: 'fallback' });
  } catch(e) { res.json({ articles: FALLBACK, source: 'fallback' }); }
});

app.get('/api/proposals', (req, res) => {
  if (!fs.existsSync(PROPOSALS_FILE)) {
    return res.json({ leader_proposals: [], variable_proposals: [], message: 'No proposals yet — run the GitHub Action to generate analysis.' });
  }
  const proposals = readJSON(PROPOSALS_FILE, { leader_proposals: [], variable_proposals: [] });
  res.set('Cache-Control', 'public, max-age=300');
  res.set('Access-Control-Allow-Origin', '*');
  res.json(proposals);
});

// ── VARIABLE CALCULATION ENGINE ──────────────────────────────────────────────
// Reads news_history.json and derives computed values for all dashboard variables.
// Each variable has a baseline, a direction, and thresholds.
// News items tagged with variable_key drive signal intensity.
// Output: { varKey: computedValue } — dashboard reads this instead of hardcoded numbers.

const HISTORY_FILE = path.join(__dirname, 'news_history.json');
const PROPOSALS_FILE = path.join(__dirname, 'proposals.json');

const VAR_CONFIG = {
  // key: { baseline, direction, floor, ceiling, sensitivity }
  // direction: 'up' = high news intensity pushes value up (bad = higher)
  //            'down' = high news intensity pushes value down (bad = lower)
  oilPrice:              { baseline: 47,  direction: 'up',   floor: 0,   ceiling: 100, sensitivity: 1.2 },
  straitControl:         { baseline: 70,  direction: 'up',   floor: 30,  ceiling: 100, sensitivity: 1.5 },
  nuclearSignalling:     { baseline: 60,  direction: 'up',   floor: 20,  ceiling: 100, sensitivity: 2.0 },
  congressConstraint:    { baseline: 20,  direction: 'down', floor: 5,   ceiling: 50,  sensitivity: 1.0 },
  diplomaticChannels:    { baseline: 22,  direction: 'down', floor: 5,   ceiling: 60,  sensitivity: 1.2 },
  armsControlArchitecture:{ baseline: 15, direction: 'down', floor: 5,   ceiling: 40,  sensitivity: 0.8 },
  netanyahuLegalJeopardy:{ baseline: 82,  direction: 'up',   floor: 50,  ceiling: 100, sensitivity: 1.0 },
  iranRegimeCohesion:    { baseline: 40,  direction: 'up',   floor: 15,  ceiling: 75,  sensitivity: 1.5 },
  trumpDomesticPressure: { baseline: 65,  direction: 'up',   floor: 30,  ceiling: 95,  sensitivity: 1.0 },
  pakistanEconomicStress:{ baseline: 68,  direction: 'up',   floor: 30,  ceiling: 95,  sensitivity: 1.2 }
};

// Also map leader watch terms to dimension signals
const LEADER_VAR_MAP = {
  'straitControl':          ['Mojtaba Khamenei', 'Mohammed bin Salman', 'Xi Jinping'],
  'nuclearSignalling':      ['Kim Jong-un', 'Vladimir Putin', 'General Asim Munir', 'Narendra Modi'],
  'congressConstraint':     ['Donald J. Trump'],
  'diplomaticChannels':     ['Donald J. Trump', 'Mojtaba Khamenei', 'Recep Tayyip Erdogan'],
  'netanyahuLegalJeopardy': ['Benjamin Netanyahu'],
  'iranRegimeCohesion':     ['Mojtaba Khamenei'],
  'trumpDomesticPressure':  ['Donald J. Trump'],
  'pakistanEconomicStress': ['General Asim Munir']
};

function computeVariables() {
  // Load history and live_variables
  const history = readJSON(HISTORY_FILE, { items: [] });
  const news    = readJSON(NEWS_FILE, { live_variables: {} });
  const items   = history.items || [];

  // Start with oil from live_variables (real Brent price)
  const computed = {};

  // Oil stress: directly from live commodity feed
  if (news.live_variables && news.live_variables.oilStress != null) {
    computed.oilPrice = news.live_variables.oilStress;
  }

  // For each other variable, scan history items
  const now = Date.now();
  const RECENCY_DAYS = 14; // weight recent items more heavily
  const cutoff = new Date(now - RECENCY_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  Object.keys(VAR_CONFIG).forEach(varKey => {
    if (varKey === 'oilPrice') return; // already computed above

    const cfg = VAR_CONFIG[varKey];

    // Find items relevant to this variable
    const relevant = items.filter(item => {
      if (item.variable_key === varKey) return true;
      // Also include high-escalation items for leaders mapped to this variable
      const mappedLeaders = LEADER_VAR_MAP[varKey] || [];
      return mappedLeaders.some(l => (item.leaders || []).includes(l)) && (item.escalation || 0) >= 3;
    });

    if (relevant.length === 0) {
      computed[varKey] = cfg.baseline;
      return;
    }

    // Compute signal intensity: weighted average escalation × source diversity × recency
    let totalSignal = 0;
    let totalWeight = 0;
    const blocs = new Set();

    relevant.forEach(item => {
      const esc = item.escalation || 2;
      const recency = (item.date || '') >= cutoff ? 1.5 : 1.0;
      const weight = esc * recency;
      totalSignal += esc * weight;
      totalWeight += weight;
      if (item.bloc) blocs.add(item.bloc);
    });

    const avgEsc    = totalWeight > 0 ? totalSignal / totalWeight : 2;
    const diversity = Math.min(blocs.size / 2, 1.5); // 2+ blocs = full weight
    const intensity = (avgEsc / 5) * diversity * cfg.sensitivity;

    // Apply to baseline
    let value;
    if (cfg.direction === 'up') {
      // More news = higher value (worse situation)
      const push = intensity * (cfg.ceiling - cfg.baseline) * 0.4;
      value = cfg.baseline + push;
    } else {
      // More news = lower value (guardrails eroding)
      const push = intensity * (cfg.baseline - cfg.floor) * 0.4;
      value = cfg.baseline - push;
    }

    computed[varKey] = Math.round(Math.max(cfg.floor, Math.min(cfg.ceiling, value)));
  });

  return computed;
}

app.get('/api/variables', (req, res) => {
  try {
    const computed = computeVariables();
    res.set('Cache-Control', 'public, max-age=300');
    res.set('Access-Control-Allow-Origin', '*');
    res.json({
      variables: computed,
      ts: new Date().toISOString(),
      source: 'news_history.json + live_variables'
    });
  } catch(e) {
    console.error('/api/variables error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── HEALTH CHECK ──
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString(), version: 'accidental-geopolitical-tracker-v2' }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  scheduleDailyDigest();
});

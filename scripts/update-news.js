#!/usr/bin/env node
/**
 * AGRA News Feed Updater — Full Coverage Build
 * Sources:
 *   1. NewsAPI.org      → primary news feed        (NEWS_API_KEY)
 *   2. Commodity API    → live Brent crude price    (COMMODITY_API_KEY)
 *   3. Claude web search → gap-fill, Persian bloc  (ANTHROPIC_API_KEY)
 * Analysis:
 *   4. news_history.json → 30-day rolling archive
 *   5. Cumulative analysis → evidence-backed dimension + variable proposals
 * Post-run:
 *   6. Resend email     → digest + proposals with full evidence chains
 */

const fs   = require('fs');
const path = require('path');

const API_KEY       = process.env.ANTHROPIC_API_KEY;
const NEWS_API_KEY  = process.env.NEWS_API_KEY;
const COMMODITY_KEY = process.env.COMMODITY_API_KEY;
const RESEND_KEY    = process.env.RESENT_API_KEY;
const NOTIFY_EMAIL  = process.env.NOTIFY_EMAIL;

if (!API_KEY)      { console.error('ANTHROPIC_API_KEY not set'); process.exit(1); }
if (!NEWS_API_KEY) { console.warn('NEWS_API_KEY not set — skipping NewsAPI'); }
if (!COMMODITY_KEY){ console.warn('COMMODITY_API_KEY not set — oil price unavailable'); }
if (!RESEND_KEY)   { console.warn('RESENT_API_KEY not set — email digest disabled'); }
if (!NOTIFY_EMAIL) { console.warn('NOTIFY_EMAIL not set — email digest disabled'); }

const MODEL          = 'claude-sonnet-4-20250514';
const NEWS_PATH      = path.join(__dirname, '..', 'news.json');
const HISTORY_PATH   = path.join(__dirname, '..', 'news_history.json');
const PROPOSALS_PATH = path.join(__dirname, '..', 'proposals.json');
const LEADERS_PATH   = path.join(__dirname, '..', 'leaders.json');
const HISTORY_DAYS   = 30;
const MAX_HISTORY_ANALYSIS = 30; // max items passed to analysis Claude call

// ── OIL STRESS ────────────────────────────────────────────────────────────────
function calcOilStress(price) {
  if (!price || isNaN(price)) return null;
  return Math.round(Math.min(100, Math.max(0, ((price - 67) / (130 - 67)) * 100)));
}

// ── COMMODITY API ─────────────────────────────────────────────────────────────
async function fetchBrentPrice() {
  if (!COMMODITY_KEY) return null;
  console.log('Fetching Brent crude...');
  const attempts = [
    { url: `https://commoditypriceapi.com/api/latest?access_key=${COMMODITY_KEY}&base=USD&symbols=BRENT`,
      parse: d => {
        if (d && d.rates && d.rates.BRENT) {
          const r = parseFloat(d.rates.BRENT);
          return r < 1 ? Math.round((1/r)*100)/100 : Math.round(r*100)/100;
        }
        return null;
      }},
    { url: `https://www.alphavantage.co/query?function=BRENT&interval=daily&apikey=${COMMODITY_KEY}`,
      parse: d => d.data && d.data[0] ? parseFloat(d.data[0].value) : null },
    { url: `https://financialmodelingprep.com/api/v3/quote/BCOUSD?apikey=${COMMODITY_KEY}`,
      parse: d => Array.isArray(d) && d[0] ? parseFloat(d[0].price) : null },
    { url: `https://api.twelvedata.com/price?symbol=BRENT&apikey=${COMMODITY_KEY}`,
      parse: d => d.price ? parseFloat(d.price) : null }
  ];
  for (const a of attempts) {
    try {
      const res = await fetch(a.url);
      if (!res.ok) continue;
      const data = await res.json();
      const price = a.parse(data);
      if (price && price > 0) { console.log(`  Brent: $${price.toFixed(2)}`); return price; }
    } catch(e) { /* try next */ }
  }
  console.warn('  Brent fetch failed');
  return null;
}

// ── NEWSAPI CLUSTERS ──────────────────────────────────────────────────────────
const NEWS_QUERIES = [
  { q: 'Iran war ceasefire Israel United States 2026',         leaders: ['Mojtaba Khamenei','Donald J. Trump','Benjamin Netanyahu'], dims: ['survival','impulsivity'] },
  { q: 'Strait of Hormuz oil tanker shipping blockade',        leaders: ['Mojtaba Khamenei','Mohammed bin Salman','Xi Jinping'],      dims: ['survival','impulsivity'] },
  { q: 'Trump Iran war Congress AUMF war powers',              leaders: ['Donald J. Trump'],                                          dims: ['accountability','impulsivity'] },
  { q: 'Netanyahu trial ICC corruption coalition Israel',      leaders: ['Benjamin Netanyahu'],                                       dims: ['survival','accountability','narcissism'] },
  { q: 'Pakistan India LoC military strike nuclear',           leaders: ['General Asim Munir','Narendra Modi'],                      dims: ['impulsivity','survival'] },
  { q: 'Putin Ukraine ceasefire nuclear Russia warning',       leaders: ['Vladimir Putin'],                                          dims: ['survival','impulsivity','narcissism'] },
  { q: 'Kim Jong-un North Korea missile DPRK test',            leaders: ['Kim Jong-un'],                                             dims: ['impulsivity','narcissism','survival'] },
  { q: 'Xi Jinping China Taiwan military South China Sea',     leaders: ['Xi Jinping'],                                              dims: ['survival','impulsivity'] },
  { q: 'Erdogan Turkey Iran mediation NATO',                   leaders: ['Recep Tayyip Erdogan'],                                    dims: ['survival','values','impulsivity'] },
  { q: 'Saudi Arabia Iran MBS oil executions',                 leaders: ['Mohammed bin Salman'],                                     dims: ['survival','values','accountability'] },
  { q: 'oil Brent crude spike Middle East war 2026',           variable: 'oilPrice',              leaders: ['Mohammed bin Salman','Mojtaba Khamenei','Donald J. Trump'], dims: ['survival','values'] },
  { q: 'nuclear signalling threat warning 2026',               variable: 'nuclearSignalling',     leaders: ['Kim Jong-un','Vladimir Putin','General Asim Munir'],        dims: ['impulsivity','survival','narcissism'] },
  { q: 'Iran US diplomacy ceasefire Qatar Oman back channel',  variable: 'diplomaticChannels',    leaders: ['Donald J. Trump','Mojtaba Khamenei'],                      dims: ['values','survival'] },
  { q: 'Iran IRGC regime internal faction stability war',      variable: 'iranRegimeCohesion',    leaders: ['Mojtaba Khamenei'],                                        dims: ['survival','accountability'] },
  { q: 'arms control New START nuclear treaty Russia US',      variable: 'armsControlArchitecture', leaders: ['Vladimir Putin','Donald J. Trump'],                     dims: ['accountability','values'] },
  { q: 'general commander killed airstrike assassination',     event: 'personnel_killed',         leaders: [], dims: ['survival','impulsivity','narcissism'] },
  { q: 'oil refinery port infrastructure attack strike',       event: 'infrastructure_attack',    leaders: [], dims: ['survival','impulsivity','accountability'] },
  { q: 'airstrike missile drone naval attack Middle East',     event: 'regional_strike',          leaders: [], dims: ['impulsivity','survival'] }
];

function classifyBloc(name) {
  const s = (name||'').toLowerCase();
  if (s.includes('irna')||s.includes('tasnim')||s.includes('press tv')||s.includes('iran international')||s.includes('radio farda')||s.includes('iranwire')) return 'persian';
  if (s.includes('al jazeera')||s.includes('middle east')||s.includes('haaretz')||s.includes('dawn')||s.includes('geo')||s.includes('ndtv')||s.includes('trt')||s.includes('arab news')||s.includes('gulf news')||s.includes('jerusalem post')||s.includes('the hindu')||s.includes('times of india')||s.includes('al-monitor')) return 'regional';
  if (s.includes('un news')||s.includes('iaea')||s.includes('human rights')||s.includes('amnesty')||s.includes('sipri')||s.includes('nato')||s.includes('pentagon')||s.includes('state department')||s.includes('centcom')) return 'institutional';
  return 'western';
}

function estimateEscalation(headline, cluster) {
  const h = (headline||'').toLowerCase();
  if (h.includes('nuclear')||h.includes('killed')||h.includes('assassinated')||h.includes('eliminated')||h.includes('collapse')) return 4;
  if (h.includes('strike')||h.includes('missile')||h.includes('attack')||h.includes('airstrike')||h.includes('drone')) return 3;
  if (h.includes('warning')||h.includes('threat')||h.includes('escalat')||h.includes('deploy')||h.includes('sanction')) return 3;
  if (cluster.event==='personnel_killed') return 4;
  if (cluster.event==='infrastructure_attack') return 3;
  if (cluster.variable==='nuclearSignalling') return 4;
  return 2;
}

// ── LANGUAGE + SOURCE QUALITY FILTERS ────────────────────────────────────────
function isEnglishHeadline(text) {
  if (!text) return false;
  const nonLatin = /[\u0600-\u06FF\u0900-\u097F\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF\u0400-\u04FF\u0A80-\u0AFF]/;
  return !nonLatin.test(text);
}
const BLOCKED_SOURCES = ['daily mail','daily star','the sun','mirror','express','metro','national enquirer','infowars','breitbart','the blaze','newsmax','oann','one america','zero hedge','zerohedge','sputnik','rt.com','russia today','globalresearch','veterans today','beforeitsnews'];
function isQualitySource(name) {
  const s = (name||'').toLowerCase();
  return !BLOCKED_SOURCES.some(b => s.includes(b));
}
function sanitiseDate(raw) {
  if (!raw) return new Date().toISOString().slice(0,10);
  const match = (raw||'').match(/(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : new Date().toISOString().slice(0,10);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── NEWSAPI ───────────────────────────────────────────────────────────────────
async function fetchFromNewsAPI(leaders) {
  if (!NEWS_API_KEY) return [];
  console.log('Fetching from NewsAPI...');
  const since = new Date(Date.now() - 7*24*60*60*1000).toISOString().slice(0,10);
  const items = [];
  const seen  = new Set();
  for (const cluster of NEWS_QUERIES) {
    try {
      const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(cluster.q)}&from=${since}&sortBy=publishedAt&pageSize=5&language=en&apiKey=${NEWS_API_KEY}`;
      const res  = await fetch(url);
      if (!res.ok) { console.warn(`  NewsAPI ${res.status}: ${cluster.q.slice(0,40)}`); continue; }
      const data = await res.json();
      if (data.status!=='ok'||!data.articles) continue;
      for (const a of data.articles) {
        const key = a.url||a.title;
        if (seen.has(key)) continue;
        seen.add(key);
        const sourceName = a.source && a.source.name ? a.source.name : 'Unknown';
        const bloc = classifyBloc(sourceName);
        items.push({
          headline:     a.title||'',
          summary:      a.description||(a.content||'').slice(0,250)||'',
          source:       sourceName,
          url:          a.url||null,
          bloc,
          date:         (a.publishedAt||'').slice(0,10),
          datetime:     a.publishedAt||new Date().toISOString(),
          leaders:      cluster.leaders||[],
          watch_terms:  [cluster.q.split(' ').slice(0,3).join(' ')],
          dimensions:   cluster.dims||[],
          variable_key: cluster.variable||null,
          event_type:   cluster.event||(cluster.variable?'static_variable':'leader_watch_term'),
          escalation:   estimateEscalation(a.title||'', cluster),
          persian_only: bloc==='persian',
          _from:        'newsapi'
        });
      }
      await sleep(1500);
    } catch(e) { console.warn(`  NewsAPI error: ${e.message}`); }
  }
  console.log(`  NewsAPI: ${items.length} items`);
  return items;
}

// ── CLAUDE GAP-FILL ───────────────────────────────────────────────────────────
async function fetchFromClaude(existingItems, leaders) {
  console.log('Claude gap-fill...');
  const leaderBlock = leaders.filter(l=>l.watch&&l.watch.length).map(l=>`${l.n||l.name}: ${(l.watch||[]).join(', ')}`).join('\n');
  const existingHeadlines = existingItems.map(i=>i.headline).join('\n').slice(0,3000);
  const system = `You are the intelligence gap-fill engine for the Accidental Geopolitical Tracker.
NewsAPI has fetched mainstream Western news. You cover what it cannot reach:
- Persian-bloc (Iran International, Radio Farda, IranWire — never IRNA/Tasnim as sole verification)
- Institutional (UN, IAEA, HRW, SIPRI, Arms Control Association, CENTCOM, NATO)
- South Asian (Dawn, Geo, NDTV, The Hindu) on India-Pakistan
- Any high-escalation event not yet covered

CRITICAL: ALL output in English only. No tabloids. No clickbait. Factual, neutral tone. Dates in YYYY-MM-DD.

ALREADY FETCHED — do not duplicate:
${existingHeadlines}

Return ONLY valid JSON:
{
  "items": [{
    "headline": "factual, neutral, English only",
    "summary": "2-3 sentences, English only",
    "source": "exact publication name",
    "url": "URL or null",
    "bloc": "western|persian|regional|institutional",
    "date": "YYYY-MM-DD",
    "datetime": "ISO 8601 full timestamp",
    "leaders": ["exact names"],
    "watch_terms": ["terms"],
    "dimensions": ["narcissism|impulsivity|values|survival|accountability"],
    "variable_key": "key or null",
    "event_type": "leader_watch_term|static_variable|personnel_killed|infrastructure_attack|regional_strike|leader_statement",
    "escalation": 3,
    "persian_only": false,
    "dimension_signal": {
      "leader": "name",
      "dimension": "impulsivity",
      "proposed_delta": 2,
      "rationale": "one sentence evidence-based reason",
      "confidence": "high|medium|low"
    }
  }]
}
dimension_signal: only include when this specific item provides clear evidence of a dimension change.`;
  const user = `Today: ${new Date().toISOString().slice(0,10)} — last 7 days.
Context: Iran-US-Israel war since Feb 28 2026. Strait ~70% closed. Pakistan on 3 fronts.
Leader watch terms:\n${leaderBlock}
Find 8-12 gap-fill items. Return valid JSON only.`;
  try {
    const raw    = await callWithSearch(system, user);
    const parsed = extractJson(raw);
    const items  = (parsed.items||[]).map(i=>({...i, _from:'claude'}));
    console.log(`  Claude: ${items.length} items, ${items.filter(i=>i.dimension_signal).length} with dimension signals`);
    return items;
  } catch(e) { console.warn(`  Claude gap-fill failed: ${e.message}`); return []; }
}

// ── NEWS HISTORY — 30-DAY ROLLING ARCHIVE ────────────────────────────────────
function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_PATH)) return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
  } catch(e) {}
  return { created: new Date().toISOString(), updated: new Date().toISOString(), retention_days: HISTORY_DAYS, items: [] };
}

function appendToHistory(newItems) {
  const history = loadHistory();
  const cutoff  = new Date(Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0,10);
  const runId   = new Date().toISOString().slice(0,16);

  // Deduplicate against existing history by headline
  const existingKeys = new Set(history.items.map(i => (i.headline||'').toLowerCase().slice(0,80)));
  const toAdd = newItems
    .filter(i => isEnglishHeadline(i.headline) && isQualitySource(i.source))
    .filter(i => !existingKeys.has((i.headline||'').toLowerCase().slice(0,80)))
    .map(i => ({ ...i, date: sanitiseDate(i.date), datetime: i.datetime||new Date().toISOString(), first_seen: new Date().toISOString(), run_id: runId, escalation: Math.max(1,Math.min(5,i.escalation||2)) }));

  // Trim items older than retention window
  const retained = history.items.filter(i => (i.date || '') >= cutoff);
  history.items    = [...retained, ...toAdd];
  history.updated  = new Date().toISOString();
  history.total_items_ever = (history.total_items_ever || 0) + toAdd.length;

  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
  console.log(`  History: +${toAdd.length} new items → ${history.items.length} total (${HISTORY_DAYS}-day window)`);
  return history;
}

// ── CUMULATIVE ANALYSIS ENGINE ────────────────────────────────────────────────
// Reads full history + current leader scores → evidence-backed proposals
async function runCumulativeAnalysis(leaders, history) {
  const items = history.items;
  if (items.length < 5) {
    console.log('  Analysis: insufficient history — skipping (need 5+ items)');
    return null;
  }

  console.log(`  Analysis: evaluating ${items.length} items across ${HISTORY_DAYS}-day window...`);

  // Build compact leader scores block
  const scoresBlock = leaders.map(l => {
    const d = l.dims || {};
    return `${l.n}: narcissism ${d.narcissism||'?'} · impulsivity ${d.impulsivity||'?'} · values ${d.values||'?'} · survival ${d.survival||'?'} · accountability ${d.accountability||'?'} · bellicosity ${l.b||'?'}`;
  }).join('\n');

  // Build compact history block — most recent items first, capped for context
  const historyBlock = items
    .slice(-MAX_HISTORY_ANALYSIS)
    .sort((a,b) => (b.date||'').localeCompare(a.date||''))
    .map(i => `[${i.date}][${i.bloc}][${i.source}] ${i.headline} | leaders: ${(i.leaders||[]).join(',')} | dims: ${(i.dimensions||[]).join(',')} | esc: ${i.escalation||'?'}`)
    .join('\n');

  const dateRange = items.length > 0
    ? `${items[0].date} to ${items[items.length-1].date}`
    : 'unknown';

  const system = `You are the cumulative analysis engine for the Accidental Geopolitical Tracker.
Your job is to evaluate the FULL accumulated news history to identify sustained patterns that justify proposing dimension score changes or variable value changes.

METHODOLOGY:
- Dimension weights: survival 25%, accountability 22%, narcissism 20%, impulsivity 18%, values 15%
- Proposal thresholds (minimum evidence required):
  survival ±2.0 → needs 3+ items, 2+ source blocs
  accountability ±2.3 → needs 3+ items, 2+ source blocs
  narcissism ±2.5 → needs 3+ items, 2+ source blocs
  impulsivity ±2.8 → needs 4+ items, 2+ source blocs
  values ±3.0 → needs 4+ items, 2+ source blocs
- A single dramatic event does NOT justify a proposal — look for SUSTAINED PATTERNS
- State media (IRNA, Tasnim, Press TV) never count toward verification
- All proposals require the human gate — you propose, Subha decides

DIMENSION DEFINITIONS (be precise):
- Accountability: degree to which a leader ACTIVELY DISMANTLED or DELIBERATELY BYPASSED accountability mechanisms — systemic, not personal
- Values: demonstrated ethical framework plus reform intent at personal political cost — not just harm record
- Survival: political/physical self-preservation as primary decision driver
- Impulsivity: frequency of unilateral, reactive, poorly-deliberated decisions
- Narcissism: need for validation, grandiosity, willingness to harm others for image

Return ONLY valid JSON:
{
  "analysis_period": {
    "start_date": "YYYY-MM-DD",
    "end_date": "YYYY-MM-DD",
    "items_evaluated": number,
    "source_blocs_represented": ["western","persian","regional","institutional"]
  },
  "leader_proposals": [
    {
      "leader": "exact name",
      "dimension": "narcissism|impulsivity|values|survival|accountability",
      "current_score": number,
      "proposed_delta": number,
      "proposed_new_score": number,
      "confidence": "high|medium|low",
      "pattern_description": "2-3 sentences describing the specific sustained behavioral pattern seen in the evidence",
      "evidence_chain": [
        {
          "date": "YYYY-MM-DD",
          "source": "publication",
          "bloc": "western|persian|regional|institutional",
          "headline": "exact headline from the history",
          "relevance": "one sentence: why this item specifically evidences this dimension change"
        }
      ],
      "items_supporting": number,
      "blocs_represented": ["western","regional"],
      "threshold_met": true,
      "counter_evidence": "any evidence that pushes back against this proposal, or null"
    }
  ],
  "variable_proposals": [
    {
      "variable": "oilPrice|straitControl|nuclearSignalling|congressConstraint|diplomaticChannels|armsControlArchitecture|netanyahuLegalJeopardy|iranRegimeCohesion",
      "current_assessment": "brief description of current state",
      "proposed_direction": "increase|decrease|hold",
      "confidence": "high|medium|low",
      "rationale": "2-3 sentences with specific evidence",
      "evidence_chain": [
        {
          "date": "YYYY-MM-DD",
          "source": "publication",
          "headline": "exact headline",
          "relevance": "why this item affects this variable"
        }
      ]
    }
  ],
  "no_change_assessment": "1-2 sentences on leaders/dimensions where evidence is insufficient or contradictory"
}

Only include proposals where the threshold is genuinely met. Quality over quantity. If no proposals meet the threshold, return empty arrays with a clear no_change_assessment.`;

  const user = `CURRENT LEADER SCORES (from leaders.json):
${scoresBlock}

NEWS HISTORY (${items.length} items, ${dateRange}):
${historyBlock}

Evaluate the full accumulated evidence. Identify sustained patterns. Return proposals only where thresholds are met. Return valid JSON only.`;

  try {
    // Analysis is pure reasoning — no web search needed
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'x-api-key':API_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:12000, system, messages:[{role:'user',content:user}] })
    });
    if (!res.ok) { const t=await res.text(); throw new Error(`HTTP ${res.status}: ${t.slice(0,300)}`); }
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const text = data.content.filter(b=>b.type==='text').map(b=>b.text).join('');
    const analysis = extractJson(text);
    const lp = (analysis.leader_proposals||[]).length;
    const vp = (analysis.variable_proposals||[]).length;
    console.log(`  Analysis complete: ${lp} leader proposals, ${vp} variable proposals`);
    return analysis;
  } catch(e) {
    console.warn(`  Cumulative analysis failed: ${e.message}`);
    return null;
  }
}

// ── CLAUDE API LOOP ───────────────────────────────────────────────────────────
async function callWithSearch(system, user) {
  const messages = [{ role:'user', content:user }];
  let iter = 0;
  while (iter++ < 20) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'x-api-key':API_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model:MODEL, max_tokens:8000, system, tools:[{type:'web_search_20250305',name:'web_search'}], messages })
    });
    if (!res.ok) { const t=await res.text(); throw new Error(`HTTP ${res.status}: ${t.slice(0,300)}`); }
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    console.log(`  iter ${iter} stop=${data.stop_reason}`);
    if (data.stop_reason==='end_turn') return data.content.filter(b=>b.type==='text').map(b=>b.text).join('');
    if (data.stop_reason==='tool_use') {
      messages.push({role:'assistant',content:data.content});
      const results = data.content.filter(b=>b.type==='tool_use').map(b=>({type:'tool_result',tool_use_id:b.id,content:b.output||b.content||'executed'}));
      if (results.length) messages.push({role:'user',content:results});
      continue;
    }
    const partial = data.content.filter(b=>b.type==='text').map(b=>b.text).join('');
    if (partial) return partial;
    throw new Error('Unexpected stop: '+data.stop_reason);
  }
  throw new Error('Max iterations exceeded');
}

function extractJson(text) {
  text = text.replace(/```json\s*/gi,'').replace(/```\s*/g,'').trim();
  const s = text.indexOf('{');
  if (s===-1) throw new Error('No JSON found');
  let d=0,e=-1;
  for (let i=s;i<text.length;i++) {
    if (text[i]==='{') d++;
    else if (text[i]==='}'){d--;if(d===0){e=i;break;}}
  }
  let j = e!==-1 ? text.slice(s,e+1) : text.slice(s);
  if (e===-1) {
    j=j.replace(/,\s*$/,'');
    const oc=(j.match(/{/g)||[]).length-(j.match(/}/g)||[]).length;
    const ac=(j.match(/\[/g)||[]).length-(j.match(/\]/g)||[]).length;
    for(let i=0;i<ac;i++) j+=']';
    for(let i=0;i<oc;i++) j+='}';
  }
  return JSON.parse(j.replace(/,\s*([\}\]])/g,'$1'));
}

function deduplicate(items) {
  const seen = new Set();
  return items
    .filter(i => isEnglishHeadline(i.headline))
    .filter(i => isQualitySource(i.source))
    .map(i => ({...i, date: sanitiseDate(i.date), datetime: i.datetime||new Date().toISOString(), escalation: Math.max(1,Math.min(5,i.escalation||2))}))
    .filter(i => {
      const k = (i.headline||'').toLowerCase().slice(0,60);
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
}

// ── RESEND EMAIL DIGEST ───────────────────────────────────────────────────────
async function sendEmailDigest(allItems, liveVars, brentPrice, analysis) {
  if (!RESEND_KEY || !NOTIFY_EMAIL) { console.log('Email skipped — keys not set'); return; }
  console.log('Sending email digest via Resend...');

  const highEsc     = allItems.filter(i=>i.escalation>=4).sort((a,b)=>b.escalation-a.escalation);
  const dimSignals  = allItems.filter(i=>i.dimension_signal);
  const persianOnly = allItems.filter(i=>i.persian_only);
  const now         = new Date().toUTCString();
  const oilLine     = brentPrice ? `$${brentPrice.toFixed(2)}/bbl → stress ${liveVars.oilStress}/100` : 'unavailable';
  const hasAnalysis = analysis && ((analysis.leader_proposals||[]).length > 0 || (analysis.variable_proposals||[]).length > 0);

  const shouldSend = highEsc.length > 0 || dimSignals.length > 0 || hasAnalysis;
  if (!shouldSend) { console.log('  Nothing to surface — skipping email'); return; }

  // ── HIGH ESCALATION TABLE ──
  const escHtml = highEsc.map(i => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #1C3525;vertical-align:top">
        <span style="font-family:monospace;font-size:10px;padding:2px 6px;border-radius:3px;background:${i.escalation>=5?'#5C1A1A':'#3D1F1F'};color:#F09090">${i.escalation}/5</span>
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #1C3525;vertical-align:top">
        <div style="font-weight:600;color:#E8F5EC;font-size:13px;margin-bottom:4px">${i.headline}</div>
        <div style="color:#A8C4B0;font-size:12px;line-height:1.5">${i.summary||''}</div>
        <div style="margin-top:6px;font-family:monospace;font-size:10px;color:#5A8068">
          ${i.source} · ${i.date} · <span style="padding:1px 5px;border-radius:2px;background:rgba(255,255,255,0.06)">${(i.bloc||'').toUpperCase()}</span>
          ${i.url ? ` · <a href="${i.url}" style="color:#5DCAA5">source ↗</a>` : ''}
        </div>
      </td>
    </tr>`).join('');

  // ── CUMULATIVE ANALYSIS PROPOSALS ──
  let analysisHtml = '';
  if (hasAnalysis) {
    const ap = analysis.analysis_period || {};
    analysisHtml += `
    <div style="margin-bottom:28px">
      <div style="font-family:monospace;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#E8C96A;margin-bottom:4px">Cumulative Analysis — ${ap.start_date||'?'} to ${ap.end_date||'?'}</div>
      <div style="font-family:monospace;font-size:9px;color:#5A8068;margin-bottom:14px">${ap.items_evaluated||0} items evaluated · ${(ap.source_blocs_represented||[]).join(', ')} · Awaiting your approval — nothing writes to leaders.json without you</div>`;

    // Leader dimension proposals
    if ((analysis.leader_proposals||[]).length > 0) {
      analysisHtml += `<div style="font-family:monospace;font-size:9px;letter-spacing:1px;text-transform:uppercase;color:#C48A92;margin-bottom:10px">Dimension Proposals (${analysis.leader_proposals.length})</div>`;
      analysis.leader_proposals.forEach(p => {
        const deltaColor = p.proposed_delta > 0 ? '#F09575' : '#5DCAA5';
        const deltaSign  = p.proposed_delta > 0 ? '+' : '';
        const confColor  = p.confidence==='high' ? '#5DCAA5' : p.confidence==='medium' ? '#E8C96A' : '#C48A92';
        analysisHtml += `
        <div style="background:#0D1A10;border:1px solid #162B1E;border-radius:8px;padding:16px;margin-bottom:12px">
          <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:8px">
            <div>
              <span style="font-weight:700;color:#E8F5EC;font-size:14px">${p.leader}</span>
              <span style="font-family:monospace;font-size:10px;color:#5A8068;margin-left:8px">— ${p.dimension.toUpperCase()}</span>
            </div>
            <div style="text-align:right">
              <span style="font-family:monospace;font-size:18px;font-weight:700;color:${deltaColor}">${deltaSign}${p.proposed_delta}</span>
              <span style="font-family:monospace;font-size:11px;color:#5A8068"> (${p.current_score} → ${p.proposed_new_score})</span>
              <span style="font-family:monospace;font-size:9px;padding:2px 6px;border-radius:3px;background:rgba(255,255,255,0.06);color:${confColor};margin-left:8px">${(p.confidence||'').toUpperCase()}</span>
            </div>
          </div>
          <p style="color:#A8C4B0;font-size:13px;line-height:1.6;margin:0 0 10px">${p.pattern_description||''}</p>
          <div style="font-family:monospace;font-size:9px;letter-spacing:1px;text-transform:uppercase;color:#3A5C45;margin-bottom:6px">Evidence chain (${p.items_supporting||0} items · ${(p.blocs_represented||[]).join(', ')})</div>
          ${(p.evidence_chain||[]).slice(0,4).map(ev => `
          <div style="border-left:2px solid #162B1E;padding:6px 10px;margin-bottom:4px">
            <div style="font-size:12px;color:#E8F5EC;font-weight:500">${ev.headline||''}</div>
            <div style="font-family:monospace;font-size:10px;color:#5A8068;margin-top:2px">${ev.date||''} · ${ev.source||''} · ${(ev.bloc||'').toUpperCase()}</div>
            <div style="font-size:11px;color:#A8C4B0;margin-top:3px;font-style:italic">${ev.relevance||''}</div>
          </div>`).join('')}
          ${p.counter_evidence ? `<div style="margin-top:8px;padding:8px 10px;background:rgba(201,168,76,0.08);border-radius:4px;font-size:11px;color:#E8C96A">⚑ Counter-evidence: ${p.counter_evidence}</div>` : ''}
        </div>`;
      });
    }

    // Variable proposals
    if ((analysis.variable_proposals||[]).length > 0) {
      analysisHtml += `<div style="font-family:monospace;font-size:9px;letter-spacing:1px;text-transform:uppercase;color:#85B7EB;margin:14px 0 10px">Variable Proposals (${analysis.variable_proposals.length})</div>`;
      analysis.variable_proposals.forEach(v => {
        const dirColor = v.proposed_direction==='increase' ? '#F09575' : v.proposed_direction==='decrease' ? '#5DCAA5' : '#E8C96A';
        analysisHtml += `
        <div style="background:#0D1A10;border:1px solid #162B1E;border-radius:8px;padding:14px;margin-bottom:10px">
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
            <span style="font-weight:600;color:#E8F5EC;font-size:13px">${v.variable||''}</span>
            <span style="font-family:monospace;font-size:11px;color:${dirColor};text-transform:uppercase">${v.proposed_direction||''}</span>
          </div>
          <p style="color:#A8C4B0;font-size:12px;line-height:1.6;margin:0 0 8px">${v.rationale||''}</p>
          ${(v.evidence_chain||[]).slice(0,2).map(ev=>`<div style="border-left:2px solid #162B1E;padding:4px 8px;margin-bottom:3px;font-size:11px;color:#A8C4B0">${ev.date||''} · ${ev.source||''} — ${ev.headline||''}</div>`).join('')}
        </div>`;
      });
    }

    if (analysis.no_change_assessment) {
      analysisHtml += `<div style="padding:10px 14px;background:rgba(58,92,69,0.1);border-radius:6px;font-size:12px;color:#5A8068;margin-top:8px">${analysis.no_change_assessment}</div>`;
    }
    analysisHtml += '</div>';
  }

  // ── PERSIAN-ONLY SIGNALS ──
  const persianHtml = persianOnly.length > 0 ? `
    <div style="margin-bottom:20px">
      <div style="font-family:monospace;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#F09575;margin-bottom:8px">Persian-Only Signals (${persianOnly.length}) — unverified, monitor closely</div>
      ${persianOnly.map(i=>`<div style="padding:8px 12px;margin-bottom:6px;background:#1A0D0D;border-left:3px solid #993C1D;border-radius:0 4px 4px 0;font-size:12px;color:#A8C4B0">${i.headline} <span style="color:#5A8068">· ${i.source} · ${i.date}</span></div>`).join('')}
    </div>` : '';

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#080F0A;font-family:'DM Sans',system-ui,sans-serif">
<div style="max-width:700px;margin:0 auto;padding:32px 24px">

  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:28px;padding-bottom:16px;border-bottom:1px solid #162B1E">
    <div>
      <div style="font-family:Georgia,serif;font-size:20px;font-weight:700;color:#E8F5EC">Accidental Geopolitical Tracker</div>
      <div style="font-family:monospace;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#5A8068;margin-top:3px">AGRA Intelligence Digest · ${now}</div>
    </div>
    <div style="text-align:right">
      <div style="font-family:monospace;font-size:10px;color:#5DCAA5">Brent crude</div>
      <div style="font-family:monospace;font-size:16px;font-weight:700;color:#E8C96A">${oilLine}</div>
    </div>
  </div>

  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:28px">
    ${[
      ['Items this run', allItems.length, '#5DCAA5'],
      ['High escalation', highEsc.length, highEsc.length>0?'#F09575':'#5A8068'],
      ['Dim proposals', (analysis&&analysis.leader_proposals||[]).length, (analysis&&(analysis.leader_proposals||[]).length>0)?'#E8C96A':'#5A8068'],
      ['Persian-only', persianOnly.length, persianOnly.length>0?'#F09575':'#5A8068']
    ].map(([label,val,color])=>`
    <div style="background:#0D1A10;border:1px solid #162B1E;border-radius:6px;padding:12px;text-align:center">
      <div style="font-family:monospace;font-size:22px;font-weight:700;color:${color}">${val}</div>
      <div style="font-family:monospace;font-size:9px;text-transform:uppercase;letter-spacing:1px;color:#5A8068;margin-top:4px">${label}</div>
    </div>`).join('')}
  </div>

  ${highEsc.length > 0 ? `
  <div style="margin-bottom:28px">
    <div style="font-family:monospace;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#C48A92;margin-bottom:10px">High Escalation Items (${highEsc.length})</div>
    <table style="width:100%;border-collapse:collapse;background:#0D1A10;border:1px solid #162B1E;border-radius:8px;overflow:hidden">
      ${escHtml}
    </table>
  </div>` : ''}

  ${analysisHtml}
  ${persianHtml}

  <div style="margin-top:32px;padding-top:16px;border-top:1px solid #162B1E;font-family:monospace;font-size:9px;color:#3A5C45;line-height:1.8">
    <div>AGRA GitHub Action · runs every 6 hours · NewsAPI + Commodity API + Claude web search + cumulative analysis</div>
    <div style="margin-top:4px">All proposals require human approval. Nothing writes to leaders.json without you.</div>
  </div>

</div></body></html>`;

  try {
    const leaderProposalCount = (analysis&&analysis.leader_proposals||[]).length;
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${RESEND_KEY}` },
      body: JSON.stringify({
        from:    'AGRA <agra@accidentalgeopoliticaltracker.com>',
        to:      [NOTIFY_EMAIL],
        subject: `AGRA · ${highEsc.length} high-esc · ${leaderProposalCount} dim proposals · Brent ${brentPrice ? '$'+brentPrice.toFixed(0) : 'N/A'}`,
        html
      })
    });
    const emailData = await emailRes.json();
    if (emailRes.ok) { console.log(`  Email sent → ${NOTIFY_EMAIL} (id: ${emailData.id})`); }
    else { console.warn(`  Email failed: ${JSON.stringify(emailData)}`); }
  } catch(e) { console.warn(`  Email error: ${e.message}`); }
}

// ── LEADERS ───────────────────────────────────────────────────────────────────
function loadLeaders() {
  if (!fs.existsSync(LEADERS_PATH)) return FALLBACK;
  const raw = JSON.parse(fs.readFileSync(LEADERS_PATH,'utf8'));
  return raw.leaders || raw || [];
}
const FALLBACK = [
  {n:'Donald J. Trump',      watch:['War Powers','Iran ceasefire','AUMF','Trump impeach']},
  {n:'Benjamin Netanyahu',   watch:['trial hearing','ICC Netanyahu','coalition collapse','ceasefire Gaza']},
  {n:'Mojtaba Khamenei',     watch:['Supreme Leader Iran','IRGC','Strait Hormuz','nuclear Iran']},
  {n:'Mohammed bin Salman',  watch:['Saudi Arabia Iran','Khashoggi','executions Saudi','MBS']},
  {n:'Narendra Modi',        watch:['India Pakistan','No First Use','LoC violations']},
  {n:'General Asim Munir',   watch:['Pakistan military','India Pakistan border','LoC','Pakistan nuclear']},
  {n:'Vladimir Putin',       watch:['Ukraine ceasefire','ICC Putin','Russia nuclear','New START']},
  {n:'Kim Jong-un',          watch:['DPRK missile','North Korea nuclear','DPRK Russia']},
  {n:'Xi Jinping',           watch:['China Taiwan','China Iran','South China Sea','China nuclear']},
  {n:'Volodymyr Zelensky',   watch:['Ukraine ceasefire','Zelensky corruption','NATO Ukraine']},
  {n:'Recep Tayyip Erdogan', watch:['Turkey NATO','S-400 Turkey','Turkey Iran','Imamoglu']}
];

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('── AGRA News Feed Updater ───────────────────────────────────');
  console.log('Timestamp:', new Date().toISOString());
  console.log('NewsAPI + Commodity API + Claude gap-fill + History + Analysis + Email\n');

  const leaders    = loadLeaders();
  const brentPrice = await fetchBrentPrice();
  const oilStress  = calcOilStress(brentPrice);
  console.log(`Oil: $${brentPrice?.toFixed(2)??'N/A'} → stress ${oilStress??'N/A'}/100\n`);

  // 1. Fetch news
  const newsApiItems = await fetchFromNewsAPI(leaders);
  console.log();
  const claudeItems  = await fetchFromClaude(newsApiItems, leaders);
  console.log();
  const allItems     = deduplicate([...newsApiItems, ...claudeItems]);

  // 2. Append to 30-day rolling history
  console.log('Updating news history...');
  const history = appendToHistory(allItems);
  console.log();

  // 3. Cumulative analysis — wait 65s to clear the 30k token/min rate limit window
  // (Claude gap-fill uses ~20k tokens; analysis needs another ~25k)
  console.log('Waiting 65s before analysis to clear rate limit window...');
  await sleep(65000);
  console.log('Running cumulative analysis...');
  const analysis = await runCumulativeAnalysis(leaders, history);
  console.log();

  // 4. Build news.json (current run)
  const liveVariables = { oilPrice: brentPrice ? Math.round(brentPrice) : null, oilStress, updatedAt: new Date().toISOString() };
  const output = {
    ts: new Date().toISOString(), lookback_days: 7, generated_by: 'AGRA GitHub Action',
    sources_used: { newsapi: !!NEWS_API_KEY, commodity: !!COMMODITY_KEY, claude: true },
    live_variables: liveVariables,
    items: allItems
  };

  const byType = allItems.reduce((a,i)=>{a[i.event_type||'?']=(a[i.event_type||'?']||0)+1;return a;},{});
  const byEsc  = allItems.reduce((a,i)=>{a[i.escalation]=(a[i.escalation]||0)+1;return a;},{});

  console.log('── Results ─────────────────────────────────────────────────');
  console.log(`Items: ${allItems.length}  (NewsAPI: ${allItems.filter(i=>i._from==='newsapi').length}  Claude: ${allItems.filter(i=>i._from==='claude').length})`);
  console.log('By type:', byType);
  console.log('By esc:', byEsc);
  console.log(`History total: ${history.items.length} items over ${HISTORY_DAYS} days`);
  console.log(`Analysis: ${(analysis&&analysis.leader_proposals||[]).length} leader proposals, ${(analysis&&analysis.variable_proposals||[]).length} variable proposals`);

  fs.writeFileSync(NEWS_PATH, JSON.stringify(output, null, 2));
  console.log(`\nWrote news.json (${(JSON.stringify(output).length/1024).toFixed(1)} KB)`);

  // Write proposals.json for dashboard Watch page
  if (analysis && ((analysis.leader_proposals||[]).length > 0 || (analysis.variable_proposals||[]).length > 0)) {
    const proposalsOutput = { ...analysis, generated_at: new Date().toISOString() };
    fs.writeFileSync(PROPOSALS_PATH, JSON.stringify(proposalsOutput, null, 2));
    console.log(`Wrote proposals.json (${(analysis.leader_proposals||[]).length} leader proposals, ${(analysis.variable_proposals||[]).length} variable proposals)`);
  }

  // 5. Send email
  await sendEmailDigest(allItems, liveVariables, brentPrice, analysis);
  console.log('── Done ─────────────────────────────────────────────────────');
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });

#!/usr/bin/env node
/**
 * AGRA News Feed Updater — Full Coverage Build
 * Sources:
 *   1. NewsAPI.org      → primary news feed        (NEWS_API_KEY)
 *   2. Commodity API    → live Brent crude price    (COMMODITY_API_KEY)
 *   3. Claude web search → gap-fill, Persian bloc  (ANTHROPIC_API_KEY)
 * Post-run:
 *   4. Resend email     → digest + dimension signals (RESENT_API_KEY + NOTIFY_EMAIL)
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

const MODEL        = 'claude-sonnet-4-20250514';
const NEWS_PATH    = path.join(__dirname, '..', 'news.json');
const LEADERS_PATH = path.join(__dirname, '..', 'leaders.json');

// ── OIL STRESS ────────────────────────────────────────────────────────────────
function calcOilStress(price) {
  if (!price || isNaN(price)) return null;
  return Math.round(Math.min(100, Math.max(0, ((price - 60) / 100) * 100)));
}

// ── COMMODITY API ─────────────────────────────────────────────────────────────
async function fetchBrentPrice() {
  if (!COMMODITY_KEY) return null;
  console.log('Fetching Brent crude...');
  const attempts = [
    { url: `https://www.alphavantage.co/query?function=BRENT&interval=daily&apikey=${COMMODITY_KEY}`,
      parse: d => d.data && d.data[0] ? parseFloat(d.data[0].value) : null },
    { url: `https://financialmodelingprep.com/api/v3/quote/BCOUSD?apikey=${COMMODITY_KEY}`,
      parse: d => Array.isArray(d) && d[0] ? parseFloat(d[0].price) : null },
    { url: `https://api.twelvedata.com/price?symbol=BRENT&apikey=${COMMODITY_KEY}`,
      parse: d => d.price ? parseFloat(d.price) : null },
    { url: `https://commodities-api.com/api/latest?access_key=${COMMODITY_KEY}&base=USD&symbols=BRENT`,
      parse: d => d.data && d.data.rates && d.data.rates.BRENT ? parseFloat(d.data.rates.BRENT) : null }
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
  console.warn('  Brent fetch failed across all formats');
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
  if (cluster.event==='personnel_killed')      return 4;
  if (cluster.event==='infrastructure_attack') return 3;
  if (cluster.variable==='nuclearSignalling')  return 4;
  return 2;
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
      await sleep(1100);
    } catch(e) { console.warn(`  NewsAPI error: ${e.message}`); }
  }
  console.log(`  NewsAPI: ${items.length} items`);
  return items;
}

// ── CLAUDE GAP-FILL ───────────────────────────────────────────────────────────
async function fetchFromClaude(existingItems, leaders) {
  console.log('Claude gap-fill + dimension signal generation...');
  const leaderBlock = leaders.filter(l=>l.watch&&l.watch.length).map(l=>`${l.n||l.name}: ${(l.watch||[]).join(', ')}`).join('\n');
  const existingHeadlines = existingItems.map(i=>i.headline).join('\n').slice(0,3000);

  const system = `You are the intelligence gap-fill engine for the Accidental Geopolitical Tracker.
NewsAPI has fetched mainstream Western news. You cover what it cannot reach:
- Persian-bloc (Iran International, Radio Farda, IranWire — never IRNA/Tasnim as sole verification)
- Institutional (UN, IAEA, HRW, SIPRI, Arms Control Association, CENTCOM, NATO)
- South Asian (Dawn, Geo, NDTV, The Hindu) on India-Pakistan
- Any high-escalation event (personnel killed, infrastructure attacked, nuclear signal) not yet covered

ALREADY FETCHED — do not duplicate:
${existingHeadlines}

Return ONLY valid JSON:
{
  "items": [
    {
      "headline": "factual only",
      "summary": "2-3 sentences",
      "source": "exact publication name",
      "url": "URL or null",
      "bloc": "western|persian|regional|institutional",
      "date": "YYYY-MM-DD",
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
    }
  ]
}
dimension_signal is optional — only include when this specific item provides clear evidence of a dimension change. Leave null otherwise.`;

  const user = `Today: ${new Date().toISOString().slice(0,10)} — last 7 days.
Context: Iran-US-Israel war since Feb 28 2026. Strait ~70% closed. Pakistan on 3 fronts.

Leader watch terms:
${leaderBlock}

Find 8-12 gap-fill items. For each item where the evidence clearly points to a dimension shift for a specific leader, include a dimension_signal. Return valid JSON only.`;

  try {
    const raw    = await callWithSearch(system, user);
    const parsed = extractJson(raw);
    const items  = (parsed.items||[]).map(i=>({...i, _from:'claude'}));
    console.log(`  Claude: ${items.length} items, ${items.filter(i=>i.dimension_signal).length} with dimension signals`);
    return items;
  } catch(e) {
    console.warn(`  Claude gap-fill failed: ${e.message}`);
    return [];
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
  return items.filter(i => {
    const k = (i.headline||'').toLowerCase().slice(0,60);
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

// ── RESEND EMAIL DIGEST ───────────────────────────────────────────────────────
async function sendEmailDigest(allItems, liveVars, brentPrice) {
  if (!RESEND_KEY || !NOTIFY_EMAIL) {
    console.log('Email skipped — RESENT_API_KEY or NOTIFY_EMAIL not set');
    return;
  }
  console.log('Sending email digest via Resend...');

  const highEsc       = allItems.filter(i=>i.escalation>=4).sort((a,b)=>b.escalation-a.escalation);
  const dimSignals    = allItems.filter(i=>i.dimension_signal);
  const persianOnly   = allItems.filter(i=>i.persian_only);
  const now           = new Date().toUTCString();
  const oilLine       = brentPrice ? `$${brentPrice.toFixed(2)}/bbl → stress ${liveVars.oilStress}/100` : 'unavailable';

  // Only send if there's something worth surfacing
  const shouldSend = highEsc.length > 0 || dimSignals.length > 0;
  if (!shouldSend) {
    console.log('  No high-escalation items or dimension signals — skipping email');
    return;
  }

  const escHtml = highEsc.map(i => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #1C3525;vertical-align:top">
        <span style="font-family:monospace;font-size:10px;padding:2px 6px;border-radius:3px;background:${i.escalation>=5?'#5C1A1A':i.escalation>=4?'#3D1F1F':'#2A2000'};color:${i.escalation>=4?'#F09090':'#E8C96A'}">${i.escalation}/5</span>
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #1C3525;vertical-align:top">
        <div style="font-weight:600;color:#E8F5EC;font-size:13px;margin-bottom:4px">${i.headline}</div>
        <div style="color:#A8C4B0;font-size:12px;line-height:1.5">${i.summary}</div>
        <div style="margin-top:6px;font-family:monospace;font-size:10px;color:#5A8068">
          ${i.source} · ${i.date} · <span style="padding:1px 5px;border-radius:2px;background:rgba(255,255,255,0.06)">${i.bloc.toUpperCase()}</span>
          ${i.url ? ` · <a href="${i.url}" style="color:#5DCAA5">source ↗</a>` : ''}
        </div>
      </td>
    </tr>`).join('');

  const dimHtml = dimSignals.map(i => {
    const s = i.dimension_signal;
    const deltaColor = s.proposed_delta > 0 ? '#F09575' : '#5DCAA5';
    const deltaSign  = s.proposed_delta > 0 ? '+' : '';
    return `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #1C3525;vertical-align:top">
        <div style="font-weight:600;color:#E8F5EC;font-size:12px">${s.leader}</div>
        <div style="font-family:monospace;font-size:10px;color:#A8C4B0;margin-top:2px">${s.dimension}</div>
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #1C3525;vertical-align:top;text-align:center">
        <span style="font-family:monospace;font-size:16px;font-weight:700;color:${deltaColor}">${deltaSign}${s.proposed_delta}</span>
        <div style="font-family:monospace;font-size:9px;color:#5A8068;margin-top:2px">${s.confidence.toUpperCase()}</div>
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #1C3525;vertical-align:top">
        <div style="color:#A8C4B0;font-size:12px;line-height:1.5">${s.rationale}</div>
        <div style="margin-top:4px;font-size:11px;color:#5A8068;font-style:italic">${i.headline}</div>
      </td>
    </tr>`;
  }).join('');

  const persianHtml = persianOnly.length > 0 ? `
    <div style="margin-top:24px">
      <div style="font-family:monospace;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#F09575;margin-bottom:8px">Persian-Only Signals (${persianOnly.length}) — unverified, monitor closely</div>
      ${persianOnly.map(i=>`<div style="padding:8px 12px;margin-bottom:6px;background:#1A0D0D;border-left:3px solid #993C1D;border-radius:0 4px 4px 0;font-size:12px;color:#A8C4B0">${i.headline} <span style="color:#5A8068">· ${i.source}</span></div>`).join('')}
    </div>` : '';

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#080F0A;font-family:'DM Sans',system-ui,sans-serif">
<div style="max-width:680px;margin:0 auto;padding:32px 24px">

  <!-- Header -->
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

  <!-- Stats row -->
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:28px">
    ${[
      ['Total items', allItems.length, '#5DCAA5'],
      ['High escalation', highEsc.length, highEsc.length>0?'#F09575':'#5A8068'],
      ['Dimension signals', dimSignals.length, dimSignals.length>0?'#E8C96A':'#5A8068'],
      ['Persian-only', persianOnly.length, persianOnly.length>0?'#F09575':'#5A8068']
    ].map(([label,val,color])=>`
    <div style="background:#0D1A10;border:1px solid #162B1E;border-radius:6px;padding:12px;text-align:center">
      <div style="font-family:monospace;font-size:22px;font-weight:700;color:${color}">${val}</div>
      <div style="font-family:monospace;font-size:9px;text-transform:uppercase;letter-spacing:1px;color:#5A8068;margin-top:4px">${label}</div>
    </div>`).join('')}
  </div>

  ${highEsc.length > 0 ? `
  <!-- High escalation -->
  <div style="margin-bottom:28px">
    <div style="font-family:monospace;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#C48A92;margin-bottom:10px">High Escalation Items (${highEsc.length})</div>
    <table style="width:100%;border-collapse:collapse;background:#0D1A10;border:1px solid #162B1E;border-radius:8px;overflow:hidden">
      ${escHtml}
    </table>
  </div>` : ''}

  ${dimSignals.length > 0 ? `
  <!-- Dimension signals -->
  <div style="margin-bottom:28px">
    <div style="font-family:monospace;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#E8C96A;margin-bottom:10px">Dimension Signals — Proposed · Awaiting Your Approval</div>
    <table style="width:100%;border-collapse:collapse;background:#0D1A10;border:1px solid #162B1E;border-radius:8px;overflow:hidden">
      <tr style="background:#112014">
        <th style="font-family:monospace;font-size:8px;letter-spacing:2px;text-transform:uppercase;color:#5A8068;padding:8px 12px;text-align:left">Leader / Dimension</th>
        <th style="font-family:monospace;font-size:8px;letter-spacing:2px;text-transform:uppercase;color:#5A8068;padding:8px 12px;text-align:center">Delta</th>
        <th style="font-family:monospace;font-size:8px;letter-spacing:2px;text-transform:uppercase;color:#5A8068;padding:8px 12px;text-align:left">Evidence</th>
      </tr>
      ${dimHtml}
    </table>
    <div style="margin-top:8px;font-size:11px;color:#3A5C45;font-style:italic">Nothing writes to leaders.json without your approval. These are proposals only.</div>
  </div>` : ''}

  ${persianHtml}

  <!-- Footer -->
  <div style="margin-top:32px;padding-top:16px;border-top:1px solid #162B1E;font-family:monospace;font-size:9px;color:#3A5C45;line-height:1.8">
    <div>AGRA GitHub Action · runs every 6 hours · sources: NewsAPI + Commodity API + Claude web search</div>
    <div style="margin-top:4px">This is an automated digest. No scores have been changed. Human gate intact.</div>
  </div>

</div>
</body>
</html>`;

  try {
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${RESEND_KEY}` },
      body: JSON.stringify({
        from:    'AGRA <agra@accidentalgeopoliticaltracker.com>',
        to:      [NOTIFY_EMAIL],
        subject: `AGRA · ${highEsc.length} high-esc · ${dimSignals.length} dim signals · Brent ${brentPrice ? '$'+brentPrice.toFixed(0) : 'N/A'}`,
        html
      })
    });
    const emailData = await emailRes.json();
    if (emailRes.ok) {
      console.log(`  Email sent → ${NOTIFY_EMAIL} (id: ${emailData.id})`);
    } else {
      console.warn(`  Email failed: ${JSON.stringify(emailData)}`);
    }
  } catch(e) {
    console.warn(`  Email error: ${e.message}`);
  }
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
  console.log('NewsAPI + Commodity API + Claude gap-fill + Resend digest\n');

  const leaders    = loadLeaders();
  const brentPrice = await fetchBrentPrice();
  const oilStress  = calcOilStress(brentPrice);
  console.log(`Oil stress: ${oilStress??'N/A'}/100  Brent: $${brentPrice?.toFixed(2)??'N/A'}\n`);

  const newsApiItems = await fetchFromNewsAPI(leaders);
  console.log();
  const claudeItems  = await fetchFromClaude(newsApiItems, leaders);
  console.log();

  const allItems = deduplicate([...newsApiItems, ...claudeItems]);

  const liveVariables = {
    oilPrice:  brentPrice ? Math.round(brentPrice) : null,
    oilStress: oilStress,
    updatedAt: new Date().toISOString()
  };

  const output = {
    ts:             new Date().toISOString(),
    lookback_days:  7,
    generated_by:   'AGRA GitHub Action',
    sources_used:   { newsapi: !!NEWS_API_KEY, commodity: !!COMMODITY_KEY, claude: true },
    live_variables: liveVariables,
    items:          allItems
  };

  const byType = allItems.reduce((a,i)=>{a[i.event_type||'?']=(a[i.event_type||'?']||0)+1;return a;},{});
  const byEsc  = allItems.reduce((a,i)=>{a[i.escalation]=(a[i.escalation]||0)+1;return a;},{});

  console.log('── Results ─────────────────────────────────────────────────');
  console.log(`Items: ${allItems.length}  (NewsAPI: ${allItems.filter(i=>i._from==='newsapi').length}  Claude: ${allItems.filter(i=>i._from==='claude').length})`);
  console.log('By type:', byType);
  console.log('By esc:', byEsc);
  console.log(`Dim signals: ${allItems.filter(i=>i.dimension_signal).length}`);
  console.log(`Persian-only: ${allItems.filter(i=>i.persian_only).length}`);

  fs.writeFileSync(NEWS_PATH, JSON.stringify(output, null, 2));
  console.log(`\nWrote news.json (${(JSON.stringify(output).length/1024).toFixed(1)} KB)`);

  await sendEmailDigest(allItems, liveVariables, brentPrice);
  console.log('── Done ─────────────────────────────────────────────────────');
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });

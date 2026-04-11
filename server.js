/**
 * SA Lottery Live Results API v2.0
 * ─────────────────────────────────────────────
 * Scrapes lottery.co.za (clean table format)
 * for all 7 SA lottery games nightly.
 *
 * Deploy to Render:
 *   Build: npm install
 *   Start: node server.js
 */

'use strict';

const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');
const cheerio = require('cheerio');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── CORS: allow all origins including file:// ───────────
app.use(cors({
  origin: (origin, cb) => cb(null, true),
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','x-update-token'],
  credentials: false
}));
app.options('*', cors());
app.use(express.json());

// ─── DATA STORE ──────────────────────────────────────────
const DATA_FILE = path.join(__dirname, 'results_cache.json');
let cache = { lastUpdated: null, draws: [] };

function loadCache() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      cache = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      console.log(`[Cache] Loaded ${cache.draws.length} draws`);
    }
  } catch(e) { console.error('[Cache] Load error:', e.message); }
}

function saveCache() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(cache, null, 2)); }
  catch(e) { console.error('[Cache] Save error:', e.message); }
}

// ─── GAME URL MAP ────────────────────────────────────────
// lottery.co.za confirmed table structure:
// | Draw Date | Draw Number | Results | Jackpot |
// NB: SA Lotto changed from 6/52 to 6/58 on 21 September 2025
// NB: za.national-lottery.com has an "Outcome" column (Roll/Won) — use that for jackpot detection
const GAME_URLS = [
  { gk:'powerball',      name:'POWERBALL',        baseUrl:'https://www.lottery.co.za/powerball/results',        pick:5, pbPool:20,   maxMain:50 },
  { gk:'powerball-plus', name:'POWERBALL PLUS',   baseUrl:'https://www.lottery.co.za/powerball-plus/results',   pick:5, pbPool:20,   maxMain:50 },
  { gk:'lotto',          name:'LOTTO',            baseUrl:'https://www.lottery.co.za/lotto/results',            pick:6, pbPool:null, maxMain:58 },
  { gk:'lotto-plus',     name:'LOTTO PLUS 1',     baseUrl:'https://www.lottery.co.za/lotto-plus-1/results',     pick:6, pbPool:null, maxMain:58 },
  { gk:'lotto-plus2',    name:'LOTTO PLUS 2',     baseUrl:'https://www.lottery.co.za/lotto-plus-2/results',     pick:6, pbPool:null, maxMain:58 },
  { gk:'daily',          name:'DAILY LOTTO',      baseUrl:'https://www.lottery.co.za/daily-lotto/results',      pick:5, pbPool:null, maxMain:36 },
  { gk:'daily-plus',     name:'DAILY LOTTO PLUS', baseUrl:'https://www.lottery.co.za/daily-lotto-plus/results', pick:5, pbPool:null, maxMain:36 }
];

// ─── SECONDARY SOURCE — za.national-lottery.com ──────────
// This site has an explicit "Outcome" column (Roll/Won)
// which gives us definitive jackpot won detection
const NL_URLS = [
  { gk:'lotto',       url:'https://za.national-lottery.com/lotto/results/{year}-archive',       pick:6, maxMain:58 },
  { gk:'lotto-plus',  url:'https://za.national-lottery.com/lotto-plus-1/results/{year}-archive',pick:6, maxMain:58 },
  { gk:'lotto-plus2', url:'https://za.national-lottery.com/lotto-plus-2/results/{year}-archive',pick:6, maxMain:58 },
];

async function scrapeNationalLottery(game, year) {
  const url = game.url.replace('{year}', year);
  try {
    const res = await axios.get(url, {
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Referer': 'https://za.national-lottery.com/'
      }
    });
    const $ = cheerio.load(res.data);
    const results = [];

    // Table: Draw Date | Results | Jackpot | Outcome
    $('table tr').each((i, row) => {
      if (i === 0) return;
      const cells = $(row).find('td');
      if (cells.length < 3) return;

      const dateText    = $(cells[0]).text().trim();
      const resultsText = $(cells[1]).text().trim();
      const jackpotText = cells.length >= 3 ? $(cells[2]).text().trim() : '';
      const outcomeText = cells.length >= 4 ? $(cells[3]).text().trim().toLowerCase() : '';

      const date = parseDate(dateText);
      if (!date) return;

      // Extract ball numbers — results cell contains list items or space-separated nums
      const nums = [];
      $(cells[1]).find('li').each((_,li) => {
        const n = parseInt($(li).text().trim());
        if (!isNaN(n)) nums.push(n);
      });
      // Fallback: parse from text
      if (nums.length === 0) {
        resultsText.split(/\s+/).forEach(s => {
          const n = parseInt(s);
          if (!isNaN(n) && n >= 1) nums.push(n);
        });
      }

      if (nums.length < game.pick) return;

      // First 'pick' numbers = main balls, next = bonus ball
      const balls  = nums.slice(0, game.pick);
      const bonus  = nums.length > game.pick ? nums[game.pick] : null;

      if (balls.some(b => b < 1 || b > game.maxMain)) return;
      if (new Set(balls).size !== balls.length) return;

      // Outcome column gives us definitive jackpot won status
      const jackpotWon = outcomeText.includes('won') || outcomeText.includes('win');
      const jackpot = parseJackpot(jackpotText);

      results.push({
        date, game: game.gk, balls,
        bonus: null,  // lotto bonus not player-selected
        powerball: null,
        jackpotWon,
        jackpot,
        source: 'national-lottery.com'
      });
    });

    console.log(`[NL Scraper] ${game.gk} ${year}: ${results.length} draws from ${url}`);
    return results;
  } catch(e) {
    console.error(`[NL Scraper] Failed ${game.gk} ${year}:`, e.message);
    return [];
  }
}
async function scrapeGame(game, year) {
  // Confirmed URL format: /powerball/results/2026 (no trailing slash)
  const url = `${game.baseUrl}/${year}`;
  try {
    const res = await axios.get(url, {
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-ZA,en;q=0.9',
        'Referer': 'https://www.lottery.co.za/'
      }
    });

    const $ = cheerio.load(res.data);
    const results = [];

    // Confirmed table structure from live inspection:
    // <table> with rows: Draw Date | Draw Number | Results | Jackpot
    // Results cell contains numbers separated by whitespace
    // e.g. "11  13  19  22  39  1" — for PB games last number is the Powerball
    $('table tr').each((i, row) => {
      if (i === 0) return; // skip header row

      const cells = $(row).find('td');
      if (cells.length < 3) return;

      const dateText    = $(cells[0]).text().trim();
      const resultsText = $(cells[2]).text().trim();
      const jackpotText = cells.length >= 4 ? $(cells[3]).text().trim() : '';

      const date = parseDate(dateText);
      if (!date) return;

      // Split result numbers — handles multiple spaces between numbers
      const nums = resultsText
        .split(/\s+/)
        .map(n => parseInt(n.trim()))
        .filter(n => !isNaN(n) && n >= 1 && n <= 100);

      // Need at least pick count numbers
      const totalExpected = game.pick + (game.pbPool ? 1 : 0);
      if (nums.length < game.pick) {
        console.log(`[Parse] ${game.name} ${date}: only ${nums.length} numbers, expected ${totalExpected} — skipping`);
        return;
      }

      const balls     = nums.slice(0, game.pick);
      const powerball = game.pbPool ? (nums[game.pick] || null) : null;

      // Validate ranges
      if (balls.some(b => b < 1 || b > game.maxMain)) {
        console.log(`[Parse] ${game.name} ${date}: ball out of range [${balls}]`);
        return;
      }
      if (new Set(balls).size !== balls.length) {
        console.log(`[Parse] ${game.name} ${date}: duplicate balls [${balls}]`);
        return;
      }
      if (powerball !== null && (powerball < 1 || powerball > game.pbPool)) {
        console.log(`[Parse] ${game.name} ${date}: PB ${powerball} out of range`);
        return;
      }

      const jackpot = parseJackpot(jackpotText);

      results.push({
        date,
        game: game.gk,
        balls,
        bonus: null,
        powerball,
        jackpotWon: false, // resolved in post-processing
        jackpot,
        source: 'lottery.co.za'
      });
    });

    console.log(`[Scraper] ${game.name} ${year}: parsed ${results.length} draws from ${url}`);
    return results;

  } catch(e) {
    console.error(`[Scraper] Failed ${game.name} ${year} (${url}):`, e.message);
    return [];
  }
}

// ─── DATE PARSER ─────────────────────────────────────────
function parseDate(str) {
  if (!str) return null;
  // "Tuesday, 24 March 2026" or "24 March 2026"
  const months = {
    January:'01',February:'02',March:'03',April:'04',
    May:'05',June:'06',July:'07',August:'08',
    September:'09',October:'10',November:'11',December:'12'
  };
  const m = str.match(/(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${months[m[2]]}-${m[1].padStart(2,'0')}`;
}

// ─── JACKPOT PARSER ──────────────────────────────────────
function parseJackpot(str) {
  if (!str) return null;
  // "R108,434,601.60" or "R5 million" or "R108.4 million"
  const clean = str.replace(/[R\s]/g,'');
  const mMillion = clean.match(/^([\d.]+)[Mm]/);
  if (mMillion) return Math.round(parseFloat(mMillion[1]) * 1e6);
  const mPlain = clean.replace(/,/g,'').match(/^[\d.]+$/);
  if (mPlain) return Math.round(parseFloat(clean.replace(/,/g,'')));
  return null;
}

// ─── RESOLVE JACKPOT WON ─────────────────────────────────
// After scraping, walk through each game's draws chronologically.
// A jackpot was won when the next draw's jackpot is significantly
// lower than expected rollover progression (reset to base).
function resolveJackpotWon(draws) {
  const BASE_JACKPOTS = {
    'powerball': 5e6, 'powerball-plus': 5e6,
    'lotto': 5e6, 'lotto-plus': 2e6, 'lotto-plus2': 1e6,
    'daily': 1e5, 'daily-plus': 5e4
  };

  const byGame = {};
  draws.forEach(d => {
    if (!byGame[d.game]) byGame[d.game] = [];
    byGame[d.game].push(d);
  });

  for (const [gk, gameDrws] of Object.entries(byGame)) {
    const sorted = gameDrws.sort((a,b) => new Date(a.date) - new Date(b.date));
    const base = BASE_JACKPOTS[gk] || 5e6;

    for (let i = 0; i < sorted.length - 1; i++) {
      const curr = sorted[i];
      const next = sorted[i + 1];
      if (curr.jackpot && next.jackpot) {
        // If next jackpot dropped significantly (to near base), current draw was won
        if (next.jackpot <= base * 2 && curr.jackpot > base * 5) {
          curr.jackpotWon = true;
        }
      }
    }
    // Last draw: check if jackpot is near base (recently won)
    const last = sorted[sorted.length - 1];
    if (last && last.jackpot && last.jackpot <= BASE_JACKPOTS[gk] * 1.5) {
      last.jackpotWon = true;
    }
  }

  return draws;
}

// ─── MERGE ───────────────────────────────────────────────
function mergeDraws(newDraws) {
  const existing = new Set(cache.draws.map(d => `${d.date}_${d.game}`));
  let added = 0;
  for (const d of newDraws) {
    const key = `${d.date}_${d.game}`;
    if (!existing.has(key)) {
      cache.draws.push(d);
      existing.add(key);
      added++;
    }
  }
  cache.draws.sort((a,b) => new Date(a.date) - new Date(b.date));
  cache.lastUpdated = new Date().toISOString();
  return added;
}

// ─── FULL UPDATE ─────────────────────────────────────────
async function runUpdate() {
  console.log(`[Update] Starting at ${new Date().toISOString()}`);
  const currentYear = new Date().getFullYear();
  const allNew = [];

  // Use national-lottery.com for Lotto games (has outcome column + 1-58 range)
  for (const game of NL_URLS) {
    const years = cache.draws.filter(d=>d.game===game.gk).length === 0
      ? [currentYear - 1, currentYear]
      : [currentYear];
    for (const year of years) {
      const results = await scrapeNationalLottery(game, year);
      allNew.push(...results);
      await sleep(1200);
    }
  }

  // Use lottery.co.za for all other games
  const otherGames = GAME_URLS.filter(g => !['lotto','lotto-plus','lotto-plus2'].includes(g.gk));
  for (const game of otherGames) {
    const years = cache.draws.filter(d=>d.game===game.gk).length === 0
      ? [currentYear - 1, currentYear]
      : [currentYear];
    for (const year of years) {
      const results = await scrapeGame(game, year);
      allNew.push(...results);
      await sleep(1200);
    }
  }

  // For Lotto games, remove old draws with wrong ball range (pre-fix stale data)
  // Any Lotto draw after Sep 21 2025 that has balls <= 52 max should be re-evaluated
  // We simply allow the new scrape to overwrite via the merge (same date+game key = skip)
  // But we must purge stale entries that were rejected with wrong maxMain
  const staleLottoDates = new Set(
    allNew.filter(d=>['lotto','lotto-plus','lotto-plus2'].includes(d.game)).map(d=>d.date)
  );
  // Remove cached lotto draws that are being re-scraped
  cache.draws = cache.draws.filter(d =>
    !['lotto','lotto-plus','lotto-plus2'].includes(d.game) || !staleLottoDates.has(d.date)
  );

  // For non-Lotto games, apply jackpot won resolution
  const nonLotto = allNew.filter(d=>!['lotto','lotto-plus','lotto-plus2'].includes(d.game));
  const lottoNew = allNew.filter(d=>['lotto','lotto-plus','lotto-plus2'].includes(d.game));
  const resolvedNonLotto = resolveJackpotWon(nonLotto);

  const added = mergeDraws([...lottoNew, ...resolvedNonLotto]);
  if (added > 0) saveCache();

  console.log(`[Update] Done. Added ${added}. Total: ${cache.draws.length}`);
  return { success: true, added, total: cache.draws.length };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── CRON SCHEDULE (SAST = UTC+2) ────────────────────────
// Daily Lotto:       every night 21:30 SAST = 19:30 UTC
// Lotto Wed+Sat:     22:00 SAST = 20:00 UTC
// Powerball Tue+Fri: 22:00 SAST = 20:00 UTC
cron.schedule('30 19 * * *',   () => { console.log('[Cron] Daily scrape'); runUpdate(); });
cron.schedule('0 20 * * 3,6',  () => { console.log('[Cron] Lotto Wed/Sat'); runUpdate(); });
cron.schedule('0 20 * * 2,5',  () => { console.log('[Cron] Powerball Tue/Fri'); runUpdate(); });

// ─── API ROUTES ───────────────────────────────────────────

app.get('/', (req, res) => res.json({
  status: 'ok',
  service: 'SA Lottery Live Results API',
  version: '2.0.0',
  lastUpdated: cache.lastUpdated,
  totalDraws: cache.draws.length,
  uptime: Math.floor(process.uptime()) + 's'
}));

app.get('/api/draws', (req, res) => {
  const { game, since, limit } = req.query;
  let draws = [...cache.draws];
  if (game)  draws = draws.filter(d => d.game === game);
  if (since) draws = draws.filter(d => d.date >= since);
  if (limit) draws = draws.slice(-parseInt(limit));
  res.json({ success: true, count: draws.length, lastUpdated: cache.lastUpdated, draws });
});

app.get('/api/latest', (req, res) => {
  // Latest draw per game + auto-computed rollover depths
  const latest = {};
  for (const d of cache.draws) {
    if (!latest[d.game] || d.date > latest[d.game].date) latest[d.game] = d;
  }

  const rolloverDepths = {};
  for (const gk of Object.keys(latest)) {
    const gameDrws = cache.draws.filter(d => d.game === gk)
      .sort((a,b) => new Date(b.date) - new Date(a.date));
    let depth = 0;
    for (const d of gameDrws) {
      if (d.jackpotWon) break;
      depth++;
    }
    rolloverDepths[gk] = depth;
  }

  // Current jackpot estimates per game
  const jackpots = {};
  for (const [gk, draw] of Object.entries(latest)) {
    jackpots[gk] = draw.jackpot || null;
  }

  res.json({ success: true, lastUpdated: cache.lastUpdated, latest, rolloverDepths, jackpots });
});

app.get('/api/status', (req, res) => {
  const gameCounts = {};
  cache.draws.forEach(d => { gameCounts[d.game] = (gameCounts[d.game]||0)+1; });
  res.json({
    success: true,
    lastUpdated: cache.lastUpdated,
    totalDraws: cache.draws.length,
    byGame: gameCounts,
    uptime: Math.floor(process.uptime()) + 's',
    cronSchedules: [
      '19:30 UTC daily (Daily Lotto)',
      '20:00 UTC Wed+Sat (Lotto)',
      '20:00 UTC Tue+Fri (Powerball)'
    ]
  });
});

// Manual trigger
app.post('/api/update', async (req, res) => {
  const token = req.headers['x-update-token'] || req.query.token;
  const expected = process.env.UPDATE_TOKEN || 'sa-lottery-update-2024';
  if (token !== expected) return res.status(401).json({ error: 'Unauthorized' });
  const result = await runUpdate();
  res.json(result);
});

// ─── START ────────────────────────────────────────────────
loadCache();
app.listen(PORT, () => {
  console.log(`\n🎱 SA Lottery API v2.0 on port ${PORT}`);
  const stale = !cache.lastUpdated ||
    (Date.now() - new Date(cache.lastUpdated).getTime()) > 12 * 60 * 60 * 1000;
  if (stale || cache.draws.length === 0) {
    console.log('[Startup] Running initial scrape...');
    setTimeout(runUpdate, 3000);
  }
});

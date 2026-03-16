/**
 * SA Lottery Live Results API
 * ─────────────────────────────────────────────
 * Scrapes nationallottery.co.za nightly,
 * caches results in memory + JSON file,
 * exposes a CORS-enabled REST API for the
 * SA Lottery Probability Engine frontend.
 *
 * Deploy to Render (free tier):
 *   - Runtime: Node
 *   - Build command: npm install
 *   - Start command: node server.js
 *   - Instance type: Free
 */

'use strict';

const express  = require('express');
const cors     = require('cors');
const cron     = require('node-cron');
const cheerio  = require('cheerio');
const axios    = require('axios');
const fs       = require('fs');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── CORS: allow any origin (your hosted HTML file) ───
app.use(cors());
app.use(express.json());

// ─── Data store ───────────────────────────────────────
const DATA_FILE = path.join(__dirname, 'results_cache.json');
let resultsCache = {
  lastUpdated: null,
  draws: []          // [{date, game, balls, bonus, powerball, jackpotWon, jackpot}]
};

// Load from disk on startup
function loadCache() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      resultsCache = JSON.parse(raw);
      console.log(`[Cache] Loaded ${resultsCache.draws.length} draws from disk`);
    }
  } catch (e) {
    console.error('[Cache] Failed to load from disk:', e.message);
  }
}

function saveCache() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(resultsCache, null, 2));
    console.log('[Cache] Saved to disk');
  } catch (e) {
    console.error('[Cache] Failed to save to disk:', e.message);
  }
}

// ─── GAME CONFIG ──────────────────────────────────────
const GAME_MAP = {
  'LOTTO':          { key: 'lotto',          pick: 6, bonus: true,  pbPool: null },
  'LOTTO PLUS 1':   { key: 'lotto-plus',     pick: 6, bonus: true,  pbPool: null },
  'LOTTO PLUS 2':   { key: 'lotto-plus2',    pick: 6, bonus: true,  pbPool: null },
  'DAILY LOTTO':    { key: 'daily',          pick: 5, bonus: false, pbPool: null },
  'DAILY LOTTO PLUS':{ key: 'daily-plus',   pick: 5, bonus: false, pbPool: null },
  'POWERBALL':      { key: 'powerball',      pick: 5, bonus: false, pbPool: 20   },
  'POWERBALL PLUS': { key: 'powerball-plus', pick: 5, bonus: false, pbPool: 20   },
};

// ─── SCRAPER ──────────────────────────────────────────
/**
 * Scrapes the National Lottery results page.
 * The site renders results in a structured table.
 * We parse the most recent draw for each game.
 *
 * NOTE: If the site structure changes, update the
 * selectors below. The parsing is defensive — any
 * row that can't be parsed is silently skipped.
 */
async function scrapeLatestResults() {
  console.log('[Scraper] Starting scrape of nationallottery.co.za...');

  const urls = [
    { url: 'https://www.nationallottery.co.za/results/lotto',         game: 'LOTTO'          },
    { url: 'https://www.nationallottery.co.za/results/lotto-plus-1',  game: 'LOTTO PLUS 1'   },
    { url: 'https://www.nationallottery.co.za/results/lotto-plus-2',  game: 'LOTTO PLUS 2'   },
    { url: 'https://www.nationallottery.co.za/results/daily-lotto',   game: 'DAILY LOTTO'    },
    { url: 'https://www.nationallottery.co.za/results/powerball',     game: 'POWERBALL'      },
    { url: 'https://www.nationallottery.co.za/results/powerball-plus',game: 'POWERBALL PLUS' },
  ];

  const newDraws = [];

  for (const { url, game } of urls) {
    try {
      const res = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; SALotteryBot/1.0)',
          'Accept': 'text/html,application/xhtml+xml',
        }
      });

      const $ = cheerio.load(res.data);
      const cfg = GAME_MAP[game];
      if (!cfg) continue;

      // ── Parse draw rows ──
      // The national lottery site uses div-based result cards.
      // We look for result containers and extract ball numbers.
      // Multiple selectors tried for resilience against site updates.

      const parsed = parseResultPage($, cfg, game);
      if (parsed.length > 0) {
        console.log(`[Scraper] ${game}: found ${parsed.length} draw(s)`);
        newDraws.push(...parsed);
      } else {
        console.warn(`[Scraper] ${game}: no results parsed from ${url}`);
      }

      // Polite delay between requests
      await sleep(1500);

    } catch (e) {
      console.error(`[Scraper] Failed for ${game}:`, e.message);
    }
  }

  return newDraws;
}

function parseResultPage($, cfg, gameName) {
  const results = [];

  // Strategy 1: Look for common result card patterns
  // The national lottery site uses various class names — we try multiple
  const selectors = [
    '.result-page .draw-results',
    '.results-container .result-item',
    '.draw-result-card',
    'table.results-table tbody tr',
    '.lottery-results .result',
  ];

  let found = false;

  for (const sel of selectors) {
    const rows = $(sel);
    if (rows.length === 0) continue;

    rows.each((i, row) => {
      const result = extractFromRow($, row, cfg, gameName);
      if (result) { results.push(result); found = true; }
    });

    if (found) break;
  }

  // Strategy 2: Generic ball number extraction fallback
  // Find any element that looks like a draw date + ball numbers
  if (!found) {
    const datePattern = /\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4}/;
    const ballPattern = /\b([1-9]|[1-4][0-9]|50)\b/g;

    $('div, section, article').each((i, el) => {
      const text = $(el).text();
      const dateMatch = text.match(datePattern);
      if (!dateMatch) return;

      const ballMatches = [...text.matchAll(ballPattern)].map(m => parseInt(m[1]));
      const uniqueBalls = [...new Set(ballMatches)];

      if (uniqueBalls.length >= cfg.pick) {
        const mainBalls = uniqueBalls.slice(0, cfg.pick);
        const date = normaliseDate(dateMatch[0]);
        if (!date) return;

        const entry = {
          date,
          game: cfg.key,
          balls: mainBalls,
          bonus: null,
          powerball: null,
          jackpotWon: false,  // Unknown from generic parse
          jackpot: null,
          source: 'scraped-fallback'
        };

        if (cfg.bonus && uniqueBalls.length > cfg.pick) {
          entry.bonus = uniqueBalls[cfg.pick];
        }
        if (cfg.pbPool && uniqueBalls.length > cfg.pick) {
          const pb = uniqueBalls[cfg.pick];
          if (pb >= 1 && pb <= cfg.pbPool) entry.powerball = pb;
        }

        results.push(entry);
        found = true;
        return false; // break each
      }
    });
  }

  return results;
}

function extractFromRow($, row, cfg, gameName) {
  try {
    const text = $(row).text();
    const datePattern = /(\d{4}-\d{2}-\d{2}|\d{2}[\/-]\d{2}[\/-]\d{4})/;
    const dateMatch = text.match(datePattern);
    if (!dateMatch) return null;

    const date = normaliseDate(dateMatch[1]);
    if (!date) return null;

    // Extract ball numbers
    const balls = [];
    $(row).find('.ball, .number, .lotto-ball, span[class*="ball"], div[class*="ball"]').each((i, el) => {
      const n = parseInt($(el).text().trim());
      if (!isNaN(n) && n >= 1 && n <= 52 && !balls.includes(n)) balls.push(n);
    });

    if (balls.length < cfg.pick) return null;

    const mainBalls = balls.slice(0, cfg.pick);
    let bonus = null, powerball = null;

    if (cfg.bonus && balls.length > cfg.pick) {
      bonus = balls[cfg.pick];
    }

    if (cfg.pbPool) {
      // Powerball is often rendered separately with a distinct class
      $(row).find('.powerball, .pb-number, [class*="powerball"]').each((i, el) => {
        const n = parseInt($(el).text().trim());
        if (!isNaN(n) && n >= 1 && n <= cfg.pbPool) powerball = n;
      });
    }

    // Jackpot detection — look for "R" + large number or "jackpot won"
    const jackpotWon = /jackpot.*won|winner|was won/i.test(text);
    const jpMatch = text.match(/R\s*([\d,]+(?:\.\d+)?)\s*[Mm]/);
    const jackpot = jpMatch ? parseFloat(jpMatch[1].replace(/,/g, '')) * 1e6 : null;

    return {
      date,
      game: cfg.key,
      balls: mainBalls,
      bonus,
      powerball,
      jackpotWon,
      jackpot,
      source: 'scraped'
    };
  } catch (e) {
    return null;
  }
}

function normaliseDate(str) {
  if (!str) return null;
  // Handle DD/MM/YYYY → YYYY-MM-DD
  if (/\d{2}[\/\-]\d{2}[\/\-]\d{4}/.test(str)) {
    const parts = str.split(/[\/\-]/);
    return `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;
  }
  // Already YYYY-MM-DD
  if (/\d{4}-\d{2}-\d{2}/.test(str)) return str;
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── MERGE NEW DRAWS INTO CACHE ──────────────────────
function mergeDraws(newDraws) {
  const existing = new Set(resultsCache.draws.map(d => `${d.date}_${d.game}`));
  let added = 0;

  for (const draw of newDraws) {
    const key = `${draw.date}_${draw.game}`;
    if (!existing.has(key)) {
      resultsCache.draws.push(draw);
      existing.add(key);
      added++;
    }
  }

  // Sort by date ascending
  resultsCache.draws.sort((a, b) => new Date(a.date) - new Date(b.date));
  resultsCache.lastUpdated = new Date().toISOString();

  console.log(`[Merge] Added ${added} new draws. Total: ${resultsCache.draws.length}`);
  return added;
}

// ─── FULL UPDATE CYCLE ───────────────────────────────
async function runUpdate() {
  console.log(`[Update] Starting at ${new Date().toISOString()}`);
  try {
    const newDraws = await scrapeLatestResults();
    const added = mergeDraws(newDraws);
    if (added > 0) saveCache();
    console.log(`[Update] Complete. Added ${added} draws.`);
    return { success: true, added, total: resultsCache.draws.length };
  } catch (e) {
    console.error('[Update] Failed:', e.message);
    return { success: false, error: e.message };
  }
}

// ─── CRON SCHEDULE ───────────────────────────────────
// SA Lotto draws:
//   Lotto / Plus 1 / Plus 2: Wednesday & Saturday ~20:30 SAST
//   Daily Lotto:              Daily ~21:00 SAST
//   Powerball / Plus:         Tuesday & Friday ~21:00 SAST
//
// We run scrapes at:
//   21:30 every day (catches Daily Lotto)
//   22:00 Wed, Sat  (catches Lotto results after processing)
//   22:00 Tue, Fri  (catches Powerball results)
//
// SAST = UTC+2, Render runs UTC, so subtract 2h
// 21:30 SAST = 19:30 UTC → cron: 30 19 * * *
// 22:00 SAST Wed/Sat = 20:00 UTC → cron: 0 20 * * 3,6
// 22:00 SAST Tue/Fri = 20:00 UTC → cron: 0 20 * * 2,5

cron.schedule('30 19 * * *', () => {
  console.log('[Cron] Daily 21:30 SAST scrape triggered');
  runUpdate();
});

cron.schedule('0 20 * * 3,6', () => {
  console.log('[Cron] Lotto Wed/Sat 22:00 SAST scrape triggered');
  runUpdate();
});

cron.schedule('0 20 * * 2,5', () => {
  console.log('[Cron] Powerball Tue/Fri 22:00 SAST scrape triggered');
  runUpdate();
});

// ─── API ROUTES ───────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'SA Lottery Live Results API',
    version: '1.0.0',
    lastUpdated: resultsCache.lastUpdated,
    totalDraws: resultsCache.draws.length,
    uptime: Math.floor(process.uptime()) + 's'
  });
});

// All draws (optionally filtered by game)
app.get('/api/draws', (req, res) => {
  const { game, since, limit } = req.query;
  let draws = [...resultsCache.draws];

  if (game) draws = draws.filter(d => d.game === game);
  if (since) draws = draws.filter(d => d.date >= since);
  if (limit) draws = draws.slice(-parseInt(limit));

  res.json({
    success: true,
    count: draws.length,
    lastUpdated: resultsCache.lastUpdated,
    draws
  });
});

// Latest draw per game
app.get('/api/latest', (req, res) => {
  const latest = {};
  for (const draw of resultsCache.draws) {
    if (!latest[draw.game] || draw.date > latest[draw.game].date) {
      latest[draw.game] = draw;
    }
  }

  // Compute rollover depth per game
  const rolloverDepths = {};
  for (const gk of Object.keys(latest)) {
    const gameDraw = resultsCache.draws.filter(d => d.game === gk);
    const sorted = [...gameDraw].sort((a, b) => new Date(b.date) - new Date(a.date));
    let depth = 0;
    for (const d of sorted) {
      if (d.jackpotWon) break;
      depth++;
    }
    rolloverDepths[gk] = depth;
  }

  res.json({
    success: true,
    lastUpdated: resultsCache.lastUpdated,
    latest,
    rolloverDepths
  });
});

// Manual trigger (protected by secret token)
app.post('/api/update', async (req, res) => {
  const token = req.headers['x-update-token'] || req.query.token;
  const expected = process.env.UPDATE_TOKEN || 'sa-lottery-update-2024';

  if (token !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const result = await runUpdate();
  res.json(result);
});

// Status / stats
app.get('/api/status', (req, res) => {
  const gameCounts = {};
  for (const d of resultsCache.draws) {
    gameCounts[d.game] = (gameCounts[d.game] || 0) + 1;
  }

  res.json({
    success: true,
    lastUpdated: resultsCache.lastUpdated,
    totalDraws: resultsCache.draws.length,
    byGame: gameCounts,
    uptime: Math.floor(process.uptime()) + 's',
    cronSchedules: [
      '19:30 UTC daily (Daily Lotto)',
      '20:00 UTC Wed+Sat (Lotto)',
      '20:00 UTC Tue+Fri (Powerball)'
    ]
  });
});

// ─── START ────────────────────────────────────────────
loadCache();

app.listen(PORT, () => {
  console.log(`\n🎱 SA Lottery API running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/`);
  console.log(`   Draws:  http://localhost:${PORT}/api/draws`);
  console.log(`   Latest: http://localhost:${PORT}/api/latest`);
  console.log(`   Status: http://localhost:${PORT}/api/status\n`);

  // Run an initial scrape on startup if cache is empty or stale
  const stale = !resultsCache.lastUpdated ||
    (Date.now() - new Date(resultsCache.lastUpdated).getTime()) > 24 * 60 * 60 * 1000;

  if (stale) {
    console.log('[Startup] Cache is empty or stale — running initial scrape...');
    setTimeout(runUpdate, 3000); // slight delay to let server fully start
  }
});

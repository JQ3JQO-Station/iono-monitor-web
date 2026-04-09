// CB DX Iono Monitor - Data Fetcher
// Runs via GitHub Actions every 5 minutes
// Outputs docs/data.json

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    let data = '';
    const req = client.get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── FxEs parser ──────────────────────────────────────────────
function parseFxEs(html) {
  // Strip HTML tags, keep printable ASCII + newlines
  let plain = '';
  let inTag = false;
  for (let i = 0; i < html.length; i++) {
    const c = html[i];
    if (c === '<') { inTag = true; continue; }
    if (c === '>') { inTag = false; continue; }
    if (inTag) continue;
    if (c === '\r') continue;
    if (c === '\n' || c === '\t') { plain += '\n'; continue; }
    const code = c.charCodeAt(0);
    plain += (code >= 32 && code <= 126) ? c : ' ';
  }

  const tokens = plain.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  const isDate = s => /^\d{4}\/\d{2}\/\d{2}$/.test(s);
  const isTime = s => /^\d{2}:\d{2}$/.test(s);
  const isFx   = s => /^-+$/.test(s) || /^\d+\.\d+$/.test(s);
  const normFx = s => /^-+$/.test(s) ? '--' : s;

  const rows = [];
  for (let i = 0; i < tokens.length - 4; i++) {
    const sp = tokens[i].indexOf(' ');
    if (sp <= 0) continue;
    const d = tokens[i].substring(0, sp).trim();
    const t = tokens[i].substring(sp + 1).trim();
    if (isDate(d) && isTime(t) &&
        isFx(tokens[i+1]) && isFx(tokens[i+2]) &&
        isFx(tokens[i+3]) && isFx(tokens[i+4])) {
      rows.push({ date: d, time: t,
        ok: normFx(tokens[i+1]), yg: normFx(tokens[i+2]),
        to: normFx(tokens[i+3]), wk: normFx(tokens[i+4]) });
      i += 4;
    }
  }

  if (rows.length === 0) return null;

  const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  return rows.reduce((best, r) => toMin(r.time) > toMin(best.time) ? r : best, rows[0]);
}

// ── MUF parser ───────────────────────────────────────────────
function parseMuf(html) {
  const result = { ok: null, yg: null, to: null };
  let curStation = '';
  let inFregion  = false;

  for (const raw of html.split('\n')) {
    if (raw.includes('Station')) {
      if      (raw.includes('OK426')) { curStation = 'ok'; inFregion = false; }
      else if (raw.includes('YG431')) { curStation = 'yg'; inFregion = false; }
      else if (raw.includes('TO536')) { curStation = 'to'; inFregion = false; }
      else curStation = '';
    }
    if (raw.includes('F region')) inFregion = true;
    if (raw.includes('E region')) inFregion = false;

    if (inFregion && curStation && result[curStation] === null) {
      const ln = raw.trim();
      const c1 = ln.indexOf(',');
      if (c1 < 0) continue;
      const dist = parseInt(ln.substring(0, c1).trim());
      const targetDist = { ok: 500, yg: 1000, to: 1500 }[curStation];
      if (dist !== targetDist) continue;

      const c2 = ln.indexOf(',', c1 + 1);
      if (c2 < 0) continue;
      const pipeIdx = ln.indexOf('|', c2);
      const mufStr = (pipeIdx > 0)
        ? ln.substring(c2 + 1, pipeIdx)
        : ln.substring(c2 + 1, c2 + 8);
      const v = parseFloat(mufStr.trim());
      if (v > 0) result[curStation] = v;
    }
  }
  return result;
}

// ── NOAA JSON parsers ─────────────────────────────────────────
function parseXray(json) {
  try {
    const arr = JSON.parse(json);
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].flux != null && arr[i].flux > 0) return arr[i].flux;
    }
  } catch (e) { /* ignore */ }
  return null;
}

function parseKp(json) {
  try {
    const arr = JSON.parse(json);
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].kp_index != null && arr[i].kp_index >= 0) return arr[i].kp_index;
    }
  } catch (e) { /* ignore */ }
  return null;
}

function parseF107(json) {
  try {
    const arr = JSON.parse(json);
    for (let i = arr.length - 1; i >= 0; i--) {
      const v = arr[i]['f10.7'] ?? arr[i].f107 ?? arr[i].flux;
      if (v != null && v > 0) return v;
    }
  } catch (e) { /* ignore */ }
  return null;
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  console.log(`[${new Date().toISOString()}] fetch-data start`);
  const result = { fetchedAt: new Date().toISOString() };

  // 前回データ読み込み（トレンド計算用）
  let prevFxes = null;
  try {
    const prevPath = path.join(__dirname, '..', 'docs', 'data.json');
    const prevData = JSON.parse(fs.readFileSync(prevPath, 'utf8'));
    prevFxes = prevData.fxes ?? null;
  } catch (e) { /* 初回は無視 */ }

  // FxEs
  try {
    const html = await fetchUrl('https://wdc.nict.go.jp/Ionosphere/realtime/fxEs/latest-fxEs.html');
    result.fxes = parseFxEs(html);
    // 前回値を付加（トレンド計算用）
    if (result.fxes && prevFxes) {
      for (const k of ['ok', 'yg', 'to', 'wk'])
        result.fxes[k + '_prev'] = prevFxes[k] ?? null;
    }
    console.log('FxEs:', result.fxes);
  } catch (e) {
    console.error('FxEs error:', e.message);
    result.fxes = null;
  }

  // MUF
  try {
    const html = await fetchUrl('https://wdc.nict.go.jp/Ionosphere/realtime/oblver/index.html');
    result.muf = parseMuf(html);
    console.log('MUF:', result.muf);
  } catch (e) {
    console.error('MUF error:', e.message);
    result.muf = { ok: null, yg: null, to: null };
  }

  // Xray flux
  try {
    const json = await fetchUrl('https://services.swpc.noaa.gov/json/goes/primary/xrays-6-hour.json');
    result.xray = parseXray(json);
    console.log('Xray:', result.xray);
  } catch (e) {
    console.error('Xray error:', e.message);
    result.xray = null;
  }

  // Kp index
  try {
    const json = await fetchUrl('https://services.swpc.noaa.gov/json/planetary_k_index_1m.json');
    result.kp = parseKp(json);
    console.log('Kp:', result.kp);
  } catch (e) {
    console.error('Kp error:', e.message);
    result.kp = null;
  }

  // F10.7 flux
  try {
    const json = await fetchUrl('https://services.swpc.noaa.gov/json/solar-cycle/f10-7cm-flux.json');
    result.f107 = parseF107(json);
    console.log('F107:', result.f107);
  } catch (e) {
    console.error('F107 error:', e.message);
    result.f107 = null;
  }

  const outPath = path.join(__dirname, '..', 'docs', 'data.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
  console.log('Written:', outPath);
}

main().catch(err => { console.error(err); process.exit(1); });

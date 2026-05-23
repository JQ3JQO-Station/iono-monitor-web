// NICTアーカイブデータをfxes-history.jsonにマージするスクリプト
// 使用方法: node scripts/merge-nict-history.js

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// 局ID → fxes-history.jsonのキー
const STATION_MAP = {
  'OK426': 'ok',
  'YG431': 'yg',
  'TO536': 'to',
  'WK546': 'wk',
};

// ファイルリスト（/tmp/ に存在するファイルを自動検出）
const STATIONS = [
  { station: 'OK426', key: 'ok' },
  { station: 'YG431', key: 'yg' },
  { station: 'TO536', key: 'to' },
  { station: 'WK546', key: 'wk' },
];
const currYear = new Date().getFullYear();
const FILES = [];
for (let y = currYear - 1; y <= currYear; y++) {
  for (const s of STATIONS) {
    const p = `/tmp/${s.station}-${y}.txt`;
    if (fs.existsSync(p)) FILES.push({ ...s, path: p });
  }
}
if (FILES.length === 0) {
  console.error('処理対象ファイルが /tmp/ に見つかりません');
  process.exit(1);
}

// タイムスタンプパース（JST → UTC ISO）
function parseTs(tsStr) {
  // YYYYMMDDHHMMSS (JST = UTC+9)
  const y  = parseInt(tsStr.slice(0, 4));
  const mo = parseInt(tsStr.slice(4, 6)) - 1;
  const d  = parseInt(tsStr.slice(6, 8));
  const h  = parseInt(tsStr.slice(8, 10));
  const mi = parseInt(tsStr.slice(10, 12));
  const jstMs = Date.UTC(y, mo, d, h, mi) - 9 * 60 * 60 * 1000;
  return new Date(jstMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// fxEs値をパース（単位: ×0.01 MHz）
function parseFxEs(raw) {
  const s = raw.trim();
  if (!s || /^-+$/.test(s)) return '--';
  const m = s.match(/^(\d+)/);
  if (!m) return '--';
  const val = parseInt(m[1]);
  if (val === 0) return '--';
  // MHzに変換して小数点2桁
  const mhz = (val / 100).toFixed(2);
  // 末尾の余分なゼロを取り除く（5.90 → 5.9、5.00 → 5.0）
  return parseFloat(mhz).toString();
}

// 1ファイルを読み込んでMap<ts, fxes>を返す
async function parseFile(filePath, key) {
  const map = new Map();
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (line.startsWith('#') || !line.trim()) continue;

    // フォーマット: STATION,YYYYMMDDHHMMSS:  col0, col1, ...
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const header = line.slice(0, colonIdx);
    const commaIdx = header.indexOf(',');
    if (commaIdx < 0) continue;
    const tsStr = header.slice(commaIdx + 1);
    if (tsStr.length !== 14) continue;

    const rest = line.slice(colonIdx + 1);
    const cols = rest.split(',');
    if (cols.length < 15) continue;

    const ts = parseTs(tsStr);
    const fxes = parseFxEs(cols[14]); // 15列目（0-indexed: 14）
    map.set(ts, fxes);
  }

  return map;
}

async function main() {
  const histPath = path.join(__dirname, '..', 'docs', 'fxes-history.json');

  // 既存のfxes-history.jsonを読み込む
  let existing = [];
  if (fs.existsSync(histPath)) {
    existing = JSON.parse(fs.readFileSync(histPath, 'utf8'));
  }

  // 既存データをMapに変換
  const merged = new Map();
  for (const rec of existing) {
    merged.set(rec.ts, { ...rec });
  }

  console.log(`既存データ: ${existing.length} 件`);

  // 各ファイルを処理してマージ
  for (const { station, key, path: filePath } of FILES) {
    if (!fs.existsSync(filePath)) {
      console.warn(`スキップ（ファイルなし）: ${filePath}`);
      continue;
    }
    process.stdout.write(`処理中: ${filePath} ... `);
    const map = await parseFile(filePath, key);
    let added = 0, updated = 0;
    for (const [ts, fxes] of map) {
      if (!merged.has(ts)) {
        merged.set(ts, { ts, ok: '--', yg: '--', to: '--', wk: '--' });
        added++;
      }
      const rec = merged.get(ts);
      // NICTアーカイブ値で常に上書き（毎日最新版を取得するため）
      if (fxes !== '--') {
        if (rec[key] !== fxes) { rec[key] = fxes; updated++; }
      } else if (rec[key] === undefined) {
        rec[key] = '--';
      }
    }
    console.log(`${map.size} 件読込、${added} 件追加、${updated} 件補完`);
  }

  // タイムスタンプでソートして保存
  const result = [...merged.values()]
    .sort((a, b) => a.ts.localeCompare(b.ts));

  // 全--エントリを除外してコンパクトJSONで保存
  const trimmed = result.filter(r => !(r.ok === '--' && r.yg === '--' && r.to === '--' && r.wk === '--'));
  fs.writeFileSync(histPath, JSON.stringify(trimmed));

  // 統計
  const total = result.length;
  const firstTs = result[0]?.ts;
  const lastTs = result[result.length - 1]?.ts;
  const esEvents = result.filter(r =>
    ['ok','yg','to','wk'].some(k => parseFloat(r[k]) >= 9.0)
  ).length;

  console.log(`\n===== 完了 =====`);
  console.log(`総件数: ${total} 件`);
  console.log(`期間: ${firstTs} 〜 ${lastTs}`);
  console.log(`Es発生（いずれかの局 >= 9.0 MHz）: ${esEvents} 件`);
  console.log(`保存先: ${histPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });

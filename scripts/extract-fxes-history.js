// FxEs履歴抽出スクリプト（一回限り実行）
// git履歴からdocs/data.jsonのFxEsデータを全件抽出し
// docs/fxes-history.json に保存する

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const outPath = path.join(__dirname, '..', 'docs', 'fxes-history.json');

// git log: data.jsonを変更した全コミットのハッシュを取得
const logOutput = execSync(
  'git log --format="%H" -- docs/data.json',
  { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
).trim().split('\n').filter(h => h.length > 0);

console.log(`対象コミット数: ${logOutput.length}`);

const seen = new Set();
const records = [];

for (let i = 0; i < logOutput.length; i++) {
  const hash = logOutput[i];
  if (i % 50 === 0) process.stdout.write(`\r処理中: ${i + 1} / ${logOutput.length}`);

  try {
    const json = execSync(`git show ${hash}:docs/data.json`, {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024
    });
    const data = JSON.parse(json);
    const fxes = data.fxes;
    if (!fxes || !fxes.date || !fxes.time) continue;

    // NICT日時はJST → UTC変換（-9時間）
    const [y, m, d] = fxes.date.split('/').map(Number);
    const [hh, mm] = fxes.time.split(':').map(Number);
    const jstMs = Date.UTC(y, m - 1, d, hh, mm) - 9 * 60 * 60 * 1000;
    const ts = new Date(jstMs).toISOString().replace(/\.\d{3}Z$/, 'Z');

    if (seen.has(ts)) continue;
    seen.add(ts);

    records.push({
      ts,
      ok: fxes.ok ?? '--',
      yg: fxes.yg ?? '--',
      to: fxes.to ?? '--',
      wk: fxes.wk ?? '--'
    });
  } catch (e) {
    // パース失敗は無視
  }
}

// タイムスタンプで昇順ソート
records.sort((a, b) => a.ts.localeCompare(b.ts));

console.log(`\n抽出完了: ${records.length} 件`);
console.log(`最古: ${records[0]?.ts}`);
console.log(`最新: ${records[records.length - 1]?.ts}`);

fs.writeFileSync(outPath, JSON.stringify(records, null, 2), 'utf8');
console.log(`保存完了: ${outPath}`);

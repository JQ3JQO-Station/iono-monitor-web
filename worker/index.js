export default {
  // ── ブラウザからのリクエスト処理 ──────────────────────────────
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST',
        'Access-Control-Allow-Headers': 'Content-Type',
      }});
    }

    const url = new URL(request.url);

    // GET → CORSプロキシ
    if (request.method === 'GET') {
      const target = url.searchParams.get('url');
      if (!target) return new Response('Missing url param', { status: 400 });
      const res = await fetch(target, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const body = await res.text();
      return new Response(body, { headers: {
        'Content-Type': res.headers.get('Content-Type') || 'text/plain',
        'Access-Control-Allow-Origin': '*',
      }});
    }

    // POST → LINE通知（ブラウザから手動送信用・既存機能を維持）
    if (request.method === 'POST') {
      const { message } = await request.json();
      const ok = await sendLine(message, env);
      return new Response(JSON.stringify({ ok }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    return new Response('Method not allowed', { status: 405 });
  },

  // ── Cron（15分ごと自動実行） ───────────────────────────────────
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkAndAlert(env));
  },
};

// ── FxEsチェック＆LINEアラート ────────────────────────────────
async function checkAndAlert(env) {
  const FXES_URL = 'https://wdc.nict.go.jp/Ionosphere/realtime/fxEs/latest-fxEs.html';

  let html;
  try {
    const res = await fetch(FXES_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    html = await res.text();
  } catch (e) {
    console.error('FxEs fetch failed:', e.message);
    return;
  }

  const fxes = parseFxEs(html);
  if (!fxes) {
    console.log('FxEs parse failed or no data');
    return;
  }

  const names = { to: '東京', yg: '鹿児島' };
  const KV_KEY = 'alert_active';

  // 東京・鹿児島で FxEs >= 9.0 の地点を検出
  const triggered = ['to', 'yg'].filter(k => {
    const v = parseFloat(fxes[k]);
    return !isNaN(v) && v >= 9.0;
  });

  if (triggered.length > 0) {
    // KVで重複送信を防止（アラート中はフラグが残る）
    const alreadySent = await env.IONO_STATE.get(KV_KEY);
    if (!alreadySent) {
      const detail = triggered.map(k => `${names[k]}: ${fxes[k]}`).join(' / ');
      const message = `⚠ CB DX Iono Monitor アラート\nFxEs >= 9.0 検出\n${detail}\n観測時刻: ${fxes.time ?? '--:--'} JST`;
      await sendLine(message, env);
      // フラグを立てる（TTL: 2時間）
      await env.IONO_STATE.put(KV_KEY, '1', { expirationTtl: 7200 });
      console.log('LINE alert sent:', detail);
    } else {
      console.log('Alert already sent, skipping');
    }
  } else {
    // アラート解除 → フラグを削除
    await env.IONO_STATE.delete(KV_KEY);
    console.log(`FxEs normal: to=${fxes.to} yg=${fxes.yg}`);
  }
}

// ── LINE Messaging API 送信 ───────────────────────────────────
async function sendLine(message, env) {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + env.LINE_TOKEN,
    },
    body: JSON.stringify({
      to: env.LINE_USER_ID,
      messages: [{ type: 'text', text: message }]
    })
  });
  return res.ok;
}

// ── FxEsパーサー（index.htmlと同一ロジック） ───────────────────
function parseFxEs(html) {
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
  const isFx   = s => /^-+$/.test(s) || /^\d*\.?\d+$/.test(s);
  const toVal  = s => /^-+$/.test(s) ? null : parseFloat(s);

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
        ok: toVal(tokens[i+1]), yg: toVal(tokens[i+2]),
        to: toVal(tokens[i+3]), wk: toVal(tokens[i+4]) });
      i += 4;
    }
  }
  if (rows.length === 0) return null;

  const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  let latestIdx = 0, latestMin = -1;
  for (let i = 0; i < rows.length; i++) {
    const m = toMin(rows[i].time);
    if (m > latestMin) { latestMin = m; latestIdx = i; }
  }

  const latest = rows[latestIdx];
  for (const k of ['ok', 'yg', 'to', 'wk'])
    latest[k] = latest[k] != null ? latest[k].toFixed(1) : '--';

  return latest;
}

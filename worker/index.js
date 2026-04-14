export default {
  // ── ブラウザ / LINE Webhook からのリクエスト ─────────────────
  async fetch(request, env) {
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

    if (request.method === 'POST') {
      const signature = request.headers.get('X-Line-Signature');
      if (signature) {
        // LINE Webhook
        return handleWebhook(request, env, signature);
      }
      // 既存: ブラウザからの直接LINE送信（互換維持）
      const { message } = await request.json();
      const ok = await pushLine(env.LINE_USER_ID, message, env);
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

// ── LINE Webhook ─────────────────────────────────────────────
async function handleWebhook(request, env, signature) {
  const body = await request.text();

  // 署名検証（LINE_CHANNEL_SECRET が設定されている場合）
  if (env.LINE_CHANNEL_SECRET) {
    const valid = await verifySignature(body, signature, env.LINE_CHANNEL_SECRET);
    if (!valid) return new Response('Unauthorized', { status: 401 });
  }

  const { events } = JSON.parse(body);
  for (const event of events) {
    if (event.type === 'follow') {
      await handleFollow(event, env);
    } else if (event.type === 'message' && event.message.type === 'text') {
      await handleMessage(event, env);
    }
  }
  return new Response('OK');
}

// ── 友達登録イベント ──────────────────────────────────────────
async function handleFollow(event, env) {
  const userId = event.source.userId;
  await replyLine(event.replyToken,
    'CB DX Iono Monitor の通知登録へようこそ！\nお名前を入力してください：', env);
  await env.IONO_STATE.put(`state_${userId}`, 'AWAITING_NAME', { expirationTtl: 86400 });
}

// ── メッセージイベント ────────────────────────────────────────
async function handleMessage(event, env) {
  const userId = event.source.userId;
  const text   = event.message.text.trim();

  // 管理者コマンド
  if (userId === env.LINE_USER_ID) {
    await handleAdminCommand(text, event, env);
    return;
  }

  const state = (await env.IONO_STATE.get(`state_${userId}`)) || 'NONE';

  // 名前の受付
  if (state === 'AWAITING_NAME') {
    const shortId = userId.slice(-6);
    await env.IONO_STATE.put(`pending_${shortId}`, JSON.stringify({
      lineId: userId, name: text, requestedAt: new Date().toISOString()
    }), { expirationTtl: 86400 * 7 });

    await pushLine(env.LINE_USER_ID,
      `📩 登録申請\n名前: ${text}\n\n承認: 承認 ${shortId}\n拒否: 拒否 ${shortId}`, env);
    await replyLine(event.replyToken,
      '申請を受け付けました。管理者が承認するまでお待ちください。', env);
    await env.IONO_STATE.delete(`state_${userId}`);
    return;
  }

  // 曜日設定
  if (state === 'AWAITING_DAYS') {
    let days;
    if (text.includes('毎日'))    days = [0,1,2,3,4,5,6];
    else if (text.includes('平日')) days = [1,2,3,4,5];
    else if (text.includes('土日')) days = [0,6];
    else {
      await replyLine(event.replyToken,
        '「毎日」「平日」「土日」のいずれかで入力してください。', env);
      return;
    }
    await updateRecipient(userId, { activeDays: days }, env);
    await env.IONO_STATE.put(`state_${userId}`, 'AWAITING_HOURS', { expirationTtl: 86400 });
    await replyLine(event.replyToken,
      '通知を受け取る時間帯を入力してください。\n例: 18-23（18:00〜23:00）\n24時間受け取る場合: 0-24', env);
    return;
  }

  // 時間帯設定
  if (state === 'AWAITING_HOURS') {
    const match = text.match(/^(\d{1,2})-(\d{1,2})$/);
    if (!match) {
      await replyLine(event.replyToken, '「18-23」のような形式で入力してください。', env);
      return;
    }
    const start = parseInt(match[1]);
    const end   = parseInt(match[2]);
    await updateRecipient(userId, { activeHours: { start, end } }, env);
    await env.IONO_STATE.delete(`state_${userId}`);

    const recipients = await getRecipients(env);
    const r = recipients.find(r => r.lineId === userId);
    const dayLabel = { '0,1,2,3,4,5,6': '毎日', '1,2,3,4,5': '平日', '0,6': '土日' };
    const dayStr = dayLabel[(r?.activeDays || []).join(',')] || '設定済み';
    await replyLine(event.replyToken,
      `✅ 設定完了！\n曜日: ${dayStr}\n時間帯: ${start}:00〜${end}:00\n\n変更したいときは「設定変更」と送ってください。`, env);
    return;
  }

  // 設定変更コマンド
  if (text === '設定変更') {
    await env.IONO_STATE.put(`state_${userId}`, 'AWAITING_DAYS', { expirationTtl: 86400 });
    await replyLine(event.replyToken,
      '通知曜日を教えてください。\n「毎日」「平日」「土日」のいずれかで入力してください。', env);
    return;
  }

  // 登録状況確認
  if (text === '状態') {
    const recipients = await getRecipients(env);
    const r = recipients.find(r => r.lineId === userId);
    if (!r) {
      await replyLine(event.replyToken, '登録されていません。', env);
    } else {
      const dayLabel = { '0,1,2,3,4,5,6': '毎日', '1,2,3,4,5': '平日', '0,6': '土日' };
      const dayStr = dayLabel[(r.activeDays || []).join(',')] || '設定済み';
      await replyLine(event.replyToken,
        `📋 現在の設定\n名前: ${r.name}\n曜日: ${dayStr}\n時間帯: ${r.activeHours.start}:00〜${r.activeHours.end}:00`, env);
    }
    return;
  }
}

// ── 管理者コマンド ────────────────────────────────────────────
async function handleAdminCommand(text, event, env) {
  const approveMatch = text.match(/^承認\s+(\S+)/);
  const rejectMatch  = text.match(/^拒否\s+(\S+)/);
  const listMatch    = text === '一覧';

  if (approveMatch) {
    const shortId  = approveMatch[1];
    const pending  = await env.IONO_STATE.get(`pending_${shortId}`);
    if (!pending) {
      await replyLine(event.replyToken, '該当する申請が見つかりません。', env); return;
    }
    const p = JSON.parse(pending);
    const recipients = await getRecipients(env);
    if (!recipients.find(r => r.lineId === p.lineId)) {
      recipients.push({
        lineId: p.lineId, name: p.name,
        activeDays: [0,1,2,3,4,5,6],
        activeHours: { start: 0, end: 24 },
        registeredAt: new Date().toISOString()
      });
      await env.IONO_STATE.put('recipients', JSON.stringify(recipients));
    }
    await env.IONO_STATE.delete(`pending_${shortId}`);
    await env.IONO_STATE.put(`state_${p.lineId}`, 'AWAITING_DAYS', { expirationTtl: 86400 });
    await pushLine(p.lineId,
      '✅ 登録が承認されました！\n\n通知を受け取る曜日を教えてください。\n「毎日」「平日」「土日」のいずれかで入力してください。', env);
    await replyLine(event.replyToken, `${p.name} を承認しました。`, env);
    return;
  }

  if (rejectMatch) {
    const shortId = rejectMatch[1];
    const pending = await env.IONO_STATE.get(`pending_${shortId}`);
    if (!pending) {
      await replyLine(event.replyToken, '該当する申請が見つかりません。', env); return;
    }
    const p = JSON.parse(pending);
    await env.IONO_STATE.delete(`pending_${shortId}`);
    await pushLine(p.lineId, '申請が承認されませんでした。', env);
    await replyLine(event.replyToken, `${p.name} の申請を拒否しました。`, env);
    return;
  }

  if (listMatch) {
    const recipients = await getRecipients(env);
    if (recipients.length === 0) {
      await replyLine(event.replyToken, '登録者はいません。', env); return;
    }
    const dayLabel = { '0,1,2,3,4,5,6': '毎日', '1,2,3,4,5': '平日', '0,6': '土日' };
    const list = recipients.map((r, i) => {
      const dayStr = dayLabel[(r.activeDays || []).join(',')] || '-';
      return `${i+1}. ${r.name} / ${dayStr} / ${r.activeHours.start}-${r.activeHours.end}時`;
    }).join('\n');
    await replyLine(event.replyToken, `📋 登録者一覧（${recipients.length}名）\n${list}`, env);
    return;
  }
}

// ── FxEsチェック＆アラート送信 ────────────────────────────────
async function checkAndAlert(env) {
  const FXES_URL = 'https://wdc.nict.go.jp/Ionosphere/realtime/fxEs/latest-fxEs.html';
  let html;
  try {
    const res = await fetch(FXES_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    html = await res.text();
  } catch (e) {
    console.error('FxEs fetch failed:', e.message); return;
  }

  const fxes = parseFxEs(html);
  if (!fxes) { console.log('FxEs parse failed'); return; }

  // 管理者を受信者リストに自動追加（初回のみ）
  const recipients = await getRecipients(env);
  if (!recipients.find(r => r.lineId === env.LINE_USER_ID)) {
    recipients.push({
      lineId: env.LINE_USER_ID, name: '管理者',
      activeDays: [0,1,2,3,4,5,6],
      activeHours: { start: 0, end: 24 },
      registeredAt: new Date().toISOString()
    });
    await env.IONO_STATE.put('recipients', JSON.stringify(recipients));
  }

  const names = { to: '東京', yg: '鹿児島' };
  const triggered = ['to', 'yg'].filter(k => {
    const v = parseFloat(fxes[k]); return !isNaN(v) && v >= 9.0;
  });

  if (triggered.length > 0) {
    // JST時刻・曜日
    const now    = new Date();
    const jstMs  = now.getTime() + 9 * 3600000;
    const jstDate = new Date(jstMs);
    const jstHour = jstDate.getUTCHours();
    const jstDay  = jstDate.getUTCDay(); // 0=日, 6=土

    const detail  = triggered.map(k => `${names[k]}: ${fxes[k]}`).join(' / ');
    const message = `⚠ CB DX Iono Monitor アラート\nFxEs >= 9.0 検出\n${detail}\n観測時刻: ${fxes.time ?? '--:--'} JST`;

    for (const r of recipients) {
      if (!r.activeDays.includes(jstDay)) continue;
      if (jstHour < r.activeHours.start || jstHour >= r.activeHours.end) continue;

      const cooldownKey = `alert_sent_${r.lineId}`;
      if (await env.IONO_STATE.get(cooldownKey)) continue;

      await pushLine(r.lineId, message, env);
      await env.IONO_STATE.put(cooldownKey, '1', { expirationTtl: 7200 });
      console.log(`Sent alert to ${r.name}`);
    }
  } else {
    // Es解除 → 全ユーザーのクールダウンをリセット
    for (const r of recipients) {
      await env.IONO_STATE.delete(`alert_sent_${r.lineId}`);
    }
    console.log(`FxEs normal: to=${fxes.to} yg=${fxes.yg}`);
  }
}

// ── KV ヘルパー ────────────────────────────────────────────────
async function getRecipients(env) {
  const str = await env.IONO_STATE.get('recipients');
  return str ? JSON.parse(str) : [];
}
async function updateRecipient(userId, updates, env) {
  const recipients = await getRecipients(env);
  const r = recipients.find(r => r.lineId === userId);
  if (r) Object.assign(r, updates);
  await env.IONO_STATE.put('recipients', JSON.stringify(recipients));
}

// ── LINE API ──────────────────────────────────────────────────
async function pushLine(to, text, env) {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + env.LINE_TOKEN,
    },
    body: JSON.stringify({ to, messages: [{ type: 'text', text }] })
  });
  return res.ok;
}
async function replyLine(replyToken, text, env) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + env.LINE_TOKEN,
    },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] })
  });
  return res.ok;
}

// ── 署名検証 ─────────────────────────────────────────────────
async function verifySignature(body, signature, channelSecret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(channelSecret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signed   = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  const expected = btoa(String.fromCharCode(...new Uint8Array(signed)));
  return expected === signature;
}

// ── FxEsパーサー ──────────────────────────────────────────────
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

  rows.sort((a, b) => {
    const da = a.date + ' ' + a.time;
    const db = b.date + ' ' + b.time;
    return da < db ? -1 : da > db ? 1 : 0;
  });

  const latest = rows[rows.length - 1];
  const prev   = rows.length >= 2 ? rows[rows.length - 2] : null;
  for (const k of ['ok', 'yg', 'to', 'wk']) {
    latest[k + '_prev'] = prev ? prev[k] : null;
    latest[k] = latest[k] != null ? latest[k].toFixed(1) : '--';
  }
  return latest;
}

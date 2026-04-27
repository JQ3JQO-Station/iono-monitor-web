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

    // GET → CORSプロキシ / デバッグ
    if (request.method === 'GET') {
      // LINE API 状態確認（デバッグ用）
      if (url.searchParams.get('action') === 'line-status') {
        const [quota, consumption] = await Promise.all([
          fetch('https://api.line.me/v2/bot/message/quota', {
            headers: { 'Authorization': 'Bearer ' + env.LINE_TOKEN }
          }).then(r => r.json()),
          fetch('https://api.line.me/v2/bot/message/quota/consumption', {
            headers: { 'Authorization': 'Bearer ' + env.LINE_TOKEN }
          }).then(r => r.json()),
        ]);
        return new Response(JSON.stringify({ quota, consumption }, null, 2), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
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
  // replyLine は返信トークン期限切れで失敗しやすいため pushLine を使用
  await pushLine(userId,
    'CB DX Iono Monitor の通知登録へようこそ！\nお名前を入力してください：', env);
  await env.IONO_STATE.put(`state_${userId}`, 'AWAITING_NAME', { expirationTtl: 86400 });
}

// ── メッセージイベント ────────────────────────────────────────
async function handleMessage(event, env) {
  const userId = event.source.userId;
  const text   = event.message.text.trim();

  // 管理者コマンド（一覧など管理専用コマンドのみ先に処理。設定変更・状態は通常フローへ）
  if (userId === env.LINE_USER_ID) {
    const handled = await handleAdminCommand(text, event, env);
    if (handled) return;
  }

  const state = (await env.IONO_STATE.get(`state_${userId}`)) || 'NONE';

  // 名前の受付 → 承認不要・即時登録
  if (state === 'AWAITING_NAME') {
    const recipients = await getRecipients(env);
    if (!recipients.find(r => r.lineId === userId)) {
      recipients.push({
        lineId: userId, name: text,
        activeDays: [0,1,2,3,4,5,6],
        activeHours: { start: 0, end: 24 },
        registeredAt: new Date().toISOString()
      });
      await env.IONO_STATE.put('recipients', JSON.stringify(recipients));
    }
    await env.IONO_STATE.put(`state_${userId}`, 'AWAITING_DAYS', { expirationTtl: 86400 });
    await pushLine(userId,
      `✅ ${text} さん、登録しました！\n\n通知を受け取る曜日を教えてください。\n「毎日」「平日」「土日」のいずれかで入力してください。`, env);
    // 管理者に通知
    if (userId !== env.LINE_USER_ID) {
      await pushLine(env.LINE_USER_ID, `📩 新規登録\n名前: ${text}`, env);
    }
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

  // 未登録ユーザーが何か送ってきた場合 → 登録フローを再起動
  const recipients = await getRecipients(env);
  if (!recipients.find(r => r.lineId === userId)) {
    await env.IONO_STATE.put(`state_${userId}`, 'AWAITING_NAME', { expirationTtl: 86400 });
    await replyLine(event.replyToken,
      'CB DX Iono Monitor の通知登録へようこそ！\nお名前を入力してください：', env);
  }
}

// ── 管理者コマンド ────────────────────────────────────────────
// 管理専用コマンドを処理した場合 true を返す。それ以外は false を返し通常フローへ
async function handleAdminCommand(text, event, env) {
  if (text === '一覧') {
    const recipients = await getRecipients(env);
    if (recipients.length === 0) {
      await pushLine(env.LINE_USER_ID, '登録者はいません。', env); return true;
    }
    const dayLabel = { '0,1,2,3,4,5,6': '毎日', '1,2,3,4,5': '平日', '0,6': '土日' };
    const list = recipients.map((r, i) => {
      const dayStr = dayLabel[(r.activeDays || []).join(',')] || '-';
      return `${i+1}. ${r.name} / ${dayStr} / ${r.activeHours.start}-${r.activeHours.end}時`;
    }).join('\n');
    await pushLine(env.LINE_USER_ID, `📋 登録者一覧（${recipients.length}名）\n${list}`, env);
    return true;
  }
  // 一覧以外（設定変更・状態など）は通常フローに任せる
  return false;
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

  // recipients を1回だけ読み込む（クールダウン情報も含む）← KV読み取りを集約
  const recipients = await getRecipients(env);
  let recipientsChanged = false;

  if (!recipients.find(r => r.lineId === env.LINE_USER_ID)) {
    recipients.push({
      lineId: env.LINE_USER_ID, name: '管理者',
      activeDays: [0,1,2,3,4,5,6],
      activeHours: { start: 0, end: 24 },
      registeredAt: new Date().toISOString()
    });
    recipientsChanged = true;
  }

  const names = { ok: '沖縄', yg: '鹿児島', to: '東京', wk: '北海道' };
  const allStations = ['ok', 'yg', 'to', 'wk'];
  const triggered = allStations.filter(k => {
    const v = parseFloat(fxes[k]); return !isNaN(v) && v >= 7.0;
  });

  const now = Date.now();
  const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2時間
  const jstDate = new Date(now + 9 * 3600000);
  const jstHour = jstDate.getUTCHours();
  const jstDay  = jstDate.getUTCDay(); // 0=日, 6=土

  if (triggered.length > 0) {
    for (const r of recipients) {
      if (!r.activeDays.includes(jstDay)) continue;
      if (jstHour < r.activeHours.start || jstHour >= r.activeHours.end) continue;

      if (!r.cooldowns) r.cooldowns = {};

      // クールダウンをメモリ内で確認（KV読み取り不要）
      const newlyTriggered = triggered.filter(k =>
        !r.cooldowns[k] || (now - r.cooldowns[k]) >= COOLDOWN_MS
      );
      if (newlyTriggered.length === 0) continue;

      const detail  = newlyTriggered.map(k => `${names[k]}: ${fxes[k]}`).join(' / ');
      const message = `⚠ CB DX Iono Monitor アラート\nFxEs >= 7.0 検出\n${detail}\n観測時刻: ${fxes.time ?? '--:--'} JST`;

      const sent = await pushLine(r.lineId, message, env);
      if (sent) {
        for (const k of newlyTriggered) {
          r.cooldowns[k] = now; // タイムスタンプをreсipientsに保存
        }
        recipientsChanged = true;
        console.log(`Sent alert to ${r.name}: ${newlyTriggered.join(', ')}`);
      } else {
        console.error(`Failed to send alert to ${r.name} — cooldown NOT set, will retry next cron`);
      }
    }
  } else {
    // 全地点解除 → 2回連続で閾値以下を確認してからクールダウンをリセット
    const clearCount = parseInt(await env.IONO_STATE.get('alert_clearing') || '0') + 1;
    if (clearCount >= 2) {
      for (const r of recipients) { r.cooldowns = {}; }
      await env.IONO_STATE.delete('alert_clearing');
      recipientsChanged = true;
      console.log(`FxEs all clear (confirmed x2) → cooldown cleared`);
    } else {
      await env.IONO_STATE.put('alert_clearing', String(clearCount), { expirationTtl: 1800 });
      console.log(`FxEs all clear (count=${clearCount}/2)`);
    }
  }

  // 変更があった場合のみ1回だけ保存 ← writeを最小化
  if (recipientsChanged) {
    await env.IONO_STATE.put('recipients', JSON.stringify(recipients));
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
  if (!res.ok) {
    const body = await res.text().catch(() => '(body read failed)');
    console.error(`LINE push failed: HTTP ${res.status} — ${body}`);
  }
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

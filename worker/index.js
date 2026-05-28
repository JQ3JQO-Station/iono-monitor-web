// VAPID公開鍵（フロントエンドと共有）
const VAPID_PUBLIC_KEY = 'BDBvHMkYX-dzeypbANl9p9_F65nDHyQwdxPMHWLwlkFiQSg11Hj0kewdgGSCKzSYb6iHHOE-REVU-ukDM7VCOsE';

// LINE継続受信者（管理者 = env.LINE_USER_ID に加えて）
const LINE_EXTRA = [
  'U5d9fea4f70f84986846c41603f5afd7b', // LV206
  'U7cef974f1cb8fdd4a6a642921850d3fd', // せたがやHY19
];

export default {
  // ── ブラウザ / LINE Webhook からのリクエスト ─────────────────
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE',
        'Access-Control-Allow-Headers': 'Content-Type',
      }});
    }

    const url = new URL(request.url);
    const action = url.searchParams.get('action');

    // ── Web Push 購読登録 ──────────────────────────────────────
    if (request.method === 'POST' && action === 'subscribe') {
      const sub = await request.json();
      if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
        return new Response('Invalid subscription', { status: 400 });
      }
      const subs = await getPushSubscriptions(env);
      if (!subs.find(s => s.endpoint === sub.endpoint)) {
        subs.push(sub);
        await env.IONO_STATE.put('push_subscriptions', JSON.stringify(subs));
      }
      return new Response('OK', { headers: { 'Access-Control-Allow-Origin': '*' } });
    }

    // ── Web Push 購読解除 ──────────────────────────────────────
    if (request.method === 'DELETE' && action === 'unsubscribe') {
      const { endpoint } = await request.json();
      let subs = await getPushSubscriptions(env);
      subs = subs.filter(s => s.endpoint !== endpoint);
      await env.IONO_STATE.put('push_subscriptions', JSON.stringify(subs));
      return new Response('OK', { headers: { 'Access-Control-Allow-Origin': '*' } });
    }

    // ── GET ────────────────────────────────────────────────────
    if (request.method === 'GET') {
      // LINE API 状態確認
      if (action === 'line-status') {
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

      // 非ホワイトリスト登録者へのLINE終了通知（一時用）
      if (action === 'farewell-new') {
        const recipients = await getRecipients(env);
        const lineWhitelist = [env.LINE_USER_ID, ...LINE_EXTRA];
        const targets = recipients.filter(r => !lineWhitelist.includes(r.lineId));
        const results = [];
        for (const r of targets) {
          const ok = await pushLine(r.lineId,
            'CB DX Iono MonitorのLINE通知は終了しました。\n\nブラウザ通知（Web Push）に移行しています。\n\n通知の登録はこちら：\nhttps://jq3jqo-station.github.io/iono-monitor-web/\n\niPhoneの方はページ内の手順をご確認ください。\n\nJQ3JQO / KyotoDR120', env);
          results.push({ name: r.name, ok });
        }
        return new Response(JSON.stringify(results, null, 2), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      // VAPID 公開鍵の提供
      if (action === 'vapid-key') {
        return new Response(JSON.stringify({ publicKey: VAPID_PUBLIC_KEY }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      // CORSプロキシ
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
        return handleWebhook(request, env, signature);
      }
      // 互換維持
      const { message } = await request.json();
      const ok = await pushLine(env.LINE_USER_ID, message, env);
      return new Response(JSON.stringify({ ok }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    return new Response('Method not allowed', { status: 405 });
  },

  // ── Cron（5分ごと自動実行） ────────────────────────────────
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkAndAlert(env));
  },
};

// ── LINE Webhook ─────────────────────────────────────────────
async function handleWebhook(request, env, signature) {
  const body = await request.text();
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
  // LINE通知は終了済み。新規登録は受け付けずWeb Pushへ誘導する
  await pushLine(userId,
    'CB DX Iono MonitorのLINE通知は終了しました。\n\nブラウザ通知（Web Push）に移行しています。\n\n通知の登録はこちら：\nhttps://jq3jqo-station.github.io/iono-monitor-web/\n\niPhoneの方はページ内の手順をご確認ください。\n\nJQ3JQO / KyotoDR120', env);
}

// ── メッセージイベント ────────────────────────────────────────
async function handleMessage(event, env) {
  const userId = event.source.userId;
  const text   = event.message.text.trim();

  if (userId === env.LINE_USER_ID) {
    const handled = await handleAdminCommand(text, event, env);
    if (handled) return;
  }

  // ホワイトリスト外のユーザーにはLINE通知終了案内を返す
  const lineWhitelist = [env.LINE_USER_ID, ...LINE_EXTRA];
  if (!lineWhitelist.includes(userId)) {
    await pushLine(userId,
      'CB DX Iono MonitorのLINE通知は終了しました。\n\nブラウザ通知（Web Push）に移行しています。\n\n通知の登録はこちら：\nhttps://jq3jqo-station.github.io/iono-monitor-web/\n\niPhoneの方はページ内の手順をご確認ください。\n\nJQ3JQO / KyotoDR120', env);
    return;
  }

  const state = (await env.IONO_STATE.get(`state_${userId}`)) || 'NONE';

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
    if (userId !== env.LINE_USER_ID) {
      await pushLine(env.LINE_USER_ID, `📩 新規登録\n名前: ${text}`, env);
    }
    return;
  }

  if (state === 'AWAITING_DAYS') {
    let days;
    if (text.includes('毎日'))    days = [0,1,2,3,4,5,6];
    else if (text.includes('平日')) days = [1,2,3,4,5];
    else if (text.includes('土日')) days = [0,6];
    else {
      await replyLine(event.replyToken, '「毎日」「平日」「土日」のいずれかで入力してください。', env);
      return;
    }
    await updateRecipient(userId, { activeDays: days }, env);
    await env.IONO_STATE.put(`state_${userId}`, 'AWAITING_HOURS', { expirationTtl: 86400 });
    await replyLine(event.replyToken,
      '通知を受け取る時間帯を入力してください。\n例: 18-23（18:00〜23:00）\n24時間受け取る場合: 0-24', env);
    return;
  }

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

  if (text === '設定変更') {
    await env.IONO_STATE.put(`state_${userId}`, 'AWAITING_DAYS', { expirationTtl: 86400 });
    await replyLine(event.replyToken,
      '通知曜日を教えてください。\n「毎日」「平日」「土日」のいずれかで入力してください。', env);
    return;
  }

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

  const recipients = await getRecipients(env);
  if (!recipients.find(r => r.lineId === userId)) {
    await env.IONO_STATE.put(`state_${userId}`, 'AWAITING_NAME', { expirationTtl: 86400 });
    await replyLine(event.replyToken,
      'CB DX Iono Monitor の通知登録へようこそ！\nお名前を入力してください：', env);
  }
}

// ── 管理者コマンド ────────────────────────────────────────────
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
    const v = parseFloat(fxes[k]); return !isNaN(v) && v >= 6.0;
  });

  const now = Date.now();
  const COOLDOWN_MS = 2 * 60 * 60 * 1000;
  const jstDate = new Date(now + 9 * 3600000);
  const jstHour = jstDate.getUTCHours();
  const jstDay  = jstDate.getUTCDay();

  // システム時間帯チェック：05:00〜20:00 JST
  const SYSTEM_HOUR_START = 5;
  const SYSTEM_HOUR_END   = 20;
  if (jstHour < SYSTEM_HOUR_START || jstHour >= SYSTEM_HOUR_END) {
    console.log(`Out of system hours (${jstHour}:xx JST) — skip alert`);
    return;
  }

  const lineWhitelist = [env.LINE_USER_ID, ...LINE_EXTRA];

  if (triggered.length > 0) {
    // ── LINE通知（ホワイトリスト3名のみ）
    for (const r of recipients) {
      if (!lineWhitelist.includes(r.lineId)) continue;
      if (!r.activeDays.includes(jstDay)) continue;
      if (jstHour < r.activeHours.start || jstHour >= r.activeHours.end) continue;

      if (!r.cooldowns) r.cooldowns = {};
      const newlyTriggered = triggered.filter(k =>
        !r.cooldowns[k] || (now - r.cooldowns[k]) >= COOLDOWN_MS
      );
      if (newlyTriggered.length === 0) continue;

      const detail  = newlyTriggered.map(k => `${names[k]}: ${fxes[k]}`).join(' / ');
      const message = `⚠ CB DX Iono Monitor アラート\nFxEs >= 6.0 検出\n${detail}\n観測時刻: ${fxes.time ?? '--:--'} JST`;

      const sent = await pushLine(r.lineId, message, env);
      if (sent) {
        for (const k of newlyTriggered) r.cooldowns[k] = now;
        recipientsChanged = true;
        console.log(`LINE sent to ${r.name}: ${newlyTriggered.join(', ')}`);
      } else {
        console.error(`LINE failed for ${r.name} — cooldown NOT set`);
      }
    }

    // ── Web Push通知（全購読者）
    await sendWebPushAlert(triggered, fxes, names, now, COOLDOWN_MS, env);

  } else {
    // 全地点解除 → 2回確認後にクールダウンリセット
    const clearCount = parseInt(await env.IONO_STATE.get('alert_clearing') || '0') + 1;
    if (clearCount >= 2) {
      for (const r of recipients) { r.cooldowns = {}; }
      await env.IONO_STATE.delete('alert_clearing');
      // Web Pushのクールダウンもリセット
      await env.IONO_STATE.delete('webpush_state');
      recipientsChanged = true;
      console.log(`FxEs all clear (confirmed x2) → cooldown cleared`);
    } else {
      await env.IONO_STATE.put('alert_clearing', String(clearCount), { expirationTtl: 1800 });
      console.log(`FxEs all clear (count=${clearCount}/2)`);
    }
  }

  if (recipientsChanged) {
    await env.IONO_STATE.put('recipients', JSON.stringify(recipients));
  }
}

// ── Web Push アラート送信 ─────────────────────────────────────
async function sendWebPushAlert(triggered, fxes, names, now, COOLDOWN_MS, env) {
  const subs = await getPushSubscriptions(env);
  if (subs.length === 0) return;

  // Web Push用クールダウン
  const stateStr = await env.IONO_STATE.get('webpush_state');
  const wpState = stateStr ? JSON.parse(stateStr) : { cooldowns: {} };

  const newlyTriggered = triggered.filter(k =>
    !wpState.cooldowns[k] || (now - wpState.cooldowns[k]) >= COOLDOWN_MS
  );
  if (newlyTriggered.length === 0) {
    console.log('Web Push: all stations in cooldown');
    return;
  }

  const detail  = newlyTriggered.map(k => `${names[k]}: ${fxes[k]}`).join(' / ');
  const payload = JSON.stringify({
    title: '⚠ CB DX Iono Monitor',
    body: `FxEs >= 6.0 検出: ${detail}（${fxes.time ?? '--:--'} JST）`,
    url: 'https://jq3jqo-station.github.io/iono-monitor-web/monitor.html',
  });

  let successCount = 0;
  const validSubs = [];
  for (const sub of subs) {
    try {
      const ok = await sendWebPush(sub, payload, env);
      if (ok) {
        successCount++;
        validSubs.push(sub);
      } else {
        console.log(`Web Push failed (410 expired?): ${sub.endpoint.slice(0, 60)}`);
        // 410 Gone = 期限切れ購読は削除済み（sendWebPushで対処）
        validSubs.push(sub); // 一旦残す（410は別処理）
      }
    } catch (e) {
      console.error('Web Push error:', e.message);
      validSubs.push(sub);
    }
  }

  for (const k of newlyTriggered) wpState.cooldowns[k] = now;
  await env.IONO_STATE.put('webpush_state', JSON.stringify(wpState));
  console.log(`Web Push sent to ${successCount}/${subs.length} subscribers`);
}

// ── Web Push 送信（RFC 8291 / RFC 8292） ───────────────────────
async function sendWebPush(subscription, payloadStr, env) {
  const { endpoint, keys } = subscription;

  // ペイロード暗号化
  const { ciphertext, salt, senderPublicKey } = await encryptWebPush(
    payloadStr, keys.p256dh, keys.auth
  );

  // aes128gcm レコード形式（RFC 8188）
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);
  const keylen = new Uint8Array([65]);
  const body = concatBytes(salt, rs, keylen, senderPublicKey, ciphertext);

  // VAPID認証ヘッダー
  const authorization = await createVapidAuth(endpoint, env);

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': authorization,
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': '86400',
    },
    body: body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`Web Push HTTP ${res.status}: ${text.slice(0, 100)}`);
  }
  return res.ok;
}

// ── RFC 8291 ペイロード暗号化 ─────────────────────────────────
async function encryptWebPush(payloadStr, p256dh, auth) {
  const recipientPubKeyBytes = b64urlToBytes(p256dh);
  const authSecret = b64urlToBytes(auth);
  const payload = new TextEncoder().encode(payloadStr);

  // 送信者の一時鍵ペア生成
  const senderKP = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
  );
  const senderPubKeyBytes = new Uint8Array(
    await crypto.subtle.exportKey('raw', senderKP.publicKey)
  );

  // 受信者公開鍵インポート
  const recipientPubKey = await crypto.subtle.importKey(
    'raw', recipientPubKeyBytes,
    { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );

  // ECDH共有シークレット
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: recipientPubKey },
    senderKP.privateKey, 256
  ));

  // ソルト（16バイト）
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // PRK = HKDF(IKM=sharedSecret, salt=authSecret, info="WebPush: info\0"+recipPub+sendPub, L=32)
  const prk_info = concatBytes(
    new TextEncoder().encode('WebPush: info\x00'),
    recipientPubKeyBytes,
    senderPubKeyBytes
  );
  const prk = await hkdf(sharedSecret, authSecret, prk_info, 32);

  // CEK = HKDF(IKM=prk, salt=salt, info="Content-Encoding: aes128gcm\0", L=16)
  const cek = await hkdf(prk, salt,
    new TextEncoder().encode('Content-Encoding: aes128gcm\x00'), 16);

  // Nonce = HKDF(IKM=prk, salt=salt, info="Content-Encoding: nonce\0", L=12)
  const nonce = await hkdf(prk, salt,
    new TextEncoder().encode('Content-Encoding: nonce\x00'), 12);

  // AES-128-GCM暗号化（payload || 0x02）
  const plaintext = concatBytes(payload, new Uint8Array([2]));
  const cekKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce }, cekKey, plaintext
  ));

  return { ciphertext, salt, senderPublicKey: senderPubKeyBytes };
}

// ── HKDF (Extract + Expand, single block) ────────────────────
async function hkdf(ikm, salt, info, length) {
  const saltKey = await crypto.subtle.importKey(
    'raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const prk = new Uint8Array(await crypto.subtle.sign('HMAC', saltKey, ikm));
  const prkKey = await crypto.subtle.importKey(
    'raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const t = new Uint8Array(await crypto.subtle.sign(
    'HMAC', prkKey, concatBytes(info, new Uint8Array([1]))
  ));
  return t.slice(0, length);
}

// ── VAPID JWT（RFC 8292） ────────────────────────────────────
async function createVapidAuth(endpoint, env) {
  const audience = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);
  const header  = strToB64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = strToB64url(JSON.stringify({
    aud: audience, exp: now + 3600, sub: 'mailto:yotsuzeki@gmail.com'
  }));
  const toSign = `${header}.${payload}`;

  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const privateKey = await crypto.subtle.importKey(
    'jwk', { ...jwk, key_ops: ['sign'] },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  );
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(toSign)
  ));
  const token = `${toSign}.${bytesToB64url(sig)}`;
  return `vapid t=${token},k=${VAPID_PUBLIC_KEY}`;
}

// ── バイト列ユーティリティ ────────────────────────────────────
function concatBytes(...arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}
function b64urlToBytes(str) {
  const padded = str + '='.repeat((4 - str.length % 4) % 4);
  const bin = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  return new Uint8Array([...bin].map(c => c.charCodeAt(0)));
}
function bytesToB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function strToB64url(str) {
  return bytesToB64url(new TextEncoder().encode(str));
}

// ── KV ヘルパー ───────────────────────────────────────────────
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
async function getPushSubscriptions(env) {
  const str = await env.IONO_STATE.get('push_subscriptions');
  return str ? JSON.parse(str) : [];
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

// ── 署名検証 ──────────────────────────────────────────────────
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

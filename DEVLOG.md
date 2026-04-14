# DEVLOG — CB DX Iono Monitor

セッション間の作業引き継ぎログ。Claude が各セッション終了時に追記する。

---

## 2026-04-13 15:46 — Discord セッション

- FxEsマーカーを四角形に変更
- 直近4回分（1時間）の履歴をマーカー内に表示（過去3回小さく上部、最新値大きく下部）
- 過去3回分でEs発生（>= 9.0）の値を赤字太字に変更
- 沖縄マーカー位置を微調整（右に1/4移動）
- **Cloudflare Worker に Cron 追加（最重要）**
  - `worker/index.js` 新規作成 → デプロイ済み
  - 15分ごと自動実行でNICT直接取得 → 東京・鹿児島 FxEs >= 9.0 でLINE送信
  - KV(IONO_STATE) で重複防止（TTL 2時間）
  - ブラウザ不要でLINEアラート送信可能になった

---

## 2026-04-14 — Desktop セッション

- corsproxy.io が403になったため、自前Cloudflare Worker（GET ?url=）に切り替え
- スポラジック → スポラディック スペル修正
- FxEs赤マーカー時の矢印を白色に変更
- LINEアラートの重複送信問題を解決
  - 原因: Discord セッションで実装済みのCron Workerに加え、ブラウザ側でも独立してLINE送信していた
  - 修正: ブラウザ側のLINE送信コードを削除、バナー表示のみに
  - LINE送信はCron Worker（KV管理）に一本化
- CLAUDE.md / DEVLOG.md 新規作成（セッション間引き継ぎ体制を整備）

---
<!-- 以下に新しいセッションの記録を追加 -->

## 2026-04-14 15:44 — Auto-log
49d78ee Remove browser-side LINE sending, LINE is now handled by Cron Worker
34e1447 data: update 06:17
33b6a4e data: update 04:20
1311885 data: update 01:08
1a0b27f data: update 23:29

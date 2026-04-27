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

---

## 2026-04-26 — Desktop セッション

- `docs/guide.html` 新規作成
  - Es伝播の仕組み（SVGイラスト、ワンスパン距離、λ/4アンテナ特性）
  - FxEsカラースケール説明
  - MUFカード（F2層伝搬であることを明記、高度比較SVG）
  - アンテナ傾きテクニック（傾け角テーブル、チップ変位量、スマホアプリによる計測）
  - Esリフレクションポイントシミュレーター（47都道府県ドロップダウン、スキップゾーン可視化）
- `docs/privacy.html` 新規作成
  - 運営者情報・LINE UserID取り扱い・NICT/NOAAデータ利用条件・免責事項
- `docs/index.html` 更新：データ出典に利用条件追記、フッターにプライバシーポリシーリンク追加
- `docs/monitor.html` 更新：LINE通知モーダルに注記追加、フッターにリンク追加

### LINE通知不達バグ修正・仕様変更（重要）
- **症状**：2026-04-28 07:05 JST、東京国分寺 FxEs=9.3 MHz 検出 → LINE通知届かず
- **原因**：`worker/index.js` で `pushLine()` の戻り値を確認せずクールダウンをセット
  → push失敗でもクールダウンが2時間有効になり、次回クーロンでの再試行がブロックされていた
- **即時対処**：本番KVの全受信者の "to" クールダウンをクリア（手動、wrangler経由）
- **コード修正**：`pushLine()` の戻り値（`res.ok`）を `sent` で受け取り、`true` の場合のみクールダウンセット
- **デプロイ**：`npx wrangler deploy` 完了（Version ID: 860ba167）
- **根本原因 2**：LINE無料プランの月間上限200通を使い切っていた（9人×複数回）
  - `/line-status` エンドポイント追加で即時確認可能に
  - pushLine失敗時にHTTPステータス・レスポンスボディをログ出力するよう改善
- **仕様変更**：システム全体の通知時間帯を 05:00〜20:00 JST に統一（Version ID: 7a5f17e3）
  - 夜間の不要な送信をなくし月間消費を削減
  - サイト（index.html・monitor.html）にお知らせバナーを追加（5/6まで表示）
- **注意**：5月1日に月間通数リセット → 通知復旧予定

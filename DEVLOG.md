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

---

## 2026-05-02 — Desktop セッション

### Web Push通知の実装（LINE通知から移行）
- **背景**：Es盛期に登録者14名×複数回でLINE月200通上限に即日到達
- **方針**：LINE通知は3名（管理者・LV206・せたがやHY19）のみ継続、他はWeb Pushに移行

#### Workerの変更（`worker/index.js`）
- Web Push送信実装（RFC 8291 aes128gcm暗号化 + RFC 8292 VAPID JWT）
  - CF Workers ネイティブ Web Crypto API で実装（外部ライブラリ不使用）
  - ECDH共有シークレット → HKDF → AES-128-GCM
- VAPIDキーペア生成・`VAPID_PRIVATE_JWK` をWorkerシークレットに登録
- `?action=subscribe` (POST) / `?action=unsubscribe` (DELETE) エンドポイント追加
- `checkAndAlert()` にLINEホワイトリスト（3名）チェックを追加
- Web Push用クールダウン（`webpush_state` KVキー）を追加
- **デプロイ**：Version ID `1b11f008`

#### フロントエンドの変更
- `docs/sw.js` 新規作成（Service Worker：push受信・通知クリック）
- `docs/index.html`：「Es発生通知を登録する」ボタン追加、iPhone向け手順モーダル追加
- `docs/monitor.html`：LINE申込ボタン → 通知登録ボタンに変更、モーダル追加

#### LINE終了アナウンス
- 11名（ホワイトリスト外）に終了アナウンスをLINE送信（全員 ok: true）
- 送信時点の消費数: ~191/200通

---

## 2026-05-02 続き — Desktop セッション

### PWAアイコン整備
- ホーム画面アイコンが「C」になる問題を修正
- `docs/icon-192.png` / `docs/icon-512.png` 新規作成（Python stdlib で生成、navy背景＋amber「Es」文字）
- `docs/manifest.json` を `index.html` / `monitor.html` の `<head>` に `<link rel="manifest">` で紐付け
- `apple-mobile-web-app-capable` / `apple-mobile-web-app-title` / `apple-touch-icon` メタタグ追加
- ユーザー（karamasu0134）がiPhone PWAでの通知登録を完了確認済み

### iPhone通知登録ガイドカードの追加
- `docs/index.html`：ボタンのサブテキストから「無料・無制限」を削除
- メニューカード下にiPhone向け通知登録ガイドカードを新設
  - 「iPhoneはホーム画面への追加が必要」の事前説明
  - 実機スクショ付き4ステップ手順（…→共有、ホーム画面に追加）
- `docs/ios-step1.png` / `docs/ios-step2.png`：実機スクショをPython stdlibで300px幅にクロップ・リサイズして追加

### LINE移行アナウンスバナーの追加
- `docs/index.html`：announce-banner div を復活・内容をLINE→Web Push移行のお知らせに変更
  - その日の初回閲覧時に表示、✕で当日非表示
  - KEY: announce_20260502、期限: 2026-05-08T15:00:00Z（5/8 JST末まで）
  - 旧バナー（announce_20260428）から差し替え

### LINE新規登録ブロック・非WL者への終了通知（重要）
- **経緯**：LINE終了アナウンス後に新規登録者が発生
- **`worker/index.js` 修正**：
  - `handleFollow`：登録フローを停止、友達追加時にWeb Push誘導メッセージを自動返信
  - `handleMessage`：ホワイトリスト外ユーザーのメッセージに終了案内を返す
  - `?action=farewell-new`（GET）：非WL登録者への一斉終了通知エンドポイント（使用後は残置、再実行可）
- **一斉送信実施**：非WL登録者12名に送信 → ok:true 5名、ok:false 7名（ブロック/退会済み）
- **デプロイ**：Version ID `961612a2`

---

## 2026-05-08 — Discord セッション

### FxEs履歴蓄積を追加
- `docs/fxes-history.json` 新規作成：git履歴448件（4/9〜現在）からFxEsデータを抽出・保存
  - 形式：`[{ts, ok, yg, to, wk}, ...]`（UTCタイムスタンプ、昇順）
  - ファイルサイズ：約49KB
- `scripts/fetch-data.js` 改修：15分更新ごとにfxes-history.jsonへ追記
  - 重複タイムスタンプはスキップ
- `scripts/extract-fxes-history.js` 追加：初回抽出スクリプト（実行済み、以後不要）
- OPERATION LOGにCB×Es分析カードを追加（ログ/検索タブ末尾）
  - 年月セレクター → その月のCB交信一覧 × FxEs4地点
  - FxEs 9.0以上を赤字強調
  - 「テスト中」バッジ付き

### NICTアーカイブデータ取り込み（2025-2026全局）
- NICTアーカイブから4局×2年分を取り込み → `docs/fxes-history.json` を大幅拡充
  - 取り込み前：448件（4/9〜現在、gitのみ）
  - 取り込み後：**70,080件**（2025/1/1〜2026/12/31）
  - 対象局：OK426（沖縄）・YG431（鹿児島）・TO536（東京）・WK546（北海道）
  - ファイルサイズ：5.0MB（コンパクトJSON形式）
  - データソース：https://wdc.nict.go.jp/Ionosphere/archive/observation-history/
- `scripts/merge-nict-history.js`：NICTアーカイブマージスクリプトを追加
- `scripts/fetch-data.js`：fxes-history.json書き込みをコンパクト形式に変更
- 2025年7月のEsイベント（9MHz超）1,294件を収録
- 昨年5月からのQSO履歴とFxEsの突き合わせが可能になった

---

## 2026-05-19 — Discord セッション

### fxes-history.json 自動更新バグ修正
- **症状**：5/18以降のFxEsデータがCB×Es分析に表示されない
- **原因①**：`.github/workflows/fetch-data.yml` の `git add` に `fxes-history.json` が含まれていなかった
- **原因②**：2026アーカイブ取り込み時に12月末まで全て`--`の空行が入り込み、fetch-data.jsが「重複タイムスタンプ」としてスキップ
- **修正①**：fetch-data.yml に `docs/fxes-history.json` を追加（根本修正）
- **修正②**：fetch-data.js: 重複タイムスタンプでも値を上書きするよう変更
- **補完**：2026アーカイブ最新版で5/9〜5/18の欠落データを補完（47,560件）
- 次回GitHub Actions実行から5/19以降も自動蓄積される

---

## 2026-05-23 — Discord セッション

### GitHub Actionsの失敗メール対応
- **症状**：5/19以降、15分ジョブが高頻度で失敗しメール通知が届くようになった
- **原因**：5/19の修正でfxes-history.jsonを15分ジョブに追加したが、複数ジョブ同時実行で毎回push競合が発生
- **修正**：fxes-history.jsonの更新を日次専用ジョブに分離
  - `fetch-data.yml`：fxes-history.jsonのgit addを削除（data.jsonのみ）
  - `update-fxes-history.yml`：新規作成（毎日01:30 JST / 16:30 UTC）
    - NICTアーカイブ（前年・当年の4局分）を再ダウンロード
    - `merge-nict-history.js` を実行してfxes-history.jsonを更新・コミット
  - `merge-nict-history.js`：年自動検出・全--除外・NICTデータで上書き対応

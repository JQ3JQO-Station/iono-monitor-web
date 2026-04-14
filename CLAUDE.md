# CB DX Iono Monitor — Claude セッション引き継ぎ設定

## セッション開始時に必ず実行すること

1. **最新コードを取得**
   ```
   git pull
   ```

2. **作業ログを確認**
   `DEVLOG.md` を読んで前回セッションの作業内容を把握する。

3. **最新コミットを確認**
   ```
   git log --oneline -10
   ```

---

## セッション終了時に必ず実行すること

重要な作業（コード変更・デプロイ・設定変更）を行った場合は `DEVLOG.md` に追記する。

フォーマット：
```
## YYYY-MM-DD HH:MM — [セッション種別: Desktop/Discord]
- やったこと1
- やったこと2
- 注意点・未完了事項
```

---

## プロジェクト概要

- **本番URL**: https://jq3jqo-station.github.io/iono-monitor-web/
- **リポジトリ**: /Users/yonzekishigeki/Desktop/電子工作/iono-monitor-web/
- **主要ファイル**:
  - `docs/index.html` — メインWebアプリ（ブラウザ直接取得）
  - `scripts/fetch-data.js` — GitHub Actions用データ取得スクリプト
  - `worker/index.js` — Cloudflare Worker（CORSプロキシ + Cron LINEアラート）
  - `worker/wrangler.toml` — Worker設定（KVバインディング含む）

## アーキテクチャ

```
NICT / NOAA
  ↓ 15分ごと
GitHub Actions (fetch-data.js)
  → docs/data.json に保存・push

Cloudflare Worker Cron (worker/index.js) — 15分ごと独立実行
  → NICT直接取得
  → 東京・鹿児島 FxEs >= 9.0 で LINE送信
  → KV(IONO_STATE) で重複防止（TTL 2時間）

ブラウザ (docs/index.html)
  → Worker経由でNICT/NOAA直接取得（CORSプロキシ）
  → アラートバナー表示のみ（LINE送信はWorkerが担当）
```

## 重要な設定値

- **Worker URL**: https://iono-line-alert.yotsuzeki.workers.dev
- **KV namespace**: IONO_STATE（ID: 74476cad97de42928c6c0fca0b7a62a4）
- **LINE通知条件**: 東京(TO536) または 鹿児島(YG431) の FxEs >= 9.0
- **LINE通知なし**: 沖縄・北海道はバナーのみ
- **CORSプロキシ**: Worker の GET ?url= エンドポイント（corsproxy.io が403のため）

## 注意事項

- Worker の変更は `cd worker && npx wrangler deploy` でデプロイが必要
- GitHub Actions は push で自動実行される
- LINE トークンは Long-lived（無期限）→ 更新不要
- `docs/color-sample.html` と `docs/manual.html` は補助ファイル（変更不要）

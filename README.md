# セキュリティ通知アプリ

Cloudflareのセキュリティイベント（ブロックされたリクエスト、チャレンジ）を監視し、登録されたエンドポイントに通知を送信するCloudflare Workerアプリです。

## 機能

- 毎日 6:00 JST に過去24時間分の Cloudflare セキュリティイベントを集約して通知
- 複数の通知エンドポイントに対応（Webhook、Slack、メール）
- Durable Objectsを使用して通知設定を保存
- KVストレージを使用して重複通知を防止
- 通知エンドポイント管理用のREST API

## セットアップ

1. 依存関係をインストール:
```bash
npm install
```

2. KV名前空間を作成:
```bash
wrangler kv:namespace create "PROCESSED_EVENTS"
```

3. zone ID を設定 (zone ID は機密ではないので plain vars に直書き):
```jsonc
// wrangler.jsonc
"vars": {
  "CLOUDFLARE_ZONE_IDS": "<zone-id-1>,<zone-id-2>"
}
```

4. API token を CF Secrets Store に投入 (値は context に出さない):
```bash
# Cloudflare dashboard で zone analytics:read 権限の API token を発行してから:
echo -n '<token値>' | bash ~/.claude/skills/secret-inject/scripts/inject-secret.sh \
  security-notification-app-cf-api-token --targets gcp,cf
```

CF Secrets Store の `bd7bc91a3e5f4111add4acf6cb4b8733/security-notification-app-cf-api-token` に入り、`wrangler.jsonc` の `secrets_store_secrets` binding 経由で `env.CLOUDFLARE_API_TOKEN.get()` から読める。

5. `wrangler.jsonc`にKV名前空間IDを設定

5. デプロイ:
```bash
npm run deploy
```

## APIエンドポイント

### すべての通知エンドポイントを取得
```
GET /api/endpoints
```

### 通知エンドポイントを追加
```
POST /api/endpoints
Content-Type: application/json

{
  "name": "My Slack Channel",
  "type": "slack",
  "url": "https://hooks.slack.com/services/YOUR/WEBHOOK/URL",
  "enabled": true
}
```

### 通知エンドポイントを削除
```
DELETE /api/endpoints/{id}
```

### エンドポイントのオン/オフを切り替え
```
POST /api/endpoints/{id}/toggle
Content-Type: application/json

{
  "enabled": false
}
```

### 手動でセキュリティチェックを実行
```
POST /api/check-events
```

## 通知タイプ

- **webhook**: 汎用Webhook（JSONペイロードを送信）
- **slack**: Slack Webhook（フォーマット済みメッセージ）
- **email**: メール通知（未実装）

## 監視対象のセキュリティイベント

- `block`: セキュリティルールによってブロックされたリクエスト
- `challenge`: チャレンジを受けたリクエスト
- `jschallenge`: JavaScriptチャレンジ

## CF Access 観点の分類 (トリアージ)

通知 (email / Slack / webhook) には、各イベントの host を **CF Access 対応が必要か**で
分類した集計が載る。`block` の大半は WAF が無料で弾いた routine だが、その中から
「Access を被せるべき開発系」や「判断できない host」を拾い出すのが目的。

| カテゴリ | 意味 |
|---|---|
| ⚠️ 要 CF Access 検討 | dev/staging/internal 風だが Access 未適用の host (= 対応候補) |
| ❓ 不明 (要確認) | どのパターンにも当てはまらない host (= 人間が分類する対象) |
| ✅ CF Access 済み | 既に Access で保護済みとみなす host |
| 🌐 公開 (Access 不要) | 公開本番。WAF/Bot で対処 |

- email 件名には actionable (要検討 + 不明) 件数が ` ⚠️要対応 N` として付く。
- 分類ロジックは `src/classify.ts` (pure module、副作用なし)。host パターンは
  `wrangler.jsonc` の `vars` で上書き可能 (未設定は ippoan 向けデフォルト):

| var | デフォルト | 用途 |
|---|---|---|
| `ACCESS_GATED_PATTERNS` | `*-staging.ippoan.org,*-dev.ippoan.org` | Access 済み host |
| `ACCESS_CANDIDATE_PATTERNS` | `*staging*,*dev*,*test*,*internal*,*admin*,*preview*` | 要対応候補 |
| `ACCESS_PUBLIC_PATTERNS` | `*.ippoan.org,*.mtamaramu.com,*.m-tama-ramu.workers.dev` | 公開本番 |

> 注: gated 判定は **config (host パターン) ベース**で、live な CF Access API は
> 叩かない (worker token は Security Events Read scope のみ)。config に無い既 gated
> host は candidate/public に誤分類され得る = あくまでトリアージのヒント。

## 通知ノイズの抑制 (件数閾値)

`NOTIFY_MIN_EVENTS` (plain var、未設定 = `1` で現状維持) を超えた時だけ通知する。
少件数の routine block 日を黙らせたい場合に上げる。閾値未満でも **dedupe mark
(`PROCESSED_EVENTS` KV) と observability log は残す**ので、取りこぼしや二重通知は無い。

```jsonc
// wrangler.jsonc vars 例
"NOTIFY_MIN_EVENTS": "20"   // 20 件未満の日はメールしない
```

週次ダイジェストにしたい場合は `triggers.crons` を `"0 21 * * 0"` (日曜のみ) 等に変更する。

## 必要なCloudflare API権限

APIトークンには以下の権限が必要です:
- Zone > Security Events > Read

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ohishi-yhonda-pub/security-notification-app)

test
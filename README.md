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

## 必要なCloudflare API権限

APIトークンには以下の権限が必要です:
- Zone > Security Events > Read

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ohishi-yhonda-pub/security-notification-app)

test
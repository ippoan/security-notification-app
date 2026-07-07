---
name: security-notification-app-map
generated-from: security-notification-app:8dc16190def60c5914d87f853bdb4b4a3fe05cd7
paths: [src/]
description: ippoan/security-notification-app (Cloudflare Workers + Durable Object、Cloudflare WAF firewall events を毎日 6:00 JST に過去 24h 分集約して email / webhook / Slack に通知) の構造ナビゲーション。GraphQL Analytics で `firewallEventsAdaptive` を multi-zone (`zoneTag_in`) で aggregate、KV (`PROCESSED_EVENTS`) で 48h dedupe (24h window x 2 で境界重複吸収)、DO (`NotificationManager`) で endpoint CRUD と通知配信。CF Secrets Store binding (`CLOUDFLARE_API_TOKEN`) と plain vars (`CLOUDFLARE_ZONE_IDS` comma-separated) の組み合わせ、single-env 運用、Workers Observability への構造化 log の配置と gotcha を 1 枚にまとめる。トリガー:「security-notification-app」「security-notifier」「firewall events」「WAF block 通知」「CLOUDFLARE_ZONE_IDS」「firewallEventsAdaptive」「checkAndNotifySecurityEvents」「/api/check-events」「security_events_detected log」「NotificationManager DO」等。
---

# security-notification-app-map — ippoan/security-notification-app 構造ナビゲーション

Cloudflare WAF の firewall events を `firewallEventsAdaptive` GraphQL から
取得し、新規 events だけ email (CF Email Routing) と (登録された) webhook /
Slack endpoint へ通知する単一 Worker。

`src/index.ts` 1 ファイルに全ロジック (Durable Object `NotificationManager` +
`WorkerEntrypoint` 形式の fetch/scheduled/RPC) が並ぶ。

> 細部 (GraphQL field 名、KV key 命名、HTML email layout) は repo 側が正。
> ここは「どこを見るか」の索引。frontmatter の `generated-from` が現在の
> tree-sha とズレたら skills-check CI が警告する。

## 区画 (`src/index.ts` 内の構造)

| symbol | 役割 |
|---|---|
| `readApiToken(env)` | `CLOUDFLARE_API_TOKEN` binding を本番 (`SecretsStoreSecret`) と vitest miniflare (plain string) の両形 normalize する helper |
| `NotificationManager` (DO) | endpoint storage (`endpoint:<id>` KV-on-DO) + `checkAndNotifySecurityEvents` + `fetchSecurityEvents` (GraphQL) + `sendNotificationsBatch` |
| `SecurityNotificationWorker` (default export) | `WorkerEntrypoint`。RPC method (`checkSecurityEvents` / `addEndpoint` 等) + HTTP route (`/api/endpoints` CRUD / `/api/check-events`) + `scheduled` (cron) |
| `sendEmailBatch` (DO 内) | `cloudflare:email` + `mimetext` で HTML テーブル形式 email を送信。`NOTIFY_EMAIL_FROM` → `NOTIFY_EMAIL_TO` 固定、events 最大 20 件 + summary |
| `sendWebhookBatch` / `sendSlackBatch` | endpoint type 別の通知。webhook は JSON POST、Slack は Block Kit |
| `classify.ts` (別ファイル, pure) | CF Access 観点で host を 4 分類 (`access-candidate` / `unknown` / `gated` / `public`) + 集計 + email/Slack/webhook 用 render helper。`summarize` / `classifyHost` / `parseClassifyConfig` / `parseMinEvents` を export。副作用なし = `test/classify.test.ts` で 100% カバー |

## entrypoint (`fetch` の HTTP route)

| path / method | 用途 |
|---|---|
| `GET /api/endpoints` | endpoint 一覧 |
| `POST /api/endpoints` | endpoint 追加 (webhook / slack / email)。`email` type は no-op (重複防止) |
| `DELETE /api/endpoints/<id>` | endpoint 削除 |
| `POST /api/endpoints/<id>/toggle` | enabled 切替 |
| `POST /api/check-events` | **手動 trigger** (cron と同じ処理を即実行)。CCoW から `curl -X POST https://security-notification-app.m-tama-ramu.workers.dev/api/check-events` で叩ける |
| (root) | `Security Notification API` 文字列を返す |

## トリガー

| trigger | flow |
|---|---|
| **cron** `0 21 * * *` (= 06:00 JST 毎日) | `scheduled` → DO `idFromName("global")` → `checkAndNotifySecurityEvents` (過去 24h を集約) |
| **手動** `POST /api/check-events` | 同上、即時実行 |
| **RPC** (`env.SECURITY_NOTIFIER.checkSecurityEvents()` 等) | 他 worker から service binding 経由 |

## gotcha (CLAUDE.md / wrangler.jsonc / 過去 PR 由来)

- **single-env (staging = prod) 運用**: `wrangler.jsonc` は root config 1 個のみ (PR #14 で `env.staging` 撤去)。PR run の `deploy-staging` job と tag push の `deploy-release` job は両方とも `npx wrangler deploy` (= root = prod) を叩く。main push では deploy 走らない (frontend-ci.yml の deploy-staging は `pull_request` event 限定、deploy-release は `refs/tags/v*` 限定)。
- **`CLOUDFLARE_API_TOKEN` は CF Secrets Store binding**: `bd7bc91a3e5f4111add4acf6cb4b8733` / `security-notification-app-cf-api-token`。GCP Secret Manager にも同名 backup、`secret-verify-gcp.yml` が CI で突合。`secrets.required` は **わざと書かない** (wrangler 4.79+ が secrets_store binding 名と衝突して deploy 落ちるため、HCReaderWorker と同様)。
- **`CLOUDFLARE_ZONE_IDS` は plain vars 直書き** (機密ではないため、cf-billing-monitor の `CF_ACCOUNT_ID` と同パターン)。**comma-separated で複数 zone** を渡せる (`zone1,zone2`)。worker が split + `JSON.stringify` して GraphQL `zoneTag_in: [...]` で multi-zone aggregate (PR #12)。
- **GraphQL field 名は `clientCountryName`** (`clientCountry` ではない、PR #15 で 1 度踏んだ)。`firewallEventsAdaptive` の field 名は CF 側の schema 進化に追従が必要。
- **48h KV dedupe**: 各 event の Ray ID を key にして `PROCESSED_EVENTS` KV に 48h TTL で書く (`event:<rayId>`)。fetch window が 24h なので TTL=48h で境界重複 (前日の cron で投げ損ねた event が翌日 window にもう一度入る等) を吸収する。`sendNotificationsBatch` の前に `console.log('security_events_detected', ...)` で構造化 log も出力 (PR #16) — CCoW から `cf_logging` MCP で過去 events を query 可能。
- **email は常時送信**: PR #10 で `sendNotificationsBatch` 冒頭で `sendEmailBatch` を必ず呼ぶ。endpoint 登録不要 (endpoint type `email` は no-op)。webhook / Slack は endpoint 登録された分だけ追加で送る。
- **CF Access 分類 + 件数閾値** (`src/classify.ts`): 通知に host の CF Access 対応要否分類 (⚠️要検討 / ❓不明 / ✅済 / 🌐公開) を載せ、email 件名に actionable 件数を付ける。host パターンは `ACCESS_{GATED,CANDIDATE,PUBLIC}_PATTERNS` env (未設定は ippoan default)。`NOTIFY_MIN_EVENTS` (default 1) 未満は通知抑制 (dedupe mark / log は残す)。分類は config ベースで live Access API は叩かない (token scope が Security Events Read のみのため = トリアージのヒント)。閾値分岐 (`this.env` scalar) は DO 実体の env に届けるため test では `runInDurableObject` で `(instance as any).env.NOTIFY_MIN_EVENTS` を直接 set する (test-side `env` proxy への代入は DO に伝播しない。KV binding は同一オブジェクト共有なので効く、の非対称に注意)。
- **`send_email` binding** (`EMAIL`): `cloudflare:email` + `mimetext` で送信。`destination_address` は `wrangler.jsonc` の `[[send_email]]` で **静的固定** (Email Routing の制約)。From/To を変える時は `vars.NOTIFY_EMAIL_FROM` / `NOTIFY_EMAIL_TO` と `[[send_email]] destination_address` の **両方**を更新する必要あり。
- **`cloudflare:email` は vitest-pool-workers v0.5 で module 解決失敗**: `sendEmailBatch` は dynamic import (`await import('cloudflare:email')`)。test では mock 不要 (path に到達しない or dynamic import が catch される)。
- **PROD worker 名 `security-notification-app`**: workers.dev は `security-notification-app.m-tama-ramu.workers.dev`。CF dashboard では Variables and secrets に `Secrets Store / CLOUDFLARE_API_TOKEN` binding が出る (PR #12 以前は `Plaintext / CLOUDFLARE_API_TOKEN (空)` だった)。
- **CF Analytics propagation lag**: firewall events が `firewallEventsAdaptive` に乗るまで 30-90 秒。手動 trigger 直後に attack→trigger しても捕捉できないことがあるので、cron 待ちのほうが確実。
- **Workers Observability log のキー**: `$metadata.service = security-notification-app` + `$metadata.message includes "security_events_detected"` で過去 attack を query 可能。`messageTemplate` は CF が自動 PII redact (`<IP4>` / `<DOMAIN>` / `<DATETIME>`)、生 IP/host が要るときは `message` を見る。
- **email 本文は上位 20 件で truncate される** (`src/index.ts` の `events.slice(0, 20)` + `... and N more events`)。154 件検出のうち特定 host の全件 (例: 9件+9件) を見たい時、email 本文だけでは足りない。下の「通知メールのトリアージ手順」を使う。
- **`ACCESS_GATED_PATTERNS` は CF Access の実設定に自動追従しない** (config ベース、live API を叩かないため)。Cloudflare dashboard / `cf-access-mcp` で新規 Access app を host パターンに追加しても、`wrangler.jsonc` 側の `ACCESS_GATED_PATTERNS` を手動で更新しない限り、その host は `*staging*`/`*preview*` 等の `ACCESS_CANDIDATE_PATTERNS` に先に拾われ「⚠️ 要 CF Access 検討」のまま誤表示され続ける。前例: `a483345` (`ui-preview.ippoan.org` 追加) / PR #30 (`*-preview.ippoan.org` 追加、2026-07-05)。新しい Access app を preview/staging/dev 系 host に張ったら、同じ turn で `ACCESS_GATED_PATTERNS` の追記も検討すること。

## 通知メールのトリアージ手順 (2026-07-05 実施、再現用)

「⚠️ 要 CF Access 検討」に挙がった host の全イベントを確認し、必要なら
`ACCESS_GATED_PATTERNS` を直す一連の作業:

1. **メール本文は最大20件で truncate される**ので、対象 host の全件を見るには
   `cf_logging` MCP (`query_worker_observability`) で通知送信時刻付近
   (cron 実行は 06:00 JST = 21:00Z 前後) の `$metadata.service =
   security-notification-app` + `$metadata.message includes
   "security_events_detected"` を timeframe 指定で1件 query する。
   `$metadata.message` に `count/actionable/categories/events[]` を含む
   JSON 全文 (truncate なし) が入っている。結果が大きい (数万文字) ので
   ファイル保存された結果を Bash + python (`json.loads`) で host フィルタ
   するとよい (Read/Grep で直接読むには行が長すぎる)。
2. 対象 host が既に CF Access で保護されているか
   `mcp__cf-access-mcp__list_access_apps` (結果が大きいので Bash grep で
   `-i -E "<host-keyword>|wildcard"` 絞り込み) で確認する。
3. 保護済みなのに `classifyHost` が `access-candidate`/`unknown` に分類する
   場合は、`ACCESS_GATED_PATTERNS` (`wrangler.jsonc`) にそのホストパターンを
   追記する (precedent: `a483345`, PR #30)。全 events が `action:block`
   (= WAF が既にブロック済み) であれば実害なしの分類ミスなので config 修正のみで良い。
4. `npm test` (classify.ts 自体は変更していなくても回帰確認) → PR → merge。

## CCoW / CI から見た立ち位置

- **consumer / publisher**: 無し (= 通知 source 専用、他 worker からは呼ばれない想定)。RPC method はあるが現状 unused。
- **CI**: `frontend-ci.yml` (worker)。typecheck + vitest + coverage + secret-verify-gcp (`security-notification-app-cf-api-token` が GCP に存在することを突合)。PR run で root config deploy、tag push で同じ root config deploy (= 二経路同 config)。
- **観測**: Workers Observability の `cf_logging` MCP で `service=security-notification-app` フィルタ。error fingerprint `1561eb1294d0307fec890e38fd1baa38` (= `Cloudflare GraphQL API error: 400`) が出たら token / zone ID 設定漏れの signal (handoff #11 の初期症状)。

## 関連

- `auth-worker-map` — `security-notification-app-cf-api-token` を含む CF Secrets Store の管理 worker (`secrets-inventory`) と同じ pattern
- `secrets-inventory-map` — secret 投入 (`secret-inject` skill 経由) と sync_from_gcp の手順
- `secret-inject` — CF API token (Cloudflare dashboard 発行値) を GCP / CF 両方に値漏れ無く投入する skill
- `wrangler-logs` — Workers Observability から live tail (`cf_logging` MCP でも同等)

## CLAUDE.md から移設 (2026-07-07)

## まず読むもの

- [`README.md`](./README.md) — セットアップ / API / CF Access 分類 / 通知ノイズ抑制の設定値
- [`.claude/skills/security-notification-app-map/SKILL.md`](./.claude/skills/security-notification-app-map/SKILL.md) —
  構造ナビゲーション + gotcha 一覧 + **通知メールのトリアージ手順** (email の
  20件 truncate を越えて全件確認する方法、`ACCESS_GATED_PATTERNS` の追従漏れ対処)

## 構成

| path | 役割 |
|---|---|
| `src/index.ts` | 全ロジック (DO `NotificationManager` + `WorkerEntrypoint` の fetch/scheduled/RPC) |
| `src/classify.ts` | CF Access 観点の host 分類 (pure module、副作用なし、100% カバー) |
| `wrangler.jsonc` | single-env (staging = prod) 設定。`ACCESS_{GATED,CANDIDATE,PUBLIC}_PATTERNS` / `CLOUDFLARE_ZONE_IDS` 等 |

## 設計上の要点 (触る前に)

- **single-env 運用**: `wrangler.jsonc` は root config 1 個のみ。PR run も tag
  push も同じ root config に `wrangler deploy` する (詳細は SKILL.md)。
- **email は上位20件で truncate される** (`events.slice(0, 20)`)。特定 host の
  全件を見たい時は email 本文だけで判断しない — SKILL.md の
  「通知メールのトリアージ手順」で `cf_logging` MCP から構造化ログ全文を取る。
- **`ACCESS_GATED_PATTERNS` は CF Access の実設定に自動追従しない** (config
  ベース、live Access API は叩かない)。新しい CF Access app を
  staging/preview/dev 系 host に張ったら、`wrangler.jsonc` の
  `ACCESS_GATED_PATTERNS` も同じ turn で更新を検討する (前例:
  `ui-preview.ippoan.org` 追加、`*-preview.ippoan.org` 追加)。
- **秘密 (`CLOUDFLARE_API_TOKEN`) は CF Secrets Store binding**。`wrangler
  secret put` は使わない (secrets-inventory の drift 検知対象から外れるため)。

## ビルド / テスト

PR を出す前に手元で green に:

```sh
npm install
npm test
```

CI (`.github/workflows/*.yml`) は `main` への PR ごとに ci-workflows の
`frontend-ci.yml` (project_type: worker) で typecheck + test + secret-verify-gcp
を回す。

## GitHub 自動化 (重要)

- **`main` に直 push しない。** PR を作る。
- PR / commit は `Refs #N` を使う (`Closes/Fixes/Resolves` は禁止 — auto-close 防止)。
  対応する issue が無い純粋な chore/config 修正は title/body に `[no-issue]` を入れる。
- `mcp__github__enable_pr_auto_merge` を reflex で呼ばない (user 明示指示時のみ)。
- PR 作成後は同じ turn で `mcp__github__subscribe_pr_activity` を呼び CI を watch する。

---

_共通項を直すときは [`ippoan/claude-md`](https://github.com/ippoan/claude-md) の
`CLAUDE.md.template` を更新すること。_

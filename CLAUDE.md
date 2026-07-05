# CLAUDE.md

Cloudflare WAF (firewall events) を毎日 6:00 JST に集約し、email / webhook /
Slack に通知する単一 Cloudflare Worker (`ippoan/security-notification-app`)。

このリポジトリで Claude Code セッションを動かす時の作業ガイド。共通項は
[ippoan/claude-md](https://github.com/ippoan/claude-md) の `CLAUDE.md.template` に従う。

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

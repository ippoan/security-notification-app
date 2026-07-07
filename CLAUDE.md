# CLAUDE.md

Cloudflare WAF (firewall events) を毎日 6:00 JST に集約し、email / webhook /
Slack に通知する単一 Cloudflare Worker (`ippoan/security-notification-app`)。

詳細 (アーキテクチャ・構成・設計解説・gotcha) は security-notification-app-map skill を参照。

## 制約 / 必守事項

- **single-env 運用**: `wrangler.jsonc` は root config 1 個のみ。PR run も tag push も同じ root config に `wrangler deploy` する。
- **email は上位 20 件で truncate される** (`events.slice(0, 20)`)。全件確認には SKILL.md の「通知メールのトリアージ手順」を使う。
- **`ACCESS_GATED_PATTERNS` は CF Access に自動追従しない**。新しい CF Access app を host に張ったら `wrangler.jsonc` の `ACCESS_GATED_PATTERNS` を同じ turn で更新する。
- **秘密 (`CLOUDFLARE_API_TOKEN`) は CF Secrets Store binding**。`wrangler secret put` は使わない (secrets-inventory の drift 検知対象から外れるため)。

## ビルド / テスト

```sh
npm install
npm test
```

CI は `frontend-ci.yml` (project_type: worker) で typecheck + test + secret-verify-gcp を回す。

## GitHub 自動化

- **`main` に直 push しない。** PR を作る。
- PR / commit は `Refs #N` を使う (`Closes/Fixes/Resolves` は禁止 — auto-close 防止)。対応する issue が無い純粋な chore/config 修正は title/body に `[no-issue]` を入れる。
- `mcp__github__enable_pr_auto_merge` を reflex で呼ばない (user 明示指示時のみ)。
- PR 作成後は同じ turn で `mcp__github__subscribe_pr_activity` を呼び CI を watch する。

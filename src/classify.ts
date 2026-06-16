// CF Access 観点で WAF firewall event の host を分類する pure module。
//
// index.ts (Worker / Durable Object) から import して通知に
// 「この host は CF Access 対応が必要か / 不明か」のトリアージ情報を載せる。
// すべて副作用なし = vitest で全分岐を網羅テストする (coverage 100% gate)。
//
// 注意: 「gated (= 既に CF Access 済み)」判定は **config (host パターン)** ベース。
// 本 module は live な CF Access API を叩かない (worker の token は Security
// Events Read scope のみ)。よって config の gated パターンに載っていない
// 既 gated host は `access-candidate` / `public` に誤分類され得る = あくまで
// トリアージのヒント。正確な突合は将来 Access:read token + API 連携で拡張可能。

export type AccessCategory = 'access-candidate' | 'unknown' | 'gated' | 'public';

export interface ClassifyConfig {
	/** 既に CF Access で保護済みとみなす host パターン。 */
	gated: string[];
	/** dev/staging/internal 風で「Access 対応を検討すべき」host パターン。 */
	candidate: string[];
	/** 公開本番で「Access 不要 (WAF/Bot で対処)」とみなす host パターン。 */
	public: string[];
}

export interface ClassifyEnv {
	ACCESS_GATED_PATTERNS?: string;
	ACCESS_CANDIDATE_PATTERNS?: string;
	ACCESS_PUBLIC_PATTERNS?: string;
	NOTIFY_MIN_EVENTS?: string;
}

// ippoan のデフォルト。staging/dev custom domain は CF Access 済み
// (security-notification-app 起点の Access 整備で `*-staging.ippoan.org` /
// `*-dev.ippoan.org` を gate 済み)。env で上書き可能。
export const DEFAULT_CLASSIFY_CONFIG: ClassifyConfig = {
	gated: ['*-staging.ippoan.org', '*-dev.ippoan.org'],
	candidate: ['*staging*', '*dev*', '*test*', '*internal*', '*admin*', '*preview*'],
	public: ['*.ippoan.org', '*.mtamaramu.com', '*.m-tama-ramu.workers.dev'],
};

// 表示順 = トリアージ優先度 (要対応 → 不明 → 済 → 公開)。
export const CATEGORY_ORDER: AccessCategory[] = ['access-candidate', 'unknown', 'gated', 'public'];

export const CATEGORY_LABEL: Record<AccessCategory, string> = {
	'access-candidate': '⚠️ 要 CF Access 検討',
	unknown: '❓ 不明 (要確認)',
	gated: '✅ CF Access 済み',
	public: '🌐 公開 (Access 不要)',
};

/** glob 風 (`*` = 任意文字列) パターンで host を完全一致判定する。case-insensitive。 */
export function matchHostPattern(host: string, pattern: string): boolean {
	const escaped = pattern
		.toLowerCase()
		.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
		.replace(/\*/g, '.*');
	return new RegExp(`^${escaped}$`).test(host.toLowerCase());
}

function matchesAny(host: string, patterns: string[]): boolean {
	return patterns.some((p) => matchHostPattern(host, p));
}

/** host を CF Access 観点の 4 カテゴリに分類する (gated を最優先で判定)。 */
export function classifyHost(host: string, cfg: ClassifyConfig = DEFAULT_CLASSIFY_CONFIG): AccessCategory {
	if (matchesAny(host, cfg.gated)) return 'gated';
	if (matchesAny(host, cfg.candidate)) return 'access-candidate';
	if (matchesAny(host, cfg.public)) return 'public';
	return 'unknown';
}

function splitCsv(v?: string): string[] | undefined {
	if (!v) return undefined;
	const arr = v
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	return arr.length > 0 ? arr : undefined;
}

/** env の comma-separated パターンを読む。未設定はデフォルトに fallback。 */
export function parseClassifyConfig(env: ClassifyEnv): ClassifyConfig {
	return {
		gated: splitCsv(env.ACCESS_GATED_PATTERNS) ?? DEFAULT_CLASSIFY_CONFIG.gated,
		candidate: splitCsv(env.ACCESS_CANDIDATE_PATTERNS) ?? DEFAULT_CLASSIFY_CONFIG.candidate,
		public: splitCsv(env.ACCESS_PUBLIC_PATTERNS) ?? DEFAULT_CLASSIFY_CONFIG.public,
	};
}

/** 通知の件数閾値。未設定・不正・0 以下は 1 (= 現状維持: 1 件でも通知)。 */
export function parseMinEvents(env: ClassifyEnv): number {
	const n = env.NOTIFY_MIN_EVENTS ? parseInt(env.NOTIFY_MIN_EVENTS, 10) : NaN;
	return Number.isFinite(n) && n > 0 ? n : 1;
}

export interface CategoryBucket {
	category: AccessCategory;
	count: number;
	hosts: Array<{ host: string; count: number }>;
}

export interface ClassifiedSummary {
	total: number;
	/** access-candidate + unknown = 人間のトリアージが要る件数。 */
	actionableCount: number;
	/** CATEGORY_ORDER 順、count>0 の bucket のみ。 */
	buckets: CategoryBucket[];
}

/** events を host 分類で集計する。 */
export function summarize(
	events: Array<{ host: string }>,
	cfg: ClassifyConfig = DEFAULT_CLASSIFY_CONFIG,
): ClassifiedSummary {
	const perCategory: Record<AccessCategory, Map<string, number>> = {
		'access-candidate': new Map(),
		unknown: new Map(),
		gated: new Map(),
		public: new Map(),
	};
	for (const e of events) {
		const m = perCategory[classifyHost(e.host, cfg)];
		m.set(e.host, (m.get(e.host) ?? 0) + 1);
	}

	// 全 4 カテゴリを常に出す (count 0 の ⚠️要対応 / ❓不明 も通知に表示する)。
	const buckets: CategoryBucket[] = CATEGORY_ORDER.map((category) => {
		const m = perCategory[category];
		const hosts = Array.from(m, ([host, count]) => ({ host, count })).sort((a, b) => b.count - a.count);
		const count = hosts.reduce((sum, h) => sum + h.count, 0);
		return { category, count, hosts };
	});
	const actionableCount = buckets
		.filter((b) => b.category === 'access-candidate' || b.category === 'unknown')
		.reduce((sum, b) => sum + b.count, 0);
	return { total: events.length, actionableCount, buckets };
}

// host 別の内訳 (全 host を細分表示、上限なし)。0 件カテゴリは "なし"。
function hostsLine(bucket: CategoryBucket): string {
	if (bucket.hosts.length === 0) return 'なし';
	return bucket.hosts.map((h) => `${h.host} (${h.count})`).join(', ');
}

/** email/Slack の件名末尾に付ける「要対応 N」。0 件なら空文字。 */
export function classificationSubjectSuffix(summary: ClassifiedSummary): string {
	return summary.actionableCount > 0 ? ` ⚠️要対応 ${summary.actionableCount}` : '';
}

/** プレーンテキスト行 (各 bucket 1 行)。 */
export function renderClassificationLines(summary: ClassifiedSummary): string[] {
	return summary.buckets.map((b) => `${CATEGORY_LABEL[b.category]}: ${b.count} — ${hostsLine(b)}`);
}

/** Slack mrkdwn (bullet)。全 4 カテゴリを 1 行ずつ。 */
export function renderClassificationMrkdwn(summary: ClassifiedSummary): string {
	return renderClassificationLines(summary).map((l) => `• ${l}`).join('\n');
}

/** email HTML。escape は呼び出し側の escapeHtml を注入。 */
export function renderClassificationHtml(summary: ClassifiedSummary, escape: (s: string) => string): string {
	const items = summary.buckets
		.map((b) => `<li>${escape(CATEGORY_LABEL[b.category])}: <b>${b.count}</b> — ${escape(hostsLine(b))}</li>`)
		.join('');
	return `<h3>CF Access 観点の分類</h3><ul>${items}</ul>`;
}

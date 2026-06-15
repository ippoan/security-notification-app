import { describe, it, expect } from 'vitest';
import {
	matchHostPattern,
	classifyHost,
	parseClassifyConfig,
	parseMinEvents,
	summarize,
	classificationSubjectSuffix,
	renderClassificationLines,
	renderClassificationMrkdwn,
	renderClassificationHtml,
	DEFAULT_CLASSIFY_CONFIG,
	type ClassifyConfig,
} from '../src/classify';

describe('matchHostPattern', () => {
	it('matches a leading wildcard', () => {
		expect(matchHostPattern('alc-staging.ippoan.org', '*-staging.ippoan.org')).toBe(true);
	});
	it('matches a substring wildcard', () => {
		expect(matchHostPattern('foo-staging-bar.example', '*staging*')).toBe(true);
	});
	it('treats dots literally (no false wildcard match)', () => {
		// `.` must not act as regex "any char": `aXippoan.org` must NOT match `*.ippoan.org`
		expect(matchHostPattern('aXippoanXorg', '*.ippoan.org')).toBe(false);
		expect(matchHostPattern('a.ippoan.org', '*.ippoan.org')).toBe(true);
	});
	it('is case-insensitive', () => {
		expect(matchHostPattern('ALC-STAGING.IPPOAN.ORG', '*-staging.ippoan.org')).toBe(true);
	});
	it('matches an exact pattern and rejects non-matches', () => {
		expect(matchHostPattern('exact.example.com', 'exact.example.com')).toBe(true);
		expect(matchHostPattern('other.example.com', 'exact.example.com')).toBe(false);
	});
});

describe('classifyHost', () => {
	it('classifies gated hosts (highest precedence)', () => {
		// staging matches gated, candidate(*staging*) and public(*.ippoan.org) too — gated wins
		expect(classifyHost('alc-staging.ippoan.org')).toBe('gated');
	});
	it('classifies access-candidate (dev/staging-like, not gated)', () => {
		expect(classifyHost('foo-staging.example.com')).toBe('access-candidate');
		expect(classifyHost('admin.example.com')).toBe('access-candidate');
	});
	it('classifies public production hosts', () => {
		expect(classifyHost('alc.ippoan.org')).toBe('public');
		expect(classifyHost('rust-ichiban.mtamaramu.com')).toBe('public');
	});
	it('classifies unknown hosts', () => {
		expect(classifyHost('scanner.evil.ru')).toBe('unknown');
	});
	it('honours a custom config', () => {
		const cfg: ClassifyConfig = { gated: ['gated.x'], candidate: ['cand.x'], public: ['pub.x'] };
		expect(classifyHost('gated.x', cfg)).toBe('gated');
		expect(classifyHost('cand.x', cfg)).toBe('access-candidate');
		expect(classifyHost('pub.x', cfg)).toBe('public');
		expect(classifyHost('nope.x', cfg)).toBe('unknown');
	});
});

describe('parseClassifyConfig', () => {
	it('falls back to defaults when env is empty', () => {
		expect(parseClassifyConfig({})).toEqual(DEFAULT_CLASSIFY_CONFIG);
	});
	it('overrides from comma-separated env vars', () => {
		const cfg = parseClassifyConfig({
			ACCESS_GATED_PATTERNS: 'a.com, b.com',
			ACCESS_CANDIDATE_PATTERNS: '*stg*',
			ACCESS_PUBLIC_PATTERNS: '*.pub.com',
		});
		expect(cfg.gated).toEqual(['a.com', 'b.com']);
		expect(cfg.candidate).toEqual(['*stg*']);
		expect(cfg.public).toEqual(['*.pub.com']);
	});
	it('treats whitespace-only env as unset (falls back)', () => {
		const cfg = parseClassifyConfig({ ACCESS_GATED_PATTERNS: '  ,  ' });
		expect(cfg.gated).toEqual(DEFAULT_CLASSIFY_CONFIG.gated);
	});
});

describe('parseMinEvents', () => {
	it('defaults to 1 when unset', () => {
		expect(parseMinEvents({})).toBe(1);
	});
	it('parses a positive integer', () => {
		expect(parseMinEvents({ NOTIFY_MIN_EVENTS: '5' })).toBe(5);
	});
	it('falls back to 1 for non-numeric values', () => {
		expect(parseMinEvents({ NOTIFY_MIN_EVENTS: 'abc' })).toBe(1);
	});
	it('falls back to 1 for zero / negative', () => {
		expect(parseMinEvents({ NOTIFY_MIN_EVENTS: '0' })).toBe(1);
		expect(parseMinEvents({ NOTIFY_MIN_EVENTS: '-3' })).toBe(1);
	});
});

describe('summarize', () => {
	it('returns an empty summary for no events', () => {
		const s = summarize([]);
		expect(s.total).toBe(0);
		expect(s.actionableCount).toBe(0);
		expect(s.buckets).toEqual([]);
	});

	it('aggregates by category and host, counting duplicates', () => {
		const events = [
			{ host: 'alc-staging.ippoan.org' }, // gated
			{ host: 'alc-staging.ippoan.org' }, // gated (duplicate host -> existing-count path)
			{ host: 'foo-staging.example.com' }, // access-candidate
			{ host: 'alc.ippoan.org' }, // public
			{ host: 'scanner.evil.ru' }, // unknown
		];
		const s = summarize(events);
		expect(s.total).toBe(5);
		// actionable = candidate(1) + unknown(1)
		expect(s.actionableCount).toBe(2);

		const byCat = Object.fromEntries(s.buckets.map((b) => [b.category, b]));
		expect(byCat['gated'].count).toBe(2);
		expect(byCat['gated'].hosts).toEqual([{ host: 'alc-staging.ippoan.org', count: 2 }]);
		expect(byCat['access-candidate'].count).toBe(1);
		expect(byCat['public'].count).toBe(1);
		expect(byCat['unknown'].count).toBe(1);

		// buckets are ordered: candidate -> unknown -> gated -> public
		expect(s.buckets.map((b) => b.category)).toEqual(['access-candidate', 'unknown', 'gated', 'public']);
	});

	it('sorts hosts within a bucket by count desc', () => {
		const events = [
			{ host: 'a.evil.ru' },
			{ host: 'b.evil.ru' },
			{ host: 'b.evil.ru' },
		];
		const s = summarize(events);
		const unknown = s.buckets.find((b) => b.category === 'unknown')!;
		expect(unknown.hosts[0]).toEqual({ host: 'b.evil.ru', count: 2 });
		expect(unknown.hosts[1]).toEqual({ host: 'a.evil.ru', count: 1 });
	});
});

describe('rendering helpers', () => {
	// 6 distinct unknown hosts -> exercises the "+N hosts" overflow branch (>5)
	const manyUnknown = summarize(
		['a', 'b', 'c', 'd', 'e', 'f'].map((p) => ({ host: `${p}.evil.ru` })),
	);
	// only gated -> actionable 0 (subject suffix empty branch)
	const onlyGated = summarize([{ host: 'alc-staging.ippoan.org' }]);
	const empty = summarize([]);

	it('classificationSubjectSuffix shows actionable count, empty when none', () => {
		expect(classificationSubjectSuffix(manyUnknown)).toBe(' ⚠️要対応 6');
		expect(classificationSubjectSuffix(onlyGated)).toBe('');
	});

	it('renderClassificationLines truncates hosts past the cap', () => {
		const lines = renderClassificationLines(manyUnknown);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain('❓ 不明 (要確認): 6');
		expect(lines[0]).toContain('+1 hosts'); // 6 hosts, cap 5
	});

	it('renderClassificationLines without overflow omits the "+N hosts" suffix', () => {
		const lines = renderClassificationLines(onlyGated);
		expect(lines[0]).toContain('✅ CF Access 済み: 1');
		expect(lines[0]).not.toContain('+');
	});

	it('renderClassificationMrkdwn bullets lines, falls back when empty', () => {
		expect(renderClassificationMrkdwn(onlyGated)).toContain('• ✅ CF Access 済み: 1');
		expect(renderClassificationMrkdwn(empty)).toBe('分類対象なし');
	});

	it('renderClassificationHtml escapes labels/hosts via injected escaper', () => {
		const calls: string[] = [];
		const escape = (s: string) => {
			calls.push(s);
			return s.replace(/&/g, '&amp;');
		};
		const html = renderClassificationHtml(onlyGated, escape);
		expect(html).toContain('<h3>CF Access 観点の分類</h3>');
		expect(html).toContain('<b>1</b>');
		expect(calls.length).toBeGreaterThan(0); // escaper was invoked
	});
});

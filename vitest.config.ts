import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		pool: '@cloudflare/vitest-pool-workers',
		globals: true,
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
				miniflare: {
					// Required to use `SELF.scheduled()`. This is an experimental
					// compatibility flag, and cannot be enabled in production.
					compatibilityFlags: ["service_binding_extra_handlers"],
					// miniflare はまだ secrets_store_secrets を natively support して
					// いないので、test では plain string で override する。
					// src 側の `readApiToken()` が string / { get() } 両方を normalize する。
					bindings: {
						CLOUDFLARE_API_TOKEN: "test-token",
						CLOUDFLARE_ZONE_IDS: "test-zone-id-1,test-zone-id-2",
					},
				},
			}
		},
		coverage: {
			provider: 'istanbul',
			reporter: ['text', 'json', 'html'],
			all: true,
			include: ['src/**/*.ts'],
			exclude: [
				'test/**/*.test.ts',
				'test/**/*.spec.ts',
				'worker-configuration.d.ts'
			],
			branches: 100,
			functions: 100,
			lines: 100,
			statements: 100
		}
	}
});
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { SELF } from 'cloudflare:test';
import { testEnv, setupTestEnvironment, mockFetch, createTestEndpoint, createTestSecurityEvent, mockKVStorage, createGraphQLSecurityResponse } from './helpers/test-helpers';

// Type assertion for SELF with scheduled method
const typedSELF = SELF as typeof SELF & {
	scheduled: (event: { scheduledTime: Date; cron: string }) => Promise<{ outcome: string }>;
};

describe('Scheduled Handler', () => {
	beforeAll(() => {
		setupTestEnvironment();
	});

	it('should execute scheduled event via SELF', async () => {
		mockFetch();

		const result = await typedSELF.scheduled({
			scheduledTime: new Date(Date.now()),
			cron: '*/5 * * * *',
		});
		
		expect(result.outcome).toBe('ok');
	});

	it('should process security events when scheduled', async () => {
		// Add a test endpoint
		const id = testEnv.NOTIFICATION_MANAGER.idFromName("global");
		const stub = testEnv.NOTIFICATION_MANAGER.get(id);
		
		const endpoint = createTestEndpoint({
			id: 'scheduled-test-1',
			name: 'Scheduled Test',
			url: 'https://example.com/scheduled'
		});
		await stub.addEndpoint(endpoint);
		
		// Mock Cloudflare API response with security events
		(global.fetch as any).mockImplementation(async (url: string) => {
			if (url.includes('api.cloudflare.com')) {
				return createGraphQLSecurityResponse([{
					ray_id: 'scheduled-event-1',
					action: 'block',
					client_ip: '1.2.3.4',
					country: 'US',
					method: 'GET',
					host: 'example.com',
					uri: '/test',
					user_agent: 'Mozilla/5.0',
					rule_id: 'rule-1',
					rule_message: 'Blocked by WAF'
				}]);
			}
			// Webhook response
			return new Response('OK', { status: 200 });
		});
		
		// Mock KV storage
		const kvMock = mockKVStorage(
			() => Promise.resolve(null),
			() => Promise.resolve(undefined)
		);
		
		// Execute scheduled event
		const result = await typedSELF.scheduled({
			scheduledTime: new Date(Date.now()),
			cron: '*/5 * * * *',
		});
		
		expect(result.outcome).toBe('ok');
		
		// Verify that the security event was processed
		expect(testEnv.PROCESSED_EVENTS.put).toHaveBeenCalledWith(
			'event:scheduled-event-1',
			expect.any(String),
			expect.objectContaining({ expirationTtl: 86400 })
		);
		
		// Restore original methods
		kvMock.restore();
	});

	it('should handle scheduled event with no security events', async () => {
		mockFetch();

		// Execute scheduled event
		const result = await typedSELF.scheduled({
			scheduledTime: new Date(Date.now()),
			cron: '*/5 * * * *',
		});
		
		expect(result.outcome).toBe('ok');
	});
});
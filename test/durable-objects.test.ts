import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { runInDurableObject, listDurableObjectIds } from 'cloudflare:test';
import { NotificationManager } from '../src/index';
import { testEnv, setupTestEnvironment, createTestEndpoint, createTestSecurityEvent, mockFetch, createGraphQLSecurityResponse } from './helpers/test-helpers';

describe('Durable Objects', () => {
	beforeAll(() => {
		setupTestEnvironment();
	});

	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('NotificationManager Core Functions', () => {
		it('should manage endpoints', async () => {
			const id = testEnv.NOTIFICATION_MANAGER.idFromName('test-endpoints');
			const stub = testEnv.NOTIFICATION_MANAGER.get(id);

			// Add endpoint
			const endpoint = createTestEndpoint({
				name: 'DO Test Endpoint',
				url: 'https://example.com/do-test'
			});
			await stub.addEndpoint(endpoint);

			// Get endpoints
			const endpoints = await stub.getEndpoints();
			expect(endpoints).toHaveLength(1);
			expect(endpoints[0].name).toBe('DO Test Endpoint');

			// Toggle endpoint
			await stub.toggleEndpoint(endpoints[0].id, false);
			const updated = await stub.getEndpoints();
			expect(updated[0].enabled).toBe(false);
			
			// Try to toggle non-existent endpoint (branch coverage)
			await stub.toggleEndpoint('non-existent-id', true);
			const afterNonExistent = await stub.getEndpoints();
			expect(afterNonExistent).toHaveLength(1); // No change

			// Remove endpoint
			await stub.removeEndpoint(endpoints[0].id);
			const final = await stub.getEndpoints();
			expect(final).toHaveLength(0);
		});

		it('should send notifications to enabled endpoints only', async () => {
			const id = testEnv.NOTIFICATION_MANAGER.idFromName('test-notifications');
			const stub = testEnv.NOTIFICATION_MANAGER.get(id);

			// Add endpoints
			await stub.addEndpoint(createTestEndpoint({ 
				name: 'Active', 
				enabled: true,
				url: 'https://example.com/active'
			}));
			await stub.addEndpoint(createTestEndpoint({ 
				name: 'Inactive', 
				enabled: false,
				url: 'https://example.com/inactive'
			}));

			// Mock webhook response
			let webhookCalls = 0;
			(global.fetch as any).mockImplementation((url: string) => {
				if (url.includes('example.com')) {
					webhookCalls++;
					return Promise.resolve(new Response('OK', { status: 200 }));
				}
				return Promise.resolve(new Response('Not Found', { status: 404 }));
			});

			const event = createTestSecurityEvent();
			await stub.sendNotifications(event);

			// Only active endpoint should be called
			expect(webhookCalls).toBe(1);
		});

		it('should handle challenge action type', async () => {
			const id = testEnv.NOTIFICATION_MANAGER.idFromName('test-challenge-action');
			const stub = testEnv.NOTIFICATION_MANAGER.get(id);

			// Add endpoint
			await stub.addEndpoint(createTestEndpoint({ enabled: true }));

			// Mock API response with only challenge action (not block)
			(global.fetch as any).mockImplementation((url: string) => {
				if (url.includes('api.cloudflare.com')) {
					return Promise.resolve(createGraphQLSecurityResponse([{
						ray_id: 'challenge-event-1',
						action: 'challenge',
						client_ip: '1.2.3.4',
						country: 'US',
						method: 'GET',
						host: 'example.com',
						uri: '/test',
						user_agent: 'Mozilla/5.0',
						rule_id: 'rule-challenge',
						rule_message: 'Challenge'
					}]));
				}
				if (url.includes('example.com')) {
					return Promise.resolve(new Response('OK', { status: 200 }));
				}
				return Promise.resolve(new Response('Not Found', { status: 404 }));
			});

			// Mock KV
			const originalGet = testEnv.PROCESSED_EVENTS.get;
			testEnv.PROCESSED_EVENTS.get = vi.fn().mockResolvedValue(null);

			await stub.checkAndNotifySecurityEvents();

			// Verify webhook was called for challenge event
			expect(global.fetch).toHaveBeenCalledWith(
				expect.stringContaining('example.com'),
				expect.any(Object)
			);

			testEnv.PROCESSED_EVENTS.get = originalGet;
		});

		it('should check and notify security events', async () => {
			const id = testEnv.NOTIFICATION_MANAGER.idFromName('test-check-notify');
			const stub = testEnv.NOTIFICATION_MANAGER.get(id);

			// Add endpoint
			await stub.addEndpoint(createTestEndpoint({ enabled: true }));

			// Mock API and webhook responses
			let apiCalled = false;
			let webhookCalled = false;

			(global.fetch as any).mockImplementation((url: string) => {
				if (url.includes('api.cloudflare.com')) {
					apiCalled = true;
					return Promise.resolve(createGraphQLSecurityResponse([{
						ray_id: 'mixed-event-1',
						action: 'challenge',
						client_ip: '1.2.3.4',
						country: 'US',
						method: 'GET',
						host: 'example.com',
						uri: '/test',
						user_agent: 'Mozilla/5.0',
						rule_id: 'rule-1',
						rule_message: 'Challenge'
					}]));
				}
				if (url.includes('example.com')) {
					webhookCalled = true;
					return Promise.resolve(new Response('OK', { status: 200 }));
				}
				return Promise.resolve(new Response('Not Found', { status: 404 }));
			});

			await stub.checkAndNotifySecurityEvents();

			expect(apiCalled).toBe(true);
			expect(webhookCalled).toBe(true);
		});
	});

	describe('Direct Instance Access', () => {
		it('should access NotificationManager instance directly', async () => {
			const id = testEnv.NOTIFICATION_MANAGER.idFromName('test-direct-access');
			const stub = testEnv.NOTIFICATION_MANAGER.get(id);

			await runInDurableObject(stub, async (instance: NotificationManager, state) => {
				expect(instance).toBeInstanceOf(NotificationManager);
				
				const endpoint = createTestEndpoint({ id: 'direct-1' });
				await instance.addEndpoint(endpoint);
				
				// Check storage directly
				const stored = await state.storage.get(`endpoint:${endpoint.id}`);
				expect(stored).toEqual(endpoint);
			});

			// Verify endpoint was added
			const endpoints = await stub.getEndpoints();
			expect(endpoints).toHaveLength(1);
		});

		it('should toggle endpoint through direct access', async () => {
			const id = testEnv.NOTIFICATION_MANAGER.idFromName('test-toggle-direct');
			const stub = testEnv.NOTIFICATION_MANAGER.get(id);

			const endpoint = createTestEndpoint({ id: 'toggle-direct-1' });
			await stub.addEndpoint(endpoint);

			await runInDurableObject(stub, async (instance: NotificationManager, state) => {
				await instance.toggleEndpoint(endpoint.id, false);
				
				const stored = await state.storage.get<any>(`endpoint:${endpoint.id}`);
				expect(stored.enabled).toBe(false);
			});
		});

		it('should access storage directly for debugging', async () => {
			const id = testEnv.NOTIFICATION_MANAGER.idFromName('test-storage-debug');
			const stub = testEnv.NOTIFICATION_MANAGER.get(id);

			// Add multiple endpoints
			for (let i = 0; i < 3; i++) {
				await stub.addEndpoint(createTestEndpoint({
					id: `storage-${i}`,
					name: `Storage Test ${i}`,
					enabled: i % 2 === 0
				}));
			}

			await runInDurableObject(stub, async (instance: NotificationManager, state) => {
				// List all storage entries
				const allEntries = await state.storage.list();
				expect(allEntries.size).toBe(3);

				// Check prefix search
				const endpointEntries = await state.storage.list({ prefix: 'endpoint:' });
				expect(endpointEntries.size).toBe(3);

				// Verify each entry
				for (const [key, value] of endpointEntries) {
					expect(key).toMatch(/^endpoint:storage-\d$/);
					expect(value).toHaveProperty('name');
					expect(value).toHaveProperty('enabled');
				}
			});
		});
	});

	describe('Durable Object Management', () => {
		it('should list Durable Object IDs', async () => {
			const id = testEnv.NOTIFICATION_MANAGER.idFromName('test-list-ids');
			const stub = testEnv.NOTIFICATION_MANAGER.get(id);
			
			// Ensure it exists by adding data
			await stub.addEndpoint(createTestEndpoint());

			const ids = await listDurableObjectIds(testEnv.NOTIFICATION_MANAGER);
			expect(ids.length).toBeGreaterThan(0);
			
			const hasOurId = ids.some(listedId => listedId.equals(id));
			expect(hasOurId).toBe(true);
		});

		it('should have isolated storage between tests', async () => {
			const id = testEnv.NOTIFICATION_MANAGER.idFromName('test-isolated-storage');
			const stub = testEnv.NOTIFICATION_MANAGER.get(id);

			const endpoints = await stub.getEndpoints();
			expect(endpoints).toHaveLength(0);
		});

		it('should handle notifications through direct access', async () => {
			const id = testEnv.NOTIFICATION_MANAGER.idFromName('test-notify-direct-access');
			const stub = testEnv.NOTIFICATION_MANAGER.get(id);

			// Add endpoints
			await stub.addEndpoint(createTestEndpoint({ enabled: true }));
			await stub.addEndpoint(createTestEndpoint({ enabled: false }));

			const event = createTestSecurityEvent();
			mockFetch(new Response('OK', { status: 200 }));

			await runInDurableObject(stub, async (instance: NotificationManager) => {
				await instance.sendNotifications(event);
			});

			// Verify fetch was called (only for enabled endpoint)
			expect(global.fetch).toHaveBeenCalledTimes(1);
		});
	});

	describe('Branch Coverage', () => {
		it('should suppress notification below NOTIFY_MIN_EVENTS but still mark processed', async () => {
			const id = testEnv.NOTIFICATION_MANAGER.idFromName('test-min-events');
			const stub = testEnv.NOTIFICATION_MANAGER.get(id);
			await stub.addEndpoint(createTestEndpoint({ enabled: true }));

			let webhookCalled = false;
			(global.fetch as any).mockImplementation((url: string) => {
				if (url.includes('api.cloudflare.com')) {
					return Promise.resolve(createGraphQLSecurityResponse([{
						ray_id: 'below-threshold-1', action: 'block', client_ip: '9.9.9.9',
						country: 'US', method: 'GET', host: 'example.com', uri: '/x',
						user_agent: 'UA', rule_id: 'r', rule_message: 'Blocked'
					}]));
				}
				if (url.includes('example.com')) {
					webhookCalled = true;
					return Promise.resolve(new Response('OK', { status: 200 }));
				}
				return Promise.resolve(new Response('Not Found', { status: 404 }));
			});

			const originalGet = testEnv.PROCESSED_EVENTS.get;
			const originalPut = testEnv.PROCESSED_EVENTS.put;
			testEnv.PROCESSED_EVENTS.get = vi.fn().mockResolvedValue(null);
			testEnv.PROCESSED_EVENTS.put = vi.fn().mockResolvedValue(undefined);

			// NOTIFY_MIN_EVENTS is a scalar var read from `this.env`; the DO env is a
			// distinct object from the test-side `env`, so set it on the live instance.
			await runInDurableObject(stub, async (instance: NotificationManager) => {
				const doEnv = (instance as any).env;
				doEnv.NOTIFY_MIN_EVENTS = '5';
				try {
					await instance.checkAndNotifySecurityEvents();

					// 1 event < threshold 5 -> no notification sent, but dedupe mark still written
					expect(webhookCalled).toBe(false);
					expect(testEnv.PROCESSED_EVENTS.put).toHaveBeenCalledWith(
						'event:below-threshold-1',
						expect.any(String),
						expect.objectContaining({ expirationTtl: 172800 })
					);
				} finally {
					delete doEnv.NOTIFY_MIN_EVENTS;
				}
			});

			testEnv.PROCESSED_EVENTS.get = originalGet;
			testEnv.PROCESSED_EVENTS.put = originalPut;
		});

		it('should handle empty result array from API', async () => {
			const id = testEnv.NOTIFICATION_MANAGER.idFromName('test-empty-result');
			const stub = testEnv.NOTIFICATION_MANAGER.get(id);

			// Mock API response with empty result
			(global.fetch as any).mockImplementation((url: string) => {
				if (url.includes('api.cloudflare.com')) {
					return Promise.resolve(createGraphQLSecurityResponse([]));
				}
				return Promise.resolve(new Response('Not Found', { status: 404 }));
			});

			await stub.checkAndNotifySecurityEvents();

			// Should complete without errors
			expect(true).toBe(true);
		});
	});

	describe('Error Handling', () => {
		it('should handle webhook failures gracefully', async () => {
			const id = testEnv.NOTIFICATION_MANAGER.idFromName('test-webhook-errors');
			const stub = testEnv.NOTIFICATION_MANAGER.get(id);

			await stub.addEndpoint(createTestEndpoint({ 
				name: 'Failing Webhook',
				enabled: true 
			}));

			// Mock failed response
			(global.fetch as any).mockRejectedValueOnce(new Error('Network error'));

			const event = createTestSecurityEvent();
			
			// Should not throw
			await expect(stub.sendNotifications(event)).resolves.not.toThrow();
		});

		it('should skip events already processed', async () => {
			const id = testEnv.NOTIFICATION_MANAGER.idFromName('test-skip-processed');
			const stub = testEnv.NOTIFICATION_MANAGER.get(id);

			// Mock KV to return existing event
			const originalGet = testEnv.PROCESSED_EVENTS.get;
			testEnv.PROCESSED_EVENTS.get = vi.fn().mockResolvedValue('exists');

			let webhookCalled = false;
			(global.fetch as any).mockImplementation((url: string) => {
				if (url.includes('api.cloudflare.com')) {
					return Promise.resolve(createGraphQLSecurityResponse([{ ray_id: 'already-processed', action: 'block' }]));
				}
				if (url.includes('example.com')) {
					webhookCalled = true;
					return Promise.resolve(new Response('OK', { status: 200 }));
				}
				return Promise.resolve(new Response('Not Found', { status: 404 }));
			});

			await stub.addEndpoint(createTestEndpoint({ enabled: true }));
			await stub.checkAndNotifySecurityEvents();

			// Webhook should not be called for already processed event
			expect(webhookCalled).toBe(false);

			testEnv.PROCESSED_EVENTS.get = originalGet;
		});
	});
});
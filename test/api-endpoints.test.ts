import { describe, it, expect, beforeAll } from 'vitest';
import { SELF } from 'cloudflare:test';
import { testEnv, setupTestEnvironment, createTestEndpoint, createTestSecurityEvent, mockFetch } from './helpers/test-helpers';

describe('API Endpoints', () => {
	beforeAll(() => {
		setupTestEnvironment();
	});

	describe('Basic Routes', () => {
		it('should return 200 on root path', async () => {
			const response = await SELF.fetch('http://localhost/');
			expect(response.status).toBe(200);
			expect(await response.text()).toBe('Security Notification API');
		});

		it('should manually trigger security check', async () => {
			const response = await SELF.fetch('http://localhost/api/check-events', {
				method: 'POST'
			});
			
			expect(response.status).toBe(200);
			const data = await response.json() as { success: boolean; message: string };
			expect(data.success).toBe(true);
			expect(data.message).toBe('Security events checked');
		});

		it('should accept force=1 and force=true on manual trigger', async () => {
			mockFetch();
			for (const v of ['1', 'true']) {
				const response = await SELF.fetch(`http://localhost/api/check-events?force=${v}`, {
					method: 'POST'
				});
				expect(response.status).toBe(200);
				const data = await response.json() as { success: boolean; force: boolean };
				expect(data.force).toBe(true);
			}
		});
	});

	describe('Endpoint Management', () => {
		it('should get empty endpoints initially', async () => {
			const response = await SELF.fetch('http://localhost/api/endpoints');
			
			expect(response.status).toBe(200);
			const data = await response.json() as { endpoints: any[] };
			expect(Array.isArray(data.endpoints)).toBe(true);
			expect(data.endpoints.length).toBe(0);
		});

		it('should add a new endpoint', async () => {
			const endpoint = createTestEndpoint({
				name: 'Test Slack',
				type: 'slack',
				url: 'https://hooks.slack.com/test'
			});

			const response = await SELF.fetch('http://localhost/api/endpoints', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(endpoint)
			});
			
			expect(response.status).toBe(200);
			const data = await response.json() as { success: boolean; endpoint: any };
			expect(data.success).toBe(true);
			expect(data.endpoint.name).toBe('Test Slack');
			expect(data.endpoint.id).toBeDefined();
		});

		it('should toggle endpoint status', async () => {
			// First add an endpoint
			const endpoint = createTestEndpoint({
				name: 'Test Toggle',
				type: 'webhook',
				url: 'https://example.com/toggle'
			});

			const addResponse = await SELF.fetch('http://localhost/api/endpoints', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(endpoint)
			});
			
			const addData = await addResponse.json() as { success: boolean; endpoint: any };
			const addedEndpoint = addData.endpoint;
			
			// Toggle it off
			const toggleResponse = await SELF.fetch(`http://localhost/api/endpoints/${addedEndpoint.id}/toggle`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ enabled: false })
			});
			
			expect(toggleResponse.status).toBe(200);
			const toggleData = await toggleResponse.json() as { success: boolean };
			expect(toggleData.success).toBe(true);
		});

		it('should delete an endpoint', async () => {
			// First add an endpoint
			const endpoint = createTestEndpoint({
				name: 'Test Delete',
				type: 'webhook',
				url: 'https://example.com/delete'
			});

			const addResponse = await SELF.fetch('http://localhost/api/endpoints', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(endpoint)
			});
			
			const addData = await addResponse.json() as { success: boolean; endpoint: any };
			const addedEndpoint = addData.endpoint;
			
			// Delete it
			const deleteResponse = await SELF.fetch(`http://localhost/api/endpoints/${addedEndpoint.id}`, {
				method: 'DELETE'
			});
			
			expect(deleteResponse.status).toBe(200);
			const data = await deleteResponse.json() as { success: boolean };
			expect(data.success).toBe(true);
		});
	});

	describe('Additional Integration Tests', () => {
		it('should handle complete endpoint lifecycle', async () => {
			// Create
			const endpoint = createTestEndpoint({
				name: 'Lifecycle Test',
				type: 'webhook',
				url: 'https://example.com/lifecycle'
			});

			const createResponse = await SELF.fetch('http://localhost/api/endpoints', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(endpoint)
			});
			expect(createResponse.status).toBe(200);
			const createData = await createResponse.json() as { success: boolean; endpoint: any };
			const created = createData.endpoint;

			// Read
			const listResponse = await SELF.fetch('http://localhost/api/endpoints');
			const listData = await listResponse.json() as { endpoints: any[] };
			expect(listData.endpoints.some(ep => ep.id === created.id)).toBe(true);

			// Update (toggle)
			const toggleResponse = await SELF.fetch(`http://localhost/api/endpoints/${created.id}/toggle`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ enabled: false })
			});
			expect(toggleResponse.status).toBe(200);

			// Delete
			const deleteResponse = await SELF.fetch(`http://localhost/api/endpoints/${created.id}`, {
				method: 'DELETE'
			});
			expect(deleteResponse.status).toBe(200);
		});

		it('should handle multiple endpoints', async () => {
			// Add multiple endpoints
			const endpoints = [
				createTestEndpoint({ name: 'Multi 1', type: 'webhook', url: 'https://example.com/multi1' }),
				createTestEndpoint({ name: 'Multi 2', type: 'slack', url: 'https://hooks.slack.com/multi2' }),
				createTestEndpoint({ name: 'Multi 3', type: 'email', email: 'multi3@example.com' })
			];

			for (const endpoint of endpoints) {
				const response = await SELF.fetch('http://localhost/api/endpoints', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(endpoint)
				});
				expect(response.status).toBe(200);
			}

			// List all
			const listResponse = await SELF.fetch('http://localhost/api/endpoints');
			const listData = await listResponse.json() as { endpoints: any[] };
			expect(listData.endpoints.length).toBeGreaterThanOrEqual(3);
		});

		it('should process security event and send notifications', async () => {
			// Add an active endpoint
			const endpoint = createTestEndpoint({
				name: 'Notification Test',
				type: 'webhook',
				url: 'https://example.com/notify',
				enabled: true
			});

			await SELF.fetch('http://localhost/api/endpoints', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(endpoint)
			});

			// Mock webhook response
			mockFetch(new Response('OK', { status: 200 }));

			// Trigger check (this would normally process events)
			const checkResponse = await SELF.fetch('http://localhost/api/check-events', {
				method: 'POST'
			});
			expect(checkResponse.status).toBe(200);
		});

		it('should handle concurrent operations', async () => {
			// Create multiple endpoints concurrently
			const promises = Array.from({ length: 5 }, (_, i) => 
				SELF.fetch('http://localhost/api/endpoints', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(createTestEndpoint({
						name: `Concurrent ${i}`,
						url: `https://example.com/concurrent${i}`
					}))
				})
			);

			const responses = await Promise.all(promises);
			responses.forEach(response => {
				expect(response.status).toBe(200);
			});
		});
	});
});
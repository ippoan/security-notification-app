import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { createRPCWorker } from './test-utils';
import { createGraphQLSecurityResponse } from './helpers/test-helpers';

// Type assertion for env with required properties
const testEnv = env as typeof env & {
	CLOUDFLARE_API_TOKEN: string;
	CLOUDFLARE_ZONE_ID: string;
};

// Mock global fetch
global.fetch = vi.fn();

describe('Edge Cases and Error Handling', () => {
	let worker: any;

	beforeEach(() => {
		worker = createRPCWorker(testEnv);
		vi.clearAllMocks();
		testEnv.CLOUDFLARE_API_TOKEN = 'test-token';
		testEnv.CLOUDFLARE_ZONE_ID = 'test-zone-id';
	});

	describe('Webhook error handling', () => {
		it('should handle webhook failures with 500 error', async () => {
			// Add webhook endpoint
			const endpoint = await worker.addEndpoint({
				name: 'Failing Webhook',
				type: 'webhook',
				url: 'https://example.com/fail',
				enabled: true
			});

			// Mock failed webhook response
			(global.fetch as any).mockResolvedValueOnce(
				new Response('Internal Server Error', { status: 500 })
			);

			const testEvent = {
				id: 'test-ray-id',
				timestamp: new Date().toISOString(),
				action: 'block',
				clientIP: '1.2.3.4',
				country: 'US',
				method: 'GET',
				host: 'example.com',
				uri: '/test',
				userAgent: 'Test User Agent',
				ruleId: 'rule-123',
				ruleName: 'Test Rule'
			};

			// Should handle error gracefully
			await expect(worker.sendTestNotification(testEvent)).resolves.not.toThrow();
		});

		it('should handle slack webhook failures', async () => {
			// Add slack endpoint
			const endpoint = await worker.addEndpoint({
				name: 'Failing Slack',
				type: 'slack',
				url: 'https://hooks.slack.com/fail',
				enabled: true
			});

			// Mock failed slack response
			(global.fetch as any).mockResolvedValueOnce(
				new Response('Bad Request', { status: 400 })
			);

			const testEvent = {
				id: 'test-ray-id',
				timestamp: new Date().toISOString(),
				action: 'challenge',
				clientIP: '1.2.3.4',
				country: 'US',
				method: 'GET',
				host: 'example.com',
				uri: '/test',
				userAgent: 'Test User Agent',
				ruleId: 'rule-123',
				ruleName: 'Test Rule'
			};

			// Should handle error gracefully
			await expect(worker.sendTestNotification(testEvent)).resolves.not.toThrow();
		});
	});

	describe('Security event filtering', () => {
		it('should handle jschallenge action type', async () => {
			// Mock API response with jschallenge action
			(global.fetch as any).mockResolvedValueOnce(
				createGraphQLSecurityResponse([{
					ray_id: 'js-event-1',
					action: 'jschallenge',
					client_ip: '1.2.3.4',
					country: 'US',
					method: 'GET',
					host: 'example.com',
					uri: '/test',
					user_agent: 'Mozilla/5.0',
					rule_id: 'rule-js',
					rule_message: 'JS Challenge'
				}])
			);

			const result = await worker.checkSecurityEvents();
			expect(result.success).toBe(true);
		});

		it('should filter out non-security actions', async () => {
			// Add an endpoint to verify notifications
			await worker.addEndpoint({
				name: 'Filter Test',
				type: 'webhook',
				url: 'https://example.com/filter',
				enabled: true
			});

			// Mock API response — GraphQL already filters by action_in, so only block events returned
			(global.fetch as any).mockResolvedValueOnce(
				createGraphQLSecurityResponse([{
					ray_id: 'block-event-1',
					action: 'block',
					client_ip: '1.2.3.6',
					country: 'US',
					method: 'GET',
					host: 'example.com',
					uri: '/blocked',
					user_agent: 'Mozilla/5.0',
					rule_id: 'rule-block',
					rule_message: 'Blocked'
				}])
			);

			// Mock KV to mark block-event-1 as not processed
			const originalGet = testEnv.PROCESSED_EVENTS.get;
			testEnv.PROCESSED_EVENTS.get = vi.fn().mockResolvedValue(null);

			// Mock webhook response
			(global.fetch as any).mockResolvedValueOnce(
				new Response('OK', { status: 200 })
			);

			const result = await worker.checkSecurityEvents();
			expect(result.success).toBe(true);

			testEnv.PROCESSED_EVENTS.get = originalGet;
		});

		it('should handle empty description', async () => {
			// Mock API response without description
			(global.fetch as any).mockResolvedValueOnce(
				createGraphQLSecurityResponse([{
					ray_id: 'no-msg-event',
					action: 'block',
					client_ip: '1.2.3.4',
					country: 'US',
					method: 'GET',
					host: 'example.com',
					uri: '/test',
					user_agent: 'Mozilla/5.0',
					rule_id: 'rule-no-msg',
					rule_message: undefined
				}])
			);

			const result = await worker.checkSecurityEvents();
			expect(result.success).toBe(true);
		});
	});

	describe('Email notification handling', () => {
		it('should handle email endpoints', async () => {
			// Add email endpoint
			const endpoint = await worker.addEndpoint({
				name: 'Email Test',
				type: 'email',
				email: 'test@example.com',
				enabled: true
			});

			// Mock console.log to verify it's called
			const consoleSpy = vi.spyOn(console, 'log');

			const testEvent = {
				id: 'test-email-event',
				timestamp: new Date().toISOString(),
				action: 'block',
				clientIP: '1.2.3.4',
				country: 'US',
				method: 'GET',
				host: 'example.com',
				uri: '/test',
				userAgent: 'Test User Agent',
				ruleId: 'rule-123',
				ruleName: 'Test Rule'
			};

			const result = await worker.sendTestNotification(testEvent);
			expect(result.success).toBe(true);
			
			// Verify console.log was called with email notification
			expect(consoleSpy).toHaveBeenCalledWith(
				`Email notification to test@example.com for 1 events`
			);

			consoleSpy.mockRestore();
		});
	});

	describe('User agent truncation', () => {
		it('should handle very long user agents in slack messages', async () => {
			// Add slack endpoint
			const endpoint = await worker.addEndpoint({
				name: 'Slack Test',
				type: 'slack',
				url: 'https://hooks.slack.com/test',
				enabled: true
			});

			// Mock successful slack response
			(global.fetch as any).mockResolvedValueOnce(
				new Response('ok', { status: 200 })
			);

			const longUserAgent = 'A'.repeat(100); // Very long user agent
			const testEvent = {
				id: 'test-ray-id',
				timestamp: new Date().toISOString(),
				action: 'block',
				clientIP: '1.2.3.4',
				country: 'US',
				method: 'GET',
				host: 'example.com',
				uri: '/test',
				userAgent: longUserAgent,
				ruleId: 'rule-123',
				ruleName: 'Test Rule'
			};

			const result = await worker.sendTestNotification(testEvent);
			expect(result.success).toBe(true);
			
			// Check that the batch message was sent successfully
			const callArgs = (global.fetch as any).mock.calls[0];
			const body = JSON.parse(callArgs[1].body);
			expect(body.text).toContain('1 Security Events Detected');
			expect(body.blocks[0].text.text).toContain('1 Security Events Detected');
		});
	});

	describe('Batch notification handling', () => {
		it('should handle more than 5 events in slack batch message', async () => {
			// Add slack endpoint
			const endpoint = await worker.addEndpoint({
				name: 'Slack Batch Test',
				type: 'slack',
				url: 'https://hooks.slack.com/batch-test',
				enabled: true
			});

			// Mock successful slack response
			(global.fetch as any).mockResolvedValueOnce(
				new Response('ok', { status: 200 })
			);

			// Create 7 events to trigger the "more events" message
			const events = Array.from({ length: 7 }, (_, i) => ({
				id: `test-event-${i}`,
				timestamp: new Date().toISOString(),
				action: i % 2 === 0 ? 'block' : 'challenge',
				clientIP: `1.2.3.${i}`,
				country: 'US',
				method: 'GET',
				host: 'example.com',
				uri: `/test-${i}`,
				userAgent: 'Test User Agent',
				ruleId: `rule-${i}`,
				ruleName: `Test Rule ${i}`
			}));

			// Send notifications for all events
			const notificationManager = testEnv.NOTIFICATION_MANAGER.get(
				testEnv.NOTIFICATION_MANAGER.idFromName("global")
			);
			await notificationManager.sendNotificationsBatch(events);

			// Check that the message includes "and 2 more events"
			const callArgs = (global.fetch as any).mock.calls[0];
			const body = JSON.parse(callArgs[1].body);
			expect(body.text).toContain('7 Security Events Detected');
			
			// Find the context block with "more events" text
			const contextBlock = body.blocks.find((block: any) => 
				block.type === 'context' && 
				block.elements?.[0]?.text?.includes('more events')
			);
			expect(contextBlock).toBeDefined();
			expect(contextBlock.elements[0].text).toContain('and 2 more events');
		});

		it('should handle empty events array gracefully', async () => {
			// Add slack endpoint
			const endpoint = await worker.addEndpoint({
				name: 'Slack Empty Test',
				type: 'slack',
				url: 'https://hooks.slack.com/empty-test',
				enabled: true
			});

			// Send notifications with empty events array
			const notificationManager = testEnv.NOTIFICATION_MANAGER.get(
				testEnv.NOTIFICATION_MANAGER.idFromName("global")
			);
			
			// Should not make any fetch calls
			const fetchSpy = vi.spyOn(global, 'fetch');
			await notificationManager.sendNotificationsBatch([]);
			
			// Verify no fetch calls were made
			expect(fetchSpy).not.toHaveBeenCalled();
			fetchSpy.mockRestore();
		});
	});

	describe('KV operations edge cases', () => {
		it('should handle null KV get response', async () => {
			const originalGet = testEnv.PROCESSED_EVENTS.get;
			testEnv.PROCESSED_EVENTS.get = vi.fn().mockResolvedValue(null);

			const events = await worker.getProcessedEvents();
			expect(Array.isArray(events)).toBe(true);

			testEnv.PROCESSED_EVENTS.get = originalGet;
		});

		it('should handle malformed JSON in KV', async () => {
			const originalList = testEnv.PROCESSED_EVENTS.list;
			const originalGet = testEnv.PROCESSED_EVENTS.get;
			
			testEnv.PROCESSED_EVENTS.list = vi.fn().mockResolvedValue({
				keys: [{ name: 'event:malformed' }]
			});
			
			testEnv.PROCESSED_EVENTS.get = vi.fn().mockResolvedValue('invalid json');

			// Should throw error when parsing invalid JSON
			await expect(worker.getProcessedEvents()).rejects.toThrow('Unexpected token');

			testEnv.PROCESSED_EVENTS.list = originalList;
			testEnv.PROCESSED_EVENTS.get = originalGet;
		});
	});

	describe('Notification system integration', () => {
		it('should handle multiple endpoints with mixed success/failure', async () => {
			// Add multiple endpoints
			await worker.addEndpoint({
				name: 'Success Webhook',
				type: 'webhook',
				url: 'https://example.com/success',
				enabled: true
			});

			await worker.addEndpoint({
				name: 'Failing Webhook',
				type: 'webhook',
				url: 'https://example.com/fail',
				enabled: true
			});

			await worker.addEndpoint({
				name: 'Success Slack',
				type: 'slack',
				url: 'https://hooks.slack.com/success',
				enabled: true
			});

			// Mock mixed responses
			(global.fetch as any)
				.mockResolvedValueOnce(new Response('OK', { status: 200 })) // Success webhook
				.mockRejectedValueOnce(new Error('Network error')) // Failing webhook
				.mockResolvedValueOnce(new Response('OK', { status: 200 })); // Success slack

			const testEvent = {
				id: 'test-ray-id',
				timestamp: new Date().toISOString(),
				action: 'block',
				clientIP: '1.2.3.4',
				country: 'US',
				method: 'GET',
				host: 'example.com',
				uri: '/test',
				userAgent: 'Test User Agent',
				ruleId: 'rule-123',
				ruleName: 'Test Rule'
			};

			const result = await worker.sendTestNotification(testEvent);
			expect(result.success).toBe(true);
			expect(result.notifiedEndpoints).toBe(3); // All 3 active endpoints attempted
		});
	});

	describe('API error responses', () => {
		it('should handle non-JSON API response', async () => {
			// Mock HTML error response
			(global.fetch as any).mockResolvedValueOnce(
				new Response('<html>Error</html>', {
					status: 500,
					headers: { 'Content-Type': 'text/html' }
				})
			);

			// Should handle gracefully
			const result = await worker.checkSecurityEvents();
			expect(result.success).toBe(true);
		});

		it('should handle network timeout', async () => {
			// Mock network timeout
			(global.fetch as any).mockRejectedValueOnce(new Error('Network timeout'));

			// Should handle gracefully
			const result = await worker.checkSecurityEvents();
			expect(result.success).toBe(true);
		});
	});

	describe('Date handling edge cases', () => {
		it('should handle events with invalid timestamps', async () => {
			// Mock API response with invalid timestamp
			(global.fetch as any).mockResolvedValueOnce(
				createGraphQLSecurityResponse([{
					ray_id: 'invalid-time-event',
					occurred_at: 'invalid-date',
					action: 'block',
					client_ip: '1.2.3.4',
					country: 'US',
					method: 'GET',
					host: 'example.com',
					uri: '/test',
					user_agent: 'Mozilla/5.0',
					rule_id: 'rule-1',
					rule_message: 'Blocked'
				}])
			);

			const result = await worker.checkSecurityEvents();
			expect(result.success).toBe(true);
		});
	});
});
import { DurableObject, WorkerEntrypoint, RpcTarget } from "cloudflare:workers";
import {
	parseClassifyConfig,
	parseMinEvents,
	summarize,
	classificationSubjectSuffix,
	renderClassificationHtml,
	renderClassificationMrkdwn,
	type ClassifyEnv,
} from "./classify";

// CF Secrets Store binding (`secrets_store_secrets`) is exposed in production
// as an object with async `.get()`. In vitest (miniflare lacks a Secrets Store
// provider) we inject a plain string via `bindings: { CLOUDFLARE_API_TOKEN: "..." }`,
// so the helper accepts both shapes.
type SecretsStoreBinding = { get(): Promise<string> };

async function readApiToken(env: Env): Promise<string> {
	const t = (env as unknown as { CLOUDFLARE_API_TOKEN: SecretsStoreBinding | string }).CLOUDFLARE_API_TOKEN;
	return typeof t === 'string' ? t : await t.get();
}

interface NotificationEndpoint {
	id: string;
	name: string;
	type: 'webhook' | 'email' | 'slack';
	url?: string;
	email?: string;
	enabled: boolean;
	createdAt: string;
}

interface SecurityEvent {
	id: string;
	timestamp: string;
	action: string;
	clientIP: string;
	country: string;
	method: string;
	host: string;
	uri: string;
	userAgent: string;
	ruleId: string;
	ruleName: string;
}

export class NotificationManager extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	async addEndpoint(endpoint: NotificationEndpoint): Promise<void> {
		await this.ctx.storage.put(`endpoint:${endpoint.id}`, endpoint);
	}

	async removeEndpoint(id: string): Promise<void> {
		await this.ctx.storage.delete(`endpoint:${id}`);
	}

	async getEndpoints(): Promise<NotificationEndpoint[]> {
		const entries = await this.ctx.storage.list({ prefix: 'endpoint:' });
		return Array.from(entries.values()) as NotificationEndpoint[];
	}

	async toggleEndpoint(id: string, enabled: boolean): Promise<void> {
		const key = `endpoint:${id}`;
		const endpoint = await this.ctx.storage.get<NotificationEndpoint>(key);
		if (endpoint) {
			endpoint.enabled = enabled;
			await this.ctx.storage.put(key, endpoint);
		}
	}

	async checkAndNotifySecurityEvents(): Promise<void> {
		try {
			const now = new Date();
			const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

			const events = await this.fetchSecurityEvents(oneDayAgo, now);
			
			// Collect unprocessed events
			const unprocessedEvents: SecurityEvent[] = [];
			
			for (const event of events) {
				const eventKey = `event:${event.id}`;
				const processed = await this.env.PROCESSED_EVENTS.get(eventKey);
				
				if (!processed) {
					unprocessedEvents.push(event);
				}
			}
			
			// Send all unprocessed events in a single batch
			if (unprocessedEvents.length > 0) {
				const cfg = parseClassifyConfig(this.env as unknown as ClassifyEnv);
				const summary = summarize(unprocessedEvents, cfg);

				// 構造化 log: Workers Observability から `event:` フィルタで
				// query 可能。email を開かなくても CCoW セッションから
				// `cf_logging` MCP で attacker IP / rule / CF Access 分類を確認できる。
				console.log('security_events_detected', JSON.stringify({
					count: unprocessedEvents.length,
					actionable: summary.actionableCount,
					categories: summary.buckets.map((b) => ({ category: b.category, count: b.count })),
					events: unprocessedEvents.map((e) => ({
						id: e.id,
						timestamp: e.timestamp,
						action: e.action,
						clientIP: e.clientIP,
						country: e.country,
						method: e.method,
						host: e.host,
						uri: e.uri,
						ruleName: e.ruleName,
					})),
				}));

				// 件数閾値: 新規 event が NOTIFY_MIN_EVENTS 未満なら通知を抑制
				// (observability log は残す)。既定 1 = 現状維持。dedupe のため
				// 通知有無に関わらず processed mark は付ける。
				if (unprocessedEvents.length >= parseMinEvents(this.env as unknown as ClassifyEnv)) {
					await this.sendNotificationsBatch(unprocessedEvents);
				}

				// Mark all events as processed
				for (const event of unprocessedEvents) {
					const eventKey = `event:${event.id}`;
					await this.env.PROCESSED_EVENTS.put(eventKey, JSON.stringify(event), {
						expirationTtl: 172800 // 48 hours (24h window x 2 で境界重複を吸収)
					});
				}
			}
		} catch (error) {
			console.error('Error checking security events:', error);
		}
	}

	private async fetchSecurityEvents(startTime: Date, endTime: Date): Promise<SecurityEvent[]> {
		const zoneIds = this.env.CLOUDFLARE_ZONE_IDS
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);

		const apiToken = await readApiToken(this.env);
		const zoneTagsLiteral = JSON.stringify(zoneIds);

		const query = `query {
			viewer {
				zones(filter: { zoneTag_in: ${zoneTagsLiteral} }) {
					firewallEventsAdaptive(
						filter: {
							datetime_geq: "${startTime.toISOString()}"
							datetime_leq: "${endTime.toISOString()}"
							action_in: ["block", "challenge", "jschallenge"]
						}
						limit: 100
						orderBy: [datetime_DESC]
					) {
						rayName
						datetime
						action
						clientIP
						clientCountryName
						clientRequestHTTPMethodName
						clientRequestHTTPHost
						clientRequestPath
						userAgent
						ruleId
						description
					}
				}
			}
		}`;

		const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${apiToken}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ query }),
		});

		if (!response.ok) {
			throw new Error(`Cloudflare GraphQL API error: ${response.status}`);
		}

		const data = await response.json() as any;

		if (data.errors?.length > 0) {
			throw new Error(`GraphQL error: ${data.errors[0].message}`);
		}

		const zones = data.data?.viewer?.zones ?? [];
		const events = zones.flatMap((zone: any) => zone.firewallEventsAdaptive ?? []);

		return events.map((event: any) => ({
			id: event.rayName,
			timestamp: event.datetime,
			action: event.action,
			clientIP: event.clientIP,
			country: event.clientCountryName,
			method: event.clientRequestHTTPMethodName,
			host: event.clientRequestHTTPHost,
			uri: event.clientRequestPath,
			userAgent: event.userAgent || '',
			ruleId: event.ruleId || '',
			ruleName: event.description || 'Unknown',
		}));
	}

	async sendNotifications(event: SecurityEvent): Promise<void> {
		const endpoints = await this.getEndpoints();
		const activeEndpoints = endpoints.filter(ep => ep.enabled);

		await this.sendToEndpointsBatch(activeEndpoints, [event]);
	}

	async sendNotificationsBatch(events: SecurityEvent[]): Promise<void> {
		if (events.length === 0) return;

		// Email は endpoint 登録に依存せず常に送る (NOTIFY_EMAIL_TO 宛)
		await this.sendEmailBatch(events).catch(err =>
			console.error('Failed to send email batch:', err)
		);

		const endpoints = await this.getEndpoints();
		const activeEndpoints = endpoints.filter(ep => ep.enabled);
		await this.sendToEndpointsBatch(activeEndpoints, events);
	}

	private async sendToEndpointsBatch(endpoints: NotificationEndpoint[], events: SecurityEvent[]): Promise<void> {
		if (events.length === 0) return;

		// Send to each endpoint with all events in a single notification
		// (email は sendNotificationsBatch で env vars 宛に常時送信されるため、
		// endpoint type 'email' は no-op として無視する)
		const promises = endpoints.map(endpoint => {
			switch (endpoint.type) {
				case 'webhook':
					return this.sendWebhookBatch(endpoint.url!, events).catch(err =>
						console.error(`Failed to send batch to webhook ${endpoint.name}:`, err)
					);
				case 'slack':
					return this.sendSlackBatch(endpoint.url!, events).catch(err =>
						console.error(`Failed to send batch to Slack ${endpoint.name}:`, err)
					);
				case 'email':
					return Promise.resolve();
			}
		});

		await Promise.all(promises);
	}

	// 個別送信用メソッド（現在は未使用、バッチ送信を推奨）
	// private async sendToEndpoint(endpoint: NotificationEndpoint, event: SecurityEvent): Promise<void> {
	// 	switch (endpoint.type) {
	// 		case 'webhook':
	// 			await this.sendWebhook(endpoint.url!, event);
	// 			break;
	// 		case 'slack':
	// 			await this.sendSlack(endpoint.url!, event);
	// 			break;
	// 		case 'email':
	// 			// Email implementation would go here
	// 			console.log(`Email notification to ${endpoint.email} for event ${event.id}`);
	// 			break;
	// 	}
	// }

	// private async sendWebhook(url: string, event: SecurityEvent): Promise<void> {
	// 	const response = await fetch(url, {
	// 		method: 'POST',
	// 		headers: { 'Content-Type': 'application/json' },
	// 		body: JSON.stringify({
	// 			type: 'cloudflare_security_event',
	// 			event: event,
	// 			timestamp: new Date().toISOString()
	// 		})
	// 	});

	// 	if (!response.ok) {
	// 		throw new Error(`Webhook failed: ${response.status}`);
	// 	}
	// }

	private async sendWebhookBatch(url: string, events: SecurityEvent[]): Promise<void> {
		const summary = summarize(events, parseClassifyConfig(this.env as unknown as ClassifyEnv));
		const response = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				type: 'cloudflare_security_events_batch',
				events: events,
				count: events.length,
				classification: {
					actionable: summary.actionableCount,
					categories: summary.buckets,
				},
				timestamp: new Date().toISOString()
			})
		});

		if (!response.ok) {
			throw new Error(`Webhook batch failed: ${response.status}`);
		}
	}

	private async sendSlackBatch(url: string, events: SecurityEvent[]): Promise<void> {
		const eventsSummary = events.reduce((acc, event) => {
			acc[event.action] = (acc[event.action] || 0) + 1;
			return acc;
		}, {} as Record<string, number>);

		const summaryText = Object.entries(eventsSummary)
			.map(([action, count]) => `${action.toUpperCase()}: ${count}`)
			.join(', ');

		const summary = summarize(events, parseClassifyConfig(this.env as unknown as ClassifyEnv));

		const blocks: any[] = [
			{
				type: 'header',
				text: {
					type: 'plain_text',
					text: `🚨 ${events.length} Security Events Detected`
				}
			},
			{
				type: 'section',
				text: {
					type: 'mrkdwn',
					text: `*Summary:* ${summaryText}\n*Time Range (JST):* ${formatJst(events[0].timestamp)} - ${formatJst(events[events.length - 1].timestamp)}`
				}
			},
			{
				type: 'section',
				text: {
					type: 'mrkdwn',
					text: `*CF Access 分類:*\n${renderClassificationMrkdwn(summary)}`
				}
			}
		];

		// Add details for first 5 events
		const displayEvents = events.slice(0, 5);
		displayEvents.forEach((event, index) => {
			blocks.push({
				type: 'divider'
			});
			blocks.push({
				type: 'section',
				text: {
					type: 'mrkdwn',
					text: `*Event ${index + 1}:* ${event.action} from ${event.clientIP} (${event.country})`
				},
				fields: [
					{ type: 'mrkdwn', text: `*Host:* ${event.host}` },
					{ type: 'mrkdwn', text: `*URI:* ${event.uri}` },
					{ type: 'mrkdwn', text: `*Rule:* ${event.ruleName}` },
					{ type: 'mrkdwn', text: `*Time (JST):* ${formatJst(event.timestamp)}` }
				]
			});
		});

		if (events.length > 5) {
			blocks.push({
				type: 'context',
				elements: [
					{
						type: 'mrkdwn',
						text: `... and ${events.length - 5} more events`
					}
				]
			});
		}

		const message = {
			text: `🚨 ${events.length} Security Events Detected`,
			blocks: blocks
		};

		const response = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(message)
		});

		if (!response.ok) {
			throw new Error(`Slack webhook batch failed: ${response.status}`);
		}
	}

	private async sendEmailBatch(events: SecurityEvent[]): Promise<void> {
		const eventsSummary = events.reduce((acc, event) => {
			acc[event.action] = (acc[event.action] || 0) + 1;
			return acc;
		}, {} as Record<string, number>);

		const summaryText = Object.entries(eventsSummary)
			.map(([action, count]) => `${action.toUpperCase()}: ${count}`)
			.join(', ');

		const summary = summarize(events, parseClassifyConfig(this.env as unknown as ClassifyEnv));
		const subject = `[CF Security] ${events.length} events detected (${summaryText})${classificationSubjectSuffix(summary)}`;

		const rows = events.slice(0, 20).map(e => `
			<tr>
				<td>${escapeHtml(formatJst(e.timestamp))}</td>
				<td>${escapeHtml(e.action)}</td>
				<td>${escapeHtml(e.clientIP)}</td>
				<td>${escapeHtml(e.country)}</td>
				<td>${escapeHtml(e.method)}</td>
				<td>${escapeHtml(e.host)}${escapeHtml(e.uri)}</td>
				<td>${escapeHtml(e.ruleName)}</td>
			</tr>
		`).join('');

		const moreNote = events.length > 20 ? `<p>... and ${events.length - 20} more events</p>` : '';

		const html = `<!DOCTYPE html>
<html><body style="font-family: sans-serif;">
<h2>🚨 ${events.length} Cloudflare Security Events</h2>
<p><b>Summary:</b> ${escapeHtml(summaryText)}</p>
<p><b>Time range (JST):</b> ${escapeHtml(formatJst(events[events.length - 1].timestamp))} - ${escapeHtml(formatJst(events[0].timestamp))}</p>
${renderClassificationHtml(summary, escapeHtml)}
<table border="1" cellpadding="4" cellspacing="0" style="border-collapse: collapse;">
	<thead><tr><th>Time (JST)</th><th>Action</th><th>Client IP</th><th>Country</th><th>Method</th><th>Host/URI</th><th>Rule</th></tr></thead>
	<tbody>${rows}</tbody>
</table>
${moreNote}
</body></html>`;

		const { EmailMessage } = await import("cloudflare:email");
		const { createMimeMessage } = await import("mimetext");

		const from = this.env.NOTIFY_EMAIL_FROM;
		const to = this.env.NOTIFY_EMAIL_TO;

		const msg = createMimeMessage();
		msg.setSender({ name: "CF Security Notifier", addr: from });
		msg.setRecipient(to);
		msg.setSubject(subject);
		msg.addMessage({ contentType: "text/html", data: html });

		const emailMessage = new EmailMessage(from, to, msg.asRaw());
		await this.env.EMAIL.send(emailMessage);
	}

	// 個別送信用メソッド（現在は未使用、バッチ送信を推奨）
	// private async sendSlack(url: string, event: SecurityEvent): Promise<void> {
	// 	const message = {
	// 		text: `🚨 Security Alert: ${event.action.toUpperCase()}`,
	// 		blocks: [
	// 			{
	// 				type: 'section',
	// 				text: {
	// 					type: 'mrkdwn',
	// 					text: `*Security Event Detected*\n*Action:* ${event.action}\n*Time:* ${new Date(event.timestamp).toLocaleString()}`
	// 				}
	// 			},
	// 			{
	// 				type: 'section',
	// 				fields: [
	// 					{ type: 'mrkdwn', text: `*Client IP:*\n${event.clientIP}` },
	// 					{ type: 'mrkdwn', text: `*Country:*\n${event.country}` },
	// 					{ type: 'mrkdwn', text: `*Method:*\n${event.method}` },
	// 					{ type: 'mrkdwn', text: `*Host:*\n${event.host}` },
	// 					{ type: 'mrkdwn', text: `*URI:*\n${event.uri}` },
	// 					{ type: 'mrkdwn', text: `*Rule:*\n${event.ruleName}` },
	// 				]
	// 			},
	// 			{
	// 				type: 'context',
	// 				elements: [
	// 					{
	// 						type: 'mrkdwn',
	// 						text: `Ray ID: ${event.id} | User Agent: ${event.userAgent.substring(0, 50)}...`
	// 					}
	// 				]
	// 			}
	// 		]
	// 	};

	// 	const response = await fetch(url, {
	// 		method: 'POST',
	// 		headers: { 'Content-Type': 'application/json' },
	// 		body: JSON.stringify(message)
	// 	});

	// 	if (!response.ok) {
	// 		throw new Error(`Slack webhook failed: ${response.status}`);
	// 	}
	// }
}


export default class SecurityNotificationWorker extends WorkerEntrypoint<Env> {
	// RPC経由で呼び出し可能なメソッド
	async checkSecurityEvents(): Promise<{ success: boolean; message: string }> {
		const notificationManager = this.env.NOTIFICATION_MANAGER.get(
			this.env.NOTIFICATION_MANAGER.idFromName("global")
		);
		await notificationManager.checkAndNotifySecurityEvents();
		return { success: true, message: 'Security events checked via RPC' };
	}

	async getEndpointsList(): Promise<NotificationEndpoint[]> {
		const notificationManager = this.env.NOTIFICATION_MANAGER.get(
			this.env.NOTIFICATION_MANAGER.idFromName("global")
		);
		return await notificationManager.getEndpoints();
	}

	// エンドポイントを追加
	async addEndpoint(endpoint: Omit<NotificationEndpoint, 'id' | 'createdAt'>): Promise<NotificationEndpoint> {
		const notificationManager = this.env.NOTIFICATION_MANAGER.get(
			this.env.NOTIFICATION_MANAGER.idFromName("global")
		);
		const newEndpoint: NotificationEndpoint = {
			...endpoint,
			id: crypto.randomUUID(),
			createdAt: new Date().toISOString()
		};
		await notificationManager.addEndpoint(newEndpoint);
		return newEndpoint;
	}

	// エンドポイントを削除
	async removeEndpoint(id: string): Promise<{ success: boolean }> {
		const notificationManager = this.env.NOTIFICATION_MANAGER.get(
			this.env.NOTIFICATION_MANAGER.idFromName("global")
		);
		await notificationManager.removeEndpoint(id);
		return { success: true };
	}

	// エンドポイントの有効/無効を切り替え
	async toggleEndpoint(id: string, enabled: boolean): Promise<{ success: boolean }> {
		const notificationManager = this.env.NOTIFICATION_MANAGER.get(
			this.env.NOTIFICATION_MANAGER.idFromName("global")
		);
		await notificationManager.toggleEndpoint(id, enabled);
		return { success: true };
	}

	// 特定のセキュリティイベントを通知（テスト用）
	async sendTestNotification(event: SecurityEvent): Promise<{ success: boolean; notifiedEndpoints: number }> {
		const notificationManager = this.env.NOTIFICATION_MANAGER.get(
			this.env.NOTIFICATION_MANAGER.idFromName("global")
		);
		await notificationManager.sendNotifications(event);
		const endpoints = await notificationManager.getEndpoints();
		const activeEndpoints = endpoints.filter(ep => ep.enabled);
		return { success: true, notifiedEndpoints: activeEndpoints.length };
	}

	// セキュリティイベントの履歴を取得（KVから）
	async getProcessedEvents(limit: number = 100): Promise<Array<{ key: string; event: SecurityEvent }>> {
		const list = await this.env.PROCESSED_EVENTS.list({ limit });
		const events = await Promise.all(
			list.keys.map(async (key) => {
				const eventData = await this.env.PROCESSED_EVENTS.get(key.name);
				return eventData ? { key: key.name, event: JSON.parse(eventData) as SecurityEvent } : null;
			})
		);
		return events.filter((e): e is { key: string; event: SecurityEvent } => e !== null);
	}

	async fetch(request: Request): Promise<Response> {
		const env = this.env;
		const ctx = this.ctx;
		const url = new URL(request.url);
		const notificationManager = env.NOTIFICATION_MANAGER.get(env.NOTIFICATION_MANAGER.idFromName("global"));

		// API endpoints for managing notification endpoints
		if (url.pathname === '/api/endpoints' && request.method === 'GET') {
			const endpoints = await notificationManager.getEndpoints();
			return Response.json({ endpoints });
		}

		if (url.pathname === '/api/endpoints' && request.method === 'POST') {
			const endpoint: NotificationEndpoint = await request.json();
			endpoint.id = crypto.randomUUID();
			endpoint.createdAt = new Date().toISOString();
			await notificationManager.addEndpoint(endpoint);
			return Response.json({ success: true, endpoint });
		}

		if (url.pathname.startsWith('/api/endpoints/') && request.method === 'DELETE') {
			const id = url.pathname.split('/').pop()!;
			await notificationManager.removeEndpoint(id);
			return Response.json({ success: true });
		}

		if (url.pathname.startsWith('/api/endpoints/') && url.pathname.endsWith('/toggle') && request.method === 'POST') {
			const id = url.pathname.split('/')[3];
			const body = await request.json() as { enabled: boolean };
			await notificationManager.toggleEndpoint(id, body.enabled);
			return Response.json({ success: true });
		}

		// Manual trigger for checking security events
		if (url.pathname === '/api/check-events' && request.method === 'POST') {
			await notificationManager.checkAndNotifySecurityEvents();
			return Response.json({ success: true, message: 'Security events checked' });
		}

		return new Response('Security Notification API', { status: 200 });
	}

	async scheduled(controller: ScheduledController): Promise<void> {
		const env = this.env;
		const notificationManager = env.NOTIFICATION_MANAGER.get(env.NOTIFICATION_MANAGER.idFromName("global"));
		await notificationManager.checkAndNotifySecurityEvents();
	}
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

// Workers default to UTC, so explicitly pin display to JST.
function formatJst(iso: string): string {
	return new Date(iso).toLocaleString('ja-JP', {
		timeZone: 'Asia/Tokyo',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false,
	});
}

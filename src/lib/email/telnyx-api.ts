import type {
	TelnyxClient, TelnyxDnsRecord, TelnyxDomain, TelnyxInbox, TelnyxInboundMessage, TelnyxWebhook,
} from "@/lib/email/telnyx-api-types";

const TELNYX_DEFAULT_BASE_URL = "https://api.telnyx.com/v2";

/** Telnyx's inbound MX target, priority 10. */
export const TELNYX_INBOUND_MX = "mx.telnyx.com";

export const isTelnyxInboundMx = (content: string) => content.trim().toLowerCase().replace(/\.$/, "") === TELNYX_INBOUND_MX;

/** TELNYX_BASE_URL points the provider at another API host (tests, proxies). */
export function telnyxBaseUrl(env: object): string {
	return ((env as { TELNYX_BASE_URL?: string }).TELNYX_BASE_URL?.trim() || TELNYX_DEFAULT_BASE_URL).replace(/\/+$/, "");
}

export function telnyxClient(env: object, apiKey: string): TelnyxClient {
	return { apiKey, baseUrl: telnyxBaseUrl(env) };
}

/** A Telnyx API error, keeping the status and the first error's code for callers that branch on them. */
export class TelnyxApiError extends Error {
	constructor(message: string, readonly status: number, readonly code: string | null) {
		super(message);
		this.name = "TelnyxApiError";
	}
}

type ErrorBody = { errors?: { code?: string | number; title?: string; detail?: string }[] };

export async function telnyxRequest<T>(
	client: TelnyxClient,
	path: string,
	init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
	const response = await fetch(`${client.baseUrl}${path}`, {
		method: init.method ?? "GET",
		headers: {
			Authorization: `Bearer ${client.apiKey}`,
			Accept: "application/json",
			...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
			...init.headers,
		},
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
	});
	if (response.status === 204) return undefined as T;
	const body = (await response.json().catch(() => null)) as (T & ErrorBody) | null;
	if (!response.ok) {
		const first = body?.errors?.[0];
		const detail = first?.detail || first?.title || `request failed (${response.status})`;
		throw new TelnyxApiError(`Telnyx: ${detail}`, response.status, first?.code !== undefined ? String(first.code) : null);
	}
	return body as T;
}

type Data<T> = { data: T };

/** Whether the key is accepted. Listing domains needs only the default email scope. */
export async function checkTelnyxKey(client: TelnyxClient): Promise<boolean> {
	try {
		await telnyxRequest(client, "/email_domains?page[size]=1");
		return true;
	} catch (error) {
		if (error instanceof TelnyxApiError && (error.status === 401 || error.status === 403)) return false;
		throw error;
	}
}

export async function findTelnyxDomain(client: TelnyxClient, hostname: string): Promise<TelnyxDomain | null> {
	const wanted = hostname.toLowerCase();
	for (let page = 1; page <= 20; page += 1) {
		const result = await telnyxRequest<Data<TelnyxDomain[]> & { meta?: { total_pages?: number } }>(
			client,
			`/email_domains?page[number]=${page}&page[size]=100`,
		);
		const match = (result.data ?? []).find((domain) => domain.type !== "shared" && domain.domain?.toLowerCase() === wanted);
		if (match) return match;
		if ((result.data ?? []).length < 100 || (result.meta?.total_pages ?? page) <= page) return null;
	}
	return null;
}

export async function getTelnyxDomain(client: TelnyxClient, id: string): Promise<TelnyxDomain> {
	return (await telnyxRequest<Data<TelnyxDomain>>(client, `/email_domains/${encodeURIComponent(id)}`)).data;
}

export async function createTelnyxDomain(client: TelnyxClient, hostname: string, inbound: boolean): Promise<TelnyxDomain> {
	return (await telnyxRequest<Data<TelnyxDomain>>(client, "/email_domains", { method: "POST", body: { domain: hostname, inbound_enabled: inbound } })).data;
}

export async function setTelnyxInbound(client: TelnyxClient, id: string, inbound: boolean): Promise<TelnyxDomain> {
	return (await telnyxRequest<Data<TelnyxDomain>>(client, `/email_domains/${encodeURIComponent(id)}`, { method: "PATCH", body: { inbound_enabled: inbound } })).data;
}

/** Verified and degraded domains need `force`; deleting is otherwise refused. */
export async function deleteTelnyxDomain(client: TelnyxClient, id: string): Promise<void> {
	await telnyxRequest(client, `/email_domains/${encodeURIComponent(id)}?force=true`, { method: "DELETE" });
}

/** Synchronous: the answer is the domain's resolved state. */
export async function verifyTelnyxDomain(client: TelnyxClient, id: string): Promise<TelnyxDomain | null> {
	const result = await telnyxRequest<Data<TelnyxDomain> | null>(client, `/email_domains/${encodeURIComponent(id)}/verify`, { method: "POST" });
	return result?.data ?? null;
}

export async function listTelnyxDnsRecords(client: TelnyxClient, id: string): Promise<TelnyxDnsRecord[]> {
	return (await telnyxRequest<Data<TelnyxDnsRecord[]>>(client, `/email_domains/${encodeURIComponent(id)}/dns_records`)).data ?? [];
}

export async function listTelnyxWebhooks(client: TelnyxClient, domainId: string): Promise<TelnyxWebhook[]> {
	return (await telnyxRequest<Data<TelnyxWebhook[]>>(client, `/email_domains/${encodeURIComponent(domainId)}/webhooks?page[size]=100`)).data ?? [];
}

export async function createTelnyxWebhook(client: TelnyxClient, domainId: string, url: string, events: string[]): Promise<TelnyxWebhook> {
	return (await telnyxRequest<Data<TelnyxWebhook>>(client, `/email_domains/${encodeURIComponent(domainId)}/webhooks`, { method: "POST", body: { url, events } })).data;
}

export async function deleteTelnyxWebhook(client: TelnyxClient, domainId: string, id: string): Promise<void> {
	await telnyxRequest(client, `/email_domains/${encodeURIComponent(domainId)}/webhooks/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function listTelnyxInboxes(client: TelnyxClient): Promise<TelnyxInbox[]> {
	const inboxes: TelnyxInbox[] = [];
	for (let page = 1; page <= 50; page += 1) {
		const result = await telnyxRequest<Data<TelnyxInbox[]>>(client, `/email_inboxes?page[number]=${page}&page[size]=100`);
		inboxes.push(...(result.data ?? []));
		if ((result.data ?? []).length < 100) break;
	}
	return inboxes;
}

export async function createTelnyxInbox(client: TelnyxClient, domainId: string, username: string): Promise<TelnyxInbox> {
	return (await telnyxRequest<Data<TelnyxInbox>>(client, "/email_inboxes", { method: "POST", body: { username, domain_id: domainId } })).data;
}

export async function deleteTelnyxInbox(client: TelnyxClient, id: string): Promise<void> {
	await telnyxRequest(client, `/email_inboxes/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/**
 * The full inbound message. `GET /email_messages/{id}` serves both directions;
 * the inbox-scoped path is the fallback for accounts where it does not.
 */
export async function getTelnyxInboundMessage(client: TelnyxClient, id: string, inboxId?: string | null): Promise<TelnyxInboundMessage> {
	try {
		return (await telnyxRequest<Data<TelnyxInboundMessage>>(client, `/email_messages/${encodeURIComponent(id)}`)).data;
	} catch (error) {
		if (!inboxId || !(error instanceof TelnyxApiError) || error.status !== 404) throw error;
		return (await telnyxRequest<Data<TelnyxInboundMessage>>(client, `/email_inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(id)}`)).data;
	}
}

/**
 * Downloads a stored body or attachment. Telnyx's own API host needs the key;
 * any other host is a pre-signed storage URL and must not receive it.
 */
export async function fetchTelnyxContent(client: TelnyxClient, url: string): Promise<Response> {
	const target = new URL(url);
	if (target.protocol !== "https:") throw new Error("Telnyx content URL is not HTTPS");
	const apiHost = new URL(client.baseUrl).host;
	const response = await fetch(target, target.host === apiHost ? { headers: { Authorization: `Bearer ${client.apiKey}` } } : undefined);
	if (!response.ok) throw new Error(`Could not download Telnyx content (${response.status})`);
	return response;
}

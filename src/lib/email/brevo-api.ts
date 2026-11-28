import type { BrevoClient, BrevoDnsRecord, BrevoDomain } from "@/lib/email/brevo-api-types";

const BREVO_DEFAULT_BASE_URL = "https://api.brevo.com/v3";

/** BREVO_BASE_URL points the provider at another API host (tests, proxies). */
export function brevoClient(env: object, apiKey: string): BrevoClient {
	const baseUrl = ((env as { BREVO_BASE_URL?: string }).BREVO_BASE_URL?.trim() || BREVO_DEFAULT_BASE_URL).replace(/\/+$/, "");
	return { apiKey, baseUrl };
}

/** A Brevo API error, keeping the status and Brevo's `code` for callers that branch on them. */
export class BrevoApiError extends Error {
	constructor(message: string, readonly status: number, readonly code: string | null) {
		super(message);
		this.name = "BrevoApiError";
	}
}

export async function brevoRequest<T>(client: BrevoClient, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
	const response = await fetch(`${client.baseUrl}${path}`, {
		method: init.method ?? "GET",
		headers: {
			"api-key": client.apiKey,
			Accept: "application/json",
			...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
		},
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
	});
	const body = (await response.json().catch(() => null)) as (T & { code?: string; message?: string }) | null;
	if (!response.ok) {
		throw new BrevoApiError(`Brevo: ${body?.message || `request failed (${response.status})`}`, response.status, body?.code ?? null);
	}
	return body as T;
}

/** Whether the key is accepted. */
export async function checkBrevoKey(client: BrevoClient): Promise<boolean> {
	try {
		await brevoRequest(client, "/account");
		return true;
	} catch (error) {
		if (error instanceof BrevoApiError && (error.status === 401 || error.status === 403)) return false;
		throw error;
	}
}

const domainPath = (hostname: string) => `/senders/domains/${encodeURIComponent(hostname.toLowerCase())}`;

/** Brevo documents both 400 and 404 for this route without saying which means "no such domain". */
const isMissingDomain = (error: unknown) =>
	error instanceof BrevoApiError && (error.status === 404 || (error.status === 400 && (error.code === "document_not_found" || /not (found|exist)/i.test(error.message))));

export async function findBrevoDomain(client: BrevoClient, hostname: string): Promise<BrevoDomain | null> {
	try {
		return await brevoRequest<BrevoDomain>(client, domainPath(hostname));
	} catch (error) {
		if (isMissingDomain(error)) return null;
		throw error;
	}
}

export async function createBrevoDomain(client: BrevoClient, hostname: string): Promise<void> {
	await brevoRequest(client, "/senders/domains", { method: "POST", body: { name: hostname.toLowerCase() } });
}

/** Asks Brevo to check the DNS records. It answers with an error while they are not visible yet. */
export async function authenticateBrevoDomain(client: BrevoClient, hostname: string): Promise<void> {
	await brevoRequest(client, `${domainPath(hostname)}/authenticate`, { method: "PUT" });
}

export async function deleteBrevoDomain(client: BrevoClient, hostname: string): Promise<void> {
	await brevoRequest(client, domainPath(hostname), { method: "DELETE" });
}

export function brevoDnsRecords(domain: BrevoDomain): BrevoDnsRecord[] {
	return Object.values(domain.dns_records ?? {}).filter((record): record is BrevoDnsRecord => !!record?.type && !!record.host_name && !!record.value);
}

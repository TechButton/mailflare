import { createDnsRecord, deleteDnsRecord, listDnsRecords } from "@/lib/cloudflare-dns";
import { isManualZone } from "@/lib/domains/provision";
import { absoluteTelnyxName as absoluteName, normalizeDnsValue as normalize, policyKind } from "@/lib/domains/telnyx-domain-utils";
import { authenticateBrevoDomain, brevoClient, brevoDnsRecords, createBrevoDomain, deleteBrevoDomain, findBrevoDomain } from "@/lib/email/brevo-api";
import { getBrevoClient, getBrevoKeyStatus } from "@/lib/email/brevo-config";
import type { BrevoClient, BrevoDnsRecord, BrevoDomain } from "@/lib/email/brevo-api-types";
import type { BrevoDomainView } from "@/lib/domains/brevo-domain-types";
import type { DomainRow } from "@/lib/domains/types";

type ZoneState = "present" | "missing" | "conflict";

async function zoneState(env: CloudflareEnv, domain: DomainRow, record: BrevoDnsRecord): Promise<ZoneState> {
	const existing = await listDnsRecords(env, domain.zoneId, { type: record.type.toUpperCase(), name: absoluteName(record.host_name, domain.hostname) });
	if (existing.some((item) => normalize(item.content ?? "") === normalize(record.value))) return "present";
	const kind = policyKind(record.value);
	if (kind && existing.some((item) => policyKind(item.content ?? "") === kind)) return "conflict";
	return "missing";
}

async function publishRecords(env: CloudflareEnv, domain: DomainRow, records: BrevoDnsRecord[]): Promise<void> {
	if (isManualZone(domain.zoneId)) return;
	for (const record of records) {
		// A DMARC record the domain already has is left alone: policy is the owner's call.
		if (await zoneState(env, domain, record) !== "missing") continue;
		const name = absoluteName(record.host_name, domain.hostname);
		const type = record.type.toUpperCase();
		if (type === "CNAME") await createDnsRecord(env, domain.zoneId, { type: "CNAME", name, content: record.value, ttl: 3600, proxied: false });
		else if (type === "TXT") await createDnsRecord(env, domain.zoneId, { type: "TXT", name, content: record.value, ttl: 3600 });
	}
}

async function view(env: CloudflareEnv, domain: DomainRow, brevo: BrevoDomain | null): Promise<BrevoDomainView> {
	const dnsManaged = !isManualZone(domain.zoneId);
	if (!brevo) return { registered: false, status: "not_registered", records: [], dnsManaged, missingDns: null };
	const records = brevoDnsRecords(brevo);
	let states: ZoneState[] = [];
	let missingDns: number | null = null;
	if (dnsManaged) {
		try {
			states = await Promise.all(records.map((record) => zoneState(env, domain, record)));
			missingDns = states.filter((state) => state === "missing").length;
		} catch { states = []; }
	}
	return {
		registered: true,
		status: brevo.authenticated ? "verified" : "pending",
		dnsManaged,
		missingDns,
		records: records.map((record, index) => ({
			type: record.type.toUpperCase(),
			name: absoluteName(record.host_name, domain.hostname),
			value: record.value,
			status: states[index] === "conflict" ? "existing_policy" : record.status ? "verified" : "pending",
		})),
	};
}

export async function getBrevoDomainView(env: CloudflareEnv, domain: DomainRow): Promise<BrevoDomainView> {
	return view(env, domain, await findBrevoDomain(await getBrevoClient(env), domain.hostname));
}

async function authenticateAndRead(client: BrevoClient, hostname: string): Promise<BrevoDomain | null> {
	// Fails until the records are visible to Brevo; the status read below says where things stand.
	await authenticateBrevoDomain(client, hostname).catch((error) => console.warn(`Brevo has not authenticated ${hostname} yet`, error));
	return findBrevoDomain(client, hostname);
}

/** Registers the domain with Brevo, writes its records to the zone (when managed) and asks Brevo to authenticate it. */
export async function setupBrevoDomain(env: CloudflareEnv, domain: DomainRow): Promise<BrevoDomainView> {
	const client = await getBrevoClient(env);
	let brevo = await findBrevoDomain(client, domain.hostname);
	if (!brevo) {
		await createBrevoDomain(client, domain.hostname);
		brevo = await findBrevoDomain(client, domain.hostname);
		if (!brevo) throw new Error("Brevo did not return the domain after adding it");
	}
	await publishRecords(env, domain, brevoDnsRecords(brevo));
	return view(env, domain, await authenticateAndRead(client, domain.hostname));
}

export async function verifyBrevoDomainView(env: CloudflareEnv, domain: DomainRow): Promise<BrevoDomainView> {
	const client = await getBrevoClient(env);
	if (!await findBrevoDomain(client, domain.hostname)) return view(env, domain, null);
	return view(env, domain, await authenticateAndRead(client, domain.hostname));
}

/** "verified", "pending", "not_registered", or null when that cannot be checked. */
export async function getBrevoDomainStatus(env: CloudflareEnv, domain: DomainRow): Promise<string | null> {
	try {
		const { apiKey } = await getBrevoKeyStatus(env);
		if (!apiKey) return null;
		const brevo = await findBrevoDomain(brevoClient(env, apiKey), domain.hostname);
		return !brevo ? "not_registered" : brevo.authenticated ? "verified" : "pending";
	} catch { return null; }
}

/** Deletes the records Brevo asked for (only where the value still matches) and the domain. */
export async function removeBrevoSending(env: CloudflareEnv, domain: DomainRow): Promise<void> {
	const client = await getBrevoClient(env);
	const brevo = await findBrevoDomain(client, domain.hostname);
	if (!brevo) return;
	if (!isManualZone(domain.zoneId)) {
		for (const record of brevoDnsRecords(brevo)) {
			// DMARC is a policy for the whole domain, which other mail services may now rely on.
			if (policyKind(record.value)) continue;
			const existing = await listDnsRecords(env, domain.zoneId, { type: record.type.toUpperCase(), name: absoluteName(record.host_name, domain.hostname) });
			for (const item of existing) {
				if (item.id && normalize(item.content ?? "") === normalize(record.value)) await deleteDnsRecord(env, domain.zoneId, item.id);
			}
		}
	}
	await deleteBrevoDomain(client, domain.hostname);
}

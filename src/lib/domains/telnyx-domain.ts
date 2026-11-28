import { and, eq, or } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, mailboxAliases, mailboxes } from "@/db/schema";
import { createDnsRecord, deleteDnsRecord, listDnsRecords } from "@/lib/cloudflare-dns";
import { isManualZone } from "@/lib/domains/provision";
import { hasMx, publishMx, removeMx } from "@/lib/domains/receiving-dns";
import {
	createTelnyxDomain, createTelnyxInbox, createTelnyxWebhook, deleteTelnyxDomain, deleteTelnyxInbox, deleteTelnyxWebhook,
	findTelnyxDomain, getTelnyxDomain, isTelnyxInboundMx, listTelnyxDnsRecords, listTelnyxInboxes, listTelnyxWebhooks,
	setTelnyxInbound, TELNYX_INBOUND_MX, telnyxClient, verifyTelnyxDomain,
} from "@/lib/email/telnyx-api";
import { getTelnyxClient, getTelnyxConfig } from "@/lib/email/telnyx-config";
import { absoluteTelnyxName, isTelnyxInboundEnabled, isTelnyxUsername, normalizeDnsValue as normalize, policyKind } from "@/lib/domains/telnyx-domain-utils";
import type { ReceivingStep } from "@/lib/aws/ses-receiving-types";
import type { DomainRow } from "@/lib/domains/types";
import type { TelnyxDomainView, TelnyxReceivingView } from "@/lib/domains/telnyx-domain-types";
import type { TelnyxClient, TelnyxDnsRecord, TelnyxDomain } from "@/lib/email/telnyx-api-types";

export const telnyxWebhookUrl = (origin: string) => `${origin.replace(/\/$/, "")}/api/inbound/telnyx`;
const RECEIVED_EVENTS = ["email.received"];


/** The MX belongs to the receiving setup, which handles conflicts with other mail services. */
const nonMx = (records: TelnyxDnsRecord[]) => records.filter((record) => record.record_type.toUpperCase() !== "MX");

type ZoneState = "present" | "missing" | "conflict";

async function zoneState(env: CloudflareEnv, domain: DomainRow, record: TelnyxDnsRecord): Promise<ZoneState> {
	const type = record.record_type.toUpperCase();
	const existing = await listDnsRecords(env, domain.zoneId, { type, name: absoluteTelnyxName(record.host, domain.hostname) });
	if (existing.some((item) => normalize(item.content ?? "") === normalize(record.value))) return "present";
	const kind = policyKind(record.value);
	if (kind && existing.some((item) => policyKind(item.content ?? "") === kind)) return "conflict";
	return "missing";
}

async function publishRecords(env: CloudflareEnv, domain: DomainRow, records: TelnyxDnsRecord[]): Promise<void> {
	if (isManualZone(domain.zoneId)) return;
	for (const record of nonMx(records)) {
		// An SPF or DMARC record the domain already has is left alone: merging policy is the owner's call.
		if (await zoneState(env, domain, record) !== "missing") continue;
		const name = absoluteTelnyxName(record.host, domain.hostname);
		const type = record.record_type.toUpperCase();
		if (type === "CNAME") await createDnsRecord(env, domain.zoneId, { type: "CNAME", name, content: record.value, ttl: 3600, proxied: false });
		else await createDnsRecord(env, domain.zoneId, { type: "TXT", name, content: record.value, ttl: 3600 });
	}
}

async function deleteRecords(env: CloudflareEnv, domain: DomainRow, records: TelnyxDnsRecord[]): Promise<void> {
	if (isManualZone(domain.zoneId)) return;
	for (const record of nonMx(records)) {
		const existing = await listDnsRecords(env, domain.zoneId, { type: record.record_type.toUpperCase(), name: absoluteTelnyxName(record.host, domain.hostname) });
		for (const item of existing) {
			if (item.id && normalize(item.content ?? "") === normalize(record.value)) await deleteDnsRecord(env, domain.zoneId, item.id);
		}
	}
}

async function ensureDomain(client: TelnyxClient, domain: DomainRow, inbound: boolean | null): Promise<TelnyxDomain> {
	const found = await findTelnyxDomain(client, domain.hostname);
	if (!found) return createTelnyxDomain(client, domain.hostname, inbound === true);
	if (inbound !== null && isTelnyxInboundEnabled(found) !== inbound) return setTelnyxInbound(client, found.id, inbound);
	return found;
}

async function view(env: CloudflareEnv, domain: DomainRow, telnyx: TelnyxDomain | null, client: TelnyxClient): Promise<TelnyxDomainView> {
	const dnsManaged = !isManualZone(domain.zoneId);
	if (!telnyx) return { registered: false, status: "not_registered", records: [], dnsManaged, missingDns: null };
	const records = nonMx(await listTelnyxDnsRecords(client, telnyx.id));
	let missingDns: number | null = null;
	const states: ZoneState[] = [];
	if (dnsManaged) {
		try {
			states.push(...await Promise.all(records.map((record) => zoneState(env, domain, record))));
			missingDns = states.filter((state, index) => state === "missing" && records[index].required !== false).length;
		} catch { states.length = 0; }
	}
	return {
		registered: true,
		status: telnyx.status,
		dnsManaged,
		missingDns,
		records: records.map((record, index) => ({
			type: record.record_type.toUpperCase(),
			name: absoluteTelnyxName(record.host, domain.hostname),
			value: record.value,
			priority: record.priority ?? null,
			required: record.required !== false,
			status: states[index] === "conflict" ? "existing_policy" : record.status ?? "unknown",
		})),
	};
}

// --- Sending -----------------------------------------------------------------

export async function getTelnyxDomainView(env: CloudflareEnv, domain: DomainRow): Promise<TelnyxDomainView> {
	const client = await getTelnyxClient(env);
	return view(env, domain, await findTelnyxDomain(client, domain.hostname), client);
}

/** Registers the domain with Telnyx, writes its records to the zone (when managed) and asks Telnyx to verify. */
export async function setupTelnyxDomain(env: CloudflareEnv, domain: DomainRow): Promise<TelnyxDomainView> {
	const client = await getTelnyxClient(env);
	const telnyx = await ensureDomain(client, domain, domain.receivingProvider === "telnyx" ? true : null);
	await publishRecords(env, domain, await listTelnyxDnsRecords(client, telnyx.id));
	const verified = await verifyTelnyxDomain(client, telnyx.id).catch(() => null);
	return view(env, domain, verified ?? await getTelnyxDomain(client, telnyx.id), client);
}

export async function verifyTelnyxDomainView(env: CloudflareEnv, domain: DomainRow): Promise<TelnyxDomainView> {
	const client = await getTelnyxClient(env);
	const telnyx = await findTelnyxDomain(client, domain.hostname);
	if (!telnyx) return view(env, domain, null, client);
	const verified = await verifyTelnyxDomain(client, telnyx.id).catch(() => null);
	return view(env, domain, verified ?? await getTelnyxDomain(client, telnyx.id), client);
}

/** The domain's Telnyx status, "not_registered", or null when that cannot be checked. */
export async function getTelnyxDomainStatus(env: CloudflareEnv, domain: DomainRow): Promise<string | null> {
	const { apiKey } = await getTelnyxConfig(env);
	if (!apiKey) return null;
	try { return (await findTelnyxDomain(telnyxClient(env, apiKey), domain.hostname))?.status ?? "not_registered"; }
	catch { return null; }
}

/**
 * Removes the sending setup. Ownership and DKIM records also serve receiving, so
 * while the domain still receives through Telnyx only the SPF include goes.
 */
export async function removeTelnyxSending(env: CloudflareEnv, domain: DomainRow): Promise<void> {
	const client = await getTelnyxClient(env);
	const telnyx = await findTelnyxDomain(client, domain.hostname);
	if (!telnyx) return;
	const records = await listTelnyxDnsRecords(client, telnyx.id);
	if (domain.receivingProvider === "telnyx") {
		await deleteRecords(env, domain, records.filter((record) => policyKind(record.value) === "spf"));
		return;
	}
	await deleteRecords(env, domain, records);
	await deleteTelnyxDomain(client, telnyx.id);
}

// --- Receiving ---------------------------------------------------------------

/** Every address Mailflare delivers for on this domain: mailboxes (including all-domain ones) and aliases. */
export async function listDomainAddresses(env: CloudflareEnv, domain: DomainRow): Promise<string[]> {
	const db = getDb(env);
	const [boxes, aliases] = await Promise.all([
		db.select({ localPart: mailboxes.localPart })
			.from(mailboxes)
			.innerJoin(domains, eq(mailboxes.domainId, domains.id))
			.where(and(eq(domains.userId, domain.userId), or(eq(mailboxes.domainId, domain.id), eq(mailboxes.useAllDomains, true)))),
		db.select({ localPart: mailboxAliases.localPart }).from(mailboxAliases).where(eq(mailboxAliases.domainId, domain.id)),
	]);
	const host = domain.hostname.toLowerCase();
	return [...new Set([...boxes, ...aliases].map((row) => `${row.localPart}@${host}`.toLowerCase()))].sort();
}

async function inboxesFor(client: TelnyxClient, domain: DomainRow, telnyx: TelnyxDomain) {
	const suffix = `@${domain.hostname.toLowerCase()}`;
	return (await listTelnyxInboxes(client)).filter((inbox) => inbox.domain_id === telnyx.id || inbox.address?.toLowerCase().endsWith(suffix));
}

function isPublicHttps(origin: string): boolean {
	try {
		const url = new URL(origin);
		return url.protocol === "https:" && !/^(localhost|127\.|\[::1\]|.*\.localhost$|.*\.test$)/.test(url.hostname);
	} catch { return false; }
}

/**
 * Receiving through Telnyx: enable inbound on the domain, publish its records
 * and MX, register the `email.received` webhook, and create one Telnyx inbox
 * per Mailflare address (Telnyx only accepts mail for addresses it has an inbox for).
 * Safe to run again: it fills in whatever is missing, such as inboxes for new mailboxes.
 */
export async function setupTelnyxReceiving(env: CloudflareEnv, domain: DomainRow, origin: string, options: { replaceMx: boolean }): Promise<void> {
	if (!isPublicHttps(origin)) {
		throw new Error("Telnyx delivers mail by calling this app over public HTTPS. Set APP_URL to your public address (localhost will not work).");
	}
	const config = await getTelnyxConfig(env);
	if (!config.publicKeyConfigured) throw new Error("Add your Telnyx public key first: Mailflare uses it to verify that webhooks come from Telnyx.");
	const client = await getTelnyxClient(env);
	const telnyx = await ensureDomain(client, domain, true);
	await publishRecords(env, domain, await listTelnyxDnsRecords(client, telnyx.id));
	await publishMx(env, domain, TELNYX_INBOUND_MX, { replace: options.replaceMx, priority: 10 });

	const endpoint = telnyxWebhookUrl(origin);
	const hooks = await listTelnyxWebhooks(client, telnyx.id);
	if (!hooks.some((hook) => hook.url === endpoint && hook.events.includes("email.received"))) {
		await createTelnyxWebhook(client, telnyx.id, endpoint, RECEIVED_EVENTS);
	}

	const existing = new Set((await inboxesFor(client, domain, telnyx)).map((inbox) => inbox.address.toLowerCase()));
	const skipped: string[] = [];
	for (const address of await listDomainAddresses(env, domain)) {
		if (existing.has(address)) continue;
		const localPart = address.slice(0, address.lastIndexOf("@"));
		if (!isTelnyxUsername(localPart)) { skipped.push(address); continue; }
		await createTelnyxInbox(client, telnyx.id, localPart);
	}
	await verifyTelnyxDomain(client, telnyx.id).catch(() => undefined);
	if (skipped.length) throw new Error(`Telnyx cannot create inboxes for ${skipped.join(", ")}: its usernames allow only letters, digits, dots, hyphens and underscores.`);
}

export async function getTelnyxReceivingView(env: CloudflareEnv, domain: DomainRow, origin: string): Promise<TelnyxReceivingView> {
	const base = { dnsManaged: !isManualZone(domain.zoneId), mx: TELNYX_INBOUND_MX };
	const config = await getTelnyxConfig(env);
	const steps: ReceivingStep[] = [
		{ key: "key", label: "Telnyx API key", ok: config.configured },
		{ key: "publicKey", label: "Telnyx public key for webhook signatures", ok: config.publicKeyConfigured },
	];
	if (!config.apiKey) return { ...base, steps, ready: false, missingInboxes: [] };
	const client = telnyxClient(env, config.apiKey);
	const telnyx = await findTelnyxDomain(client, domain.hostname);
	steps.push({ key: "domain", label: "Inbound enabled for this domain", ok: isTelnyxInboundEnabled(telnyx), detail: telnyx ? undefined : "Domain is not in Telnyx yet" });
	const mxOk = await hasMx(env, domain, TELNYX_INBOUND_MX);
	steps.push({ key: "mx", label: "MX record points to Telnyx", ok: mxOk === true, detail: mxOk === null ? "Could not check DNS from here" : TELNYX_INBOUND_MX });
	steps.push({ key: "verified", label: "Domain verified", ok: telnyx?.status === "verified", detail: telnyx?.status });
	let missingInboxes: string[] = [];
	if (telnyx) {
		const hooks = await listTelnyxWebhooks(client, telnyx.id);
		steps.push({ key: "webhook", label: "Webhook delivering mail to Mailflare", ok: hooks.some((hook) => hook.url === telnyxWebhookUrl(origin) && hook.events.includes("email.received")) });
		const existing = new Set((await inboxesFor(client, domain, telnyx)).map((inbox) => inbox.address.toLowerCase()));
		missingInboxes = (await listDomainAddresses(env, domain)).filter((address) => !existing.has(address));
		steps.push({
			key: "inboxes",
			label: "A Telnyx inbox for every address",
			ok: missingInboxes.length === 0,
			detail: missingInboxes.length ? `Missing: ${missingInboxes.slice(0, 5).join(", ")}${missingInboxes.length > 5 ? ` and ${missingInboxes.length - 5} more` : ""}` : undefined,
		});
	} else {
		steps.push({ key: "webhook", label: "Webhook delivering mail to Mailflare", ok: false });
		steps.push({ key: "inboxes", label: "A Telnyx inbox for every address", ok: false });
	}
	return { ...base, steps, ready: steps.every((step) => step.ok), missingInboxes };
}

export async function hasTelnyxReceivingConfig(env: CloudflareEnv, domain: DomainRow): Promise<boolean | null> {
	const { apiKey } = await getTelnyxConfig(env);
	if (!apiKey) return null;
	try { return isTelnyxInboundEnabled(await findTelnyxDomain(telnyxClient(env, apiKey), domain.hostname)); }
	catch { return null; }
}

/** Removes the MX, webhook and inboxes; the domain goes too unless it still sends through Telnyx. */
export async function removeTelnyxReceiving(env: CloudflareEnv, domain: DomainRow): Promise<void> {
	const client = await getTelnyxClient(env);
	await removeMx(env, domain, isTelnyxInboundMx);
	const telnyx = await findTelnyxDomain(client, domain.hostname);
	if (!telnyx) return;
	for (const hook of await listTelnyxWebhooks(client, telnyx.id)) {
		if (hook.events.includes("email.received") && hook.url.endsWith("/api/inbound/telnyx")) await deleteTelnyxWebhook(client, telnyx.id, hook.id);
	}
	for (const inbox of await inboxesFor(client, domain, telnyx)) await deleteTelnyxInbox(client, inbox.id);
	if (domain.sendingProvider === "telnyx") {
		await setTelnyxInbound(client, telnyx.id, false);
		return;
	}
	await deleteRecords(env, domain, await listTelnyxDnsRecords(client, telnyx.id));
	await deleteTelnyxDomain(client, telnyx.id);
}

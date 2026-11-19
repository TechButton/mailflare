import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { appSettings } from "@/db/schema";
import { isMissingColumnError } from "@/lib/database-errors";
import { telnyxClient } from "@/lib/email/telnyx-api";
import type { TelnyxClient } from "@/lib/email/telnyx-api-types";

/**
 * One Telnyx account serves every domain. The API key sends and manages domains;
 * the public key verifies inbound webhooks. Each comes from the admin setting
 * (`app_settings.telnyx_config`), falling back to TELNYX_API_KEY and
 * TELNYX_PUBLIC_KEY so they can be provisioned outside the database.
 */
type StoredTelnyx = { apiKey?: string; publicKey?: string };

export type TelnyxConfigStatus = {
	configured: boolean;
	source: "settings" | "environment" | null;
	publicKeyConfigured: boolean;
	publicKeySource: "settings" | "environment" | null;
};

async function readStored(env: CloudflareEnv): Promise<StoredTelnyx | null> {
	try {
		const [row] = await getDb(env).select({ telnyxConfig: appSettings.telnyxConfig }).from(appSettings).where(eq(appSettings.id, "default")).limit(1);
		if (!row?.telnyxConfig) return null;
		return JSON.parse(row.telnyxConfig) as StoredTelnyx;
	} catch (error) {
		// Before the migration the column does not exist; the env vars still work.
		if (isMissingColumnError(error) || error instanceof SyntaxError) return null;
		throw error;
	}
}

const envValue = (env: CloudflareEnv, name: string) => (env as unknown as Record<string, string | undefined>)[name]?.trim() || null;

export async function getTelnyxConfig(env: CloudflareEnv): Promise<TelnyxConfigStatus & { apiKey: string | null; publicKey: string | null }> {
	const stored = await readStored(env);
	const savedKey = stored?.apiKey?.trim() || null;
	const savedPublic = stored?.publicKey?.trim() || null;
	const apiKey = savedKey ?? envValue(env, "TELNYX_API_KEY");
	const publicKey = savedPublic ?? envValue(env, "TELNYX_PUBLIC_KEY");
	return {
		configured: !!apiKey,
		source: savedKey ? "settings" : apiKey ? "environment" : null,
		publicKeyConfigured: !!publicKey,
		publicKeySource: savedPublic ? "settings" : publicKey ? "environment" : null,
		apiKey,
		publicKey,
	};
}

export async function getTelnyxClient(env: CloudflareEnv): Promise<TelnyxClient> {
	const { apiKey } = await getTelnyxConfig(env);
	if (!apiKey) throw new Error("Telnyx is selected but no API key is configured");
	return telnyxClient(env, apiKey);
}

/** Saves the fields given; `null` clears one, `undefined` keeps it. */
export async function saveTelnyxConfig(env: CloudflareEnv, update: { apiKey?: string | null; publicKey?: string | null }): Promise<void> {
	const current = (await readStored(env)) ?? {};
	const next: StoredTelnyx = { ...current };
	for (const field of ["apiKey", "publicKey"] as const) {
		if (update[field] === null) delete next[field];
		else if (update[field] !== undefined) next[field] = update[field]!;
	}
	const values = { telnyxConfig: Object.keys(next).length ? JSON.stringify(next) : null, updatedAt: new Date() };
	await getDb(env).insert(appSettings).values({ id: "default", ...values }).onConflictDoUpdate({ target: appSettings.id, set: values });
}

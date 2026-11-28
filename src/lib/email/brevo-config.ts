import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { appSettings } from "@/db/schema";
import { isMissingColumnError } from "@/lib/database-errors";
import { brevoClient } from "@/lib/email/brevo-api";
import type { BrevoClient, BrevoKeyStatus } from "@/lib/email/brevo-api-types";

/** One Brevo key serves every domain. A BREVO_API_KEY secret wins over the admin setting, as for Resend. */
async function readSaved(env: CloudflareEnv): Promise<string | null> {
	try {
		const [row] = await getDb(env).select({ brevoApiKey: appSettings.brevoApiKey }).from(appSettings).where(eq(appSettings.id, "default")).limit(1);
		return row?.brevoApiKey?.trim() || null;
	} catch (error) {
		// Before the migration the column does not exist; the env var still works.
		if (isMissingColumnError(error)) return null;
		throw error;
	}
}

export async function getBrevoKeyStatus(env: CloudflareEnv): Promise<BrevoKeyStatus & { apiKey: string | null }> {
	const fromEnv = (env as { BREVO_API_KEY?: string }).BREVO_API_KEY?.trim() || null;
	const apiKey = fromEnv ?? (await readSaved(env));
	return {
		configured: !!apiKey,
		source: fromEnv ? "environment" : apiKey ? "settings" : null,
		apiKey,
	};
}

export async function getBrevoClient(env: CloudflareEnv): Promise<BrevoClient> {
	const { apiKey } = await getBrevoKeyStatus(env);
	if (!apiKey) throw new Error("Brevo is selected but no API key is configured");
	return brevoClient(env, apiKey);
}

/** `null` removes the saved key. */
export async function saveBrevoKey(env: CloudflareEnv, apiKey: string | null): Promise<void> {
	const values = { brevoApiKey: apiKey, updatedAt: new Date() };
	await getDb(env).insert(appSettings).values({ id: "default", ...values }).onConflictDoUpdate({ target: appSettings.id, set: values });
}

import { z } from "zod";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { checkTelnyxKey, telnyxClient } from "@/lib/email/telnyx-api";
import { getTelnyxConfig, saveTelnyxConfig } from "@/lib/email/telnyx-config";
import { isTelnyxPublicKey } from "@/lib/email/telnyx-signature";

const schema = z.object({
	apiKey: z.string().trim().min(1).max(500).optional(),
	publicKey: z.string().trim().min(1).max(200).optional(),
}).refine((value) => value.apiKey !== undefined || value.publicKey !== undefined);

const removeSchema = z.object({ target: z.enum(["apiKey", "publicKey", "all"]).default("all") });

async function authorize(request: Request, mutation: boolean) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return { env, error: auth.error };
	if (!isPrimaryAdmin(auth.user)) return { env, error: Response.json({ error: "Only the primary administrator can manage the Telnyx keys" }, { status: 403 }) };
	if (mutation && !hasValidSessionMutationOrigin(request)) return { env, error: Response.json({ error: "Invalid origin" }, { status: 403 }) };
	return { env, error: null };
}

/** What is configured and where it comes from; the keys themselves never leave the server. */
async function status(env: CloudflareEnv) {
	const { configured, source, publicKeyConfigured, publicKeySource } = await getTelnyxConfig(env);
	return { configured, source, publicKeyConfigured, publicKeySource };
}

const noStore = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
	const access = await authorize(request, false);
	if (access.error) return access.error;
	return Response.json(await status(access.env), { headers: noStore });
}

/** Saves the API key (checked against Telnyx first), the webhook public key, or both. */
export async function PUT(request: Request) {
	const access = await authorize(request, true);
	if (access.error) return access.error;
	const parsed = schema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return Response.json({ error: "Enter a Telnyx API key or public key" }, { status: 400 });
	const { apiKey, publicKey } = parsed.data;
	if (publicKey !== undefined && !isTelnyxPublicKey(publicKey)) {
		return Response.json({ error: "That is not a Telnyx public key. Copy it from Keys & Credentials → Public Key in the Telnyx portal." }, { status: 400 });
	}
	if (apiKey !== undefined) {
		const valid = await checkTelnyxKey(telnyxClient(access.env, apiKey)).catch(() => null);
		if (valid === null) return Response.json({ error: "Could not reach Telnyx to check the key" }, { status: 502 });
		if (!valid) return Response.json({ error: "Telnyx rejected this API key" }, { status: 400 });
	}
	await saveTelnyxConfig(access.env, { apiKey, publicKey });
	return Response.json(await status(access.env), { headers: noStore });
}

export async function DELETE(request: Request) {
	const access = await authorize(request, true);
	if (access.error) return access.error;
	const parsed = removeSchema.safeParse(await request.json().catch(() => ({})));
	const target = parsed.success ? parsed.data.target : "all";
	await saveTelnyxConfig(access.env, {
		...(target !== "publicKey" ? { apiKey: null } : {}),
		...(target !== "apiKey" ? { publicKey: null } : {}),
	});
	return Response.json(await status(access.env), { headers: noStore });
}

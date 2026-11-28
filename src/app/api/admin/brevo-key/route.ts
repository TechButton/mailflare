import { z } from "zod";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { brevoClient, checkBrevoKey } from "@/lib/email/brevo-api";
import { getBrevoKeyStatus, saveBrevoKey } from "@/lib/email/brevo-config";

const schema = z.object({ apiKey: z.string().trim().min(1).max(500) });
const noStore = { "Cache-Control": "no-store" };

async function authorize(request: Request, mutation: boolean) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return { env, error: auth.error };
	if (!isPrimaryAdmin(auth.user)) return { env, error: Response.json({ error: "Only the primary administrator can manage the Brevo API key" }, { status: 403 }) };
	if (mutation && !hasValidSessionMutationOrigin(request)) return { env, error: Response.json({ error: "Invalid origin" }, { status: 403 }) };
	return { env, error: null };
}

/** What is configured and where it comes from; the key itself never leaves the server. */
async function status(env: CloudflareEnv) {
	const { configured, source } = await getBrevoKeyStatus(env);
	return { configured, source };
}

export async function GET(request: Request) {
	const access = await authorize(request, false);
	if (access.error) return access.error;
	return Response.json(await status(access.env), { headers: noStore });
}

export async function PUT(request: Request) {
	const access = await authorize(request, true);
	if (access.error) return access.error;
	const parsed = schema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return Response.json({ error: "Enter a Brevo API key" }, { status: 400 });
	if ((await getBrevoKeyStatus(access.env)).source === "environment") {
		return Response.json({ error: "The Brevo API key is set by BREVO_API_KEY" }, { status: 409 });
	}
	const valid = await checkBrevoKey(brevoClient(access.env, parsed.data.apiKey)).catch(() => null);
	if (valid === null) return Response.json({ error: "Could not reach Brevo to check the key" }, { status: 502 });
	if (!valid) return Response.json({ error: "Brevo rejected this API key" }, { status: 400 });
	await saveBrevoKey(access.env, parsed.data.apiKey);
	return Response.json(await status(access.env), { headers: noStore });
}

export async function DELETE(request: Request) {
	const access = await authorize(request, true);
	if (access.error) return access.error;
	await saveBrevoKey(access.env, null);
	return Response.json(await status(access.env), { headers: noStore });
}

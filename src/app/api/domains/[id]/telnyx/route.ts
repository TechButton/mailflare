import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { requireUser } from "@/lib/auth/cookies";
import { canManageDomains } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getDomainForUser } from "@/lib/domains/service";
import { getTelnyxConfig } from "@/lib/email/telnyx-config";
import { sendSystemEmail } from "@/lib/email/system-mail";
import { getTelnyxDomainView, setupTelnyxDomain, verifyTelnyxDomainView } from "@/lib/domains/telnyx-domain";

type Params = { params: Promise<{ id: string }> };
const noStore = { "Cache-Control": "no-store" };

/** Telnyx sending status for the domain: whether a key exists, and the domain's records and verification. */
export async function GET(request: Request, { params }: Params) {
	const { id } = await params;
	const env = getEnv();
	const user = await requireUser(env, request);
	const domain = await getDomainForUser(env, user.id, id);
	if (!domain) return NextResponse.json({ error: "Not found" }, { status: 404 });
	if (domain.sendingProvider !== "telnyx") return NextResponse.json({ error: "Telnyx is not selected for this domain" }, { status: 400 });
	const config = await getTelnyxConfig(env);
	if (!config.configured) return NextResponse.json({ keyConfigured: false, telnyx: null }, { headers: noStore });
	try {
		return NextResponse.json({ keyConfigured: true, telnyx: await getTelnyxDomainView(env, domain) }, { headers: noStore });
	} catch (error) {
		return NextResponse.json({ keyConfigured: true, error: error instanceof Error ? error.message : "Could not reach Telnyx" }, { status: 502 });
	}
}

export async function POST(request: Request, { params }: Params) {
	const { id } = await params;
	const env = getEnv();
	const user = await requireUser(env, request);
	if (!canManageDomains(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const domain = await getDomainForUser(env, user.id, id);
	if (!domain) return NextResponse.json({ error: "Not found" }, { status: 404 });
	const body = (await request.json().catch(() => ({}))) as { action?: string };
	if (body.action !== "setup" && body.action !== "verify" && body.action !== "test") return NextResponse.json({ error: "Unknown action" }, { status: 400 });
	try {
		if (body.action === "test") {
			const sent = await sendSystemEmail(env, {
				to: user.email,
				subject: "Mailflare test email",
				text: `This message confirms ${domain.hostname} can send mail through Telnyx.`,
				hostname: domain.hostname,
			});
			if (!sent) return NextResponse.json({ error: `Create a mailbox on ${domain.hostname} to send the test from.` }, { status: 400 });
			return NextResponse.json({ ok: true, to: user.email });
		}
		const telnyx = body.action === "setup" ? await setupTelnyxDomain(env, domain) : await verifyTelnyxDomainView(env, domain);
		return NextResponse.json({ telnyx }, { headers: noStore });
	} catch (error) {
		return NextResponse.json({ error: error instanceof Error ? error.message : "Telnyx request failed" }, { status: 502 });
	}
}

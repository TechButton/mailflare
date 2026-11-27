import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { getEmailAddress } from "@/lib/email/address";
import { telnyxClient } from "@/lib/email/telnyx-api";
import { getTelnyxConfig } from "@/lib/email/telnyx-config";
import { resolveTelnyxInboundMessage, TelnyxMessageTooLargeError, telnyxMessageToMime, telnyxRecipients, type TelnyxWebhookEvent } from "@/lib/email/telnyx-inbound";
import { telnyxAddressList } from "@/lib/email/telnyx-mime-utils";
import { verifyTelnyxSignature } from "@/lib/email/telnyx-signature";
import { intakeProviderMail } from "@/lib/email/provider-intake";

export const dynamic = "force-dynamic";

/**
 * Telnyx's `email.received` webhook. Authenticated by the Ed25519 signature
 * over `timestamp|body` with the account's public key, within five minutes.
 * Telnyx gives parsed fields rather than raw MIME, so the message is rebuilt
 * and run through the normal intake. Non-2xx answers make Telnyx retry.
 */
export async function POST(request: Request) {
	const env = getEnv();
	const config = await getTelnyxConfig(env);
	if (!config.publicKey || !config.apiKey) return NextResponse.json({ error: "Telnyx receiving is not set up" }, { status: 503 });
	const body = await request.text();
	const valid = await verifyTelnyxSignature(config.publicKey, {
		signature: request.headers.get("telnyx-signature-ed25519"),
		timestamp: request.headers.get("telnyx-timestamp"),
	}, body);
	if (!valid) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });

	let event: TelnyxWebhookEvent;
	try { event = JSON.parse(body) as TelnyxWebhookEvent; } catch { return NextResponse.json({ error: "Invalid body" }, { status: 400 }); }
	if (event.data?.event_type !== "email.received") return NextResponse.json({ ignored: true });

	const client = telnyxClient(env, config.apiKey);
	const message = await resolveTelnyxInboundMessage(client, event);
	const from = telnyxAddressList(message.from ?? null)[0];
	if (!from) return NextResponse.json({ error: "Message has no sender" }, { status: 400 });
	let raw: ArrayBuffer;
	try { raw = await telnyxMessageToMime(client, message); }
	catch (error) {
		// Retrying cannot make it smaller: accept the event and drop the message, as for other providers.
		if (error instanceof TelnyxMessageTooLargeError) return NextResponse.json({ delivered: 0, dropped: error.message });
		throw error;
	}
	const result = await intakeProviderMail(env, {
		from: getEmailAddress(from),
		recipients: telnyxRecipients(message as typeof message & Record<string, unknown>),
		raw,
		// Telnyx reports no authentication verdicts; spam scoring then trusts none.
		verdicts: {},
	});
	return NextResponse.json(result);
}

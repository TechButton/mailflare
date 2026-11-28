import { getEmailAddress, parseEmailAddressParts } from "@/lib/email/address";
import { TelnyxApiError, telnyxRequest } from "@/lib/email/telnyx-api";
import type { TelnyxClient } from "@/lib/email/telnyx-api-types";
import type { OutboundProviderMessage } from "@/lib/email/outbound-provider-types";

/** Headers the Telnyx payload carries as fields, or that describe the MIME Telnyx builds. */
const FIELD_HEADERS = new Set(["from", "to", "cc", "bcc", "subject", "reply-to", "content-type", "mime-version", "content-transfer-encoding"]);
/** Threading headers: sent when Telnyx accepts them, dropped on a retry when it does not. */
const THREADING_HEADERS = new Set(["message-id", "in-reply-to", "references"]);

function toBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	return btoa(binary);
}

/** Telnyx returns its own UUID, never an RFC 5322 Message-ID, so we mint one for replies to thread against. */
export function mintTelnyxMessageId(from: string): string {
	const domain = getEmailAddress(from).split("@")[1] || "mailflare.local";
	return `<${crypto.randomUUID()}@${domain}>`;
}

/** Idempotency keys are 1-255 of [A-Za-z0-9_-]. */
export function telnyxIdempotencyKey(value: string | undefined): string | null {
	const cleaned = value?.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 255);
	return cleaned ? cleaned : null;
}

/** Telnyx rejects RFC 5322 `Name <addr>` strings: send a bare address, or `{ email, name }` when there is a display name. */
function toTelnyxAddress(value: string): string | { email: string; name: string } {
	const { name, address } = parseEmailAddressParts(value);
	return name ? { email: address, name } : address;
}

export function telnyxPayload(message: OutboundProviderMessage, messageId: string, options: { threadingHeaders: boolean }) {
	const headers: Record<string, string> = {};
	let replyTo: string | null = null;
	for (const [name, value] of Object.entries(message.headers ?? {})) {
		const key = name.toLowerCase();
		if (key === "reply-to") { replyTo = value; continue; }
		if (FIELD_HEADERS.has(key) || key === "message-id") continue;
		if (THREADING_HEADERS.has(key) && !options.threadingHeaders) continue;
		headers[name] = value;
	}
	if (options.threadingHeaders) headers["Message-ID"] = messageId;
	return {
		from: toTelnyxAddress(message.from),
		to: message.to.map(toTelnyxAddress),
		...(message.cc?.length ? { cc: message.cc.map(toTelnyxAddress) } : {}),
		...(message.bcc?.length ? { bcc: message.bcc.map(toTelnyxAddress) } : {}),
		...(replyTo ? { reply_to: toTelnyxAddress(replyTo) } : {}),
		subject: message.subject,
		...(message.html ? { html_body: message.html } : {}),
		...(message.text ? { text_body: message.text } : {}),
		...(Object.keys(headers).length ? { headers } : {}),
		...(message.attachments?.length ? {
			attachments: message.attachments.map((attachment) => ({
				filename: attachment.filename,
				content_type: attachment.type,
				content: toBase64(attachment.content),
				disposition: attachment.disposition,
				...(attachment.disposition === "inline" && attachment.contentId ? { content_id: attachment.contentId.replace(/^<|>$/g, "") } : {}),
			})),
		} : {}),
	};
}

/** A 400/422 naming a header: Telnyx refused a custom header we chose to send. */
const isHeaderRejection = (error: unknown) =>
	error instanceof TelnyxApiError && (error.status === 400 || error.status === 422) && /header/i.test(error.message);

/**
 * Sends through `POST /v2/email_messages`. The minted Message-ID and the
 * reply's In-Reply-To/References ride as custom headers; if Telnyx refuses
 * them, the send is retried once without, so delivery never depends on threading.
 */
export async function sendWithTelnyx(client: TelnyxClient, message: OutboundProviderMessage, idempotencyKey?: string): Promise<{ messageId: string }> {
	const messageId = message.headers?.["Message-ID"] ?? mintTelnyxMessageId(message.from);
	const key = telnyxIdempotencyKey(idempotencyKey);
	const send = (threadingHeaders: boolean, keySuffix: string) => telnyxRequest<{ data?: { id?: string } }>(client, "/email_messages", {
		method: "POST",
		body: telnyxPayload(message, messageId, { threadingHeaders }),
		headers: key ? { "Idempotency-Key": `${key}${keySuffix}`.slice(0, 255) } : undefined,
	});
	try {
		await send(true, "");
	} catch (error) {
		if (!isHeaderRejection(error)) throw error;
		console.warn("Telnyx refused threading headers; sending without them", error);
		await send(false, "-nh");
	}
	return { messageId };
}

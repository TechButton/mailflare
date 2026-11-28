import { parseEmailAddressParts } from "@/lib/email/address";
import { BrevoApiError, brevoRequest } from "@/lib/email/brevo-api";
import type { BrevoClient } from "@/lib/email/brevo-api-types";
import type { OutboundProviderMessage } from "@/lib/email/outbound-provider-types";

/** Headers carried as payload fields, or that Brevo writes itself (it assigns the Message-ID). */
const OWN_HEADERS = new Set(["from", "to", "cc", "bcc", "subject", "reply-to", "message-id", "content-type", "mime-version", "content-transfer-encoding"]);
/** Brevo limits display names to 70 characters. */
const MAX_NAME_LENGTH = 70;

function toBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	return btoa(binary);
}

function brevoAddress(value: string) {
	const { address, name } = parseEmailAddressParts(value);
	return name ? { email: address, name: name.slice(0, MAX_NAME_LENGTH) } : { email: address };
}

export function brevoPayload(message: OutboundProviderMessage, options: { customHeaders: boolean }) {
	const headers: Record<string, string> = {};
	let replyTo: string | null = null;
	for (const [name, value] of Object.entries(message.headers ?? {})) {
		const key = name.toLowerCase();
		if (key === "reply-to") replyTo = value;
		else if (options.customHeaders && !OWN_HEADERS.has(key)) headers[name] = value;
	}
	return {
		sender: brevoAddress(message.from),
		to: message.to.map(brevoAddress),
		...(message.cc?.length ? { cc: message.cc.map(brevoAddress) } : {}),
		...(message.bcc?.length ? { bcc: message.bcc.map(brevoAddress) } : {}),
		...(replyTo ? { replyTo: brevoAddress(replyTo) } : {}),
		subject: message.subject,
		...(message.html ? { htmlContent: message.html } : {}),
		...(message.text ? { textContent: message.text } : {}),
		...(Object.keys(headers).length ? { headers } : {}),
		// Brevo documents no Content-ID field, so inline files go as ordinary attachments.
		...(message.attachments?.length ? { attachment: message.attachments.map((attachment) => ({ name: attachment.filename, content: toBase64(attachment.content) })) } : {}),
	};
}

/** A 400 naming a header: Brevo refused one we chose to send. */
const isHeaderRejection = (error: unknown) => error instanceof BrevoApiError && error.status === 400 && /header/i.test(error.message);

/**
 * Sends through `POST /smtp/email`. Brevo says standard headers are not supported
 * without saying whether In-Reply-To/References count, so if it refuses a header
 * the send is retried once without any. The returned messageId is Brevo's.
 */
export async function sendWithBrevo(client: BrevoClient, message: OutboundProviderMessage): Promise<{ messageId: string }> {
	const send = (customHeaders: boolean) => brevoRequest<{ messageId?: string } | null>(client, "/smtp/email", {
		method: "POST",
		body: brevoPayload(message, { customHeaders }),
	});
	let result: { messageId?: string } | null;
	try {
		result = await send(true);
	} catch (error) {
		if (!isHeaderRejection(error)) throw error;
		console.warn("Brevo refused the message headers; sending without them", error);
		result = await send(false);
	}
	if (result?.messageId) return { messageId: result.messageId };
	// Accepted without an ID: mint one so the sent copy can still be stored and threaded.
	const domain = parseEmailAddressParts(message.from).address.split("@")[1] || "mailflare.local";
	return { messageId: `<${crypto.randomUUID()}@${domain}>` };
}

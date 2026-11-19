import { fetchTelnyxContent, getTelnyxInboundMessage } from "@/lib/email/telnyx-api";
import { buildTelnyxMime, telnyxAddressList } from "@/lib/email/telnyx-mime-utils";
import { MAX_PROVIDER_MESSAGE_BYTES } from "@/lib/email/provider-intake";
import type { TelnyxClient, TelnyxInboundAttachment, TelnyxInboundMessage, TelnyxMimeAttachment } from "@/lib/email/telnyx-api-types";

export type TelnyxWebhookEvent = {
	data?: { event_type?: string; canonical_event_type?: string; id?: string; payload?: Record<string, unknown> };
};

const hasContent = (message: TelnyxInboundMessage) =>
	!!message.from && ["text_body", "html_body", "text_body_url", "html_body_url"].some((field) => typeof (message as Record<string, unknown>)[field] === "string");

const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

/**
 * The inbound message an `email.received` event names. The payload's exact
 * shape is undocumented, so use it directly when it already carries the
 * sender and a body, and otherwise fetch the message by id.
 */
export async function resolveTelnyxInboundMessage(client: TelnyxClient, event: TelnyxWebhookEvent): Promise<TelnyxInboundMessage> {
	const payload = (event.data?.payload ?? {}) as TelnyxInboundMessage & Record<string, unknown>;
	if (hasContent(payload)) return payload;
	const id = str(payload.id) ?? str(payload.email_id) ?? str(payload.email_message_id) ?? str(payload.message_uuid);
	if (!id) throw new Error("The Telnyx event names no message");
	const fetched = await getTelnyxInboundMessage(client, id, str(payload.inbox_id));
	// Fields only the event carries (the inbox address, say) still count.
	return { ...payload, ...fetched };
}

async function readBody(client: TelnyxClient, inline: string | null | undefined, url: string | null | undefined): Promise<string | null> {
	if (typeof inline === "string") return inline;
	if (!url) return null;
	return (await fetchTelnyxContent(client, url)).text();
}

function decodeBase64(value: string): Uint8Array {
	const binary = atob(value.replace(/\s+/g, ""));
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

async function readAttachment(client: TelnyxClient, attachment: TelnyxInboundAttachment, inlineList: boolean): Promise<TelnyxMimeAttachment | null> {
	const url = attachment.url ?? attachment.download_url;
	let content: Uint8Array | null = null;
	if (typeof attachment.content === "string" && attachment.content) content = decodeBase64(attachment.content);
	else if (url) content = new Uint8Array(await (await fetchTelnyxContent(client, url)).arrayBuffer());
	if (!content) return null;
	return {
		filename: attachment.filename ?? "attachment",
		contentType: attachment.content_type ?? "application/octet-stream",
		content,
		inline: inlineList || attachment.disposition === "inline",
		contentId: attachment.content_id ?? null,
	};
}

/** Rebuilds the message as raw MIME, downloading its bodies and attachments. Throws past the receiving size limit. */
export async function telnyxMessageToMime(client: TelnyxClient, message: TelnyxInboundMessage): Promise<ArrayBuffer> {
	const [text, html] = await Promise.all([
		readBody(client, message.text_body, message.text_body_url),
		readBody(client, message.html_body, message.html_body_url),
	]);
	const attachments: TelnyxMimeAttachment[] = [];
	let total = (text?.length ?? 0) + (html?.length ?? 0);
	const listed = [
		...(message.attachments ?? []).map((attachment) => ({ attachment, inline: false })),
		...(message.inline_files ?? []).map((attachment) => ({ attachment, inline: true })),
	];
	for (const { attachment, inline } of listed) {
		if (typeof attachment.size_bytes === "number" && total + attachment.size_bytes > MAX_PROVIDER_MESSAGE_BYTES) throw new TelnyxMessageTooLargeError();
		const read = await readAttachment(client, attachment, inline);
		if (!read) continue;
		total += read.content.byteLength;
		if (total > MAX_PROVIDER_MESSAGE_BYTES) throw new TelnyxMessageTooLargeError();
		attachments.push(read);
	}
	return new TextEncoder().encode(buildTelnyxMime(message, { text, html, attachments })).buffer as ArrayBuffer;
}

export class TelnyxMessageTooLargeError extends Error {
	constructor() { super("Message exceeds the 25 MiB receiving limit"); }
}

/** Everyone the message was addressed to, plus the inbox address when the event names one (BCC is redacted). */
export function telnyxRecipients(message: TelnyxInboundMessage & Record<string, unknown>): string[] {
	const extra = ["recipient", "inbox_address", "address"].map((field) => str(message[field])).filter((value): value is string => !!value);
	const inbox = message.inbox as { address?: unknown } | undefined;
	if (inbox && str(inbox.address)) extra.push(str(inbox.address)!);
	return [...telnyxAddressList(message.to), ...telnyxAddressList(message.cc), ...telnyxAddressList(message.bcc), ...extra]
		.filter((address) => address.includes("@"));
}

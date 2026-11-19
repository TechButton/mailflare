import type { TelnyxAddress, TelnyxInboundMessage, TelnyxMimeAttachment } from "@/lib/email/telnyx-api-types";

/**
 * Telnyx hands inbound mail over as parsed fields, not raw MIME. These helpers
 * rebuild a standards-shaped message from them so it can enter the same intake
 * as every other provider. Headers that only the receiving side may assert
 * (authentication results, SES traces) are dropped: they would come from the
 * sender, and spam scoring must not trust them.
 */

/** Headers rebuilt from structured fields, or describing the body we write ourselves. */
const REBUILT = new Set([
	"from", "to", "cc", "bcc", "reply-to", "subject", "date", "message-id", "in-reply-to", "references",
	"mime-version", "content-type", "content-transfer-encoding", "content-disposition", "content-id",
]);

const UNTRUSTED = (name: string) =>
	name === "authentication-results" || name === "arc-authentication-results" || name === "received-spf" || name.startsWith("x-ses-")
	|| name === "x-mailflare-forwarded";

const HEADER_NAME = /^[!-9;-~]+$/;

function encodeWord(value: string): string {
	if (/^[\x20-\x7e]*$/.test(value)) return value;
	const bytes = new TextEncoder().encode(value);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return `=?UTF-8?B?${btoa(binary)}?=`;
}

const clean = (value: string) => value.replace(/[\r\n]+/g, " ").trim();

function addressOf(value: TelnyxAddress | null | undefined): { email: string; name: string } | null {
	if (!value) return null;
	if (typeof value === "string") {
		const match = /^(.*)<([^<>]+)>\s*$/.exec(value);
		return match ? { email: clean(match[2]), name: clean(match[1]).replace(/^"|"$/g, "") } : { email: clean(value), name: "" };
	}
	const email = value.email ? clean(value.email) : "";
	return email ? { email, name: value.name ? clean(value.name) : "" } : null;
}

export function telnyxAddressList(value: TelnyxAddress[] | TelnyxAddress | null | undefined): string[] {
	const list = Array.isArray(value) ? value : value ? [value] : [];
	return list.map(addressOf).filter((entry): entry is { email: string; name: string } => !!entry?.email).map((entry) => entry.email);
}

function formatAddress(entry: { email: string; name: string }): string {
	if (!entry.name) return entry.email;
	const name = encodeWord(entry.name);
	return name === entry.name ? `"${entry.name.replace(/(["\\])/g, "\\$1")}" <${entry.email}>` : `${name} <${entry.email}>`;
}

function formatList(value: TelnyxAddress[] | TelnyxAddress | null | undefined): string | null {
	const list = (Array.isArray(value) ? value : value ? [value] : []).map(addressOf).filter((entry): entry is { email: string; name: string } => !!entry?.email);
	return list.length ? list.map(formatAddress).join(", ") : null;
}

const angle = (value: string) => {
	const trimmed = clean(value);
	return trimmed.startsWith("<") ? trimmed : `<${trimmed}>`;
};

/** The message's original headers as name/value pairs, whatever shape Telnyx used. */
export function telnyxHeaderPairs(headers: TelnyxInboundMessage["headers"]): [string, string][] {
	if (!headers) return [];
	const pairs: [string, string][] = [];
	if (Array.isArray(headers)) {
		for (const entry of headers) if (entry && typeof entry.name === "string" && typeof entry.value === "string") pairs.push([entry.name, entry.value]);
		return pairs;
	}
	for (const [name, value] of Object.entries(headers)) {
		for (const item of Array.isArray(value) ? value : [value]) {
			if (typeof item === "string" || typeof item === "number") pairs.push([name, String(item)]);
		}
	}
	return pairs;
}

function headerValue(pairs: [string, string][], name: string): string | null {
	return pairs.find(([key]) => key.toLowerCase() === name)?.[1] ?? null;
}

function base64Lines(bytes: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	return (btoa(binary).match(/.{1,76}/g) ?? []).join("\r\n");
}

const utf8Part = (contentType: string, text: string) =>
	`Content-Type: ${contentType}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Lines(new TextEncoder().encode(text))}\r\n`;

const quoteParam = (value: string) => `"${clean(value).replace(/(["\\])/g, "\\$1")}"`;

function attachmentPart(attachment: TelnyxMimeAttachment): string {
	const type = /^[\w.+-]+\/[\w.+-]+$/.test(attachment.contentType) ? attachment.contentType : "application/octet-stream";
	const filename = encodeWord(clean(attachment.filename) || "attachment");
	const lines = [
		`Content-Type: ${type}; name=${quoteParam(filename)}`,
		"Content-Transfer-Encoding: base64",
		`Content-Disposition: ${attachment.inline ? "inline" : "attachment"}; filename=${quoteParam(filename)}`,
	];
	if (attachment.contentId) lines.push(`Content-ID: ${angle(attachment.contentId)}`);
	return `${lines.join("\r\n")}\r\n\r\n${base64Lines(attachment.content)}\r\n`;
}

function multipart(subtype: string, parts: string[], boundary: string): string {
	return `Content-Type: multipart/${subtype}; boundary="${boundary}"\r\n\r\n${parts.map((part) => `--${boundary}\r\n${part}`).join("")}--${boundary}--\r\n`;
}

/**
 * Rebuilds RFC 5322 MIME from a Telnyx inbound message. `boundarySeed` makes
 * the output deterministic for tests.
 */
export function buildTelnyxMime(
	message: TelnyxInboundMessage,
	content: { text: string | null; html: string | null; attachments: TelnyxMimeAttachment[] },
	boundarySeed: string = crypto.randomUUID().replace(/-/g, ""),
): string {
	const original = telnyxHeaderPairs(message.headers);
	const headers: string[] = [];
	const push = (name: string, value: string | null | undefined) => { if (value) headers.push(`${name}: ${value}`); };

	push("From", formatList(message.from ?? null) ?? (headerValue(original, "from") ? clean(headerValue(original, "from")!) : null));
	push("To", formatList(message.to) ?? (headerValue(original, "to") ? clean(headerValue(original, "to")!) : null));
	push("Cc", formatList(message.cc));
	push("Reply-To", formatList(message.reply_to));
	const subject = message.subject ?? headerValue(original, "subject");
	push("Subject", subject === null || subject === undefined ? null : encodeWord(clean(subject)));
	const dateHeader = headerValue(original, "date");
	const received = message.received_at ?? message.created_at;
	const parsedDate = received ? new Date(received) : null;
	push("Date", dateHeader ? clean(dateHeader) : parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toUTCString() : new Date().toUTCString());
	const messageId = message.message_id ?? headerValue(original, "message-id");
	push("Message-ID", messageId ? angle(messageId) : null);
	const inReplyTo = message.in_reply_to ?? headerValue(original, "in-reply-to");
	push("In-Reply-To", inReplyTo ? angle(inReplyTo) : null);
	const references = Array.isArray(message.references)
		? message.references
		: typeof message.references === "string" ? message.references.split(/\s+/) : (headerValue(original, "references") ?? "").split(/\s+/);
	const referenceList = references.map((value) => value.trim()).filter(Boolean).map(angle);
	push("References", referenceList.length ? referenceList.join(" ") : null);

	for (const [name, value] of original) {
		const key = name.toLowerCase();
		if (REBUILT.has(key) || UNTRUSTED(key) || !HEADER_NAME.test(name)) continue;
		push(name, encodeWord(clean(value)));
	}
	headers.push("MIME-Version: 1.0");

	const text = content.text;
	const html = content.html;
	let body: string;
	if (text !== null && html !== null) body = multipart("alternative", [utf8Part("text/plain", text), utf8Part("text/html", html)], `alt_${boundarySeed}`);
	else if (html !== null) body = utf8Part("text/html", html);
	else body = utf8Part("text/plain", text ?? "");

	if (content.attachments.length) {
		body = multipart("mixed", [body, ...content.attachments.map(attachmentPart)], `mix_${boundarySeed}`);
	}
	return `${headers.join("\r\n")}\r\n${body}`;
}

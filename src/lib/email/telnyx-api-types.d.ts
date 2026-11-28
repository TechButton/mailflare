/** Telnyx Email API client: where calls go and the key they carry. */
export type TelnyxClient = { apiKey: string; baseUrl: string };

export type TelnyxDomainStatus = "pending" | "verified" | "failed" | "degraded" | "suspended";

export type TelnyxDomain = {
	id: string;
	domain: string;
	status: TelnyxDomainStatus | string;
	inbound_enabled?: boolean;
	inbound?: { enabled?: boolean; catch_all?: boolean; mx_required?: boolean } | null;
	usable_for_inbound?: boolean;
	usable_for_sending?: boolean;
	type?: string;
};

export type TelnyxDnsRecord = {
	host: string;
	value: string;
	record_type: "TXT" | "MX" | "CNAME" | string;
	priority?: number | null;
	required?: boolean;
	status?: string;
	actual_value?: string | null;
};

export type TelnyxWebhook = { id: string; url: string; events: string[]; domain_id?: string };

export type TelnyxInbox = { id: string; address: string; domain_id?: string | null; status?: string };

/** An address as Telnyx returns it: a bare string or `{ email, name }`. */
export type TelnyxAddress = string | { email?: string | null; name?: string | null };

export type TelnyxInboundAttachment = {
	filename?: string | null;
	content_type?: string | null;
	disposition?: string | null;
	content_id?: string | null;
	/** Base64, when Telnyx inlines the bytes. */
	content?: string | null;
	url?: string | null;
	download_url?: string | null;
	size_bytes?: number | null;
};

/**
 * The inbound message object (`InboundMessage`). Telnyx gives no raw MIME, so
 * Mailflare rebuilds a message from these fields; every field is optional
 * because the webhook payload is not fully documented.
 */
export type TelnyxInboundMessage = {
	id?: string;
	inbox_id?: string | null;
	message_id?: string | null;
	in_reply_to?: string | null;
	references?: string[] | string | null;
	from?: TelnyxAddress | null;
	to?: TelnyxAddress[] | TelnyxAddress | null;
	cc?: TelnyxAddress[] | TelnyxAddress | null;
	bcc?: TelnyxAddress[] | TelnyxAddress | null;
	reply_to?: TelnyxAddress[] | TelnyxAddress | null;
	subject?: string | null;
	text_body?: string | null;
	html_body?: string | null;
	text_body_url?: string | null;
	html_body_url?: string | null;
	headers?: Record<string, unknown> | { name: string; value: string }[] | null;
	attachments?: TelnyxInboundAttachment[] | null;
	inline_files?: TelnyxInboundAttachment[] | null;
	received_at?: string | null;
	created_at?: string | null;
};

export type TelnyxMimeAttachment = {
	filename: string;
	contentType: string;
	content: Uint8Array;
	inline: boolean;
	contentId: string | null;
};

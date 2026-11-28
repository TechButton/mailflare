/** Brevo API client: where calls go and the key they carry. */
export type BrevoClient = { apiKey: string; baseUrl: string };

export type BrevoDnsRecord = { type: string; host_name: string; value: string; status?: boolean };

/** `GET /senders/domains/{name}`. Record keys vary (brevo_code, dkim_record, dmarc_record, ...), so they are read generically. */
export type BrevoDomain = {
	domain?: string;
	verified?: boolean;
	authenticated?: boolean;
	dns_records?: Record<string, BrevoDnsRecord | null | undefined>;
};

export type BrevoKeyStatus = { configured: boolean; source: "settings" | "environment" | null };

import type { ReceivingStep } from "@/lib/aws/ses-receiving-types";

export type TelnyxDomainView = {
	registered: boolean;
	/** Telnyx's status (verified, pending, failed, degraded, suspended) or "not_registered". */
	status: string;
	records: {
		type: string;
		/** Absolute DNS name. */
		name: string;
		value: string;
		priority: number | null;
		/** Telnyx marks SPF and DMARC as recommended rather than required. */
		required: boolean;
		/** Telnyx's record status, or "existing_policy" when the zone already has its own SPF/DMARC there. */
		status: string;
	}[];
	/** Mailflare can write the records to the Cloudflare zone itself. */
	dnsManaged: boolean;
	/** Required records absent from the zone; null when DNS is manual or unchecked. */
	missingDns: number | null;
};

export type TelnyxReceivingView = {
	steps: ReceivingStep[];
	ready: boolean;
	mx: string;
	dnsManaged: boolean;
	/** Mailflare addresses on this domain with no Telnyx inbox yet. */
	missingInboxes: string[];
};

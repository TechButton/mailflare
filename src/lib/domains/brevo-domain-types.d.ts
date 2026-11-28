export type BrevoDomainView = {
	registered: boolean;
	status: "verified" | "pending" | "not_registered";
	records: {
		type: string;
		/** Absolute DNS name. */
		name: string;
		value: string;
		/** "verified", "pending", or "existing_policy" when the zone already has its own DMARC there. */
		status: string;
	}[];
	/** Mailflare can write the records to the Cloudflare zone itself. */
	dnsManaged: boolean;
	/** Records absent from the zone; null when DNS is manual or unchecked. */
	missingDns: number | null;
};

export const normalizeDnsValue = (value: string) => value.replace(/^"|"$/g, "").trim().toLowerCase().replace(/\.$/, "");

/** Telnyx names records absolutely or relative to the domain; Cloudflare needs them absolute. */
export function absoluteTelnyxName(host: string, hostname: string): string {
	const name = normalizeDnsValue(host);
	if (!name || name === "@") return hostname;
	return name === hostname || name.endsWith(`.${hostname}`) ? name : `${name}.${hostname}`;
}

/** SPF and DMARC allow one record per name; a second one breaks both. */
export function policyKind(value: string): "spf" | "dmarc" | null {
	const lower = normalizeDnsValue(value);
	return lower.startsWith("v=spf1") ? "spf" : lower.startsWith("v=dmarc1") ? "dmarc" : null;
}

/** Telnyx usernames: 1-64 of letters, digits, dot, hyphen, underscore, starting and ending alphanumeric. */
export const isTelnyxUsername = (localPart: string) => /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(localPart);

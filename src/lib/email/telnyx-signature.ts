/** Telnyx rejects nothing itself; we refuse webhooks signed further than this from our clock. */
export const TELNYX_SIGNATURE_TOLERANCE_SECONDS = 300;

function decodeBase64(value: string): Uint8Array<ArrayBuffer> | null {
	try {
		const binary = atob(value.trim());
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
		return bytes;
	} catch { return null; }
}

/**
 * Verifies a Telnyx webhook: an Ed25519 signature (`telnyx-signature-ed25519`,
 * base64) over `${telnyx-timestamp}|${raw body}`, checked with the account's
 * public key from the Mission Control Portal (base64, 32 bytes). The body must
 * be the exact bytes received, never re-serialized JSON.
 */
export async function verifyTelnyxSignature(
	publicKey: string,
	headers: { signature: string | null; timestamp: string | null },
	body: string,
	nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
	if (!headers.signature || !headers.timestamp || !/^\d+$/.test(headers.timestamp.trim())) return false;
	const timestamp = Number(headers.timestamp.trim());
	if (Math.abs(nowSeconds - timestamp) > TELNYX_SIGNATURE_TOLERANCE_SECONDS) return false;
	const key = decodeBase64(publicKey);
	const signature = decodeBase64(headers.signature);
	if (!key || key.length !== 32 || !signature || signature.length !== 64) return false;
	try {
		const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "Ed25519" }, false, ["verify"]);
		const signed = new TextEncoder().encode(`${headers.timestamp.trim()}|${body}`);
		return await crypto.subtle.verify({ name: "Ed25519" }, cryptoKey, signature, signed);
	} catch { return false; }
}

/** Whether a pasted value looks like a Telnyx public key (base64 of 32 bytes). */
export function isTelnyxPublicKey(value: string): boolean {
	return decodeBase64(value)?.length === 32;
}

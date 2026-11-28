import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after, afterEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import PostalMime from "postal-mime";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-telnyx-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

async function bundle(entry, outfile) {
	await build({
		entryPoints: [join(root, entry)],
		outfile: join(outDir, outfile),
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		logLevel: "silent",
		alias: { "@": join(root, "src") },
	});
	return import(pathToFileURL(join(outDir, outfile)).href);
}

const signature = await bundle("src/lib/email/telnyx-signature.ts", "signature.mjs");
const mime = await bundle("src/lib/email/telnyx-mime-utils.ts", "mime.mjs");
const send = await bundle("src/lib/email/telnyx-send.ts", "send.mjs");
const api = await bundle("src/lib/email/telnyx-api.ts", "api.mjs");
const domainUtils = await bundle("src/lib/domains/telnyx-domain-utils.ts", "domain-utils.mjs");

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function keyPair() {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	// The raw 32-byte key is the tail of the SPKI DER encoding; Telnyx shows it base64.
	const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
	return { publicKey: raw.toString("base64"), privateKey };
}

const signBody = (privateKey, timestamp, body) => sign(null, Buffer.from(`${timestamp}|${body}`), privateKey).toString("base64");

test("Telnyx webhook signatures verify over timestamp|body", async () => {
	const { publicKey, privateKey } = keyPair();
	const body = JSON.stringify({ data: { event_type: "email.received", payload: { id: "m1" } } });
	const now = 1_800_000_000;
	const headers = { timestamp: String(now), signature: signBody(privateKey, now, body) };
	assert.equal(await signature.verifyTelnyxSignature(publicKey, headers, body, now), true);
	assert.equal(await signature.verifyTelnyxSignature(publicKey, headers, `${body} `, now), false, "tampered body");
	assert.equal(await signature.verifyTelnyxSignature(publicKey, { ...headers, timestamp: String(now + 1) }, body, now), false, "timestamp is signed");
	assert.equal(await signature.verifyTelnyxSignature(keyPair().publicKey, headers, body, now), false, "other key");
	assert.equal(await signature.verifyTelnyxSignature(publicKey, headers, body, now + 301), false, "replay window");
	assert.equal(await signature.verifyTelnyxSignature(publicKey, { ...headers, signature: null }, body, now), false);
	assert.equal(await signature.verifyTelnyxSignature("not-base64!", headers, body, now), false);
});

test("Telnyx public keys must be 32 bytes of base64", () => {
	assert.equal(signature.isTelnyxPublicKey(keyPair().publicKey), true);
	assert.equal(signature.isTelnyxPublicKey("KEY0123"), false);
});

test("inbound messages rebuild into MIME the normal parser reads", async () => {
	const pdf = new TextEncoder().encode("%PDF-1.4 test");
	const raw = mime.buildTelnyxMime(
		{
			from: { email: "alice@example.net", name: "Alice Ünïcode" },
			to: [{ email: "team@example.com", name: "Team" }],
			cc: ["bob@example.org"],
			subject: "Grüße from Telnyx",
			message_id: "abc@example.net",
			in_reply_to: "<prev@example.com>",
			references: ["<root@example.com>", "prev@example.com"],
			received_at: "2026-11-19T10:00:00Z",
			headers: {
				"X-Custom": "kept",
				"Authentication-Results": "spoofed; spf=pass",
				"X-SES-Spam-Verdict": "PASS",
				"Content-Type": "text/plain",
				"Bad Header": "dropped",
			},
		},
		{
			text: "Hello",
			html: "<p>Hello <img src=\"cid:logo\"></p>",
			attachments: [
				{ filename: "report.pdf", contentType: "application/pdf", content: pdf, inline: false, contentId: null },
				{ filename: "logo.png", contentType: "image/png", content: new Uint8Array([1, 2, 3]), inline: true, contentId: "logo" },
			],
		},
		"seed",
	);
	assert.doesNotMatch(raw, /spoofed|X-SES-Spam-Verdict|Bad Header/);
	assert.match(raw, /^X-Custom: kept$/m);
	const parsed = await PostalMime.parse(raw);
	assert.equal(parsed.from.address, "alice@example.net");
	assert.equal(parsed.from.name, "Alice Ünïcode");
	assert.deepEqual(parsed.to.map((entry) => entry.address), ["team@example.com"]);
	assert.deepEqual(parsed.cc.map((entry) => entry.address), ["bob@example.org"]);
	assert.equal(parsed.subject, "Grüße from Telnyx");
	assert.equal(parsed.messageId, "<abc@example.net>");
	assert.equal(parsed.inReplyTo, "<prev@example.com>");
	assert.equal(parsed.references, "<root@example.com> <prev@example.com>");
	assert.equal(parsed.text.trim(), "Hello");
	assert.match(parsed.html, /Hello/);
	assert.equal(parsed.attachments.length, 2);
	const report = parsed.attachments.find((item) => item.filename === "report.pdf");
	assert.equal(new TextDecoder().decode(report.content), "%PDF-1.4 test");
	const logo = parsed.attachments.find((item) => item.filename === "logo.png");
	assert.equal(logo.disposition, "inline");
	assert.equal(logo.contentId, "<logo>");
});

test("a text-only message with header-list headers still parses", async () => {
	const raw = mime.buildTelnyxMime(
		{ headers: [{ name: "From", value: "x@example.net" }, { name: "Subject", value: "From headers" }], to: "a@example.com" },
		{ text: "Body", html: null, attachments: [] },
	);
	const parsed = await PostalMime.parse(raw);
	assert.equal(parsed.from.address, "x@example.net");
	assert.equal(parsed.subject, "From headers");
	assert.equal(parsed.text.trim(), "Body");
	assert.equal(parsed.attachments.length, 0);
});

test("address lists accept strings, objects and display-name strings", () => {
	assert.deepEqual(mime.telnyxAddressList([{ email: "a@x.com" }, "B <b@x.com>", "c@x.com", { name: "no email" }]), ["a@x.com", "b@x.com", "c@x.com"]);
	assert.deepEqual(mime.telnyxAddressList(null), []);
});

test("the send payload maps fields, drops reserved headers and inlines attachments", () => {
	const payload = send.telnyxPayload({
		from: "Me <me@example.com>",
		to: ["you@example.net"],
		cc: [],
		bcc: ["hidden@example.org"],
		subject: "Hi",
		html: "<p>Hi</p>",
		text: "Hi",
		headers: { "Message-ID": "<old@x>", "In-Reply-To": "<p@x>", References: "<r@x> <p@x>", "Reply-To": "reply@example.com", "List-Unsubscribe": "<mailto:u@example.com>", Subject: "dup" },
		attachments: [
			{ filename: "a.txt", type: "text/plain", content: new TextEncoder().encode("abc").buffer, disposition: "attachment" },
			{ filename: "i.png", type: "image/png", content: new Uint8Array([1]).buffer, disposition: "inline", contentId: "<img1>" },
		],
	}, "<new@example.com>", { threadingHeaders: true });
	assert.deepEqual(payload.from, { email: "me@example.com", name: "Me" });
	assert.deepEqual(payload.to, ["you@example.net"]);
	assert.equal(payload.cc, undefined, "empty cc is omitted");
	assert.deepEqual(payload.bcc, ["hidden@example.org"]);
	assert.equal(payload.reply_to, "reply@example.com");
	assert.equal(payload.html_body, "<p>Hi</p>");
	assert.equal(payload.text_body, "Hi");
	assert.deepEqual(payload.headers, { "In-Reply-To": "<p@x>", References: "<r@x> <p@x>", "List-Unsubscribe": "<mailto:u@example.com>", "Message-ID": "<new@example.com>" });
	assert.equal(payload.attachments[0].content, "YWJj");
	assert.equal(payload.attachments[0].disposition, "attachment");
	assert.equal(payload.attachments[1].content_id, "img1");

	const bare = send.telnyxPayload({ from: "me@example.com", to: ["you@example.net"], subject: "Hi", text: "x", headers: { "In-Reply-To": "<p@x>" } }, "<n@x>", { threadingHeaders: false });
	assert.equal(bare.headers, undefined);
	assert.equal(bare.attachments, undefined);
});

test("addresses with a display name are sent as objects in every field", () => {
	const payload = send.telnyxPayload({
		from: '"Chen, Maya" <maya@example.com>',
		to: ["Sam <sam@example.net>", "<bare@example.net>"],
		cc: ["Lee <lee@example.net>"],
		bcc: ["Kim <kim@example.net>"],
		subject: "Hi",
		text: "x",
		headers: { "Reply-To": "Help Desk <help@example.com>" },
	}, "<n@example.com>", { threadingHeaders: true });
	assert.deepEqual(payload.from, { email: "maya@example.com", name: "Chen, Maya" });
	assert.deepEqual(payload.to, [{ email: "sam@example.net", name: "Sam" }, "bare@example.net"]);
	assert.deepEqual(payload.cc, [{ email: "lee@example.net", name: "Lee" }]);
	assert.deepEqual(payload.bcc, [{ email: "kim@example.net", name: "Kim" }]);
	assert.deepEqual(payload.reply_to, { email: "help@example.com", name: "Help Desk" });
});

test("inbound is read from every shape Telnyx uses", () => {
	const enabled = domainUtils.isTelnyxInboundEnabled;
	assert.equal(enabled({ inbound: { enabled: true, catch_all: false, mx_required: true }, usable_for_inbound: true }), true);
	assert.equal(enabled({ usable_for_inbound: true }), true);
	assert.equal(enabled({ inbound_enabled: true }), true);
	assert.equal(enabled({ inbound: { enabled: false }, usable_for_inbound: false }), false);
	for (const domain of [{}, { inbound: null }, null, undefined]) assert.equal(enabled(domain), false);
});

test("idempotency keys keep only the characters Telnyx accepts", () => {
	assert.equal(send.telnyxIdempotencyKey("job_abc:123/x"), "job_abc123x");
	assert.equal(send.telnyxIdempotencyKey(undefined), null);
	assert.equal(send.telnyxIdempotencyKey(":::"), null);
});

test("sending retries once without threading headers when Telnyx refuses them", async () => {
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), init, body: JSON.parse(init.body) });
		if (calls.length === 1) return Response.json({ errors: [{ code: "10015", title: "Bad Request", detail: "header Message-ID is not allowed" }] }, { status: 422 });
		return Response.json({ data: { id: "uuid-1", status: "queued" } }, { status: 202 });
	};
	const client = api.telnyxClient({}, "KEY123");
	const result = await send.sendWithTelnyx(client, { from: "me@example.com", to: ["you@example.net"], subject: "Hi", text: "x", headers: { "In-Reply-To": "<p@x>" } }, "job_1");
	assert.equal(calls.length, 2);
	assert.equal(calls[0].url, "https://api.telnyx.com/v2/email_messages");
	assert.equal(calls[0].init.headers.Authorization, "Bearer KEY123");
	assert.equal(calls[0].init.headers["Idempotency-Key"], "job_1");
	assert.equal(calls[1].init.headers["Idempotency-Key"], "job_1-nh");
	assert.equal(calls[0].body.headers["Message-ID"], result.messageId);
	assert.equal(calls[1].body.headers, undefined);
	assert.match(result.messageId, /^<[0-9a-f-]{36}@example\.com>$/);
});

test("other Telnyx errors surface with their detail", async () => {
	globalThis.fetch = async () => Response.json({ errors: [{ code: "10007", detail: "Domain is not verified" }] }, { status: 403 });
	const client = api.telnyxClient({ TELNYX_BASE_URL: "https://telnyx.test/v2/" }, "KEY");
	await assert.rejects(send.sendWithTelnyx(client, { from: "me@example.com", to: ["a@b.c"], subject: "s", text: "t" }), /Telnyx: Domain is not verified/);
});

test("content downloads send the key only to Telnyx's own API host", async () => {
	const seen = [];
	globalThis.fetch = async (url, init) => { seen.push({ url: String(url), auth: init?.headers?.Authorization ?? null }); return new Response("body"); };
	const client = api.telnyxClient({}, "KEY");
	await api.fetchTelnyxContent(client, "https://api.telnyx.com/v2/email_messages/1/text");
	await api.fetchTelnyxContent(client, "https://storage.example.com/signed?sig=1");
	assert.deepEqual(seen.map((entry) => entry.auth), ["Bearer KEY", null]);
	await assert.rejects(api.fetchTelnyxContent(client, "http://api.telnyx.com/x"), /not HTTPS/);
});

test("DNS helpers resolve names, spot policy records and Telnyx usernames", () => {
	assert.equal(domainUtils.absoluteTelnyxName("@", "example.com"), "example.com");
	assert.equal(domainUtils.absoluteTelnyxName("telnyx1._domainkey", "example.com"), "telnyx1._domainkey.example.com");
	assert.equal(domainUtils.absoluteTelnyxName("_dmarc.example.com.", "example.com"), "_dmarc.example.com");
	assert.equal(domainUtils.policyKind("\"v=spf1 include:spf.telnyx.com ~all\""), "spf");
	assert.equal(domainUtils.policyKind("v=DMARC1; p=none"), "dmarc");
	assert.equal(domainUtils.policyKind("telnyx-domain-verification=abc"), null);
	assert.equal(domainUtils.isTelnyxUsername("first.last"), true);
	assert.equal(domainUtils.isTelnyxUsername("a"), true);
	assert.equal(domainUtils.isTelnyxUsername("-bad"), false);
	assert.equal(domainUtils.isTelnyxUsername("a+tag"), false);
	assert.equal(api.isTelnyxInboundMx("MX.Telnyx.com."), true);
	assert.equal(api.isTelnyxInboundMx("route1.mx.cloudflare.net"), false);
});

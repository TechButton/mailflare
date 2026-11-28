import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after, afterEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-brevo-"));
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

const send = await bundle("src/lib/email/brevo-send.ts", "send.mjs");
const api = await bundle("src/lib/email/brevo-api.ts", "api.mjs");
const attachments = await bundle("src/lib/email/brevo-attachment-utils.ts", "attachments.mjs");

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockFetch(...responses) {
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), method: init?.method, headers: init?.headers, body: init?.body ? JSON.parse(init.body) : undefined });
		const [status, body] = responses[Math.min(calls.length, responses.length) - 1];
		return new Response(JSON.stringify(body), { status });
	};
	return calls;
}

const client = api.brevoClient({}, "test-key");
const message = {
	from: '"Maya Chen" <maya@example.com>',
	to: ["Sam <sam@example.net>"],
	cc: ["lee@example.net"],
	subject: "Hello",
	text: "Hi",
	headers: { "Reply-To": "help@example.com", "Message-ID": "<mine@example.com>", "In-Reply-To": "<parent@example.net>" },
	attachments: [{ filename: "a.txt", type: "text/plain", content: new TextEncoder().encode("abc").buffer, disposition: "attachment" }],
};

test("Brevo send maps addresses, reply-to and attachments, and returns Brevo's Message-ID", async () => {
	const calls = mockFetch([201, { messageId: "<123@relay.example>" }]);
	assert.deepEqual(await send.sendWithBrevo(client, message), { messageId: "<123@relay.example>" });
	const [call] = calls;
	assert.equal(call.url, "https://api.brevo.com/v3/smtp/email");
	assert.equal(call.headers["api-key"], "test-key");
	assert.deepEqual(call.body.sender, { email: "maya@example.com", name: "Maya Chen" });
	assert.deepEqual(call.body.to, [{ email: "sam@example.net", name: "Sam" }]);
	assert.deepEqual(call.body.cc, [{ email: "lee@example.net" }]);
	assert.deepEqual(call.body.replyTo, { email: "help@example.com" });
	assert.deepEqual(call.body.headers, { "In-Reply-To": "<parent@example.net>" });
	assert.deepEqual(call.body.attachment, [{ name: "a.txt", content: "YWJj" }]);
});

test("Brevo send retries once without headers when a header is refused", async () => {
	const calls = mockFetch([400, { code: "invalid_parameter", message: "headers: In-Reply-To is not supported" }], [201, { messageId: "<ok@relay.example>" }]);
	assert.equal((await send.sendWithBrevo(client, message)).messageId, "<ok@relay.example>");
	assert.equal(calls.length, 2);
	assert.equal(calls[1].body.headers, undefined);
});

test("Brevo send does not retry other errors", async () => {
	const calls = mockFetch([400, { code: "invalid_parameter", message: "sender is not valid" }]);
	await assert.rejects(send.sendWithBrevo(client, message), /Brevo: sender is not valid/);
	assert.equal(calls.length, 1);
});

test("a missing Brevo domain reads as null and other failures are raised", async () => {
	mockFetch([404, { code: "document_not_found", message: "Domain not found" }]);
	assert.equal(await api.findBrevoDomain(client, "example.com"), null);
	mockFetch([400, { code: "invalid_parameter", message: "Domain does not exist" }]);
	assert.equal(await api.findBrevoDomain(client, "example.com"), null);
	mockFetch([401, { code: "unauthorized", message: "Key not found" }]);
	await assert.rejects(api.findBrevoDomain(client, "example.com"), /Key not found/);
});

test("the Brevo key check tells a rejected key from an outage", async () => {
	mockFetch([401, { code: "unauthorized", message: "Key not found" }]);
	assert.equal(await api.checkBrevoKey(client), false);
	mockFetch([500, {}]);
	await assert.rejects(api.checkBrevoKey(client));
});

test("Brevo DNS records are read whatever their keys are, skipping empty ones", () => {
	const record = { type: "TXT", host_name: "@", value: "brevo-code=1" };
	assert.deepEqual(api.brevoDnsRecords({ dns_records: { brevo_code: record, dmarc_record: null, other: { type: "CNAME", host_name: "x", value: "" } } }), [record]);
});

test("only file types on Brevo's list are sent as attachments", () => {
	assert.equal(attachments.isBrevoAttachmentName("Report.PDF"), true);
	for (const name of ["script.js", "setup.exe", "noextension"]) assert.equal(attachments.isBrevoAttachmentName(name), false, name);
});

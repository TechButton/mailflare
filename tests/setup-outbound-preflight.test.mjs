import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const { app } = await loadApp("setup-preflight", `export { getSetupRequirementChecks } from "./src/lib/setup/configuration.ts";`);

const outbound = (vars, mailer = false) => app.getSetupRequirementChecks({ MAILFLARE_RUNTIME: "node", DB: {}, EMAIL: { configured: mailer }, ...vars })
	.find((check) => check.key === "Outbound mail").configured;

test("self-hosted setup accepts a provider API key in place of an SMTP relay", () => {
	for (const name of ["TELNYX_API_KEY", "RESEND_API_KEY", "BREVO_API_KEY"]) assert.equal(outbound({ [name]: "key" }), true, name);
	assert.equal(outbound({ AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b", AWS_REGION: "us-east-1" }), true);
	assert.equal(outbound({}, true), true);
});

test("self-hosted setup still asks for outbound mail when none is configured", () => {
	assert.equal(outbound({}), false);
	assert.equal(outbound({ TELNYX_API_KEY: "  " }), false);
	assert.equal(outbound({ TELNYX_PUBLIC_KEY: "only-the-webhook-key" }), false);
	assert.equal(outbound({ AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b" }), false);
});

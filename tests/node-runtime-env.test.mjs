import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The self-hosted runtime passes through only the variables it names, so a missing one is silently ignored.
test("the Node runtime passes the Telnyx and Brevo variables to the app", () => {
	const source = readFileSync(new URL("../server/runtime/env.ts", import.meta.url), "utf8");
	for (const name of ["TELNYX_API_KEY", "TELNYX_PUBLIC_KEY", "TELNYX_BASE_URL", "BREVO_API_KEY", "BREVO_BASE_URL"]) {
		assert.ok(source.includes(`${name}: optional("${name}")`), name);
	}
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const lines = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n").split("\n");
const instructions = (path) => lines(path).filter((line) => line.trim() && !line.startsWith("#"));

test("Dockerfile.railway matches Dockerfile apart from VOLUME, which Railway rejects", () => {
	assert.ok(!instructions("Dockerfile.railway").some((line) => /^\s*VOLUME\b/i.test(line)));
	assert.deepEqual(instructions("Dockerfile.railway"), instructions("Dockerfile").filter((line) => !/^\s*VOLUME\b/i.test(line)));
});

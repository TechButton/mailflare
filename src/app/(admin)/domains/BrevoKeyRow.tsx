"use client";

import { useEffect, useState } from "react";
import { confirmDestructive } from "@/components/ui/confirm-dialog";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { postJson, requestJson } from "./api";
import { StatusRow } from "./status-row";

export type BrevoKeyRowStatus = { configured: boolean; source: "settings" | "environment" | null };

/** The Brevo API key shared by every domain that sends through Brevo. */
export default function BrevoKeyRow({ onChanged, onError }: { onChanged: (status: BrevoKeyRowStatus) => void; onError: (message: string) => void }) {
	const { t } = useLanguage();
	const [status, setStatus] = useState<BrevoKeyRowStatus | null>(null);
	const [value, setValue] = useState("");
	const [editing, setEditing] = useState(false);
	const [busy, setBusy] = useState(false);

	// Read once on mount; the callbacks are the parent's and change every render.
	useEffect(() => {
		let active = true;
		requestJson<BrevoKeyRowStatus>("/api/admin/brevo-key", "GET")
			.then((data) => { if (active) { setStatus(data); onChanged(data); } })
			.catch((error) => { if (active) onError(error instanceof Error ? error.message : t("brevo.unreachable")); });
		return () => { active = false; };
	}, []);

	async function run(action: () => Promise<BrevoKeyRowStatus | null>) {
		setBusy(true);
		onError("");
		try {
			const next = await action();
			if (next) { setStatus(next); onChanged(next); }
		} catch (error) { onError(error instanceof Error ? error.message : t("domains.requestFailed")); } finally { setBusy(false); }
	}

	const save = () => run(async () => {
		const next = await postJson<BrevoKeyRowStatus>("/api/admin/brevo-key", "PUT", { apiKey: value });
		setValue("");
		setEditing(false);
		return next;
	});
	const remove = () => run(async () => {
		if (!await confirmDestructive(t("brevo.removeConfirm"))) return null;
		return postJson<BrevoKeyRowStatus>("/api/admin/brevo-key", "DELETE", {});
	});
	const showForm = status?.configured === false || editing;

	return (
		<>
			<StatusRow
				ok={!!status?.configured && !editing}
				title={t("brevo.apiKey")}
				hint={t("brevo.apiKeyHint")}
				action={status?.configured && status.source !== "environment" && !editing ? (
					<>
						<Button size="sm" variant="outline" className="bg-white" disabled={busy} onClick={() => setEditing(true)}>{t("resend.replace")}</Button>
						<Button size="sm" variant="outline" className="bg-white" disabled={busy} onClick={() => void remove()}>{t("resend.remove")}</Button>
					</>
				) : undefined}
			>
				{showForm ? (
					<form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); void save(); }}>
						<Input type="password" autoComplete="off" aria-label={t("brevo.apiKey")} placeholder="xkeysib-..." value={value} onChange={(event) => setValue(event.target.value)} className="max-w-xs bg-white" />
						<Button type="submit" size="sm" disabled={!value.trim() || busy}>{busy ? t("domains.checking") : t("resend.saveKey")}</Button>
						{editing && <Button type="button" size="sm" variant="outline" className="bg-white" onClick={() => { setEditing(false); setValue(""); }}>{t("common.cancel")}</Button>}
					</form>
				) : !status ? t("domains.checking") : status.source === "environment" ? t("brevo.keyFromEnv") : t("brevo.keySaved")}
			</StatusRow>
			{showForm && <li className="list-none px-1 text-xs text-neutral-500">{t("brevo.keyInstructions")}</li>}
		</>
	);
}

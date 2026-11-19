"use client";

import { useEffect, useState } from "react";
import { confirmDestructive } from "@/components/ui/confirm-dialog";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { postJson, requestJson } from "./api";
import { StatusRow } from "./status-row";

export type TelnyxKeyStatus = { configured: boolean; publicKeyConfigured: boolean };

type Props = {
	/** Show the webhook public key row (receiving needs it; sending does not). */
	withPublicKey: boolean;
	onChanged: (status: TelnyxKeyStatus) => void;
	onError: (message: string) => void;
};

type Field = "apiKey" | "publicKey";

/** The shared Telnyx API key and webhook public key, used by both the sending and receiving setup. */
export default function TelnyxKeyRows({ withPublicKey, onChanged, onError }: Props) {
	const { t } = useLanguage();
	const [status, setStatus] = useState<TelnyxKeyStatus | null>(null);
	const [values, setValues] = useState<Record<Field, string>>({ apiKey: "", publicKey: "" });
	const [editing, setEditing] = useState<Field | null>(null);
	const [busy, setBusy] = useState(false);

	// Read once on mount; the callbacks are the parent's and change every render.
	useEffect(() => {
		let active = true;
		requestJson<TelnyxKeyStatus>("/api/admin/telnyx-key", "GET")
			.then((data) => { if (active) { setStatus(data); onChanged(data); } })
			.catch((error) => { if (active) onError(error instanceof Error ? error.message : t("telnyx.unreachable")); });
		return () => { active = false; };
	}, []);

	async function run(action: () => Promise<TelnyxKeyStatus | null>) {
		setBusy(true);
		onError("");
		try {
			const next = await action();
			if (next) { setStatus(next); onChanged(next); }
		} catch (error) { onError(error instanceof Error ? error.message : t("domains.requestFailed")); } finally { setBusy(false); }
	}

	const save = (field: Field) => run(async () => {
		const next = await postJson<TelnyxKeyStatus>("/api/admin/telnyx-key", "PUT", { [field]: values[field] });
		setValues((current) => ({ ...current, [field]: "" }));
		setEditing(null);
		return next;
	});
	const remove = (field: Field) => run(async () => {
		if (field === "apiKey" && !await confirmDestructive(t("telnyx.removeConfirm"))) return null;
		return postJson<TelnyxKeyStatus>("/api/admin/telnyx-key", "DELETE", { target: field });
	});

	const row = (field: Field, configured: boolean | null, copy: { title: string; hint: string; placeholder: string; instructions: string }) => {
		const showForm = configured === false || editing === field;
		return (
			<>
				<StatusRow
					ok={!!configured && editing !== field}
					title={copy.title}
					hint={copy.hint}
					action={configured && editing !== field ? (
						<>
							<Button size="sm" variant="outline" className="bg-white" disabled={busy} onClick={() => setEditing(field)}>{t("resend.replace")}</Button>
							<Button size="sm" variant="outline" className="bg-white" disabled={busy} onClick={() => void remove(field)}>{t("resend.remove")}</Button>
						</>
					) : undefined}
				>
					{showForm ? (
						<form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); void save(field); }}>
							<Input type="password" autoComplete="off" aria-label={copy.title} placeholder={copy.placeholder} value={values[field]} onChange={(event) => setValues((current) => ({ ...current, [field]: event.target.value }))} className="max-w-xs bg-white" />
							<Button type="submit" size="sm" disabled={!values[field].trim() || busy}>{busy ? t("domains.checking") : t("resend.saveKey")}</Button>
							{editing === field && <Button type="button" size="sm" variant="outline" className="bg-white" onClick={() => { setEditing(null); setValues((current) => ({ ...current, [field]: "" })); }}>{t("common.cancel")}</Button>}
						</form>
					) : configured ? t("telnyx.keySaved") : t("domains.checking")}
				</StatusRow>
				{showForm && <li className="list-none px-1 text-xs text-neutral-500">{copy.instructions}</li>}
			</>
		);
	};

	return (
		<>
			{row("apiKey", status ? status.configured : null, { title: t("telnyx.apiKey"), hint: t("telnyx.apiKeyHint"), placeholder: "KEY...", instructions: t("telnyx.keyInstructions") })}
			{withPublicKey && row("publicKey", status ? status.publicKeyConfigured : null, { title: t("telnyx.publicKey"), hint: t("telnyx.publicKeyHint"), placeholder: "base64", instructions: t("telnyx.publicKeyInstructions") })}
		</>
	);
}

"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/components/language-provider";
import type { BrevoDomainView } from "@/lib/domains/brevo-domain-types";
import BrevoKeyRow from "./BrevoKeyRow";
import { postJson, requestJson } from "./api";
import { StatusRow } from "./status-row";

type BrevoResponse = { keyConfigured?: boolean; brevo?: BrevoDomainView | null; error?: string };

/** Sending through Brevo: the shared key, then the domain's registration, DNS records and verification. */
export default function BrevoDomainSection({ domainId, onStatus }: { domainId: string; onStatus?: (status: string | null) => void }) {
	const { t } = useLanguage();
	const [keyConfigured, setKeyConfigured] = useState<boolean | null>(null);
	const [view, setView] = useState<BrevoDomainView | null>(null);
	const [fetching, setFetching] = useState(true);
	// Nothing to fetch until the key rows report whether a key exists.
	const loading = keyConfigured === null || (keyConfigured && fetching);
	const [reload, setReload] = useState(0);
	const [busy, setBusy] = useState<"setup" | "verify" | "test" | null>(null);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");

	useEffect(() => {
		if (!keyConfigured) return;
		let active = true;
		requestJson<BrevoResponse>(`/api/domains/${domainId}/brevo`, "GET")
			.then((data) => { if (active) { setView(data.brevo ?? null); setError(""); } })
			.catch((err) => { if (active) setError(err instanceof Error ? err.message : t("brevo.unreachable")); })
			.finally(() => { if (active) setFetching(false); });
		return () => { active = false; };
	}, [domainId, keyConfigured, reload, t]);

	useEffect(() => {
		if (loading) return;
		onStatus?.(keyConfigured === false ? "no_key" : view?.status ?? null);
	}, [loading, keyConfigured, view, onStatus]);

	async function run(kind: "setup" | "verify" | "test", action: () => Promise<void>) {
		setBusy(kind);
		setError("");
		setNotice("");
		try { await action(); }
		catch (err) { setError(err instanceof Error ? err.message : t("domains.requestFailed")); }
		finally { setBusy(null); }
	}

	const domainAction = (action: "setup" | "verify") => run(action, async () => {
		const data = await postJson<BrevoResponse>(`/api/domains/${domainId}/brevo`, "POST", { action });
		setView(data.brevo ?? null);
	});
	const sendTest = () => run("test", async () => {
		const data = await postJson<{ to: string }>(`/api/domains/${domainId}/brevo`, "POST", { action: "test" });
		setNotice(t("resend.testSent", { to: data.to }));
	});

	const verified = view?.status === "verified";
	const status = view?.status.replace(/_/g, " ") ?? "";
	const label = loading
		? t("domains.checking")
		: !view
			? t("brevo.unreachable")
			: verified
				? t("brevo.verified")
				: !view.registered
					? t("brevo.notAdded")
					: view.missingDns === 0
						? t("brevo.waiting", { status })
						: view.missingDns
							? t("resend.missingDns", { count: view.missingDns })
							: t("resend.dnsCheck", { status });
	const verifyOnly = !!view?.registered && (!view.dnsManaged || view.missingDns === 0);
	const button = !view
		? null
		: verifyOnly
			? view.dnsManaged ? t("resend.btn.checkStatus") : t("resend.btn.verify")
			: !view.registered
				? view.dnsManaged ? t("resend.btn.setupDomainDns") : t("resend.btn.setupDomain")
				: t("resend.btn.createMissing");

	return (
		<div className="space-y-2">
			<ul className="space-y-2">
				<BrevoKeyRow
					onChanged={(next) => { setKeyConfigured(next.configured); if (!next.configured) setView(null); setFetching(true); setReload((value) => value + 1); }}
					onError={setError}
				/>
				{keyConfigured && (
					<StatusRow
						ok={verified}
						title={t("resend.domain")}
						hint={t("brevo.domainHint")}
						action={verified ? (
							<Button size="sm" variant="outline" className="bg-white" disabled={busy !== null} onClick={() => void sendTest()}>{busy === "test" ? t("resend.sending") : t("resend.sendTest")}</Button>
						) : button && !loading ? (
							<Button size="sm" variant="outline" className="bg-white" disabled={busy !== null} onClick={() => void domainAction(verifyOnly ? "verify" : "setup")}>
								{busy === "verify" ? t("domains.checking") : busy === "setup" ? t("domains.working") : button}
							</Button>
						) : undefined}
					>
						{label}
					</StatusRow>
				)}
			</ul>
			{view && view.registered && !verified && !view.dnsManaged && <p className="text-xs text-neutral-500">{t("resend.addRecords")}</p>}
			{view && view.registered && !verified && view.dnsManaged && view.missingDns === 0 && <p className="text-xs text-neutral-500">{t("resend.propagate")}</p>}
			{view?.records.some((record) => record.status === "existing_policy") && <p className="text-xs text-neutral-500">{t("brevo.existingPolicy")}</p>}
			{view && view.records.length > 0 && !verified && (
				<ul className="space-y-1 text-xs text-neutral-600">
					{view.records.map((record) => (
						<li key={`${record.type}-${record.name}-${record.value}`} className="grid gap-1 rounded-lg bg-white px-3 py-2 sm:grid-cols-[4rem_minmax(8rem,14rem)_minmax(0,1fr)_auto]">
							<span className="font-medium">{record.type}</span>
							<span className="break-all">{record.name}</span>
							<span className="break-all">{record.value}</span>
							<span className="uppercase text-neutral-500">{record.status.replace(/_/g, " ")}</span>
						</li>
					))}
				</ul>
			)}
			{notice && <p role="status" className="text-xs text-green-700">{notice}</p>}
			{error && <p role="alert" className="text-xs text-red-600">{error}</p>}
		</div>
	);
}

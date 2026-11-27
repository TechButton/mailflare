# Sending and receiving providers

Mailflare keeps your mail data in your own D1 database and R2 bucket, Backblaze B2 or AWS S3 (or SQLite and local files when self-hosted). What carries mail over the wire is a choice you make **per domain**, separately for receiving and for sending:

| | Cloudflare | Resend | Amazon SES | Telnyx |
|---|---|---|---|---|
| **Receiving** | Email Routing (the default) | `email.received` webhook | S3 + SNS notification | `email.received` webhook (preview) |
| **Sending** | Cloudflare Email Sending | Resend API | SESv2 API | Telnyx Email API |

DNS stays on Cloudflare for every combination: Mailflare writes the records for whichever provider you pick. A domain can also be **receive-only** (sending: Not selected) or **send-only** (receiving: Not selected).

Open **Admin → Domains**, expand a domain, and use the **Setup receiving email** and **Setup sending email** sections. Each provider is a card with a switch. Turning a switch on selects that provider and shows its setup; the icon on the left is a green check when it is fully set up and an amber triangle when it is not.

> Selecting a provider does not change DNS. The Setup button inside the provider's card does. This lets you prepare a new provider while the old one keeps working.

## Choosing at add time

**New domain** asks which service receives the domain's mail (**Receive mail with**) and which sends it (**Send mail with**), each a dropdown of Cloudflare, Resend, Amazon SES, Telnyx or Not selected. Cloudflare Email Routing and the Cloudflare sending subdomain are only enabled on the zone for the Cloudflare choice. For Resend, SES or Telnyx the domain is added without touching either; finish from the domain page once the credentials are in. The same choices are available over the API as `receivingProvider` and `sendingProvider` (see [API](api.md#domain-management)).

## Resend

Resend uses one **API key**, shared by every domain that uses it. Create it at [resend.com/api-keys](https://resend.com/api-keys).

- A **full-access** key lets Mailflare add the domain to Resend, write its DNS records to the Cloudflare zone, verify it, and (for receiving) register the webhook.
- A **sending-only** key can send, but Resend refuses it for domain and webhook management, so you add the domain at [resend.com/domains](https://resend.com/domains), create its records yourself, and use **Send test email** to confirm. Mailflare says so in the card instead of failing.

The key is checked against Resend when you save it. It can also come from the `RESEND_API_KEY` secret, which takes priority over a key saved in the app. Only the primary administrator can change it.

A service with a Resend-compatible API works the same way: set `RESEND_BASE_URL` to its API address and use its key. Every Resend call (sending, domains, webhooks, received mail) goes to that address. If the service refuses a custom `Message-ID` header, set `RESEND_CUSTOM_MESSAGE_ID=false`: Mailflare then sends without it and threads replies on the Message-ID the service reports for the sent email (`message_id` from `GET /emails/{id}`), falling back to its own when none is reported yet. If it refuses other headers Mailflare sets, such as `Auto-Submitted` on system mail and auto-replies, list them in `RESEND_OMIT_HEADERS` (comma-separated) and they are left out of every send.

**Sending.** Setup creates the domain in Resend, publishes its DKIM and SPF records, and asks Resend to verify. Verification is Resend's own status: it can stay `pending` for a few minutes after the DNS is added, and **Check status** re-asks Resend without creating anything new. Replies thread correctly because Mailflare sets its own `Message-ID`.

**Receiving.** Setup enables the receiving capability on the domain, points the apex MX at Resend, and registers one webhook for `email.received` at `/api/inbound/resend`. The webhook is authenticated with the Svix signing secret Resend returns when it is created; Mailflare stores that secret, which is why a webhook it did not create itself is replaced. For each event Mailflare fetches the message, downloads the raw MIME and runs it through the normal inbound pipeline. Resend must be able to reach your app, so `APP_URL` has to be a public HTTPS address.

## Amazon SES

Create an IAM user with programmatic access, then enter its **access key ID**, **secret access key** and **region** in the SES card. Mailflare validates them before saving: it proves the identity with STS, then makes a harmless call to each service it needs, and lists every permission the key lacks. Credentials can also come from `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_REGION`, which take priority over saved ones.

The key needs this policy (the card shows it too, with only the missing parts called out):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["sts:GetCallerIdentity", "ses:GetAccount", "ses:SendEmail", "ses:CreateEmailIdentity", "ses:GetEmailIdentity", "ses:DeleteEmailIdentity", "ses:SetIdentityNotificationTopic"], "Resource": "*" },
    { "Effect": "Allow", "Action": ["ses:DescribeActiveReceiptRuleSet", "ses:CreateReceiptRuleSet", "ses:SetActiveReceiptRuleSet", "ses:CreateReceiptRule", "ses:UpdateReceiptRule", "ses:DescribeReceiptRule", "ses:DeleteReceiptRule"], "Resource": "*" },
    { "Effect": "Allow", "Action": ["sns:ListTopics", "sns:CreateTopic", "sns:SetTopicAttributes", "sns:Subscribe", "sns:ListSubscriptionsByTopic"], "Resource": "*" },
    { "Effect": "Allow", "Action": ["s3:ListAllMyBuckets", "s3:CreateBucket", "s3:PutBucketPolicy", "s3:PutLifecycleConfiguration", "s3:ListBucket", "s3:GetObject", "s3:DeleteObject"], "Resource": "*" }
  ]
}
```

Only the sending statements are needed if you use SES just for sending.

**Sending.** Setup creates the domain's SES identity, publishes its three DKIM CNAME records to the Cloudflare zone, and tracks verification. New AWS accounts start in the **SES sandbox**, where SES delivers only to verified addresses; Mailflare shows a warning row until you request production access in the SES console. Replies thread because Mailflare stores the Message-ID SES assigns (`<id@email.amazonses.com>` in us-east-1, `<id@region.amazonses.com>` elsewhere).

**Receiving.** SES can only receive in some regions (for example us-east-1, us-west-2 and eu-west-1); Mailflare rejects the others. Setup creates, idempotently:

1. an S3 bucket (`mailflare-inbound-<account>-<region>`) that only SES may write to, with a one-day expiry for leftovers (best effort);
2. an SNS topic that only SES may publish to, subscribed to `/api/inbound/ses` with a secret token in the URL;
3. a receipt rule for the domain in the account's active rule set (Mailflare creates and activates `mailflare-inbound` only if the account has none, and otherwise adds its rule beside yours);
4. the MX record `inbound-smtp.<region>.amazonaws.com`.

Each message is read from your own bucket, handed to the normal inbound pipeline, and deleted. SES's virus scan is enabled and infected messages are dropped. `APP_URL` has to be a public HTTPS address so SNS can reach the endpoint. The bucket and topic are shared by all SES domains; **Clean up** removes only the domain's rule and MX, so Mailflare never deletes resources another domain may still use.

## Telnyx

Telnyx uses one **API key** and one **public key**, shared by every domain that uses it. Create the API key under **Keys & Credentials → API Keys** in the Telnyx portal; copy the public key from **Keys & Credentials → Public Key**. The API key is checked against Telnyx when you save it. They can also come from `TELNYX_API_KEY` and `TELNYX_PUBLIC_KEY`. Only the primary administrator can change them.

**Sending.** Setup creates the domain in Telnyx (`/v2/email_domains`), publishes the records Telnyx asks for (ownership TXT, DKIM at `telnyx1._domainkey`, SPF and DMARC), and asks Telnyx to verify. Telnyx only allows one SPF and one DMARC record per name, so if the domain already has its own, Mailflare leaves it alone and the card asks you to add `include:spf.telnyx.com` to your SPF yourself; those two records are recommended rather than required, so verification does not wait for them. Telnyx returns its own message UUID rather than a `Message-ID`, so Mailflare sets its own `Message-ID` (and the reply's `In-Reply-To`/`References`) as custom headers, and retries once without them if Telnyx refuses them. Telnyx caps a request at 8 MB, so large attachments become download links, as with Cloudflare.

**Receiving (preview).** Telnyx accepts mail only for addresses that have an **inbox**, and it hands each message over as parsed fields, not raw MIME. Setup:

1. enables inbound on the Telnyx domain and publishes its records;
2. points the apex MX at `mx.telnyx.com` (priority 10);
3. registers a webhook for `email.received` at `/api/inbound/telnyx`;
4. creates one Telnyx inbox for each mailbox and alias on the domain.

Each webhook is verified with Ed25519 over `telnyx-timestamp|body` against your public key and refused when the timestamp is more than five minutes off. Mailflare then fetches the message, downloads its bodies and attachments, rebuilds a MIME message from them and runs it through the normal inbound pipeline. Authentication headers in the original message (`Authentication-Results`, `X-SES-*`) are dropped because nothing vouches for them, so spam scoring sees no SPF/DKIM verdict for Telnyx mail.

Telnyx inboxes are per address, so mail to an address Mailflare does not know about, including catch-all routing rules, never arrives. When you add a mailbox or alias, the receiving card shows the missing inbox and **Setup receiving** creates it. Telnyx usernames allow only letters, digits, dots, hyphens and underscores, so an address like `a+b@` cannot get an inbox. Telnyx does not document the exact `email.received` payload yet, which is why receiving is marked as a preview: Mailflare uses the payload when it carries the message and otherwise fetches it by id. `APP_URL` has to be a public HTTPS address.

## Bounces and complaints

Resend and SES can report permanent bounces and spam complaints back to Mailflare, which keeps a per-domain suppression list. It is off by default; see [deliverability.md](deliverability.md).

## MX records and switching receiving provider

Only one service can own a domain's MX records. When a provider's Setup finds MX records for something else (including Cloudflare Email Routing's), it stops and shows them, and replaces them only after you confirm. Confirming means the previous service stops receiving mail for that domain.

Per-address routes to the Mailflare Worker are only created for domains that receive through Cloudflare, and are recreated when you set Cloudflare up again.

## Cleaning up the provider you left

If a provider you are not using still has configuration for the domain, its card shows **Clean up**:

- **Cloudflare sending** deletes the zone's sending subdomain and its DNS.
- **Cloudflare receiving** deletes the domain's routing rules and MX, and disables Email Routing on the zone when no other domain uses it.
- **Resend** deletes the domain from Resend and its DNS records. If the domain still receives (or sends) through Resend, only the capability you are leaving is switched off.
- **SES sending** deletes the identity and its DKIM records.
- **SES receiving** deletes the domain's receipt rule and MX.
- **Telnyx sending** deletes the domain from Telnyx and its DNS records. If the domain still receives through Telnyx, only the SPF include is removed.
- **Telnyx receiving** deletes the MX, the webhook and the domain's inboxes, and the domain itself unless it still sends through Telnyx.

You cannot clean up the provider that is currently selected.

## Behavior that differs from Cloudflare

- **Routing rules.** Reject and forward rules need to act on the live SMTP session, which only Cloudflare's email handler can do. For mail received through Resend, SES or Telnyx, a reject rule drops the message and forward rules are not applied. Store and categorize rules, mailbox rules, spam handling and webhooks work as usual.
- **Attachments.** Cloudflare and Telnyx send large files as download links from your storage bucket to stay under their limits. Resend and SES send attachments directly, within the administrator's outgoing limit; past 20 MB they too go as download links, which keeps the encoded message under what most receiving servers accept (the limit can be raised to 50 MB on Node/Docker; Workers stay at 25 MB).
- **Size.** Inbound mail from any provider is capped at 25 MiB and the same attachment limits apply; larger messages are dropped.

## Configuration reference

| Variable | Purpose |
|---|---|
| `RESEND_API_KEY` | Resend key; overrides one saved in the app |
| `RESEND_BASE_URL` | Base URL of the Resend API (default `https://api.resend.com`); point it at a Resend-compatible service to send and receive through that instead |
| `RESEND_CUSTOM_MESSAGE_ID` | `false` stops sending Mailflare's own `Message-ID` header, for compatible services that refuse it (default: sent) |
| `RESEND_OMIT_HEADERS` | Comma-separated headers left out of every Resend send, for compatible services that refuse them (default: none) |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` | SES credentials; override ones saved in the app |
| `TELNYX_API_KEY` | Telnyx API key used when none is saved in the app |
| `TELNYX_PUBLIC_KEY` | Telnyx public key (base64) for verifying inbound webhooks, used when none is saved in the app |
| `TELNYX_BASE_URL` | Base URL of the Telnyx API (default `https://api.telnyx.com/v2`) |
| `APP_URL` | Public HTTPS address; required for Resend, SES and Telnyx receiving, because the providers call this app |

Settings saved in the app take precedence over these variables. Keys saved in the app are stored as plain text in the `app_settings` table (as the AI provider key already is), so protect database backups accordingly.

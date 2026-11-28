# Deploying to Railway

Railway runs the same Node server as the [Docker self-hosting](self-hosting.md) setup. Railway's limits change, so check [its pricing](https://railway.com/pricing) first. The figures below were read on 2026-11-27.

## What works on Railway

- **Send through an HTTPS API.** Railway disables outbound SMTP on the Free, Trial and Hobby plans, so `SMTP_URL` does not work there. Choose Brevo, Resend, Telnyx or Amazon SES for each domain.
- **Receive through a webhook** (Telnyx, Resend or Amazon SES), or through the Cloudflare Email Routing relay. This guide turns the built-in SMTP listener off.

## Setup

1. Create a project from your GitHub repository.
2. Attach a volume to the service, mounted at `/data`. Without it, **every redeploy erases your mail**.
3. Generate a Railway domain for the service.
4. Set these variables:

| Variable | Value | Why |
|---|---|---|
| `RAILWAY_DOCKERFILE_PATH` | `Dockerfile.railway` | Railway rejects the `VOLUME` instruction in `Dockerfile` |
| `RAILWAY_RUN_UID` | `0` | The image runs as a non-root user, which cannot write to a Railway volume. This makes the app run as root |
| `APP_URL` | `https://` plus your Railway domain | Webhooks, password reset and the same-origin check |
| `TRUST_PROXY` | `1` | Railway terminates HTTPS in front of the app |
| `SMTP_INBOUND_PORT` | `0` | No built-in SMTP listener |

**Set your sending provider's key as a variable before opening `/setup`** (`BREVO_API_KEY`, `RESEND_API_KEY`, `TELNYX_API_KEY`, or the three `AWS_*` variables). Setup does not continue without outbound mail, and keys saved in the app only become possible afterwards. Set `TELNYX_PUBLIC_KEY` too for Telnyx receiving, or save it on the domain page later. Set `CF_TOKEN` if Mailflare should manage DNS in your Cloudflare zones; otherwise add the records it lists yourself.

5. Set the healthcheck path to `/api/setup/status`, deploy, then open `/setup` on your domain.

## Free plan limits

The Free plan includes $1 of usage a month, up to 0.5 GB of memory and a 0.5 GB volume, with no custom domain. Memory is billed at $10 per GB per month, so $1 covers about 0.1 GB running for a whole month. **Expect an always-awake install to need a paid plan.** Hobby is $5 a month and includes $5 of usage.

Free services sleep after a period without outbound traffic and wake on the next request. While the app is asleep or restarting:

- Jobs are held in memory. Scheduled and undo-send mail still waiting at a restart is not sent automatically (see [Operations](self-hosting.md#operations)).
- Timed work, such as the 02:00 UTC backup and follow-up reminders, should not be relied on.
- Incoming mail depends on your provider retrying a webhook that the waking app did not answer.

The 0.5 GB volume holds the database, raw messages, attachments and local backups, so it can fill quickly. Object storage (`S3_*` or `B2_*`) moves files off the volume.

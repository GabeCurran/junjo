# Security policy

## Reporting a vulnerability

Please report security vulnerabilities privately by emailing
**gabecurran01@gmail.com** with the subject line `[Junjo Security]`.

Do not open a public GitHub Issue for security reports. Public reports
expose users before a fix is available.

Please include:

- A description of the vulnerability and its impact.
- Steps to reproduce, or a proof-of-concept.
- The Junjo package and version affected (e.g. `@junjo-io/sdk@0.1.2`).
- Any disclosure timeline you have in mind.

You should expect an initial acknowledgement within **72 hours** and a
substantive response within **7 days**. Critical issues get a private
patch and a coordinated disclosure once a fix is available.

## Scope

In scope:

- The published OSS packages: `@junjo-io/sdk`, `@junjo-io/react`,
  `@junjo-io/shared`, `@junjo/server`, and `junjo-roblox`.
- The Junjo HTTP API surface (`/v1/*`) and webhook delivery pipeline.

Out of scope:

- Third-party services (Clerk, Supabase, Postgres, Roblox HttpService,
  etc.). Report those upstream.
- Self-host deployments where the operator has misconfigured an auth
  proxy, exposed `JUNJO_ADMIN_TOKEN` publicly, or skipped the SSRF
  guard for webhook URLs (`WEBHOOK_ALLOW_PRIVATE_HOSTS=true` in
  production).
- The proprietary cloud dashboard at `apps/dashboard`. Coordinate any
  cloud-specific reports through the same email.

## Versioning

Junjo is pre-1.0. Security fixes ship to the latest published version.
Once a `1.x` line exists, fixes will additionally backport to the most
recent prior minor for at least 90 days.

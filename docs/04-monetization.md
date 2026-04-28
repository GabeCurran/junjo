# 04 - Monetization

## Model: open-core

The dominant pattern for dev tools at this layer (Supabase, Sentry, PostHog, Nakama, Colyseus all do versions of it):

- **Free OSS SDK + Docker server image** - MIT license. Devs can `npm install @junjo/sdk` and self-host the server against any Postgres they own.
- **Paid managed cloud** - we host the server, the database, the dashboards. Devs get free tier + paid tiers.

## Why devs will pay for cloud even though OSS exists

- They don't want to run, monitor, scale, or back up another Postgres
- GDPR compliance, audit log retention, SOC2 (eventually) handled by us
- Cross-game shared identity layer (only available in cloud - see [docs/02-scope.md](./02-scope.md))
- Admin + analytics dashboards (cloud only)
- Premium SDK features (advanced webhooks, bulk operations, scheduled events)
- Support - fast bug fixes, integration help

## Pricing tiers (proposed; tune after launch)

| Tier | Price | Limits |
|------|-------|--------|
| **Free** | $0/mo | 1 game · 100 monthly active members · 1 group max · 5 roles · 10K API calls/mo · community support |
| **Starter** | $20/mo | 1 game · 1K MAM · unlimited groups · unlimited roles · 100K API calls/mo · email support |
| **Studio** | $100/mo | 3 games · 10K MAM · custom domain · webhook signing · analytics · priority email |
| **Pro** | $500/mo | 10 games · 100K MAM · cross-game identity · audit log retention 1yr · Slack/Discord integration · 24h support |
| **Enterprise** | Custom | Unlimited · dedicated infra · SLA · invoicing · SOC2 reports |

These are starting points - adjust based on actual cost-to-serve and competitor pricing once we have data.

## Cost-to-serve math

For groups/permissions/audit (the V1 product), backend cost is dominated by:
- Postgres storage + queries
- SSE connection time
- Webhook outbound bandwidth + retry storage

Rough estimate at scale:
- Supabase free tier handles thousands of free-tier games
- ~$25/mo Supabase Pro handles hundreds of paying customers' games
- ~$200/mo Supabase Pro at low thousands of paying customers
- SSE connections are cheap (long-lived but low bandwidth - most events are <1KB)
- Webhook retries: ~0 cost if we use Postgres-backed queue (no Redis needed)

Target gross margin: 80%+ (industry standard for SaaS).

## Realistic revenue expectations

**Year 1 (months 1-12):** $0-500/mo. Most months $0. The first paying customer probably comes ~6-9 months after launch. Gabe needs to be OK with this - it's a passion project that pays in skill-building and portfolio value first, revenue second.

**Year 2:** $500-5K/mo if positioning lands and Gabe ships consistently. This requires real marketing - Twitter presence, dev-tool blog posts, conference talks at gamedev meetups, sponsored episodes of game-dev podcasts, etc.

**Year 3+:** depends entirely on whether Junjo finds 50+ paying customers. If it does, $5-25K/mo is plausible. If it doesn't, it stays a portfolio piece and a "this exists if you ever need it" tool.

## What we don't do

- **Pay-per-API-call billing.** Hated by indie devs. Predictable monthly tiers with usage caps work better.
- **Per-CCU pricing.** Photon does this; it punishes devs whose games go viral. We charge by MAM (monthly active members) instead, which scales more predictably.
- **Forced cloud-only model.** Self-host has to be a real, supported option - even if 90% of revenue comes from cloud. The OSS path is what builds the community.
- **Dual-license / commercial-license games.** Adds legal complexity, scares off indie devs, hard to enforce. MIT for everything OSS.

## Conflict-of-interest with future employer

If Gabe accepts a FT offer at a game-tools company (Riot, Epic, Unity, Roblox, etc.), Junjo could be a non-compete violation depending on the contract and the employer's products. Pre-acceptance checklist:

1. Read the offer's non-compete clause carefully
2. Specifically ask: "I have a side project called Junjo that's an open-source SDK + paid cloud for game-domain group/role/permission systems. Does this conflict?"
3. Get the answer in writing
4. Worst case: pause Junjo development, keep it personal use only, until employment ends or the conflict is removed
5. Best case: company is fine with it (most are for OSS / non-competing tools); business as usual

Most non-competes are narrow enough that an open-source SDK is fine. A paid managed cloud might not be. Decide with eyes open.

## What success looks like

- **6 months post-launch:** 100+ GitHub stars, 5+ active self-hosters posting issues, 1-3 paying cloud customers
- **12 months:** 500+ stars, 10+ paying customers, $200-500/mo MRR, recognized in the indie game dev community
- **24 months:** either growing to $2K-5K/mo with consistent customer acquisition, OR plateau and decision point about how much more to invest

## What failure looks like (and how to react)

- **6 months post-launch with <50 stars and no paying customers:** the wedge isn't sharp enough OR the audience isn't reachable from where Gabe currently is. Either pivot positioning (e.g., niche down to "Roblox guild kit" specifically) or accept it as a portfolio piece and stop investing.
- **Don't keep pouring time into a project nobody wants.** The portfolio value caps out around month 12; after that, every additional weekend is opportunity cost vs. DSA, interview prep, or a different side project.

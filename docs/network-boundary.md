# Network boundary design

This document defines the intended outbound-network policy for Muaddib when running in approval mode.

EPHEMERAL DOCUMENT. Do not reference elsewhere, will be deleted once we are finished.

## Goal

Maximize agent autonomy while adding the minimum practical restriction needed to make secrets exfiltration hard:

- block arbitrary first-contact network destinations
- preserve natural autonomous browsing/following of links
- avoid per-request micromanagement once a destination is trusted in an arc

## Core idea

Use a single per-arc trust set shared by all outbound HTTP surfaces:

- `visit_webpage`
- Gondolin direct network access from the workspace agent (`curl`, `wget`, libraries, etc.)
- any other host-side helper fetches we decide to route through the same policy

Once a URL is trusted in an arc, it is trusted for all purposes in that arc.

There is no separate policy for `visit_webpage` vs direct network access.

Artifact fetches are expected to be handled locally/intercepted before outbound policy enforcement, so they do not require separate trust state.

## Trust unit

Trust is keyed by a **canonical URL**:

- keep: scheme, hostname, explicit non-default port, pathname
- strip: query string and fragment
- normalize hostname to lowercase
- normalize empty path to `/`
- remove default ports (`:80` for `http`, `:443` for `https`)

Examples:

- `https://Example.com/foo?a=1#x` -> `https://example.com/foo`
- `https://example.com/foo?a=2` -> `https://example.com/foo`
- `https://example.com` -> `https://example.com/`

This means approval/trust is effectively **path-level**, not query-level.

## How a URL becomes trusted

A canonical URL becomes trusted in an arc if it was seen within the last 30 days via any of:

1. explicit approval through `request_network_access`
2. a `web_search` result URL
3. a successful `visit_webpage`
4. a redirect from an already trusted source URL

All of these feed the same per-arc trust ledger.

## Enforcement

### `visit_webpage`

Allowed iff the canonical URL is trusted in the current arc.

On success, record the canonical URL as trusted/refreshed in the arc ledger.

### Direct outbound network from the sandbox

Allowed iff the canonical request URL is trusted in the current arc.

No further distinction is made between GET/POST, body/no-body, or custom headers.
Once a canonical URL is trusted, it is trusted for all intents and purposes in that arc.

This is a deliberate simplicity/autonomy tradeoff.

### Redirects

Redirects from a trusted source are automatically trusted.

That means:

- the redirect target is allowed immediately for the in-flight request
- the redirect target canonical URL is recorded into the same arc trust ledger
- subsequent requests to that canonical URL in the same arc are allowed

We intentionally do **not** add extra approval friction for redirects.

## Approval mechanism

Use a first-class tool, tentatively named `request_network_access`.

Reasoning:

- it works for both `visit_webpage` and direct network access
- it has structured arguments
- it integrates cleanly with harness-driven approval
- it is easier to audit than a shell convention

A shell/skill wrapper may be added later for convenience, but the tool is the source of truth.

Minimal shape:

```json
{
  "url": "https://example.com/path?maybe=query",
  "reason": "why the agent needs access"
}
```

The approval stores the canonical URL in the current arc's trust ledger.

## Persistence

Store trust state per arc under `$MUADDIB_HOME/arcs/<arc>/`.

Suggested file:

- `network-trust.jsonl`

Suggested event shape:

```json
{"ts":"2026-03-09T12:00:00.000Z","source":"web_search","rawUrl":"https://example.com/foo?a=1","canonicalUrl":"https://example.com/foo"}
{"ts":"2026-03-09T12:01:00.000Z","source":"approval","rawUrl":"https://example.com/foo?token=x","canonicalUrl":"https://example.com/foo"}
{"ts":"2026-03-09T12:02:00.000Z","source":"redirect","rawUrl":"https://cdn.example.net/bar","canonicalUrl":"https://cdn.example.net/bar","fromCanonicalUrl":"https://example.com/foo"}
```

At enforcement time, only entries from the last 30 days count.

## Security posture / non-goals

This design is meant to stop the agent from exfiltrating to an arbitrary brand-new endpoint.

It does **not** try to stop exfiltration to:

- an already trusted/approved path
- a path introduced by a search result
- a redirect target reached from a trusted URL

That tradeoff is intentional: autonomy and a simple mental model are prioritized over fine-grained request policing.

## Implementation notes

Expected implementation touchpoints:

- `src/agent/tools/web.ts`
  - enforce trust for `visit_webpage`
  - record trust from `web_search` result URLs
  - refresh trust on successful visits
- `src/agent/gondolin/network.ts`
  - enforce the same trust set for sandbox HTTP requests
  - auto-record redirect targets as trusted
- new shared policy/ledger module
  - canonicalize URLs
  - load/store per-arc trust ledger
  - answer "is this URL trusted in this arc?"
- new tool
  - `request_network_access`

## Summary

The policy is intentionally simple:

- one shared per-arc trust set
- trust key is canonical URL with query stripped
- search results, visits, approvals, and redirects all grow the same trust set
- both `visit_webpage` and direct network use the same allow rule
- once trusted in an arc, trusted for all intents and purposes in that arc

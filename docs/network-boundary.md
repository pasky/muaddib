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
2. config-driven auto-approval via `agent.tools.gondolin.{profiles,arcs}.*.urlAllowRegexes`
3. a `web_search` result URL
4. a successful `visit_webpage`
5. a redirect from an already trusted source URL

All of these feed the same per-arc trust ledger.

## Enforcement

### `visit_webpage`

Allowed iff the canonical URL is already trusted in the current arc, or matches a configured auto-approval regex for that arc.

When a configured regex matches, Muaddib records an `approval` trust event first, then proceeds with the fetch.
On success, `visit_webpage` also records its normal visit trust refresh.

### Direct outbound network from the sandbox

Allowed iff the canonical request URL is already trusted in the current arc, or matches a configured auto-approval regex for that arc.

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

Use the first-class `request_network_access` tool.

Reasoning:

- it works for both `visit_webpage` and direct network access
- it has structured arguments
- it is easier to audit than a shell convention
- the same tool can be satisfied either by room-native user approval or config policy

A shell/skill wrapper may be added later for convenience, but the tool is the source of truth.

Minimal shape:

```json
{
  "url": "https://example.com/path?maybe=query",
  "reason": "why the agent needs access"
}
```

Resolution order:

1. canonicalize the URL
2. if it is already trusted in the arc, return immediately
3. if it matches `agent.tools.gondolin.profiles/arcs.*.urlAllowRegexes`, auto-approve and record trust
4. otherwise create a pending room-native approval request

### Room-native approval flow

Pending approvals are scoped to the originating arc and thread (when present).
Muaddib emits a request message like:

- `Network access request 12 for https://example.com/docs. Reply !approve 12 or !deny 12.`

Users resolve it in the same room/thread with:

- `!approve <id>`
- `!deny <id>`

On approval, the canonical URL is recorded in the current arc's trust ledger.
On denial, the waiting tool call resumes with a denial message but no trust entry is written.

### Config auto-approval

Auto-approval rules live under Gondolin arc/profile fragments because those already define per-human-arc policy:

- `agent.tools.gondolin.profiles.<name>.urlAllowRegexes`
- `agent.tools.gondolin.arcs.<glob>.urlAllowRegexes`

These are JavaScript regex **sources** (not `/literal/flags` strings) matched against the canonical URL.
Matching rules are additive across all profiles/arcs that apply to the current human arc.

## Persistence

Store trust state per arc under `$MUADDIB_HOME/arcs/<arc>/`.

Suggested file:

- `network-trust.jsonl`

Suggested event shape:

```json
{"ts":"2026-03-09T12:00:00.000Z","source":"web_search","rawUrl":"https://example.com/foo?a=1","canonicalUrl":"https://example.com/foo"}
{"ts":"2026-03-09T12:01:00.000Z","source":"approval","rawUrl":"https://example.com/foo?token=x","canonicalUrl":"https://example.com/foo"}
{"ts":"2026-03-09T12:01:30.000Z","source":"visit_webpage","rawUrl":"https://example.com/foo?a=2","canonicalUrl":"https://example.com/foo"}
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
  - auto-approve matching config regexes before host-side fetches
  - record trust from `web_search` result URLs
  - refresh trust on successful visits
- `src/agent/gondolin/network.ts`
  - enforce the same trust set for sandbox HTTP requests
  - auto-approve matching config regexes before direct sandbox fetches
  - auto-record redirect targets as trusted
- `src/rooms/command/message-handler.ts`
  - own pending room-native approvals
  - intercept `!approve` / `!deny` before steering or new agent execution
- shared policy/ledger module
  - canonicalize URLs
  - load/store per-arc trust ledger
  - answer "is this URL trusted in this arc?"
  - auto-approve matching config regexes into the same ledger
- tool
  - `request_network_access`

## Summary

The policy is intentionally simple:

- one shared per-arc trust set
- trust key is canonical URL with query stripped
- search results, visits, approvals, config auto-approvals, and redirects all grow the same trust set
- users can resolve pending requests in-room with `!approve <id>` / `!deny <id>`
- both `visit_webpage` and direct network use the same allow rule
- once trusted in an arc, trusted for all intents and purposes in that arc

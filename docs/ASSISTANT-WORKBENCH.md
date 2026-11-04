# Optional assistant workbench (experimental)

The assistant extends the existing Bursar web console with guided local draft
creation. It is not the mandate's signing agent and it is not an alternative to
the existing MCP host, spender, wallet or smart-contract checks.

## Dataflow

1. The user opens a drawer in Workspace or on a mandate page.
2. The browser sends chat messages and a minimal context through a same-origin
   route. Workspace summaries are **opt-in**; notes, private terms, salts,
   keys and passphrases are excluded by an explicit allowlist on both sides.
3. A configured, server-side chat-completions model streams text and may call
   one of two *proposal* functions: draft create or draft patch.
4. The route validates and emits a typed proposal, never executing it.
5. The browser validates the proposal again, compares it to the current local
   workspace, renders exact old/new values and requires an Apply click.
6. The WorkspaceActions.update closure checks the full local workspace revision
   again and runs Bursar's existing limits validation before saving.
7. Successful local persistence offers links to the existing draft editor and
   /console/new?draft=<id> UI for activation and owner wallet signatures.

## Capability lanes

| Lane | Availability in this change | Authority |
| --- | --- | --- |
| Read public mandate context | Available | Existing mandate reader, not model output |
| Create local workspace draft | Available after review | Browser WorkspaceActions.update |
| Patch unactivated local draft | Available after review | Browser WorkspaceActions.update |
| Mandate creation/owner updates | Navigation only | Existing wallet UI and on-chain checks |
| Delegated payment over MCP | Not exposed | Existing separate MCP connection/signing authority |
| Arbitrary shell, repository or URL access | Never exposed | None |

## Authority gates

- **Availability**: feature flag, protected endpoint, valid server configuration.
- **Input**: constrained size, roles, context and tool schemas.
- **Scope**: patch targets an existing unlocked local draft; active mandates
  cannot be edited through the draft assistant.
- **State**: full local workspace revision is compared before applying.
- **Approval**: the user must click Apply on the displayed exact proposal.
- **Commit**: fresh revision validation inside the workspace update closure.
- **Verification**: successful local write is returned by WorkspaceActions.update;
  actual chain writes are handled only by existing Bursar screens.

All refusals stop the operation. The model never receives a signing key,
the draft workspace cipher key, a general-purpose transaction tool or arbitrary
MCP invocation. No hidden retry or automatic proposal application exists.
A future payment lane would need its own actor binding, idempotency ledger,
on-chain re-checks and verification before it can be enabled.

## Configuration

Assistant is disabled unless `BURSAR_ASSISTANT_ENABLED=true`. The web server
requires `BURSAR_ASSISTANT_MODEL`, `BURSAR_ASSISTANT_API_KEY`, a HTTPS
`BURSAR_ASSISTANT_BASE_URL` (default `https://api.openai.com/v1`) and
`BURSAR_ASSISTANT_ACCESS_TOKEN` (minimum 24 characters). Access token is
entered by the operator in the drawer; browser tab memory only.

The model endpoint must support the OpenAI-compatible streaming
`/chat/completions` API with function/tool call deltas.

The operator token is one shared secret, not a user identity. The in-memory
per-instance limiter is only a circuit-breaker. This version is suitable for
local development and trusted, access-restricted self-hosting. Do **not**
turn it on for anonymous public traffic. Before public availability, add
per-user authentication, metering and a distributed abuse limiter.

The model may be a third party. Opting into draft summaries sends those
fields to that provider; full conversation messages are sent to the provider
whenever the user submits. The app does not persist conversations to a server.

## Manual acceptance

- With the feature flag off, no Assistant button or model endpoint is exposed.
- With no access token, a chat request is refused before reaching the provider.
- An unlocked workspace and a valid proposal lead to a review card, **not** a
  write; dismissing it has no effect.
- Apply creates/patches a local draft without on-chain transactions.
- Locking or changing the workspace before Apply refuses the stale proposal.
- An activated draft, unknown action, unsupported field or contradictory
  fully specified budget is refused.
- Navigate to the existing create form and verify wallet signature still
  belongs to the original UI.

No production-grade, backend-managed autonomous agent is claimed here.

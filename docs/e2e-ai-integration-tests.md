# E2E AI Integration Tests

## Goal

Test complex multi-component AI pipelines end-to-end, from IRC event ingestion
through agent execution to IRC response delivery, with mocking only at the
LLM API and external HTTP boundaries.

## Architecture

```
IrcRoomMonitor.processMessageEvent(fakeIrcEvent)
  → real RoomMessageHandler
    → real CommandExecutor
      → real SessionRunner
        → real Agent loop
          → streamSimple ← MOCKED (scripted LLM responses)
          → real tool executors (web_search, oracle, generate_image, etc.)
            → fetch ← MOCKED (for external HTTP)
          → real post-processing (refusal detection, artifact policy, tool summary)
        → real persistence to ChatHistoryStore
  → FakeSender.sendMessage() ← VERIFIED (what goes out to IRC)
```

### Mock boundaries

| Boundary | What's mocked | Why |
|----------|--------------|-----|
| `streamSimple` from `@mariozechner/pi-ai` | Scripted LLM responses (text, tool calls) | Controls what the agent loop "hears" from the LLM |
| `completeSimple` from `@mariozechner/pi-ai` | Context reducer and classifier responses | These are simple single-turn LLM calls outside the agent loop |
| Global `fetch` | OpenRouter (image gen), Jina (web search) | External HTTP calls made by tool executors |

### Verification points

| Point | What's checked |
|-------|---------------|
| `FakeSender.sent` | Actual IRC output: response text, progress reports, cost followups |
| `ChatHistoryStore` queries | Persisted messages including tool summaries (internal monologue), bot responses, LLM call logs |
| Artifact filesystem | Generated files under `$MUADDIB_HOME/artifacts/` |

### streamSimple mock design

The mock is "scenario-aware" — a queue of scripted LLM responses popped per
`streamSimple` call. Each response is either:
- **Text-only**: emits `start → text_start → text_delta → text_end → done`
- **Tool call**: emits `start → toolcall_start → toolcall_delta → toolcall_end → done` with `stopReason: "toolUse"`

The mock creates real `AssistantMessageEventStream` instances (from `@mariozechner/pi-ai`)
so the agent loop processes them identically to real LLM responses.

## Test scenarios

### 1. Oracle chain

LLM returns `oracle` tool call → oracle executor creates nested SessionRunner →
nested LLM call returns analysis → outer agent receives result → final answer
flows out via FakeSender.

Validates: two-level agent nesting, oracle tool wiring, nested session lifecycle.

### 2. Context reduction + multi-tool + progress reports + tool summary

10 seeded history messages → `completeSimple` mock returns condensed summary for
context reducer → agent calls `web_search` (fetch mock returns results) → agent
emits progress report → agent calls `execute_code` → tool summary LLM generates
persistence summary → final answer sent to IRC.

Validates: context reduction feeding into agent loop, multi-iteration tool use,
progress report delivery via FakeSender, tool summary persisted as internal
monologue in ChatHistoryStore.

### 3. Refusal → fallback → tool use

First `streamSimple` call returns text containing refusal signal
(`"is_refusal": true`) → `detectRefusalSignal` triggers → model switches to
`refusalFallbackModel` → second `streamSimple` call returns a tool call →
tool executes → final response annotated with `[refusal fallback to ...]`.

Validates: refusal detection in SessionRunner, model switching, fallback
annotation in post-processing, tool use after model switch.

### 4. Image generation pipeline

LLM returns `generate_image` tool call → executor calls OpenRouter
(fetch mock returns image data URL) → artifact written to
`$MUADDIB_HOME/artifacts/` → agent sees image result → final response
with artifact URL sent to IRC.

Validates: image tool executor, OpenRouter API interaction, artifact
storage, artifact URL in IRC response.

### 5. Steering mid-flight

First IRC message triggers agent execution. While agent is executing a tool
(e.g. `execute_code`), a second IRC event arrives and is enqueued in the
steering queue. At the next agent loop turn boundary, the steering message
is injected. The agent incorporates it into its final response.

Validates: steering queue integration with real agent loop, mid-flight
message injection via `steeringMessageProvider`, concurrent message handling.

import { describe, expect, it } from "vitest";

import { detectRefusalErrorSignal, detectRefusalSignal } from "../src/agent/refusal-detection.js";

// xAI "permission-denied" refusal as the raw provider payload …
const XAI_PERMISSION_DENIED_RAW = '{"code":"permission-denied","error":"I can\'t help with that request."}';
// … as OpenRouter's 403 wrapper (raw payload JSON-escaped inside metadata.raw) …
const XAI_PERMISSION_DENIED_WRAPPED =
  '403: {"message":"Provider returned error","code":403,"metadata":{"raw":"{\\"code\\":\\"permission-denied\\",\\"error\\":\\"I can\'t help with that request.\\"}","provider_name":"xAI","is_byok":false}}';
// … and verbatim as pi-ai surfaced it in a live stopReason=error errorMessage (both forms).
const XAI_PERMISSION_DENIED_LIVE = `${XAI_PERMISSION_DENIED_WRAPPED} ; ${XAI_PERMISSION_DENIED_RAW}`;

describe("refusal detection", () => {
  it.each([
    ["anthropic_refusal", "The model refused to complete the request."],
    ["openai_cybersecurity_flag", "400 This content was flagged for possible cybersecurity risk."],
    ["xai_permission_denied", XAI_PERMISSION_DENIED_RAW],
    ["xai_permission_denied", XAI_PERMISSION_DENIED_WRAPPED],
    ["xai_permission_denied", XAI_PERMISSION_DENIED_LIVE],
  ])("classifies a %s errorMessage as a refusal", (label, errorMessage) => {
    expect(detectRefusalErrorSignal(errorMessage)).toBe(label);
  });

  it.each([
    '403: {"message":"Provider returned error","code":403,"metadata":{"raw":"permission denied: invalid API key","provider_name":"xAI"}}',
    "403 Forbidden: permission-denied for this organization",
    // Refusal wording alone (no permission-denied code) is too generic to act on.
    "500 upstream error: I can't help with that request.",
    "503 overloaded",
  ])("does not classify a genuine auth/availability error as a refusal: %s", (errorMessage) => {
    expect(detectRefusalErrorSignal(errorMessage)).toBeNull();
  });

  it("keeps error-only patterns out of body-text detection", () => {
    expect(detectRefusalSignal(`The provider said: ${XAI_PERMISSION_DENIED_LIVE}`)).toBeNull();
    expect(detectRefusalSignal("I can't help with that request.")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import { MuaddibAgentRunner } from "../src/agent/muaddib-agent-runner.js";

describe("MuaddibAgentRunner", () => {
  it("stores resolved model spec and supports tool registration hooks", () => {
    const runner = new MuaddibAgentRunner({
      model: "openai:gpt-4o-mini",
      systemPrompt: "You are a test assistant.",
    });

    expect(runner.modelSpec).toBe("openai:gpt-4o-mini");

    const fakeTool = {
      name: "fake_tool",
      label: "Fake Tool",
      description: "A fake test tool",
      parameters: {
        type: "object",
        properties: {},
      },
      execute: async () => ({
        content: [{ type: "text", text: "ok" }],
        details: {},
      }),
    } as any;

    runner.registerTool(fakeTool);

    expect(runner.getRegisteredTools().map((tool) => tool.name)).toContain("fake_tool");
  });
});

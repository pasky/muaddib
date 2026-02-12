import { Type } from "@sinclair/typebox";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Message,
} from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";

import {
  AgentIterationLimitError,
  MuaddibAgentRunner,
} from "../src/agent/muaddib-agent-runner.js";

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

  it("loops across repeated tool calls and feeds tool results into subsequent iterations", async () => {
    const callContexts: Message[][] = [];
    let streamCallIndex = 0;

    const streamFn: StreamFn = async (_model, context) => {
      callContexts.push(cloneMessages(context));
      streamCallIndex += 1;

      if (streamCallIndex === 1) {
        return streamWithMessage(
          makeAssistantMessage([
            { type: "toolCall", id: "call-1", name: "web_search", arguments: { query: "first" } },
          ], "toolUse"),
        );
      }

      if (streamCallIndex === 2) {
        return streamWithMessage(
          makeAssistantMessage([
            { type: "toolCall", id: "call-2", name: "web_search", arguments: { query: "second" } },
          ], "toolUse"),
        );
      }

      return streamWithMessage(
        makeAssistantMessage([{ type: "text", text: "done" }], "stop", {
          input: 3,
          output: 5,
        }),
      );
    };

    const toolQueries: string[] = [];
    const runner = new MuaddibAgentRunner({
      model: "openai:gpt-4o-mini",
      systemPrompt: "You are a test assistant.",
      streamFn,
      tools: [
        {
          name: "web_search",
          label: "Web Search",
          description: "search",
          parameters: Type.Object({
            query: Type.String(),
          }),
          execute: async (_toolCallId, params) => {
            toolQueries.push(params.query);
            return {
              content: [{ type: "text", text: `result:${params.query}` }],
              details: {},
            };
          },
        },
      ],
    });

    const result = await runner.runSingleTurn("do the thing");

    expect(result.text).toBe("done");
    expect(result.iterations).toBe(3);
    expect(result.completionAttempts).toBe(1);
    expect(toolQueries).toEqual(["first", "second"]);

    const secondCallMessages = callContexts[1] ?? [];
    const firstToolResult = secondCallMessages.find(
      (message) => message.role === "toolResult" && message.toolName === "web_search",
    );
    expect(firstToolResult?.role).toBe("toolResult");
    if (firstToolResult?.role === "toolResult") {
      expect(firstToolResult.content[0]?.type).toBe("text");
      const firstContent = firstToolResult.content[0];
      if (firstContent?.type === "text") {
        expect(firstContent.text).toContain("result:first");
      }
    }
  });

  it("enforces max iteration cap for endless tool loops", async () => {
    let streamCalls = 0;

    const streamFn: StreamFn = async () => {
      streamCalls += 1;
      return streamWithMessage(
        makeAssistantMessage(
          [{ type: "toolCall", id: `loop-${streamCalls}`, name: "loop_tool", arguments: {} }],
          "toolUse",
        ),
      );
    };

    const runner = new MuaddibAgentRunner({
      model: "openai:gpt-4o-mini",
      systemPrompt: "loop test",
      streamFn,
      maxIterations: 2,
      tools: [
        {
          name: "loop_tool",
          label: "Loop Tool",
          description: "loop forever",
          parameters: Type.Object({}),
          execute: async () => ({
            content: [{ type: "text", text: "loop" }],
            details: {},
          }),
        },
      ],
    });

    await expect(runner.runSingleTurn("never stop")).rejects.toBeInstanceOf(AgentIterationLimitError);
    expect(streamCalls).toBe(2);
  });

  it("retries when completion is empty and returns non-empty follow-up completion", async () => {
    const callContexts: Message[][] = [];
    let streamCallIndex = 0;

    const streamFn: StreamFn = async (_model, context) => {
      callContexts.push(cloneMessages(context));
      streamCallIndex += 1;

      if (streamCallIndex === 1) {
        return streamWithMessage(
          makeAssistantMessage(
            [
              {
                type: "toolCall",
                id: "fa-1",
                name: "final_answer",
                arguments: { answer: "<thinking>I still need to think</thinking>" },
              },
            ],
            "toolUse",
          ),
        );
      }

      if (streamCallIndex === 2) {
        return streamWithMessage(makeAssistantMessage([{ type: "text", text: "" }], "stop"));
      }

      return streamWithMessage(makeAssistantMessage([{ type: "text", text: "Actual answer" }], "stop"));
    };

    const runner = new MuaddibAgentRunner({
      model: "openai:gpt-4o-mini",
      systemPrompt: "non-empty completion",
      streamFn,
      maxCompletionRetries: 1,
      tools: [
        {
          name: "final_answer",
          label: "Final Answer",
          description: "final",
          parameters: Type.Object({
            answer: Type.String(),
          }),
          execute: async (_toolCallId, params) => ({
            content: [{ type: "text", text: params.answer }],
            details: {},
          }),
        },
      ],
    });

    const result = await runner.runSingleTurn("test retry");

    expect(result.text).toBe("Actual answer");
    expect(result.iterations).toBe(3);
    expect(result.completionAttempts).toBe(2);

    const secondCallMessages = callContexts[1] ?? [];
    const finalAnswerToolResult = secondCallMessages.find(
      (message) => message.role === "toolResult" && message.toolName === "final_answer",
    );
    expect(finalAnswerToolResult?.role).toBe("toolResult");
    if (finalAnswerToolResult?.role === "toolResult") {
      expect(finalAnswerToolResult.content[0]?.type).toBe("text");
      const content = finalAnswerToolResult.content[0];
      if (content?.type === "text") {
        expect(content.text).toContain("<thinking>");
      }
    }

    const thirdCallMessages = callContexts[2] ?? [];
    const retryPrompt = thirdCallMessages[thirdCallMessages.length - 1];
    expect(retryPrompt?.role).toBe("user");
    if (retryPrompt?.role === "user") {
      const retryText =
        typeof retryPrompt.content === "string"
          ? retryPrompt.content
          : retryPrompt.content
              .filter((content) => content.type === "text")
              .map((content) => content.text)
              .join("\n");
      expect(retryText).toContain("previous completion was empty");
    }
  });
});

function streamWithMessage(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({
      type: "start",
      partial: message,
    });
    stream.push({
      type: "done",
      reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
      message,
    });
  });
  return stream;
}

function makeAssistantMessage(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  usage?: Partial<Pick<AssistantMessage["usage"], "input" | "output">>,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "openai",
    model: "gpt-4o-mini",
    usage: {
      input: usage?.input ?? 1,
      output: usage?.output ?? 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: (usage?.input ?? 1) + (usage?.output ?? 1),
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function cloneMessages(context: Context): Message[] {
  return JSON.parse(JSON.stringify(context.messages)) as Message[];
}

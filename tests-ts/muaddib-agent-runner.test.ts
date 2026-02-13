import { Type } from "@sinclair/typebox";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Message,
} from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";

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
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const runner = new MuaddibAgentRunner({
      model: "openai:gpt-4o-mini",
      systemPrompt: "You are a test assistant.",
      streamFn,
      logger,
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

    expect(logger.info).toHaveBeenCalledWith("Tool web_search executed: result:first...");
    expect(logger.info).toHaveBeenCalledWith("Tool web_search executed: result:second...");
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("Tool web_search result details:"));
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("result:first"));
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("result:second"));
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

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const runner = new MuaddibAgentRunner({
      model: "openai:gpt-4o-mini",
      systemPrompt: "loop test",
      streamFn,
      maxIterations: 2,
      logger,
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
    expect(logger.warn).toHaveBeenCalledWith("Exceeding max iterations...");
    expect(logger.error).toHaveBeenCalledWith(
      "Agent iteration failed:",
      "Agent exceeded max iterations (2).",
    );
  });

  it("logs tool execution failures with warning severity", async () => {
    let streamCallIndex = 0;

    const streamFn: StreamFn = async () => {
      streamCallIndex += 1;

      if (streamCallIndex === 1) {
        return streamWithMessage(
          makeAssistantMessage([
            { type: "toolCall", id: "fail-1", name: "web_search", arguments: { query: "boom" } },
          ], "toolUse"),
        );
      }

      return streamWithMessage(makeAssistantMessage([{ type: "text", text: "done" }], "stop"));
    };

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const runner = new MuaddibAgentRunner({
      model: "openai:gpt-4o-mini",
      systemPrompt: "tool failure",
      streamFn,
      logger,
      tools: [
        {
          name: "web_search",
          label: "Web Search",
          description: "search",
          parameters: Type.Object({
            query: Type.String(),
          }),
          execute: async () => {
            throw new Error("boom");
          },
        },
      ],
    });

    const result = await runner.runSingleTurn("trigger failure");

    expect(result.text).toBe("done");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Tool web_search failed:"));
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("Tool web_search error details:"));
  });

  it("returns accepted final_answer even when provider stream errors afterward", async () => {
    let streamCallIndex = 0;

    const streamFn: StreamFn = async () => {
      streamCallIndex += 1;

      if (streamCallIndex === 1) {
        return streamWithMessage(
          makeAssistantMessage(
            [
              {
                type: "toolCall",
                id: "fa-accepted-1",
                name: "final_answer",
                arguments: { answer: "terminal answer" },
              },
            ],
            "toolUse",
          ),
        );
      }

      return streamWithErrorMessage(
        makeAssistantMessage(
          [{ type: "text", text: "" }],
          "error",
          undefined,
          "JSON error injected into SSE stream",
        ),
      );
    };

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const runner = new MuaddibAgentRunner({
      model: "openai:gpt-4o-mini",
      systemPrompt: "terminal final answer",
      streamFn,
      logger,
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

    const result = await runner.runSingleTurn("test final answer terminality");

    expect(result.text).toBe("terminal answer");
    expect(logger.warn).toHaveBeenCalledWith(
      "Agent run ended with stream error after accepted final_answer; returning final_answer result.",
      "error=JSON error injected into SSE stream",
    );
  });

  it("rejects final_answer terminality when combined with disallowed tools", async () => {
    let streamCallIndex = 0;

    const streamFn: StreamFn = async () => {
      streamCallIndex += 1;

      if (streamCallIndex === 1) {
        return streamWithMessage(
          makeAssistantMessage(
            [
              {
                type: "toolCall",
                id: "fa-rejected-1",
                name: "final_answer",
                arguments: { answer: "should not be accepted" },
              },
              {
                type: "toolCall",
                id: "search-1",
                name: "web_search",
                arguments: { query: "extra" },
              },
            ],
            "toolUse",
          ),
        );
      }

      return streamWithErrorMessage(
        makeAssistantMessage(
          [{ type: "text", text: "" }],
          "error",
          undefined,
          "JSON error injected into SSE stream",
        ),
      );
    };

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const runner = new MuaddibAgentRunner({
      model: "openai:gpt-4o-mini",
      systemPrompt: "terminal final answer",
      streamFn,
      logger,
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
        {
          name: "web_search",
          label: "Web Search",
          description: "search",
          parameters: Type.Object({
            query: Type.String(),
          }),
          execute: async () => ({
            content: [{ type: "text", text: "search result" }],
            details: {},
          }),
        },
      ],
    });

    await expect(runner.runSingleTurn("test final answer rejection")).rejects.toThrow(
      "Agent run failed: JSON error injected into SSE stream",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "Rejecting final_answer as terminal response",
      "reason=disallowed_tool_combo",
      "tools=final_answer,web_search",
    );
  });

  it("rejects final_answer when make_plan is present without quest tools", async () => {
    let streamCallIndex = 0;

    const streamFn: StreamFn = async () => {
      streamCallIndex += 1;

      if (streamCallIndex === 1) {
        return streamWithMessage(
          makeAssistantMessage(
            [
              {
                type: "toolCall",
                id: "fa-rejected-2",
                name: "final_answer",
                arguments: { answer: "should not be accepted" },
              },
              {
                type: "toolCall",
                id: "plan-1",
                name: "make_plan",
                arguments: { plan: "do steps" },
              },
            ],
            "toolUse",
          ),
        );
      }

      return streamWithErrorMessage(
        makeAssistantMessage(
          [{ type: "text", text: "" }],
          "error",
          undefined,
          "JSON error injected into SSE stream",
        ),
      );
    };

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const runner = new MuaddibAgentRunner({
      model: "openai:gpt-4o-mini",
      systemPrompt: "terminal final answer",
      streamFn,
      logger,
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
        {
          name: "make_plan",
          label: "Make Plan",
          description: "plan",
          parameters: Type.Object({
            plan: Type.String(),
          }),
          execute: async (_toolCallId, params) => ({
            content: [{ type: "text", text: params.plan }],
            details: {},
          }),
        },
      ],
    });

    await expect(runner.runSingleTurn("test final answer rejection")).rejects.toThrow(
      "Agent run failed: JSON error injected into SSE stream",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "Rejecting final_answer as terminal response",
      "reason=make_plan_without_quest_tool",
      "tools=final_answer,make_plan",
    );
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

  it("switches to vision fallback model when tool output includes image content", async () => {
    const streamModels: string[] = [];
    let streamCallIndex = 0;

    const streamFn: StreamFn = async (model) => {
      streamModels.push(String((model as { id?: string }).id ?? "unknown"));
      streamCallIndex += 1;

      if (streamCallIndex === 1) {
        return streamWithMessage(
          makeAssistantMessage([
            {
              type: "toolCall",
              id: "tool-image",
              name: "visit_webpage",
              arguments: { url: "https://example.com/image.png" },
            },
          ], "toolUse"),
        );
      }

      return streamWithMessage(makeAssistantMessage([{ type: "text", text: "vision answer" }], "stop"));
    };

    const modelAdapter = {
      resolve: (modelSpec: string) => {
        if (modelSpec === "openai:primary") {
          return {
            spec: {
              raw: modelSpec,
              provider: "openai",
              modelId: "primary",
            },
            model: { id: "primary", api: "openai-completions" },
          };
        }

        if (modelSpec === "openai:vision") {
          return {
            spec: {
              raw: modelSpec,
              provider: "openai",
              modelId: "vision",
            },
            model: { id: "vision", api: "openai-completions" },
          };
        }

        throw new Error(`Unexpected model: ${modelSpec}`);
      },
    };

    const runner = new MuaddibAgentRunner({
      model: "openai:primary",
      systemPrompt: "vision fallback test",
      streamFn,
      modelAdapter: modelAdapter as any,
      tools: [
        {
          name: "visit_webpage",
          label: "Visit Webpage",
          description: "visit",
          parameters: Type.Object({
            url: Type.String(),
          }),
          execute: async () => ({
            content: [
              {
                type: "image",
                data: "QUJD",
                mimeType: "image/png",
              },
            ],
            details: {},
          }),
        },
      ],
    });

    const result = await runner.runSingleTurn("inspect image", {
      visionFallbackModel: "openai:vision",
    });

    expect(streamModels).toEqual(["primary", "vision"]);
    expect(result.toolCallsCount).toBe(1);
    expect(result.text).toBe("vision answer [image fallback to vision]");
  });

  it("generates persistence summary for persistent tool calls", async () => {
    let streamCallIndex = 0;

    const streamFn: StreamFn = async () => {
      streamCallIndex += 1;

      if (streamCallIndex === 1) {
        return streamWithMessage(
          makeAssistantMessage([
            { type: "toolCall", id: "tool-1", name: "web_search", arguments: { query: "muaddib" } },
          ], "toolUse"),
        );
      }

      return streamWithMessage(makeAssistantMessage([{ type: "text", text: "done" }], "stop"));
    };

    const persistenceCalls: string[] = [];
    const completeSimpleFn = vi.fn(async () =>
      makeAssistantMessage(
        [{ type: "text", text: "Summary: Searched for muaddib references." }],
        "stop",
      ),
    );

    const runner = new MuaddibAgentRunner({
      model: "openai:gpt-4o-mini",
      systemPrompt: "summary test",
      streamFn,
      completeSimpleFn,
      tools: [
        {
          name: "web_search",
          label: "Web Search",
          description: "search",
          parameters: Type.Object({
            query: Type.String(),
          }),
          execute: async () => ({
            content: [{ type: "text", text: "Found docs at https://example.com/docs" }],
            details: {},
          }),
        },
      ],
    });

    const result = await runner.runSingleTurn("search", {
      persistenceSummaryModel: "openai:gpt-4o-mini",
      onPersistenceSummary: async (text) => {
        persistenceCalls.push(text);
      },
    });

    expect(result.text).toBe("done");
    expect(completeSimpleFn).toHaveBeenCalledTimes(1);
    expect(persistenceCalls).toEqual(["Summary: Searched for muaddib references."]);
  });

  it("treats chronicler/quest tool calls as persistent-summary inputs", async () => {
    let streamCallIndex = 0;

    const streamFn: StreamFn = async () => {
      streamCallIndex += 1;

      if (streamCallIndex === 1) {
        return streamWithMessage(
          makeAssistantMessage([
            {
              type: "toolCall",
              id: "tool-chronicle",
              name: "chronicle_read",
              arguments: { relative_chapter_id: -1 },
            },
          ], "toolUse"),
        );
      }

      if (streamCallIndex === 2) {
        return streamWithMessage(
          makeAssistantMessage([
            {
              type: "toolCall",
              id: "tool-quest",
              name: "quest_start",
              arguments: {
                id: "quest-1",
                goal: "Close parity",
                success_criteria: "done",
              },
            },
          ], "toolUse"),
        );
      }

      return streamWithMessage(makeAssistantMessage([{ type: "text", text: "done" }], "stop"));
    };

    const completeSimpleFn = vi.fn(async () =>
      makeAssistantMessage([{ type: "text", text: "Summary with chronicler + quest tools" }], "stop"),
    );

    const runner = new MuaddibAgentRunner({
      model: "openai:gpt-4o-mini",
      systemPrompt: "summary test",
      streamFn,
      completeSimpleFn,
      tools: [
        {
          name: "chronicle_read",
          label: "Chronicle Read",
          description: "read",
          parameters: Type.Object({
            relative_chapter_id: Type.Integer(),
          }),
          execute: async () => ({
            content: [{ type: "text", text: "# Arc: test" }],
            details: {},
          }),
        },
        {
          name: "quest_start",
          label: "Quest Start",
          description: "quest",
          parameters: Type.Object({
            id: Type.String(),
            goal: Type.String(),
            success_criteria: Type.String(),
          }),
          execute: async () => ({
            content: [{ type: "text", text: "REJECTED: quests runtime is deferred" }],
            details: {},
          }),
        },
      ],
    });

    const summaries: string[] = [];
    const result = await runner.runSingleTurn("do it", {
      persistenceSummaryModel: "openai:gpt-4o-mini",
      onPersistenceSummary: async (text) => {
        summaries.push(text);
      },
    });

    expect(result.text).toBe("done");
    expect(completeSimpleFn).toHaveBeenCalledTimes(1);
    expect(summaries).toEqual(["Summary with chronicler + quest tools"]);
  });

  it("does not invoke persistence summary callback when no persistent tools were used", async () => {
    const completeSimpleFn = vi.fn();
    const onPersistenceSummary = vi.fn();

    const runner = new MuaddibAgentRunner({
      model: "openai:gpt-4o-mini",
      systemPrompt: "summary test",
      streamFn: async () =>
        streamWithMessage(makeAssistantMessage([{ type: "text", text: "plain response" }], "stop")),
      completeSimpleFn: completeSimpleFn as any,
    });

    const result = await runner.runSingleTurn("hello", {
      persistenceSummaryModel: "openai:gpt-4o-mini",
      onPersistenceSummary,
    });

    expect(result.text).toBe("plain response");
    expect(completeSimpleFn).not.toHaveBeenCalled();
    expect(onPersistenceSummary).not.toHaveBeenCalled();
  });

  it("logs persistence-summary generation errors and keeps final response", async () => {
    let streamCallIndex = 0;

    const streamFn: StreamFn = async () => {
      streamCallIndex += 1;

      if (streamCallIndex === 1) {
        return streamWithMessage(
          makeAssistantMessage([
            { type: "toolCall", id: "tool-1", name: "web_search", arguments: { query: "muaddib" } },
          ], "toolUse"),
        );
      }

      return streamWithMessage(makeAssistantMessage([{ type: "text", text: "done" }], "stop"));
    };

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const runner = new MuaddibAgentRunner({
      model: "openai:gpt-4o-mini",
      systemPrompt: "summary test",
      streamFn,
      completeSimpleFn: vi.fn(async () => {
        throw new Error("summary model unavailable");
      }),
      logger,
      tools: [
        {
          name: "web_search",
          label: "Web Search",
          description: "search",
          parameters: Type.Object({
            query: Type.String(),
          }),
          execute: async () => ({
            content: [{ type: "text", text: "Found docs" }],
            details: {},
          }),
        },
      ],
    });

    const result = await runner.runSingleTurn("search", {
      persistenceSummaryModel: "openai:gpt-4o-mini",
      onPersistenceSummary: async () => {
        throw new Error("should not be called");
      },
    });

    expect(result.text).toBe("done");
    expect(logger.error).toHaveBeenCalledWith(
      "Failed to generate tool persistence summary:",
      "summary model unavailable",
    );
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

function streamWithErrorMessage(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({
      type: "error",
      reason: "error",
      error: message,
    });
  });
  return stream;
}

function makeAssistantMessage(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  usage?: Partial<Pick<AssistantMessage["usage"], "input" | "output">>,
  errorMessage?: string,
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
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

function cloneMessages(context: Context): Message[] {
  return JSON.parse(JSON.stringify(context.messages)) as Message[];
}

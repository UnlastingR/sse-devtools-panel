import { describe, expect, it } from "vitest";
import { detectAiProfile, vendorHintFromUrl } from "../../ai-profile";
import {
  ConversationMergeSession,
  conversationHasContent,
  mergeChatgptTurnGroup,
  mergeAiConversation,
  sanitizeChatgptAnswerText,
} from "../index";

function assert(cond: unknown, msg: string): asserts cond {
  expect(cond, msg).toBeTruthy();
}

describe("ai-merge", () => {
  it("reads Work thinking effort from server metadata", () => {
    const events = [
      {
        event: "delta",
        data: JSON.stringify({
          o: "add",
          v: {
            message: {
              id: "work-message",
              author: { role: "assistant" },
              content: { content_type: "text", parts: [""] },
              metadata: {
                working_turn_id: "work",
                turn_exchange_id: "turn",
                resolved_model_slug: "gpt-6-luna-wm",
              },
              recipient: "all",
            },
          },
          conversation_id: "conv",
        }),
        raw: "",
        index: 0,
        receivedAt: 1_000,
      },
      {
        event: "message",
        data: JSON.stringify({
          type: "server_ste_metadata",
          metadata: {
            requested_model_experience: "work",
            product_experience: "work",
            thinking_effort: "max",
          },
          conversation_id: "conv",
        }),
        raw: "",
        index: 1,
        receivedAt: 1_100,
      },
    ];
    const merged = mergeAiConversation(events, "https://chatgpt.com/backend-api/f/conversation");
    expect(merged.profile).toBe("chatgpt-web-work");
    expect(merged.endMeta.thinkingEffort).toBe("max");
  });

  it("inherits Work thinking effort from the request payload for short continuations", () => {
    const record = {
      requestId: "short-work",
      url: "https://chatgpt.com/backend-api/f/conversation",
      method: "POST",
      transport: "fetch" as const,
      streamKind: "sse" as const,
      startedAt: 1_000,
      endedAt: 2_000,
      streamStatus: "done" as const,
      requestPayloadPreview: JSON.stringify({ thinking_effort: "max" }),
      raw: "",
      events: [
        {
          event: "delta",
          data: JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "short-message",
                author: { role: "assistant" },
                content: { content_type: "text", parts: [""] },
                metadata: {
                  working_turn_id: "work",
                  turn_exchange_id: "turn",
                  resolved_model_slug: "gpt-6-luna-wm",
                },
                recipient: "all",
              },
            },
            conversation_id: "conv",
          }),
          raw: "",
          index: 0,
          receivedAt: 1_100,
        },
      ],
    };
    const grouped = mergeChatgptTurnGroup(record, [record]);
    expect(grouped?.conversation.profile).toBe("chatgpt-web-work");
    expect(grouped?.conversation.endMeta.thinkingEffort).toBe("max");
  });

  it("upgrades a ChatGPT web stream from chat to Work when later metadata arrives", () => {
    const session = new ConversationMergeSession();
    const url = "https://chatgpt.com/backend-api/f/conversation";
    const first = [
      {
        data: JSON.stringify({
          o: "add",
          v: {
            message: {
              id: "m1",
              author: { role: "assistant" },
              content: { content_type: "text", parts: [""] },
              metadata: { working_turn_id: "w", turn_exchange_id: "x" },
              recipient: "all",
            },
          },
          conversation_id: "conv",
        }),
        event: "delta",
        receivedAt: 1_000,
      },
    ];
    session.push(first, url);
    expect(session.snapshot().profile).toBe("chatgpt-web-chat");

    const full = [
      ...first,
      {
        data: JSON.stringify({
          type: "server_ste_metadata",
          metadata: {
            requested_model_experience: "work",
            product_experience: "work",
            turn_mode: "projects",
            temporal_conversation_turn: true,
          },
          conversation_id: "conv",
        }),
        event: "message",
        receivedAt: 2_000,
      },
    ];
    session.push(full, url);
    expect(session.snapshot().profile).toBe("chatgpt-web-work");
  });

  it("matches previous script coverage", () => {
    function ev(data: string, event = "message") {
      return { data, event };
    }

    {
      assert(
        vendorHintFromUrl("https://api.deepseek.com/chat/completions") === "deepseek",
        "deepseek host",
      );
      assert(
        vendorHintFromUrl("https://ark.cn-beijing.volces.com/api/v3/chat/completions") ===
          "doubao-ark",
        "doubao ark host",
      );
      assert(
        vendorHintFromUrl("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions") ===
          "qwen",
        "qwen host",
      );
      assert(
        vendorHintFromUrl("https://chatgpt.com/backend-api/f/conversation") === "openai",
        "chatgpt host",
      );
    }

    {
      const events = [
        ev("v1", "delta_encoding"),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "tool-a",
                author: { role: "assistant" },
                create_time: 101,
                content: { content_type: "code", text: "{}" },
                metadata: { reasoning_title: "阶段 A", reasoning_start_time: 100 },
                recipient: "web.run",
                channel: "commentary",
              },
            },
          }),
          "delta",
        ),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "tool-b",
                author: { role: "assistant" },
                create_time: 102,
                content: { content_type: "code", text: "{}" },
                metadata: {
                  reasoning_title: "阶段 B",
                  reasoning_start_time: 100,
                  parent_id: "tool-a",
                },
                recipient: "python",
                channel: "commentary",
              },
            },
          }),
          "delta",
        ),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "late-summary-a",
                author: { role: "assistant" },
                create_time: null,
                content: {
                  content_type: "thoughts",
                  thoughts: [{ summary: "阶段 A 摘要", content: "hidden", finished: true }],
                },
                metadata: {
                  inline_cot_expandable_content: { source_message_ids: ["tool-a"] },
                  reasoning_title: "阶段 A",
                },
                recipient: "all",
                channel: null,
              },
            },
          }),
          "delta",
        ),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "title-only-result",
                author: { role: "tool", name: "web.run" },
                create_time: null,
                content: { content_type: "text", parts: [""] },
                metadata: { reasoning_title: "空阶段" },
                recipient: "all",
                channel: null,
              },
            },
          }),
          "delta",
        ),
      ];
      const t = mergeAiConversation(events, "https://chatgpt.com/backend-api/f/conversation");
      const stages = t.channels.reasoningStages ?? [];
      assert(
        stages.length === 2,
        `delayed summaries should not duplicate stages: ${stages.length}`,
      );
      assert(stages[0]?.title === "阶段 A", "first stage preserved");
      assert(stages[0]?.elapsedSec !== undefined, "first stage keeps timestamp");
      assert(
        stages[0]?.items.some((item) => item.kind === "summary" && item.text === "阶段 A 摘要"),
        "late summary is attached back to original stage",
      );
      assert(stages[1]?.title === "阶段 B", "second stage preserved");
      assert(!stages.some((stage) => stage.title === "空阶段"), "title-only stage is omitted");
    }

    {
      const events = [
        ev("v1", "delta_encoding"),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "timed-tool",
                author: { role: "assistant" },
                create_time: 130,
                content: { content_type: "code", text: "{}" },
                metadata: { reasoning_start_time: 100, reasoning_title: "执行工作流日志读取" },
                recipient: "python",
                channel: "commentary",
              },
            },
          }),
          "delta",
        ),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "untimed-summary",
                author: { role: "assistant" },
                create_time: null,
                content: {
                  content_type: "thoughts",
                  thoughts: [
                    { summary: "轮询获取并修复工作流运行日志", content: "", finished: true },
                  ],
                },
                metadata: {
                  reasoning_title: "获取并修复工作流日志",
                  inline_cot_expandable_content: { source_message_ids: ["timed-tool"] },
                },
                recipient: "all",
                channel: null,
              },
            },
          }),
          "delta",
        ),
      ];
      const t = mergeAiConversation(events, "https://chatgpt.com/backend-api/f/conversation");
      const stage = (t.channels.reasoningStages ?? []).find(
        (item) => item.title === "获取并修复工作流日志",
      );
      assert(
        stage?.elapsedSec === 30,
        `untimed summary stage inherits source time: ${stage?.elapsedSec}`,
      );
      assert(
        t.channels.reasoning.includes("+30.0s  阶段 · 获取并修复工作流日志"),
        "untimed summary stage renders inherited timestamp",
      );
    }

    {
      const events = [
        ev("v1", "delta_encoding"),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "devspace-wrapper",
                author: { role: "assistant" },
                create_time: 201,
                content: { content_type: "text", parts: [""] },
                metadata: {
                  is_visually_hidden_from_conversation: true,
                  reasoning_title: "打开工作区",
                  reasoning_start_time: 200,
                },
                recipient: "functions.exec",
                channel: "commentary",
              },
            },
          }),
          "delta",
        ),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "devspace-call",
                author: { role: "assistant" },
                create_time: 202,
                content: {
                  content_type: "code",
                  text: JSON.stringify({
                    path: "/Devspace/link-test/open_workspace",
                    args: { path: "/root/codex/project", mode: "checkout" },
                  }),
                },
                metadata: {
                  parent_id: "devspace-wrapper",
                  connector_tool_payload: JSON.stringify({
                    path: "/root/codex/project",
                    mode: "checkout",
                  }),
                  chatgpt_sdk: {
                    resource_name: "Devspace_open_workspace",
                    html_asset_pointer: "ui://devspace/workspace-app/v2.html",
                    action_name: "open_workspace",
                  },
                },
                recipient: "api_tool.call_tool",
                channel: null,
              },
            },
          }),
          "delta",
        ),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "devspace-result",
                author: { role: "tool", name: "api_tool.call_tool" },
                create_time: 203,
                content: { content_type: "code", text: "{}" },
                metadata: {
                  parent_id: "devspace-call",
                  invoked_resource: {
                    resource_uri: "/asdk_app/link/open_workspace",
                    contains_mcp_source: true,
                    app_name: "Devspace",
                  },
                },
                recipient: "all",
                channel: "commentary",
              },
            },
          }),
          "delta",
        ),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "final-widget",
                author: { role: "assistant" },
                create_time: 204,
                content: { content_type: "text", parts: ["widget"] },
                metadata: {
                  parent_id: "devspace-result",
                  content_references: [],
                },
                recipient: "all",
                channel: "final",
              },
            },
          }),
          "delta",
        ),
        ev(
          JSON.stringify({
            p: "/message/metadata/content_references",
            o: "append",
            v: [
              {
                matched_text: '\uE200genui\uE202{"chart":{',
                type: "hidden",
                invalid: true,
              },
            ],
          }),
          "delta",
        ),
        ev(
          JSON.stringify({
            p: "",
            o: "patch",
            v: [
              {
                p: "/message/metadata/content_references/0/type",
                o: "replace",
                v: "client_defined_widget",
              },
              {
                p: "/message/metadata/content_references/0/invalid",
                o: "remove",
              },
              {
                p: "/message/metadata/content_references/0",
                o: "append",
                v: {
                  category: "visualization",
                  data: {
                    widget_type: "charts_widget_v2",
                    language: "recharts-json",
                    content: { chartType: "bar" },
                  },
                },
              },
            ],
          }),
          "delta",
        ),
      ];
      const t = mergeAiConversation(events, "https://chatgpt.com/backend-api/f/conversation");
      assert(t.channels.tools.length === 2, "APP UI tool plus client widget are both listed");
      const appUi = t.channels.tools[0];
      assert(appUi?.provider === "Devspace", "Devspace provider preserved");
      assert(appUi?.kind === "app" && appUi?.source === "mcp", "Devspace remains APP MCP");
      assert(appUi?.presentation === "app_ui", "Devspace UI card is marked as APP UI");
      assert(
        appUi?.uiResource === "ui://devspace/workspace-app/v2.html",
        "Devspace UI resource preserved",
      );
      const widget = t.channels.tools[1];
      assert(widget?.provider === "chart" && widget?.kind === "widget", "chart widget detected");
      assert(widget?.widgetCategory === "visualization", "widget category preserved");
      assert(widget?.widgetType === "charts_widget_v2", "widget implementation preserved");
      assert(widget?.presentation === "client_widget", "client widget presentation preserved");
      const reasoningTools = (t.channels.reasoningStages ?? []).flatMap((stage) =>
        stage.items.filter((item) => item.kind === "tool"),
      );
      assert(
        reasoningTools.some(
          (item) => item.toolId === appUi?.id && item.text.includes("APP · MCP · UI"),
        ),
        "APP UI card is linked from reasoning",
      );
      assert(
        reasoningTools.some(
          (item) => item.toolId === widget?.id && item.text.includes("WIDGET · VISUALIZATION"),
        ),
        "client widget is linked from reasoning",
      );
    }

    {
      const events = [
        ev("v1", "delta_encoding"),
        ev(
          JSON.stringify({
            v: {
              message: {
                id: "hidden-progress",
                author: { role: "assistant" },
                content: { content_type: "text", parts: ["Cam"] },
                metadata: { resolved_model_slug: "gpt-5-6-thinking" },
                recipient: "all",
                channel: "commentary",
              },
            },
          }),
          "delta",
        ),
        ev(JSON.stringify({ p: "/message/content/parts/0", o: "append", v: "ou" }), "delta"),
        ev(
          JSON.stringify({
            p: "",
            o: "patch",
            v: [
              { p: "/message/content/parts/0", o: "append", v: "fox。" },
              {
                p: "/message/metadata",
                o: "append",
                v: { is_visually_hidden_from_conversation: true },
              },
            ],
          }),
          "delta",
        ),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "progress",
                author: { role: "assistant" },
                content: { content_type: "text", parts: ["正在检查"] },
                metadata: { is_thinking_preamble_message: true },
                recipient: "all",
                channel: "commentary",
              },
            },
          }),
          "delta",
        ),
        ev(JSON.stringify({ p: "/message/content/parts/0", o: "append", v: "。" }), "delta"),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "tool-call",
                author: { role: "assistant" },
                content: { content_type: "code", text: '{"query":"status"}' },
                metadata: {},
                recipient: "functions.exec",
                channel: "commentary",
              },
            },
          }),
          "delta",
        ),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "final",
                author: { role: "assistant" },
                content: { content_type: "text", parts: ["`a"] },
                metadata: {
                  resolved_model_slug: "gpt-5-6-thinking",
                  thinking_effort: "extended",
                },
                recipient: "all",
                channel: "final",
              },
            },
          }),
          "delta",
        ),
        ev(JSON.stringify({ p: "/message/content/parts/0", o: "append", v: "istudio" }), "delta"),
        ev(JSON.stringify({ v: "-to-api`" }), "delta"),
        ev(
          JSON.stringify({
            p: "",
            o: "patch",
            v: [
              { p: "/message/content/parts/0", o: "append", v: " 正常。" },
              { p: "/message/status", o: "replace", v: "finished_successfully" },
              { p: "/message/end_turn", o: "replace", v: true },
            ],
          }),
          "delta",
        ),
        ev(JSON.stringify({ type: "message_stream_complete" })),
        ev("[DONE]"),
      ];
      const det = detectAiProfile(events, "https://chatgpt.com/backend-api/f/conversation");
      assert(det.profile === "chatgpt-web-chat", `chatgpt profile got ${det.profile}`);
      assert(det.vendorHint === "openai", `chatgpt vendor got ${det.vendorHint}`);
      const t = mergeAiConversation(events, "https://chatgpt.com/backend-api/f/conversation");
      assert(
        t.channels.content === "`aistudio-to-api` 正常。",
        `chatgpt content: ${t.channels.content}`,
      );
      assert(!t.channels.content.includes("Camoufox"), "hidden commentary must be excluded");
      assert(
        t.channels.reasoning.includes("说明 · 正在检查。"),
        `chatgpt reasoning: ${t.channels.reasoning}`,
      );
      assert(t.channels.tools.length === 1, `chatgpt tools: ${t.channels.tools.length}`);
      assert(t.channels.tools[0]?.name === "functions.exec", "chatgpt tool name");
      assert(t.endMeta.model === "gpt-5-6-thinking", "chatgpt model");
      assert(t.endMeta.thinkingEffort === "extended", "chatgpt thinking effort");
      assert(t.endMeta.finishReason === "stop", "chatgpt finish");

      const rich =
        '正文\n\uE200cite\uE202turn1news2\uE201\n\uE200navlist\uE202继续阅读\uE202turn1news2\uE201\n\uE200genui\uE202{"x":1}\uE201';
      assert(sanitizeChatgptAnswerText(rich).trim() === "正文", "chatgpt rich markers stripped");
    }

    {
      const events = [
        ev("v1", "delta_encoding"),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "outer",
                author: { role: "assistant" },
                content: { content_type: "text", parts: [""] },
                metadata: {},
                recipient: "functions.exec",
                channel: "commentary",
              },
            },
          }),
          "delta",
        ),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "connector",
                author: { role: "assistant" },
                content: {
                  content_type: "code",
                  text: JSON.stringify({
                    path: "/Devspace/link_x/read",
                    args: { workspaceId: "ws", path: "a.ts" },
                  }),
                },
                metadata: {
                  parent_id: "outer",
                  connector_tool_payload: '{"workspaceId":"ws","path":"a.ts"}',
                },
                recipient: "api_tool.call_tool",
                channel: null,
              },
            },
          }),
          "delta",
        ),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "connector-result",
                author: { role: "tool", name: "api_tool.call_tool" },
                content: { content_type: "code", text: '{"result":"ok"}' },
                metadata: {
                  parent_id: "connector",
                  invoked_plugin: {},
                  invoked_resource: {
                    app_name: "Devspace",
                    contains_mcp_source: true,
                    resource_uri: "/asdk_app_x/link_y/read",
                  },
                },
                recipient: "all",
                channel: "commentary",
              },
            },
          }),
          "delta",
        ),
      ];
      const t = mergeAiConversation(events, "https://chatgpt.com/backend-api/f/conversation");
      assert(t.channels.tools.length === 1, `connector tools: ${t.channels.tools.length}`);
      assert(t.channels.tools[0]?.name === "functions.exec", "outer logical tool name");
      assert(t.channels.tools[0]?.arguments.includes('"path":"a.ts"'), "connector args merged");
      assert(t.channels.tools[0]?.provider === "Devspace", "connector app name restored");
      assert(t.channels.tools[0]?.kind === "app", "connector classified as app");
      assert(t.channels.tools[0]?.source === "mcp", "connector source restored");
      assert(t.channels.tools[0]?.operation === "read", "connector operation restored");
    }

    {
      const events = [
        ev("v1", "delta_encoding"),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "orphan-wrapper",
                author: { role: "assistant" },
                content: { content_type: "text", parts: [""] },
                metadata: { is_visually_hidden_from_conversation: true },
                recipient: "functions.exec",
                channel: "commentary",
              },
            },
          }),
          "delta",
        ),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "zotero-wrapper",
                author: { role: "assistant" },
                content: { content_type: "text", parts: [""] },
                metadata: { is_visually_hidden_from_conversation: true },
                recipient: "functions.exec",
                channel: "commentary",
              },
            },
          }),
          "delta",
        ),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "zotero-api",
                author: { role: "assistant" },
                content: {
                  content_type: "code",
                  text: JSON.stringify({
                    path: "/zotero-mcp/link_x/zotero-mcp_search_library",
                    args: { q: "ship track cloud" },
                  }),
                },
                metadata: {
                  parent_id: "zotero-wrapper",
                  connector_tool_payload: '{"q":"ship track cloud"}',
                },
                recipient: "api_tool.call_tool",
                channel: null,
              },
            },
          }),
          "delta",
        ),
      ];
      const t = mergeAiConversation(events, "https://chatgpt.com/backend-api/f/conversation");
      assert(t.channels.tools.length === 1, `zotero tools: ${t.channels.tools.length}`);
      assert(t.channels.tools[0]?.provider === "zotero-mcp", "zotero provider inferred");
      assert(t.channels.tools[0]?.kind === "app", "zotero classified as app");
      assert(t.channels.tools[0]?.source === undefined, "unknown app source stays unknown");
      assert(
        t.channels.tools[0]?.operation === "zotero-mcp_search_library",
        "zotero operation inferred",
      );
      assert(t.channels.tools[0]?.arguments.includes("ship track cloud"), "zotero args preserved");
    }

    {
      const events = [
        ev("v1", "delta_encoding"),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "web-call",
                author: { role: "assistant" },
                content: { content_type: "text", parts: [""] },
                metadata: {},
                recipient: "web.run",
                channel: null,
              },
            },
          }),
          "delta",
        ),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "web-query",
                author: { role: "tool", name: "web.run" },
                content: { content_type: "text", parts: [""] },
                metadata: {
                  parent_id: "web-call",
                  search_model_queries: { queries: ["alpha", "beta"] },
                },
                recipient: "all",
              },
            },
          }),
          "delta",
        ),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "web-results",
                author: { role: "tool", name: "web.run" },
                content: { content_type: "text", parts: [""] },
                metadata: {
                  parent_id: "web-query",
                  search_result_groups: [
                    {
                      domain: "example.com",
                      entries: [
                        {
                          title: "Example",
                          url: "https://example.com/a",
                          snippet: "snippet",
                          attribution: "example.com",
                          ref_id: { turn_index: 1, ref_type: "search", ref_index: 2 },
                        },
                      ],
                    },
                  ],
                },
                recipient: "all",
              },
            },
          }),
          "delta",
        ),
      ];
      const t = mergeAiConversation(events, "https://chatgpt.com/backend-api/f/conversation");
      assert(t.channels.tools.length === 1, `web tools: ${t.channels.tools.length}`);
      assert(t.channels.tools[0]?.provider === "web.run", "web provider restored");
      assert(t.channels.tools[0]?.kind === "search", "web classified as search");
      const args = JSON.parse(t.channels.tools[0]!.arguments);
      assert(args.queries.length === 2, "web queries restored");
      assert(args.results.length === 1, "web results restored");
      assert(args.results[0].cite_index === undefined, "internal web citation id hidden");
    }

    {
      const events = [
        ev("v1", "delta_encoding"),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "recall-before-web",
                author: { role: "assistant" },
                content: { content_type: "code", text: '{"query":"context"}' },
                metadata: { request_id: "req-1", working_turn_id: "turn-1" },
                recipient: "q7dr546",
              },
            },
          }),
          "delta",
        ),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "recall-summary-before-web",
                author: { role: "assistant" },
                content: {
                  content_type: "thoughts",
                  thoughts: [{ summary: "恢复上下文", content: "", finished: true }],
                },
                metadata: {
                  parent_id: "recall-before-web",
                  request_id: "req-1",
                  working_turn_id: "turn-1",
                  inline_cot_expandable_content: { source_message_ids: ["recall-before-web"] },
                  tool_summary_type: "personal_context",
                },
                recipient: "all",
              },
            },
          }),
          "delta",
        ),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "standalone-web",
                author: { role: "tool", name: "web.run" },
                content: { content_type: "text", parts: [""] },
                metadata: {
                  parent_id: "recall-summary-before-web",
                  request_id: "req-1",
                  working_turn_id: "turn-1",
                  reasoning_title: "正在搜索 OpenAI official site",
                  search_model_queries: { queries: ["OpenAI official site"] },
                },
                recipient: "all",
              },
            },
          }),
          "delta",
        ),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "final-with-search-results",
                author: { role: "assistant" },
                content: { content_type: "text", parts: ["done"] },
                metadata: {
                  request_id: "req-1",
                  working_turn_id: "turn-1",
                  search_result_groups: [
                    {
                      domain: "openai.com",
                      entries: [
                        {
                          title: "OpenAI Status",
                          url: "https://status.openai.com/",
                          snippet: "Operational",
                          attribution: "openai.com",
                        },
                      ],
                    },
                  ],
                },
                recipient: "all",
                channel: "final",
                end_turn: true,
              },
            },
          }),
          "delta",
        ),
      ];
      const t = mergeAiConversation(events, "https://chatgpt.com/backend-api/f/conversation");
      assert(t.channels.tools.length === 2, `standalone web tools: ${t.channels.tools.length}`);
      assert(t.channels.tools[1]?.provider === "web.run", "standalone web provider restored");
      assert(t.channels.tools[1]?.kind === "search", "standalone web classified as search");
      const args = JSON.parse(t.channels.tools[1]!.arguments);
      assert(args.queries.length === 1, "standalone web query restored");
      assert(args.results.length === 1, "standalone web results restored from same turn");
      assert(
        t.channels.reasoning.includes("工具 · web.run · SEARCH · 1 个查询 / 1 个结果"),
        "standalone web appears in reasoning timeline",
      );
    }

    {
      const events = [
        ev("v1", "delta_encoding"),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "view-result",
                author: { role: "tool", name: "web.run" },
                content: { content_type: "text", parts: [""] },
                metadata: {
                  request_id: "req-view",
                  working_turn_id: "turn-view",
                  search_model_queries: { queries: [] },
                  search_result_groups: [
                    {
                      domain: "energy.gov",
                      entries: [
                        {
                          title: "Energy page",
                          url: "https://energy.gov/page",
                          snippet: "one page",
                          ref_id: { ref_type: "view", ref_index: 0 },
                        },
                      ],
                    },
                  ],
                },
                recipient: "all",
              },
            },
          }),
          "delta",
        ),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "final-union",
                author: { role: "assistant" },
                content: { content_type: "text", parts: ["done"] },
                metadata: {
                  request_id: "req-view",
                  working_turn_id: "turn-view",
                  search_result_groups: [
                    {
                      domain: "example.com",
                      entries: Array.from({ length: 97 }, (_, i) => ({
                        title: `Historical ${i}`,
                        url: `https://example.com/${i}`,
                        snippet: "old search result",
                      })),
                    },
                  ],
                },
                recipient: "all",
                channel: "final",
                end_turn: true,
              },
            },
          }),
          "delta",
        ),
      ];
      const t = mergeAiConversation(events, "https://chatgpt.com/backend-api/f/conversation");
      const view = t.channels.tools.find((tool) => tool.provider === "web.run");
      assert(view?.operation === "VIEW", "standalone result-only web call classified as VIEW");
      const args = JSON.parse(view!.arguments);
      assert(args.results.length === 1, "VIEW keeps only its direct result groups");
    }

    {
      const events = [
        ev("v1", "delta_encoding"),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "files-wrapper",
                author: { role: "assistant" },
                content: { content_type: "text", parts: [""] },
                metadata: {},
                recipient: "functions.exec",
                channel: "commentary",
              },
            },
          }),
          "delta",
        ),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "files-api",
                author: { role: "assistant" },
                content: {
                  content_type: "code",
                  text: JSON.stringify({ path: "/files/find", args: { find: [] } }),
                },
                metadata: { parent_id: "files-wrapper", connector_tool_payload: '{"find":[]}' },
                recipient: "api_tool.call_tool",
                channel: null,
              },
            },
          }),
          "delta",
        ),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "files-result",
                author: { role: "tool", name: "api_tool.call_tool" },
                content: { content_type: "code", text: "{}" },
                metadata: {
                  parent_id: "files-api",
                  invoked_resource: {
                    resource_uri: "/files/find",
                    contains_mcp_source: false,
                  },
                },
                recipient: "all",
                channel: "commentary",
              },
            },
          }),
          "delta",
        ),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "python-call",
                author: { role: "assistant" },
                content: { content_type: "code", text: "sum([1,2,3,4])" },
                metadata: {},
                recipient: "python",
                channel: "commentary",
              },
            },
          }),
          "delta",
        ),
      ];
      const t = mergeAiConversation(events, "https://chatgpt.com/backend-api/f/conversation");
      assert(t.channels.tools.length === 2, `builtin tools: ${t.channels.tools.length}`);
      assert(t.channels.tools[0]?.provider === "files", "files provider restored");
      assert(t.channels.tools[0]?.kind === "builtin", "files classified as builtin");
      assert(t.channels.tools[0]?.operation === "find", "files operation restored");
      assert(t.channels.tools[1]?.provider === "python", "python provider restored");
      assert(t.channels.tools[1]?.kind === "builtin", "python classified as builtin");
    }

    {
      const events = [
        ev("v1", "delta_encoding"),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "container-call",
                author: { role: "assistant" },
                content: { content_type: "code", text: '{"cmd":["git","status"]}' },
                metadata: {},
                recipient: "container.exec",
                channel: "analysis",
              },
            },
          }),
          "delta",
        ),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "container-result",
                author: { role: "tool", name: "container.exec" },
                content: { content_type: "execution_output", text: "container-exec-sse-probe\n" },
                metadata: { parent_id: "container-call" },
                recipient: "all",
                channel: null,
              },
            },
          }),
          "delta",
        ),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "container-summary",
                author: { role: "assistant" },
                content: {
                  content_type: "thoughts",
                  thoughts: [{ summary: "执行容器连通性探测", content: "", finished: true }],
                },
                metadata: {
                  inline_cot_expandable_content: {
                    source_message_ids: ["container-call", "container-result"],
                  },
                  tool_summary_type: "container",
                  parent_id: "container-result",
                },
                recipient: "all",
                channel: null,
              },
            },
          }),
          "delta",
        ),
      ];
      const t = mergeAiConversation(events, "https://chatgpt.com/backend-api/f/conversation");
      assert(t.channels.tools.length === 1, `container tools: ${t.channels.tools.length}`);
      assert(t.channels.tools[0]?.name === "container.exec", "raw container recipient preserved");
      assert(t.channels.tools[0]?.provider === "container", "container provider normalized");
      assert(t.channels.tools[0]?.kind === "builtin", "container classified as builtin");
      assert(t.channels.tools[0]?.operation === "exec", "container operation extracted");
      assert(
        t.channels.reasoning.includes("工具 · container · BUILTIN · exec"),
        "container gets builtin reasoning label",
      );
    }

    {
      const events = [
        ev("v1", "delta_encoding"),
        ...[
          ["family", "safety_settings.get_family_info"],
          ["trusted", "safety_settings.get_trusted_contact"],
          ["genui", "genui.search"],
          ["automation", "automations.peek"],
          ["summary", "summary_reader.read"],
        ].map(([id, recipient]) =>
          ev(
            JSON.stringify({
              o: "add",
              v: {
                message: {
                  id,
                  author: { role: "assistant" },
                  content: { content_type: "code", text: "{}" },
                  metadata: {},
                  recipient,
                  channel: "commentary",
                },
              },
            }),
            "delta",
          ),
        ),
      ];
      const t = mergeAiConversation(events, "https://chatgpt.com/backend-api/f/conversation");
      assert(t.channels.tools.length === 5, `direct builtin tools: ${t.channels.tools.length}`);
      assert(t.channels.tools[0]?.provider === "safety_settings", "safety provider normalized");
      assert(t.channels.tools[0]?.kind === "builtin", "safety classified as builtin");
      assert(t.channels.tools[0]?.operation === "get_family_info", "safety operation extracted");
      assert(t.channels.tools[2]?.provider === "genui", "genui provider normalized");
      assert(t.channels.tools[2]?.operation === "search", "genui operation extracted");
      assert(t.channels.tools[3]?.provider === "automations", "automations provider normalized");
      assert(t.channels.tools[4]?.provider === "summary_reader", "summary reader normalized");
    }

    {
      const events = [
        ev("v1", "delta_encoding"),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "recall-call",
                author: { role: "assistant" },
                content: {
                  content_type: "code",
                  text: JSON.stringify({ query: "find the previous SSE DevTools discussion" }),
                },
                metadata: {},
                recipient: "q7dr546",
                channel: "commentary",
              },
            },
          }),
          "delta",
        ),
      ];
      const t = mergeAiConversation(events, "https://chatgpt.com/backend-api/f/conversation");
      assert(t.channels.tools.length === 1, `recall tools: ${t.channels.tools.length}`);
      assert(t.channels.tools[0]?.name === "q7dr546", "raw opaque recall recipient preserved");
      assert(t.channels.tools[0]?.provider === "RECALL", "recall gets stable uppercase label");
      assert(t.channels.tools[0]?.kind === "builtin", "recall classified as builtin");
      assert(t.channels.tools[0]?.operation === "SEARCH", "recall operation normalized");
      assert(
        t.channels.reasoning.includes("工具 · RECALL · BUILTIN · SEARCH"),
        "reasoning uses stable recall identity",
      );
    }

    {
      const events = [
        ev("v1", "delta_encoding"),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "recall-call",
                author: { role: "assistant" },
                create_time: 100,
                content: {
                  content_type: "code",
                  text: JSON.stringify({ query: "restore prior SSE context" }),
                },
                metadata: { reasoning_start_time: 100, reasoning_title: "正在回忆" },
                recipient: "q7dr546",
                channel: "commentary",
              },
            },
          }),
          "delta",
        ),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "recall-summary",
                author: { role: "assistant" },
                create_time: 101,
                content: {
                  content_type: "thoughts",
                  thoughts: [{ summary: "恢复了对话上下文", content: "hidden", finished: true }],
                },
                metadata: {
                  parent_id: "recall-call",
                  inline_cot_expandable_content: { source_message_ids: ["recall-call"] },
                  tool_summary_type: "personal_context",
                },
                recipient: "all",
                channel: null,
              },
            },
          }),
          "delta",
        ),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "after-recall",
                author: { role: "assistant" },
                create_time: 102,
                content: { content_type: "text", parts: ["继续验证 SSE logical turn"] },
                metadata: {},
                recipient: "all",
                channel: "commentary",
              },
            },
          }),
          "delta",
        ),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "after-tool",
                author: { role: "assistant" },
                create_time: 103,
                content: { content_type: "code", text: "{}" },
                metadata: { parent_id: "after-recall" },
                recipient: "functions.exec",
                channel: "commentary",
              },
            },
          }),
          "delta",
        ),
      ];
      const t = mergeAiConversation(events, "https://chatgpt.com/backend-api/f/conversation");
      assert(t.channels.reasoningStages?.length === 2, "recall summary closes its stage");
      assert(t.channels.reasoningStages?.[0]?.title === "正在回忆", "recall stage keeps title");
      assert(
        t.channels.reasoningStages?.[0]?.items.some(
          (item) => item.kind === "summary" && item.text === "恢复了对话上下文",
        ),
        "recall summary stays in recall stage",
      );
      assert(
        t.channels.reasoningStages?.[1]?.title === "",
        "post-recall work starts a fresh stage",
      );
      assert(
        t.channels.reasoningStages?.[1]?.items.some(
          (item) => item.kind === "commentary" && item.text.includes("继续验证 SSE"),
        ),
        "post-recall commentary is not grouped under recall",
      );
      assert(
        t.channels.reasoningStages?.[1]?.items.some(
          (item) => item.kind === "tool" && item.text.includes("functions.exec"),
        ),
        "post-recall tools stay with the new stage",
      );
    }

    {
      const events = [
        ev("v1", "delta_encoding"),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "ordinary-summary",
                author: { role: "assistant" },
                create_time: 100,
                content: {
                  content_type: "thoughts",
                  thoughts: [{ summary: "整理验证方向", content: "hidden", finished: true }],
                },
                metadata: { reasoning_start_time: 100 },
                recipient: "all",
                channel: null,
              },
            },
          }),
          "delta",
        ),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "ordinary-commentary",
                author: { role: "assistant" },
                create_time: 101,
                content: { content_type: "text", parts: ["继续检查同一阶段"] },
                metadata: {},
                recipient: "all",
                channel: "commentary",
              },
            },
          }),
          "delta",
        ),
      ];
      const t = mergeAiConversation(events, "https://chatgpt.com/backend-api/f/conversation");
      assert(t.channels.reasoningStages?.length === 1, "ordinary summary does not close stage");
      assert(
        t.channels.reasoningStages?.[0]?.items.some(
          (item) => item.kind === "commentary" && item.text === "继续检查同一阶段",
        ),
        "ordinary follow-up remains in the same stage",
      );
    }

    {
      const events = [
        ev("v1", "delta_encoding"),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "web-1",
                author: { role: "assistant" },
                create_time: 100,
                content: { content_type: "text", parts: [""] },
                metadata: { reasoning_start_time: 100, reasoning_title: "搜索网页" },
                recipient: "web.run",
                channel: null,
              },
            },
          }),
          "delta",
        ),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "result-1",
                author: { role: "tool", name: "web.run" },
                create_time: 101,
                content: { content_type: "text", parts: [""] },
                metadata: {
                  parent_id: "web-1",
                  reasoning_title: "正在搜索 first query",
                  search_model_queries: { queries: ["first query"] },
                  search_result_groups: [
                    {
                      domain: "one.example",
                      entries: [{ title: "One", url: "https://one.example", snippet: "one" }],
                    },
                  ],
                },
                recipient: "all",
              },
            },
          }),
          "delta",
        ),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "web-2",
                author: { role: "assistant" },
                create_time: 102,
                content: { content_type: "text", parts: [""] },
                metadata: { parent_id: "result-1", reasoning_title: "补充搜索" },
                recipient: "web.run",
                channel: null,
              },
            },
          }),
          "delta",
        ),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "result-2",
                author: { role: "tool", name: "web.run" },
                create_time: 103,
                content: { content_type: "text", parts: [""] },
                metadata: {
                  parent_id: "web-2",
                  search_model_queries: { queries: ["second query"] },
                  search_result_groups: [
                    {
                      domain: "two.example",
                      entries: [{ title: "Two", url: "https://two.example", snippet: "two" }],
                    },
                  ],
                },
                recipient: "all",
              },
            },
          }),
          "delta",
        ),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "summary",
                author: { role: "assistant" },
                create_time: 104,
                content: {
                  content_type: "thoughts",
                  thoughts: [{ summary: "已完成两轮搜索", content: "", finished: true }],
                },
                metadata: { parent_id: "result-2" },
                recipient: "all",
                channel: null,
              },
            },
          }),
          "delta",
        ),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "recap",
                author: { role: "assistant" },
                create_time: 105,
                content: { content_type: "reasoning_recap", content: "思考了 2m 13s" },
                metadata: { parent_id: "summary", finished_duration_sec: 133 },
                recipient: "all",
                channel: null,
              },
            },
          }),
          "delta",
        ),
      ];
      const t = mergeAiConversation(events, "https://chatgpt.com/backend-api/f/conversation");
      assert(t.channels.tools.length === 2, `separate web tools: ${t.channels.tools.length}`);
      const first = JSON.parse(t.channels.tools[0]!.arguments);
      const second = JSON.parse(t.channels.tools[1]!.arguments);
      assert(first.queries.join() === "first query", "first web call owns only first query");
      assert(first.results.length === 1 && first.results[0].title === "One", "first web results");
      assert(second.queries.join() === "second query", "second web call owns only second query");
      assert(
        second.results.length === 1 && second.results[0].title === "Two",
        "second web results",
      );
      assert(t.channels.reasoning.includes("阶段 · 搜索网页"), "reasoning stage included");
      assert(
        t.channels.reasoning.includes("工具 · web.run · SEARCH · 1 个查询 / 1 个结果"),
        "tool trace included",
      );
      assert(t.channels.reasoning.includes("摘要 · 已完成两轮搜索"), "summary included");
      assert(t.channels.reasoningStages?.length === 2, "two structured reasoning stages");
      assert(t.channels.reasoningStages?.[0]?.title === "搜索网页", "first stage title");
      assert(t.channels.reasoningStages?.[1]?.title === "补充搜索", "second stage title");
      assert(
        t.channels.reasoningStages?.[0]?.items.some(
          (item) => item.kind === "tool" && item.toolId === "web-1",
        ),
        "reasoning tool keeps logical tool id for navigation",
      );
      assert(
        t.channels.reasoningStages?.[1]?.items.some(
          (item) => item.kind === "summary" && item.text === "已完成两轮搜索",
        ),
        "summary grouped under second stage",
      );
      assert(t.channels.reasoning.includes("总思考时间：133s"), "duration included");
      assert(!t.channels.reasoning.includes("思考了 2m 13s"), "duration recap de-duplicated");
    }

    {
      const events = [
        ev("v1", "delta_encoding"),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "thoughts",
                author: { role: "assistant" },
                content: {
                  content_type: "thoughts",
                  thoughts: [{ summary: "第一步", content: "hidden", finished: true }],
                },
                metadata: {},
                recipient: "all",
                channel: null,
              },
            },
          }),
          "delta",
        ),
        ev(
          JSON.stringify({
            p: "/message/content/thoughts",
            o: "append",
            v: [{ summary: "第二步", content: "hidden too", finished: true }],
          }),
          "delta",
        ),
      ];
      const t = mergeAiConversation(events, "https://chatgpt.com/backend-api/f/conversation");
      assert(
        t.channels.reasoning.includes("摘要 · 第一步"),
        `first summary: ${t.channels.reasoning}`,
      );
      assert(
        t.channels.reasoning.includes("摘要 · 第二步"),
        `second summary: ${t.channels.reasoning}`,
      );
      assert(t.channels.reasoningStages?.length === 1, "unclassified thoughts use one stage");
      assert(
        t.channels.reasoningStages?.[0]?.items.filter((item) => item.kind === "summary").length ===
          2,
        "all summary revisions are preserved",
      );
      assert(!t.channels.reasoning.includes("hidden"), "private thought content must not leak");
    }

    {
      const events = [
        ev("v1", "delta_encoding"),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "summary-revisions",
                author: { role: "assistant" },
                content: {
                  content_type: "thoughts",
                  thoughts: [{ summary: "整理分阶段思路", content: "hidden", finished: true }],
                },
                metadata: {},
                recipient: "all",
                channel: null,
              },
            },
          }),
          "delta",
        ),
        ev(
          JSON.stringify({
            p: "/message/content/thoughts",
            o: "append",
            v: [{ summary: "整理了分阶段思路", content: "hidden too", finished: true }],
          }),
          "delta",
        ),
      ];
      const t = mergeAiConversation(events, "https://chatgpt.com/backend-api/f/conversation");
      const summaries =
        t.channels.reasoningStages?.[0]?.items
          .filter((item) => item.kind === "summary")
          .map((item) => item.text) ?? [];
      assert(summaries.length === 2, "similar summary revisions are not deduplicated");
      assert(summaries[0] === "整理分阶段思路", "first summary revision preserved");
      assert(summaries[1] === "整理了分阶段思路", "second summary revision preserved");
    }

    {
      const fileEvents = [
        ev(
          JSON.stringify({
            file_id: "file_1",
            event: "file.processing.started",
            progress: 0,
          }),
        ),
        ev(
          JSON.stringify({
            file_id: "file_1",
            event: "file.processing.completed",
            progress: 100,
          }),
        ),
      ];
      const fileStream = mergeAiConversation(
        fileEvents,
        "https://chatgpt.com/backend-api/files/process_upload_stream",
      );
      assert(fileStream.profile === "generic", `file stream profile: ${fileStream.profile}`);

      const resume = detectAiProfile(
        [ev("v1", "delta_encoding")],
        "https://chatgpt.com/backend-api/f/conversation/resume",
      );
      assert(resume.profile === "generic", "ambiguous resume bootstrap does not lock subtype");

      const normalChat = detectAiProfile(
        [
          ev("v1", "delta_encoding"),
          ev(
            JSON.stringify({
              o: "add",
              v: {
                message: {
                  id: "chat-message",
                  author: { role: "assistant" },
                  content: { content_type: "text", parts: [""] },
                  metadata: { working_turn_id: "chat-turn" },
                  recipient: "all",
                },
              },
              conversation_id: "conv",
            }),
            "delta",
          ),
        ],
        "https://chatgpt.com/backend-api/f/conversation",
      );
      assert(normalChat.profile === "chatgpt-web-chat", "normal ChatGPT SSE uses chat profile");

      const workByModel = detectAiProfile(
        [
          ev("v1", "delta_encoding"),
          ev(
            JSON.stringify({
              o: "add",
              v: {
                message: {
                  id: "work-model-message",
                  author: { role: "assistant" },
                  content: { content_type: "text", parts: [""] },
                  metadata: {
                    working_turn_id: "work-turn",
                    resolved_model_slug: "gpt-6-luna-wm",
                  },
                  recipient: "all",
                },
              },
              conversation_id: "conv",
            }),
            "delta",
          ),
        ],
        "https://chatgpt.com/backend-api/f/conversation",
      );
      assert(workByModel.profile === "chatgpt-web-work", "*-wm model metadata implies Work");

      const work = detectAiProfile(
        [
          ev("v1", "delta_encoding"),
          ev(
            JSON.stringify({
              type: "stream_handoff",
              conversation_id: "conv",
              turn_exchange_id: "work-turn",
              options: [{ type: "subscribe_ws_topic", topic_id: "conversation-turn-work" }],
            }),
          ),
          ev(
            JSON.stringify({
              type: "server_ste_metadata",
              metadata: {
                requested_model_experience: "work",
                product_experience: "work",
                turn_mode: "projects",
              },
              conversation_id: "conv",
            }),
          ),
        ],
        "https://chatgpt.com/backend-api/f/conversation",
      );
      assert(work.profile === "chatgpt-web-work", "Work handoff uses Work profile");
    }

    {
      const directMcp = [
        ev("v1", "delta_encoding"),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "direct-devspace-call",
                author: { role: "assistant" },
                content: {
                  content_type: "code",
                  text: JSON.stringify({
                    path: "/asdk_app_x/link_y/open_workspace",
                    args: { mode: "checkout", path: "/root/codex" },
                  }),
                },
                metadata: {
                  working_turn_id: "work",
                  turn_exchange_id: "exchange",
                  is_temporal_turn: true,
                  stream_topic_id: "conversation-turn-work",
                  async_source: "server:conversation-turn-work:US",
                },
                recipient: "api_tool.call_tool",
                channel: "commentary",
              },
            },
            conversation_id: "conv",
          }),
          "delta",
        ),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "direct-devspace-result",
                author: { role: "tool", name: "api_tool.call_tool" },
                content: { content_type: "code", text: "{}" },
                metadata: {
                  parent_id: "direct-devspace-call",
                  connector_type: "MCP",
                  invoked_resource: {
                    app_name: "Devspace",
                    resource_uri: "/asdk_app_x/link_y/open_workspace",
                  },
                  chatgpt_sdk: { html_asset_pointer: "ui://devspace/workspace-app/v2.html" },
                },
                recipient: "all",
                channel: "commentary",
              },
            },
            conversation_id: "conv",
          }),
          "delta",
        ),
      ];
      const t = mergeAiConversation(directMcp, "https://chatgpt.com/backend-api/f/conversation");
      assert(t.profile === "chatgpt-web-work", "direct MCP call stays in Work profile");
      assert(t.channels.tools.length === 1, `direct MCP tools: ${t.channels.tools.length}`);
      assert(t.channels.tools[0]?.provider === "Devspace", "direct MCP app name restored");
      assert(t.channels.tools[0]?.kind === "app", "direct MCP classified as app");
      assert(t.channels.tools[0]?.source === "mcp", "direct MCP source restored");
      assert(t.channels.tools[0]?.operation === "open_workspace", "direct MCP operation restored");
      assert(t.channels.tools[0]?.presentation === "app_ui", "direct MCP UI restored");
      assert(
        t.channels.reasoning.includes("Devspace · APP · MCP · UI · open_workspace"),
        "direct MCP call appears in reasoning timeline",
      );
    }

    {
      const jitMcp = [
        ev("v1", "delta_encoding"),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "jit-thoughts",
                author: { role: "assistant" },
                content: {
                  content_type: "thoughts",
                  thoughts: [{ summary: "Thinking", content: "", finished: false }],
                },
                metadata: {
                  resolved_model_slug: "gpt-6-luna-wm",
                  working_turn_id: "work",
                  turn_exchange_id: "exchange",
                  dil_v2_reasoning: { appData: { title: "Worked", items: [] } },
                },
                recipient: "all",
              },
            },
            conversation_id: "conv",
          }),
          "delta",
        ),
        ev(
          JSON.stringify({
            o: "patch",
            v: [
              {
                p: "/message/metadata/dil_v2_reasoning/appData/items",
                o: "append",
                v: [
                  {
                    id: "exec-jit:integration",
                    label: "Using Devspace integration",
                    connectorId: "asdk_app_devspace",
                    toolName: "devspace.exec_command",
                  },
                ],
              },
            ],
          }),
          "delta",
        ),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: {
                id: "jit-approval",
                author: { role: "tool", name: "api_tool.call_tool" },
                content: { content_type: "text", parts: [""] },
                metadata: {
                  jit_plugin_data: {
                    from_server: {
                      type: "confirm_action",
                      body: {
                        connector_name: "Devspace",
                        connector_id: "asdk_app_devspace",
                        params: {
                          path: "/asdk_app_devspace/link_x/Execute_command",
                          args: {
                            cmd: "echo hello",
                            workingDirectory: "/root/codex",
                            workspaceId: "ws_test",
                          },
                        },
                      },
                    },
                  },
                },
                recipient: "all",
              },
            },
            conversation_id: "conv",
          }),
          "delta",
        ),
      ];
      const t = mergeAiConversation(jitMcp, "https://chatgpt.com/backend-api/f/conversation");
      const devspace = t.channels.tools.filter((tool) => tool.provider === "Devspace");
      assert(devspace.length === 1, `JIT Devspace tools: ${devspace.length}`);
      assert(devspace[0]?.operation === "exec_command", "JIT operation normalized");
      assert(
        devspace[0]?.aliases?.includes("exec-jit:integration"),
        "JIT tool keeps DIL alias for reasoning jump",
      );
      const args = JSON.parse(devspace[0]!.arguments) as {
        path?: string;
        args?: { cmd?: string; workingDirectory?: string; workspaceId?: string };
      };
      assert(args.args?.cmd === "echo hello", "JIT command restored");
      assert(args.args?.workingDirectory === "/root/codex", "JIT working directory restored");
      assert(args.args?.workspaceId === "ws_test", "JIT workspace restored");
    }

    {
      const events = [
        ev(
          JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion.chunk",
            model: "deepseek-reasoner",
            choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
          }),
        ),
        ev(
          JSON.stringify({
            choices: [{ index: 0, delta: { reasoning_content: "先想一步" }, finish_reason: null }],
          }),
        ),
        ev(
          JSON.stringify({
            choices: [{ index: 0, delta: { reasoning_content: "再想一步" }, finish_reason: null }],
          }),
        ),
        ev(
          JSON.stringify({
            choices: [{ index: 0, delta: { content: "你好" }, finish_reason: null }],
          }),
        ),
        ev(
          JSON.stringify({
            choices: [{ index: 0, delta: { content: "，世界" }, finish_reason: null }],
          }),
        ),
        ev(
          JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        ),
        ev("[DONE]"),
      ];

      const det = detectAiProfile(events, "https://api.deepseek.com/v1/chat/completions");
      assert(det.profile === "openai-compatible", "profile openai");
      assert(det.vendorHint === "deepseek", "vendor deepseek");
      assert(det.reasoningFields.includes("reasoning_content"), "reasoning field");

      const t = mergeAiConversation(events, "https://api.deepseek.com/v1/chat/completions");
      assert(t.channels.reasoning === "先想一步再想一步", "reasoning merge");
      assert(t.channels.content === "你好，世界", "content merge");
      assert(t.endMeta.finishReason === "stop", "finish");
      assert(t.endMeta.usage && t.endMeta.usage.total_tokens === 15, "usage");
      assert(conversationHasContent(t), "has content");
    }

    {
      const events = [
        ev(
          JSON.stringify({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index: 0, id: "call_1", type: "function", function: { name: "get_" } },
                  ],
                },
                finish_reason: null,
              },
            ],
          }),
        ),
        ev(
          JSON.stringify({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [{ index: 0, function: { name: "weather", arguments: '{"city":' } }],
                },
                finish_reason: null,
              },
            ],
          }),
        ),
        ev(
          JSON.stringify({
            choices: [
              {
                index: 0,
                delta: { tool_calls: [{ index: 0, function: { arguments: '"SZ"}' } }] },
                finish_reason: "tool_calls",
              },
            ],
          }),
        ),
      ];
      const t = mergeAiConversation(
        events,
        "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      );
      assert(t.profile === "openai-compatible", "tool profile");
      assert(t.vendorHint === "qwen", "qwen vendor");
      assert(t.channels.tools.length === 1, "one tool");
      assert(t.channels.tools[0].name === "get_weather", "tool name concat");
      assert(t.channels.tools[0].arguments === '{"city":"SZ"}', "tool args concat");
      assert(t.endMeta.finishReason === "tool_calls", "tool finish");
    }

    {
      const events = [ev("not-json"), ev("data: hello")];
      const t = mergeAiConversation(events);
      assert(t.profile === "generic", "generic");
      assert(!conversationHasContent(t), "empty conversation");
    }

    {
      // Without STREAM_* event names, top-level block_type still detects doubao-web via payload.
      const det = detectAiProfile(
        [
          ev(JSON.stringify({ block_type: 10000, content: { text_block: { text: "答" } } })),
          ev(JSON.stringify({ text: "x" }), "CHUNK_DELTA"),
        ],
        "https://www.doubao.com/chat",
      );
      assert(det.profile === "doubao-web", "doubao web profile");

      const t = mergeAiConversation(
        [
          ev(
            JSON.stringify({
              content: {
                content_block: [
                  {
                    block_type: 10040,
                    block_id: "think-1",
                    content: { thinking_block: { streaming_title: "正在思考" } },
                  },
                ],
              },
              meta: { user_type: 2 },
            }),
            "STREAM_MSG_NOTIFY",
          ),
          ev(
            JSON.stringify({
              patch_op: [
                {
                  patch_object: 1,
                  patch_value: {
                    content_block: [
                      {
                        block_type: 10000,
                        block_id: "think-text",
                        parent_id: "think-1",
                        content: {
                          text_block: {
                            text: "先想",
                            icon_url: "https://cdn.example/Deep_Think.png",
                          },
                        },
                      },
                    ],
                  },
                },
              ],
            }),
            "STREAM_CHUNK",
          ),
          ev(JSON.stringify({ text: "一下" }), "CHUNK_DELTA"),
          ev(
            JSON.stringify({
              patch_op: [
                {
                  patch_object: 1,
                  patch_value: {
                    content_block: [
                      {
                        block_type: 10000,
                        block_id: "answer-1",
                        content: { text_block: { text: "你好" } },
                      },
                    ],
                  },
                },
              ],
            }),
            "STREAM_CHUNK",
          ),
          ev(JSON.stringify({ text: "呀！" }), "CHUNK_DELTA"),
        ],
        "https://www.doubao.com/chat",
      );
      assert(t.channels.reasoning === "先想一下", `doubao reasoning got: ${t.channels.reasoning}`);
      assert(t.channels.content === "你好呀！", `doubao merge got: ${t.channels.content}`);
    }

    {
      // Doubao replays the same search as scene=2 citation block with a new block_id.
      const searchPayload = {
        summary: "搜索 1 个关键词，参考 2 篇资料",
        queries: ["北京今日天气"],
        results: [
          { text_card: { title: "A", url: "https://a.example", summary: "a", index: 1 } },
          { text_card: { title: "B", url: "https://b.example", summary: "b", index: 2 } },
        ],
        scene: 1,
      };
      const t = mergeAiConversation(
        [
          ev(
            JSON.stringify({
              content: {
                content_block: [
                  {
                    block_type: 10040,
                    block_id: "think-1",
                    content: { thinking_block: { streaming_title: "正在思考" } },
                  },
                ],
              },
              meta: { user_type: 2 },
            }),
            "STREAM_MSG_NOTIFY",
          ),
          ev(
            JSON.stringify({
              patch_op: [
                {
                  patch_object: 1,
                  patch_value: {
                    content_block: [
                      {
                        block_type: 10025,
                        block_id: "search-live",
                        parent_id: "think-1",
                        content: { search_query_result_block: searchPayload },
                      },
                    ],
                  },
                },
              ],
            }),
            "STREAM_CHUNK",
          ),
          ev(
            JSON.stringify({
              patch_op: [
                {
                  patch_object: 1,
                  patch_value: {
                    content_block: [
                      {
                        block_type: 10025,
                        block_id: "search-replay",
                        content: {
                          search_query_result_block: { ...searchPayload, scene: 2 },
                        },
                      },
                    ],
                  },
                },
              ],
            }),
            "STREAM_CHUNK",
          ),
        ],
        "https://www.doubao.com/chat",
      );
      assert(t.channels.tools.length === 1, `doubao search dedupe got ${t.channels.tools.length}`);
      assert(t.channels.tools[0].id === "search-live", "keep live search id");
    }

    {
      assert(vendorHintFromUrl("https://www.kimi.com/chat") === "moonshot", "kimi host");
      const events = [
        ev(
          JSON.stringify({
            op: "set",
            mask: "chat.lastRequest",
            chat: { id: "c1", lastRequest: { options: { thinking: true } } },
          }),
          "chat.lastRequest",
        ),
        ev(
          JSON.stringify({
            op: "set",
            mask: "message",
            message: { id: "u1", role: "user", blocks: [{ text: { content: "天气" } }] },
          }),
          "message",
        ),
        ev(
          JSON.stringify({
            op: "set",
            mask: "block.multiStage",
            block: {
              id: "1",
              multiStage: {
                stages: [{ name: "STAGE_NAME_THINKING", status: "STAGE_STATUS_START" }],
              },
            },
          }),
          "block.multiStage",
        ),
        ev(
          JSON.stringify({
            op: "set",
            mask: "block.stage",
            block: {
              id: "2",
              parentId: "1",
              stage: { name: "STAGE_NAME_THINKING", status: "STAGE_STATUS_START" },
            },
          }),
          "block.stage",
        ),
        ev(
          JSON.stringify({
            op: "set",
            mask: "block.think",
            block: { id: "3", parentId: "2", think: { content: "用户" } },
          }),
          "block.think",
        ),
        ev(
          JSON.stringify({
            op: "append",
            mask: "block.think.content",
            block: { id: "3", parentId: "2", think: { content: "询问广州天气" } },
          }),
          "block.think.content",
        ),
        ev(
          JSON.stringify({
            op: "set",
            mask: "block.stage",
            block: {
              id: "2",
              parentId: "1",
              stage: { name: "STAGE_NAME_THINKING", status: "STAGE_STATUS_END" },
            },
          }),
          "block.stage",
        ),
        ev(
          JSON.stringify({
            op: "set",
            block: {
              id: "5",
              tool: {
                toolCallId: "web_search:7",
                name: "web_search",
                args: '{"queries": ["广州天气预报 未来三天"]}',
                status: "STATUS_RUNNING",
              },
            },
          }),
          "block.tool",
        ),
        ev(
          JSON.stringify({
            op: "set",
            mask: "block.tool.contents,block.tool.status",
            block: {
              id: "5",
              tool: {
                contents: [
                  {
                    searchResult: {
                      id: "1",
                      base: {
                        title: "中国天气网",
                        url: "https://www.weather.com.cn/",
                        siteName: "中国天气网",
                        snippet: "多云转晴",
                      },
                      refIndex: "web_search:7#0",
                    },
                  },
                ],
                status: "STATUS_DONE",
              },
            },
          }),
          "block.tool.contents,block.tool.status",
        ),
        ev(
          JSON.stringify({
            op: "append",
            mask: "block.text.content",
            block: { id: "4", parentId: "", text: { content: "正文增量" } },
          }),
          "block.text.content",
        ),
        ev(
          JSON.stringify({
            op: "set",
            mask: "message",
            message: { id: "a1", role: "assistant", status: "MESSAGE_STATUS_COMPLETED" },
          }),
          "message",
        ),
      ];
      const det = detectAiProfile(events, "https://www.kimi.com/chat/...");
      assert(det.profile === "kimi-web", `kimi profile got ${det.profile}`);
      assert(det.vendorHint === "moonshot", "kimi vendor");
      const t = mergeAiConversation(events, "https://www.kimi.com/chat");
      assert(t.profile === "kimi-web", "kimi merge profile");
      assert(t.channels.reasoning.includes("用户"), `kimi reasoning: ${t.channels.reasoning}`);
      assert(
        t.channels.reasoning.includes("询问广州天气"),
        `kimi think.content: ${t.channels.reasoning}`,
      );
      assert(t.channels.content.includes("正文增量"), `kimi content: ${t.channels.content}`);
      assert(!t.channels.content.includes("询问广州天气"), "thinking must not leak");
      assert(t.channels.tools.length === 1, `kimi tools ${t.channels.tools.length}`);
      assert(t.channels.tools[0].name === "web_search", "kimi web_search");
      assert(t.endMeta.finishReason === "stop", "kimi finish");
      assert(conversationHasContent(t), "kimi has content");

      // Citation chips in block.text must not leak into Content tab
      const citeChip =
        "\uE3A0article\u{1F6E0}web_search:16#7\u{1F6E0}web_search:16#5\u{1F6E0}web_search:16#9\uE3A8";
      const citeEvents = [
        ev(
          JSON.stringify({
            op: "append",
            mask: "block.text.content",
            block: { id: "c1", parentId: "", text: { content: " " } },
          }),
          "block.text.content",
        ),
        ev(
          JSON.stringify({
            op: "append",
            mask: "block.text.content",
            block: { id: "c1", parentId: "", text: { content: citeChip } },
          }),
          "block.text.content",
        ),
        ev(
          JSON.stringify({
            op: "append",
            mask: "block.text.content",
            block: { id: "c1", parentId: "", text: { content: "## 合肥天气" } },
          }),
          "block.text.content",
        ),
      ];
      const citeMerged = mergeAiConversation(citeEvents, "https://www.kimi.com/chat");
      assert(citeMerged.profile === "kimi-web", "cite profile");
      assert(!citeMerged.channels.content.includes("web_search:"), "cite chip stripped");
      assert(!citeMerged.channels.content.includes("article"), "article chip stripped");
      assert(!citeMerged.channels.content.includes("\uE3A0"), "pua start stripped");
      assert(citeMerged.channels.content.includes("## 合肥天气"), "real answer kept");
      assert(citeMerged.channels.content.trim().startsWith("##"), "no leading whitespace seed");
    }

    {
      const qwenEnvelope = (messages, extra = {}) =>
        JSON.stringify({
          error_msg: "",
          error_code: 0,
          data: {
            extra_info: { agent_name: "AgentProxy", scene: "deep_think_r1lite", ...extra },
            messages,
          },
        });

      const events = [
        ev(
          qwenEnvelope([
            {
              mime_type: "plan_cot/post",
              content: "用户询问深圳天气，准备搜索相关信息。",
              status: "processing",
            },
          ]),
        ),
        ev(
          qwenEnvelope([
            {
              mime_type: "plan_cot/post",
              content:
                "用户询问深圳天气，准备搜索相关信息。\n我准备通过这些步骤来收集信息。\n- 查询深圳今日天气 ",
              status: "processing",
            },
          ]),
        ),
        ev(
          qwenEnvelope([
            {
              mime_type: "bar/progress",
              meta_data: {
                type: "cot",
                content: { list: [{ query: "深圳天气" }] },
              },
              status: "processing",
            },
          ]),
        ),
        ev(
          qwenEnvelope([
            {
              mime_type: "bar/progress",
              meta_data: {
                match_num: 2,
                list: [
                  {
                    title: "深圳天气预报",
                    url: "https://weather.sz.gov.cn/",
                    summary: "多云间晴天",
                  },
                ],
              },
              status: "processing",
            },
          ]),
        ),
        ev(
          qwenEnvelope([
            {
              mime_type: "multi_load/iframe",
              meta_data: {
                multi_load: [
                  {
                    type: "deep_think",
                    content: { think_content: "我需要回答深圳天气", status: "processing" },
                  },
                ],
              },
              content: "[(deep_think)]",
              status: "processing",
            },
          ]),
        ),
        ev(
          qwenEnvelope([
            {
              mime_type: "multi_load/iframe",
              meta_data: {
                multi_load: [
                  {
                    type: "deep_think",
                    content: {
                      think_content: "我需要回答深圳天气，根据检索结果整理答案。",
                      status: "complete",
                    },
                  },
                ],
              },
              content: "[(deep_think)]\n\n今日深圳多云间晴天",
              status: "processing",
            },
          ]),
        ),
        ev(
          qwenEnvelope(
            [
              {
                mime_type: "multi_load/iframe",
                meta_data: { multi_load: [] },
                content: "[(deep_think)]\n\n今日深圳多云间晴天，气温26~33℃。",
                status: "complete",
              },
            ],
            { sse_end: "1" },
          ),
        ),
      ];

      const det = detectAiProfile(events, "https://www.qianwen.com/chat");
      assert(det.profile === "qwen-web", `qwen profile got ${det.profile}`);
      assert(det.vendorHint === "qwen", "qwen vendor");
      const t = mergeAiConversation(events, "https://www.qianwen.com/chat");
      assert(t.profile === "qwen-web", "qwen merge profile");
      assert(
        t.channels.reasoning.includes("用户询问深圳天气"),
        `qwen plan_cot: ${t.channels.reasoning}`,
      );
      assert(
        t.channels.reasoning.includes("根据检索结果"),
        `qwen deep_think: ${t.channels.reasoning}`,
      );
      assert(
        t.channels.content.includes("今日深圳多云间晴天"),
        `qwen content: ${t.channels.content}`,
      );
      assert(!t.channels.content.includes("我需要回答深圳天气"), "thinking must not leak");
      assert(t.channels.tools.length === 1, `qwen tools ${t.channels.tools.length}`);
      assert(t.channels.tools[0].name === "web_search", "qwen web_search");
      const args = JSON.parse(t.channels.tools[0].arguments);
      assert(
        Array.isArray(args.queries) && args.queries.some((q) => String(q).includes("深圳")),
        "qwen queries",
      );
      assert(Array.isArray(args.results) && args.results.length >= 1, "qwen results");
      assert(t.endMeta.finishReason === "stop", "qwen finish");
      assert(conversationHasContent(t), "qwen has content");
    }

    {
      const qwenEnvelope = (messages) =>
        JSON.stringify({
          error_code: 0,
          data: { extra_info: { agent_name: "AgentProxy" }, messages },
        });

      const stackedPlanCot =
        "这是一个\n" +
        "这是一个关于合肥市当日天气\n" +
        "这是一个关于合肥市当日天气情况的查询问题。需要提供合肥市今天的温度范围、天气现象、风力风向、湿度等实时天气数据，以及相关的天气预警信息和生活指数建议。\n";

      const events = [ev(qwenEnvelope([{ mime_type: "plan_cot/post", content: stackedPlanCot }]))];
      const t = mergeAiConversation(events, "https://www.qianwen.com/chat");
      assert(
        t.channels.reasoning ===
          "这是一个关于合肥市当日天气情况的查询问题。需要提供合肥市今天的温度范围、天气现象、风力风向、湿度等实时天气数据，以及相关的天气预警信息和生活指数建议。",
        `qwen stacked collapse: ${JSON.stringify(t.channels.reasoning)}`,
      );
      assert(!t.channels.reasoning.includes("这是一个\n这是一个"), "stacked lines must collapse");
    }

    {
      const chatglmEnvelope = (parts, status = "init") =>
        JSON.stringify({
          id: "msg1",
          conversation_id: "conv1",
          assistant_id: "65940acff94777010aa6b796",
          status,
          parts,
          meta_data: {},
        });

      const events = [
        ev(chatglmEnvelope([])),
        ev(
          chatglmEnvelope([
            {
              role: "assistant",
              status: "init",
              content: [{ type: "think", think: "拆解用户请求", tool_calls: {} }],
            },
          ]),
        ),
        ev(
          chatglmEnvelope([
            {
              role: "assistant",
              status: "init",
              content: [{ type: "think", think: "拆解用户请求：今天深圳天气", tool_calls: {} }],
            },
          ]),
        ),
        ev(
          chatglmEnvelope([
            {
              role: "assistant",
              status: "init",
              content: [
                {
                  type: "tool_calls",
                  tool_calls: {
                    id: "tool-abc",
                    name: "search",
                    arguments: JSON.stringify({
                      search_query: [
                        { q: "江苏 今天 天气 预报 实时", recency: 1 },
                        { q: "江苏 各市 天气 今天 南京 苏州 无锡", recency: 1 },
                        { q: "江苏 气象局 天气 预警 今天", recency: 1 },
                        { q: "江苏 空气质量 今天", recency: 1 },
                      ],
                    }),
                  },
                },
              ],
              meta_data: { show_type: "mc_tool_call2" },
            },
          ]),
        ),
        ev(
          chatglmEnvelope([
            {
              role: "assistant",
              status: "finish",
              content: [
                {
                  type: "tool_result",
                  tool_calls: {
                    id: "tool-abc",
                    name: "search",
                    arguments: JSON.stringify({
                      search_query: [
                        { q: "江苏 今天 天气 预报 实时", recency: 1 },
                        { q: "江苏 各市 天气 今天 南京 苏州 无锡", recency: 1 },
                        { q: "江苏 气象局 天气 预警 今天", recency: 1 },
                        { q: "江苏 空气质量 今天", recency: 1 },
                      ],
                    }),
                  },
                },
              ],
              meta_data: {
                show_type: "mc_tool_result2",
                tool_result_extra: {
                  search_duration: 6.7,
                  search_results: [
                    {
                      title: "江苏省气象台变更发布高温黄色预警",
                      url: "https://example.com/nj",
                      host_name: "so.html5.qq.com",
                      index: 1,
                      snippet: "<p>预计南京最高气温可达35℃</p>",
                    },
                    {
                      title: "苏州天气",
                      url: "https://example.com/sz",
                      host_name: "weather.com.cn",
                      index: 2,
                    },
                  ],
                },
              },
            },
          ]),
        ),
        ev(
          chatglmEnvelope([
            {
              role: "assistant",
              status: "init",
              content: [{ type: "text", text: "好的，深圳今天" }],
            },
          ]),
        ),
        ev(
          chatglmEnvelope(
            [
              {
                role: "assistant",
                status: "finish",
                model: "glm-4",
                content: [{ type: "text", text: "好的，深圳今天多云间晴天，气温26~33℃。" }],
              },
            ],
            "finish",
          ),
        ),
      ];

      const det = detectAiProfile(events, "https://chatglm.cn/main/chat");
      assert(det.profile === "chatglm-web", `chatglm profile got ${det.profile}`);
      assert(det.vendorHint === "chatglm", "chatglm vendor");
      const t = mergeAiConversation(events, "https://chatglm.cn/main/chat");
      assert(t.profile === "chatglm-web", "chatglm merge profile");
      assert(
        t.channels.reasoning.includes("拆解用户请求"),
        `chatglm think: ${t.channels.reasoning}`,
      );
      assert(t.channels.reasoning.includes("今天深圳天气"), "chatglm think snapshot");
      assert(t.channels.content.includes("多云间晴天"), `chatglm content: ${t.channels.content}`);
      assert(!t.channels.content.includes("拆解用户请求"), "think must not leak");
      assert(t.channels.tools.length === 1, `chatglm tools ${t.channels.tools.length}`);
      assert(t.channels.tools[0].name === "web_search", "chatglm search normalized to web_search");
      assert(t.channels.tools[0].id === "tool-abc", "chatglm tool id");
      const chatglmArgs = JSON.parse(t.channels.tools[0].arguments);
      assert(chatglmArgs.type === "SEARCH", "chatglm SEARCH payload");
      assert(
        Array.isArray(chatglmArgs.queries) && chatglmArgs.queries.length === 4,
        `chatglm queries ${JSON.stringify(chatglmArgs.queries)}`,
      );
      assert(chatglmArgs.queries[0].includes("江苏"), "chatglm query text");
      assert(
        Array.isArray(chatglmArgs.results) && chatglmArgs.results.length === 2,
        `chatglm results ${chatglmArgs.results?.length}`,
      );
      assert(chatglmArgs.results[0].url === "https://example.com/nj", "chatglm result url");
      assert(chatglmArgs.results[0].site_name === "so.html5.qq.com", "chatglm host_name");
      assert(
        String(chatglmArgs.results[0].snippet || "").includes("南京") &&
          !String(chatglmArgs.results[0].snippet || "").includes("<p>"),
        "chatglm snippet stripped",
      );
      assert(t.endMeta.finishReason === "stop", "chatglm finish");
      assert(conversationHasContent(t), "chatglm has content");
    }

    {
      assert(vendorHintFromUrl("https://yuanbao.tencent.com/chat") === "yuanbao", "yuanbao host");

      const events = [
        ev(JSON.stringify({ type: "text" })),
        ev("status", "speech_type"),
        ev(
          JSON.stringify({
            type: "step",
            msg: "正在搜索资料",
            toolCallType: "web_search",
            scene: "ai_search_deep_search",
          }),
        ),
        ev(
          JSON.stringify({
            type: "deepSearch",
            title: "思考中",
            contents: [
              {
                type: "toolCall",
                toolCallName: "hunyuan_web_search",
                docs: [
                  { index: 1, title: "深圳气象局", url: "https://weather.sz.gov.cn/a" },
                  { index: 2, title: "腾讯网", url: "https://example.com/b" },
                ],
              },
            ],
          }),
        ),
        ev(
          JSON.stringify({
            type: "deepSearch",
            title: "思考中",
            contents: [{ type: "text", componentId: "0", msg: "用户只说" }],
          }),
        ),
        ev(
          JSON.stringify({
            type: "deepSearch",
            title: "思考中",
            contents: [{ type: "text", componentId: "0", msg: "明天天气" }],
          }),
        ),
        ev(
          JSON.stringify({
            type: "deepSearch",
            title: "已深度思考",
            contents: [{ type: "text", componentId: "2", msg: "按上下文延续为深圳" }],
          }),
        ),
        ev(
          JSON.stringify({
            type: "searchGuid",
            title: "引用 2 篇资料作为参考",
            docs: [
              {
                index: 1,
                title: "深圳气象局更新",
                url: "https://weather.sz.gov.cn/a",
                quote: "最高气温36℃",
                web_site_name: "深圳气象局",
              },
              {
                index: 2,
                title: "腾讯网天气",
                url: "https://example.com/b",
                web_site_name: "腾讯网",
              },
            ],
          }),
        ),
        ev(JSON.stringify({ type: "text", msg: "明天" })),
        ev(JSON.stringify({ type: "text", msg: "深圳晴热" })),
        ev(JSON.stringify({ type: "meta", stopReason: "stop", pluginID: "OneAgent" })),
      ];

      const det = detectAiProfile(events, "https://yuanbao.tencent.com/chat");
      assert(det.profile === "yuanbao-web", `yuanbao profile got ${det.profile}`);
      assert(det.vendorHint === "yuanbao", "yuanbao vendor");
      const t = mergeAiConversation(events, "https://yuanbao.tencent.com/chat");
      assert(t.profile === "yuanbao-web", "yuanbao merge profile");
      assert(
        t.channels.reasoning.includes("用户只说明天天气"),
        `yuanbao think: ${t.channels.reasoning}`,
      );
      assert(t.channels.reasoning.includes("按上下文延续为深圳"), "yuanbao think comps joined");
      assert(t.channels.content === "明天深圳晴热", `yuanbao content: ${t.channels.content}`);
      assert(!t.channels.content.includes("用户只说"), "think must not leak");
      assert(t.channels.tools.length === 1, `yuanbao tools ${t.channels.tools.length}`);
      assert(t.channels.tools[0].name === "web_search", "yuanbao web_search");
      const yArgs = JSON.parse(t.channels.tools[0].arguments);
      assert(yArgs.type === "SEARCH", "yuanbao SEARCH");
      assert(
        Array.isArray(yArgs.results) && yArgs.results.length === 2,
        `yuanbao results ${yArgs.results?.length}`,
      );
      assert(yArgs.results[0].site_name === "深圳气象局", "yuanbao site from searchGuid");
      assert(String(yArgs.results[0].snippet || "").includes("36"), "yuanbao quote snippet");
      assert(t.endMeta.finishReason === "stop", "yuanbao finish");
      assert(conversationHasContent(t), "yuanbao has content");
    }
  });
});

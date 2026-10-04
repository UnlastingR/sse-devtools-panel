import { describe, expect, it } from "vitest";
import { mergeAiConversation } from "../index";

function ev(data: string, event = "delta", receivedAt?: number) {
  return { data, event, ...(receivedAt == null ? {} : { receivedAt }) };
}

function add(message: Record<string, unknown>) {
  return ev(JSON.stringify({ o: "add", v: { message } }));
}

function assistant(
  id: string,
  createTime: number | null,
  recipient: string,
  metadata: Record<string, unknown> = {},
  content: Record<string, unknown> = { content_type: "code", text: "{}" },
  channel: string | null = "commentary",
) {
  return {
    id,
    author: { role: "assistant" },
    create_time: createTime,
    content,
    metadata,
    recipient,
    channel,
  };
}

function tool(
  id: string,
  name: string,
  createTime: number,
  parentId: string,
  updateTime?: number,
  metadata: Record<string, unknown> = {},
) {
  return {
    id,
    author: { role: "tool", name },
    create_time: createTime,
    update_time: updateTime ?? null,
    content: { content_type: "execution_output", text: "ok\n" },
    metadata: { parent_id: parentId, ...metadata },
    recipient: "all",
    channel: null,
  };
}

function commentary(
  id: string,
  createTime: number,
  text: string,
  metadata: Record<string, unknown>,
) {
  return assistant(
    id,
    createTime,
    "all",
    metadata,
    { content_type: "text", parts: [text] },
    "commentary",
  );
}

function recap(id: string, parentId: string, reasoningStart: number, reasoningEnd: number) {
  return assistant(
    id,
    reasoningEnd,
    "all",
    {
      parent_id: parentId,
      reasoning_start_time: reasoningStart,
      reasoning_end_time: reasoningEnd,
      finished_duration_sec: reasoningEnd - reasoningStart,
      reasoning_status: "reasoning_ended",
    },
    { content_type: "reasoning_recap", content: `思考了 ${reasoningEnd - reasoningStart}s` },
    null,
  );
}

function merged(
  events: ReturnType<typeof ev>[],
  observation?: Parameters<typeof mergeAiConversation>[2],
) {
  return mergeAiConversation(
    [ev('"v1"', "delta_encoding"), ...events],
    "https://chatgpt.com/backend-api/f/conversation",
    observation,
  );
}

function findItem(result: ReturnType<typeof merged>, predicate: (text: string) => boolean) {
  return result.channels.reasoningStages
    ?.flatMap((stage) => stage.items)
    .find((item) => predicate(item.text));
}

describe("ChatGPT reasoning timing", () => {
  it("does not duplicate a DIL status as both stage title and identical summary", () => {
    const result = merged([
      ev(
        JSON.stringify({
          o: "add",
          v: {
            message: assistant(
              "dil-stage",
              null,
              "all",
              {
                resolved_model_slug: "gpt-6-luna-wm",
                working_turn_id: "work",
                turn_exchange_id: "turn",
                dil_v2_reasoning: {
                  appData: { title: "Worked", current_status: "Thinking", items: [] },
                },
              },
              {
                content_type: "thoughts",
                thoughts: [{ summary: "Thinking", content: "", finished: false }],
              },
              null,
            ),
          },
          conversation_id: "conv",
        }),
        "delta",
        10_000,
      ),
      ev(
        JSON.stringify({
          o: "patch",
          v: [
            {
              p: "/message/content/thoughts/0/summary",
              o: "replace",
              v: "检查仓库状态",
            },
            {
              p: "/message/metadata/dil_v2_reasoning/appData/current_status",
              o: "replace",
              v: "检查仓库状态",
            },
          ],
        }),
        "delta",
        12_000,
      ),
    ]);

    const stage = result.channels.reasoningStages?.find((item) => item.title === "检查仓库状态");
    expect(stage).toBeTruthy();
    expect(
      stage?.items.some((item) => item.kind === "summary" && item.text === "检查仓库状态"),
    ).toBe(false);
    expect(result.channels.reasoning).not.toContain("摘要 · 检查仓库状态");
  });

  it("stops total reasoning time at reasoning_recap before final text streaming", () => {
    const result = merged(
      [
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: assistant(
                "thoughts",
                null,
                "all",
                {
                  reasoning_start_time: 100,
                  reasoning_status: "is_reasoning",
                },
                {
                  content_type: "thoughts",
                  thoughts: [{ summary: "分析问题", content: "", finished: false }],
                },
                null,
              ),
            },
          }),
          "delta",
          100_000,
        ),
        ev(
          JSON.stringify({
            o: "add",
            v: { message: recap("recap", "thoughts", 100, 110) },
          }),
          "delta",
          110_000,
        ),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: assistant(
                "final",
                null,
                "all",
                { parent_id: "recap" },
                { content_type: "text", parts: ["正文开始"] },
                "final",
              ),
            },
          }),
          "delta",
          111_000,
        ),
        ev(
          JSON.stringify({ p: "/message/content/parts/0", o: "append", v: "，继续输出很久" }),
          "delta",
          160_000,
        ),
      ],
      { endedAtMs: 160_000, streamStatus: "done" },
    );

    expect(result.channels.reasoningDurationSec).toBe(10);
    expect(result.channels.reasoningDurationKind).toBe("measured");
  });

  it("does not use stream end as reasoning end after final has started", () => {
    const result = merged(
      [
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: assistant(
                "thoughts-open",
                null,
                "all",
                { reasoning_status: "is_reasoning" },
                {
                  content_type: "thoughts",
                  thoughts: [{ summary: "Thinking", content: "", finished: false }],
                },
                null,
              ),
            },
          }),
          "delta",
          200_000,
        ),
        ev(
          JSON.stringify({
            o: "patch",
            v: [
              { p: "/message/content/thoughts/0/summary", o: "replace", v: "完成分析" },
              { p: "/message/content/thoughts/0/finished", o: "replace", v: true },
            ],
          }),
          "delta",
          212_000,
        ),
        ev(
          JSON.stringify({
            o: "add",
            v: {
              message: assistant(
                "final-fallback",
                null,
                "all",
                { parent_id: "thoughts-open" },
                { content_type: "text", parts: ["最终回答"] },
                "final",
              ),
            },
          }),
          "delta",
          213_000,
        ),
        ev(
          JSON.stringify({ p: "/message/content/parts/0", o: "append", v: "后续正文" }),
          "delta",
          260_000,
        ),
      ],
      { endedAtMs: 260_000, streamStatus: "done" },
    );

    expect(result.channels.reasoningDurationSec).toBe(12);
    expect(result.channels.reasoningDurationKind).toBe("inferred");
  });

  it("tracks Work thought title replacements instead of keeping stale Thinking", () => {
    const result = merged([
      add(
        assistant(
          "thoughts",
          100,
          "all",
          {
            reasoning_start_time: 100,
            dil_v2_reasoning: {
              appData: { title: "Worked", current_status: "Thinking" },
            },
          },
          {
            content_type: "thoughts",
            thoughts: [{ summary: "Thinking", content: "", finished: false }],
          },
          null,
        ),
      ),
      ev(
        JSON.stringify({
          o: "patch",
          v: [
            {
              p: "/message/content/thoughts/0/summary",
              o: "replace",
              v: "检查仓库状态",
            },
            {
              p: "/message/metadata/dil_v2_reasoning/appData/current_status",
              o: "replace",
              v: "检查仓库状态",
            },
          ],
        }),
        "delta",
        105_000,
      ),
      add(recap("recap", "thoughts", 100, 110)),
    ]);

    expect(result.channels.reasoning).not.toContain("Thinking");
    expect(result.channels.reasoning).toContain("检查仓库状态");
    expect(result.channels.reasoningStages?.some((stage) => stage.title === "检查仓库状态")).toBe(
      true,
    );
  });

  it("measures Python through the tool result update_time, not its first result chunk", () => {
    const result = merged([
      add(
        assistant("python-call", 110, "python", {
          reasoning_start_time: 100,
          reasoning_title: "运行 Python",
        }),
      ),
      add(tool("python-result", "python", 112, "python-call")),
      ev(
        JSON.stringify({
          p: "",
          o: "patch",
          v: [
            { p: "/message/update_time", o: "replace", v: 115 },
            { p: "/message/status", o: "replace", v: "finished_successfully" },
          ],
        }),
      ),
      add(recap("recap", "python-result", 100, 116)),
    ]);

    const item = findItem(result, (text) => text.includes("python · BUILTIN"));
    expect(item?.elapsedSec).toBe(10);
    expect(item?.durationSec).toBe(5);
    expect(item?.durationKind).toBe("measured");
    expect(result.channels.reasoning).toContain("工具 · python · BUILTIN · 耗时 5.0s");
  });

  it("measures container from call to its terminal tool result", () => {
    const result = merged([
      add(
        assistant("container-call", 210, "container.exec", {
          reasoning_start_time: 200,
          reasoning_title: "运行容器命令",
        }),
      ),
      add(tool("container-result", "container.exec", 214.25, "container-call")),
    ]);

    const item = findItem(result, (text) => text.includes("container · BUILTIN · exec"));
    expect(item?.durationSec).toBeCloseTo(4.25, 5);
    expect(item?.durationKind).toBe("measured");
  });

  it("measures a functions.exec/files wrapper through its nested tool completion", () => {
    const result = merged([
      add(
        assistant(
          "files-wrapper",
          310,
          "functions.exec",
          { reasoning_start_time: 300, reasoning_title: "读取文件" },
          { content_type: "text", parts: [""] },
        ),
      ),
      add(
        assistant(
          "files-api",
          311,
          "api_tool.call_tool",
          { parent_id: "files-wrapper" },
          { content_type: "code", text: '{"path":"/files/read","args":{}}' },
          null,
        ),
      ),
      add(
        tool("files-result", "api_tool.call_tool", 315, "files-api", undefined, {
          invoked_resource: { resource_uri: "/files/read", contains_mcp_source: false },
        }),
      ),
      add(tool("files-wrapper-result", "functions.exec", 316.5, "files-result")),
    ]);

    const item = findItem(result, (text) => text.includes("files · BUILTIN · read"));
    expect(item?.durationSec).toBeCloseTo(6.5, 5);
    expect(item?.durationKind).toBe("measured");
  });

  it("infers commentary duration from the next visible reasoning event", () => {
    const result = merged([
      add(
        commentary("note", 410, "准备调用工具", {
          reasoning_start_time: 400,
          reasoning_title: "准备",
        }),
      ),
      add(
        assistant("python-call", 414.5, "python", {
          reasoning_start_time: 400,
          reasoning_title: "准备",
          parent_id: "note",
        }),
      ),
      add(tool("python-result", "python", 416, "python-call")),
      add(recap("recap", "python-result", 400, 420)),
    ]);

    const note = findItem(result, (text) => text === "准备调用工具");
    expect(note?.durationSec).toBeCloseTo(4.5, 5);
    expect(note?.durationKind).toBe("inferred");
    expect(result.channels.reasoning).toContain("说明 · 准备调用工具 · ≈4.5s");
  });

  it("keeps overlapping tool durations independent instead of serializing them", () => {
    const result = merged([
      add(
        assistant("tool-a", 510, "python", {
          reasoning_start_time: 500,
          reasoning_title: "并发工具",
        }),
      ),
      add(
        assistant("tool-b", 512, "container.exec", {
          reasoning_start_time: 500,
          reasoning_title: "并发工具",
          parent_id: "tool-a",
        }),
      ),
      add(tool("tool-b-result", "container.exec", 515, "tool-b")),
      add(tool("tool-a-result", "python", 520, "tool-a")),
    ]);

    const python = findItem(result, (text) => text.includes("python · BUILTIN"));
    const container = findItem(result, (text) => text.includes("container · BUILTIN · exec"));
    const stage = result.channels.reasoningStages?.find((value) => value.title === "并发工具");
    expect(python?.durationSec).toBe(10);
    expect(container?.durationSec).toBe(3);
    expect(stage?.durationSec).toBe(10);
  });

  it("allows a stage to overlap the next stage when its measured tool is still running", () => {
    const result = merged([
      add(
        assistant("long-tool", 610, "python", {
          reasoning_start_time: 600,
          reasoning_title: "阶段 A",
        }),
      ),
      add(
        commentary("stage-b-note", 615, "阶段 B 已开始", {
          reasoning_start_time: 600,
          reasoning_title: "阶段 B",
          parent_id: "long-tool",
        }),
      ),
      add(tool("long-tool-result", "python", 620, "long-tool")),
      add(recap("recap", "long-tool-result", 600, 625)),
    ]);

    const stages = result.channels.reasoningStages ?? [];
    expect(stages.find((stage) => stage.title === "阶段 A")?.durationSec).toBe(10);
    expect(stages.find((stage) => stage.title === "阶段 B")?.durationSec).toBe(10);
  });

  it("does not let a delayed null-time summary stretch or duplicate an earlier stage", () => {
    const result = merged([
      add(
        commentary("stage-a", 705, "A 的说明", {
          reasoning_start_time: 700,
          reasoning_title: "阶段 A",
        }),
      ),
      add(
        assistant("stage-b-tool", 710, "python", {
          reasoning_start_time: 700,
          reasoning_title: "阶段 B",
          parent_id: "stage-a",
        }),
      ),
      add(tool("stage-b-result", "python", 712, "stage-b-tool")),
      add(
        assistant(
          "late-a-summary",
          null,
          "all",
          {
            reasoning_title: "阶段 A",
            inline_cot_expandable_content: { source_message_ids: ["stage-a"] },
            parent_id: "stage-b-result",
          },
          {
            content_type: "thoughts",
            thoughts: [{ summary: "A 的延迟摘要", content: "", finished: true }],
          },
          null,
        ),
      ),
    ]);

    const stages = result.channels.reasoningStages ?? [];
    expect(stages.filter((stage) => stage.title === "阶段 A")).toHaveLength(1);
    expect(stages.find((stage) => stage.title === "阶段 A")?.elapsedSec).toBe(5);
    expect(stages.find((stage) => stage.title === "阶段 A")?.durationSec).toBe(5);
  });

  it("infers standalone web.run duration when the stream exposes only a tool result", () => {
    const result = merged([
      add(
        tool("web-result", "web.run", 810, "missing-call", undefined, {
          reasoning_start_time: 800,
          reasoning_title: "搜索",
          request_id: "req-web",
          working_turn_id: "turn-web",
          search_model_queries: { queries: ["OpenAI"] },
        }),
      ),
      add(
        commentary("after-web", 814, "搜索完成后继续", {
          reasoning_start_time: 800,
          request_id: "req-web",
          working_turn_id: "turn-web",
          parent_id: "web-result",
        }),
      ),
    ]);

    const web = findItem(result, (text) => text.includes("web.run · SEARCH"));
    expect(web?.durationSec).toBe(4);
    expect(web?.durationKind).toBe("inferred");
  });

  it("uses browser receive timestamps as the primary Work clock", () => {
    const start = 1_000;
    const webCall = assistant(
      "work-view-call",
      null,
      "web.run",
      { reasoning_start_time: start, reasoning_title: "读取网页" },
      { content_type: "text", parts: [""] },
      "commentary",
    );
    const webResult = {
      id: "work-view-result",
      author: { role: "tool", name: "web.run" },
      create_time: null,
      update_time: null,
      content: { content_type: "text", parts: [""] },
      metadata: {
        parent_id: "work-view-call",
        reasoning_start_time: start,
        search_model_queries: { queries: [] },
        search_result_groups: [
          {
            domain: "example.com",
            entries: [
              {
                title: "Example",
                url: "https://example.com/article",
                snippet: "Total lines: 100",
                ref_id: { turn_index: 1, ref_type: "view", ref_index: 0 },
              },
            ],
          },
        ],
      },
      recipient: "all",
      channel: null,
    };

    const result = merged([
      ev(JSON.stringify({ o: "add", v: { message: webCall } }), "delta", 1_010_000),
      ev(JSON.stringify({ o: "add", v: { message: webResult } }), "delta", 1_014_000),
      add(recap("work-recap", "work-view-result", start, 1_020)),
    ]);

    const web = findItem(result, (text) => text.includes("web.run · VIEW"));
    expect(web?.elapsedSec).toBe(0);
    expect(web?.durationSec).toBe(4);
    expect(web?.durationKind).toBe("measured");
    expect(result.channels.reasoning).toContain("+0.0s  工具 · web.run · VIEW");
    expect(result.channels.tools[0]?.operation).toBe("VIEW");
    expect(JSON.parse(result.channels.tools[0]!.arguments).type).toBe("VIEW");
  });

  it("shows timing even when Work omits reasoning_start_time and message timestamps", () => {
    const result = merged([
      ev(
        JSON.stringify({
          o: "add",
          v: {
            message: {
              id: "thoughts-no-server-time",
              author: { role: "assistant" },
              create_time: null,
              update_time: null,
              content: {
                content_type: "thoughts",
                thoughts: [{ summary: "Thinking", content: "", finished: false }],
              },
              metadata: { reasoning_status: "is_reasoning" },
              recipient: "all",
            },
          },
        }),
        "delta",
        10_000,
      ),
      ev(
        JSON.stringify({
          o: "patch",
          v: [
            {
              p: "/message/content/thoughts/0/summary",
              o: "replace",
              v: "检查工具可用性",
            },
            {
              p: "/message/metadata/dil_v2_reasoning/appData/current_status",
              o: "replace",
              v: "检查工具可用性",
            },
          ],
        }),
        "delta",
        12_500,
      ),
    ]);

    const stage = result.channels.reasoningStages?.find((item) => item.title === "检查工具可用性");
    expect(stage?.elapsedSec).toBe(2.5);
    expect(result.channels.reasoningDurationSec).toBe(2.5);
  });

  it("recovers DIL connector items as tools without an explicit tool message", () => {
    const result = merged([
      ev(
        JSON.stringify({
          o: "add",
          v: {
            message: {
              id: "dil-thoughts",
              author: { role: "assistant" },
              create_time: null,
              update_time: null,
              content: {
                content_type: "thoughts",
                thoughts: [{ summary: "Thinking", content: "", finished: false }],
              },
              metadata: {
                dil_v2_reasoning: {
                  appData: { title: "Worked", current_status: "Thinking", items: [] },
                },
              },
              recipient: "all",
            },
          },
        }),
        "delta",
        20_000,
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
                  id: "exec-1:integration",
                  type: "connector_call",
                  label: "Using Devspace integration",
                  connectorId: "asdk_app_devspace",
                  toolName: "devspace.exec_command",
                },
              ],
            },
          ],
        }),
        "delta",
        22_000,
      ),
    ]);

    const tool = result.channels.tools.find((item) => item.id === "exec-1:integration");
    expect(tool?.provider).toBe("Devspace");
    expect(tool?.source).toBe("mcp");
    expect(tool?.operation).toBe("exec_command");
    expect(
      findItem(result, (text) => text.includes("Devspace · APP · MCP · exec_command")),
    ).toBeTruthy();
  });

  it("supports zero-length inferred intervals when two visible events share a timestamp", () => {
    const result = merged([
      add(
        commentary("note", 910, "同一时刻说明", {
          reasoning_start_time: 900,
          reasoning_title: "同刻事件",
        }),
      ),
      add(
        assistant("tool", 910, "python", {
          reasoning_start_time: 900,
          reasoning_title: "同刻事件",
          parent_id: "note",
        }),
      ),
      add(tool("tool-result", "python", 911, "tool")),
    ]);

    const note = findItem(result, (text) => text === "同一时刻说明");
    expect(note?.durationSec).toBe(0);
    expect(note?.durationKind).toBe("inferred");
  });

  it("does not invent a duration when no completion or later boundary exists", () => {
    const result = merged([
      add(
        assistant("open-tool", 1010, "python", {
          reasoning_start_time: 1000,
          reasoning_title: "仍在运行",
        }),
      ),
    ]);

    const item = findItem(result, (text) => text.includes("python · BUILTIN"));
    expect(item?.durationSec).toBeUndefined();
    expect(item?.durationKind).toBeUndefined();
  });

  it("uses reasoning_end_time as the final commentary boundary and stage end", () => {
    const result = merged([
      add(
        commentary("last-note", 1110, "最后说明", {
          reasoning_start_time: 1100,
          reasoning_title: "收尾",
        }),
      ),
      add(recap("recap", "last-note", 1100, 1117.5)),
    ]);

    const note = findItem(result, (text) => text === "最后说明");
    const stage = result.channels.reasoningStages?.find((value) => value.title === "收尾");
    expect(note?.durationSec).toBeCloseTo(7.5, 5);
    expect(note?.durationKind).toBe("inferred");
    expect(stage?.durationSec).toBeCloseTo(7.5, 5);
    expect(stage?.durationKind).toBe("inferred");
    expect(result.channels.reasoning).toContain("阶段 · 收尾 · ≈7.5s");
  });

  it("covers the observed tool-tool-commentary shape inside one stage", () => {
    const result = merged([
      add(
        assistant("first-tool", 1239.9, "python", {
          reasoning_start_time: 1200,
          reasoning_title: "检索文件中的工具调用模式",
        }),
      ),
      add(tool("first-result", "python", 1243, "first-tool")),
      add(
        assistant("second-tool", 1247, "python", {
          reasoning_start_time: 1200,
          parent_id: "first-result",
        }),
      ),
      add(tool("second-result", "python", 1250, "second-tool")),
      add(
        commentary("late-note", 1250.8, "还有一个重要发现", {
          reasoning_start_time: 1200,
          parent_id: "second-result",
        }),
      ),
      add(
        commentary("next-stage", 1250.8, "继续检查消息类型", {
          reasoning_start_time: 1200,
          reasoning_title: "检查 ChatGPT 消息类型与解析器字段",
          parent_id: "late-note",
        }),
      ),
    ]);

    const stage = result.channels.reasoningStages?.find(
      (value) => value.title === "检索文件中的工具调用模式",
    );
    const note = findItem(result, (text) => text === "还有一个重要发现");
    expect(stage?.elapsedSec).toBeCloseTo(39.9, 5);
    expect(stage?.durationSec).toBeCloseTo(10.9, 5);
    expect(note?.elapsedSec).toBeCloseTo(50.8, 5);
    expect(note?.durationSec).toBe(0);
  });

  it("inherits a provable parent timestamp for null-time commentary", () => {
    const result = merged([
      add(
        commentary("anchor", 1310, "有时间的说明", {
          reasoning_start_time: 1300,
          reasoning_title: "阶段",
        }),
      ),
      add(
        assistant(
          "untimed-note",
          null,
          "all",
          { parent_id: "anchor", reasoning_start_time: 1300 },
          { content_type: "text", parts: ["没有 create_time 的说明"] },
          "commentary",
        ),
      ),
      add(
        assistant("next-tool", 1315, "python", {
          parent_id: "untimed-note",
          reasoning_start_time: 1300,
        }),
      ),
      add(tool("next-result", "python", 1317, "next-tool")),
    ]);

    const note = findItem(result, (text) => text === "没有 create_time 的说明");
    expect(note?.elapsedSec).toBe(10);
    expect(note?.durationSec).toBe(5);
    expect(note?.durationKind).toBe("inferred");
  });

  it("lets measured tool completion extend a stage beyond an earlier reasoning_end marker", () => {
    const result = merged([
      add(
        assistant("late-tool", 1410, "python", {
          reasoning_start_time: 1400,
          reasoning_title: "等待工具",
        }),
      ),
      add(recap("early-recap", "late-tool", 1400, 1415)),
      add(tool("late-result", "python", 1420, "late-tool")),
    ]);

    const item = findItem(result, (text) => text.includes("python · BUILTIN"));
    const stage = result.channels.reasoningStages?.find((value) => value.title === "等待工具");
    expect(item?.durationSec).toBe(10);
    expect(stage?.durationSec).toBe(10);
  });

  it("infers the open reasoning tail from a terminal network error", () => {
    const completed = [
      [1791022728.4343805, 1791023103.1473522, 374],
      [1791023103.170502, 1791023227.5134134, 124],
      [1791023227.6586292, 1791023290.472696, 62],
      [1791023290.4940233, 1791023364.6687334, 74],
      [1791023364.8302653, 1791023420.9227853, 56],
      [1791023420.9584706, 1791024289.0792053, 868],
    ] as const;
    const events = completed.map(([start, end, duration], index) =>
      add(
        assistant(
          `completed-${index}`,
          end,
          "all",
          {
            reasoning_start_time: start,
            reasoning_end_time: end,
            finished_duration_sec: duration,
            reasoning_status: "reasoning_ended",
          },
          { content_type: "reasoning_recap", content: `思考了 ${duration}s` },
          null,
        ),
      ),
    );
    events.push(
      add(
        commentary("open-tail", 1791024384.490473, "最后一段仍在工作", {
          reasoning_start_time: 1791024289.1259665,
          reasoning_title: "完善会话滚动位置持久化",
        }),
      ),
    );

    const result = merged(events, {
      endedAtMs: 1791024401842,
      streamStatus: "error",
      closeReason: "error",
    });
    const note = findItem(result, (text) => text === "最后一段仍在工作");
    const stage = result.channels.reasoningStages?.find(
      (value) => value.title === "完善会话滚动位置持久化",
    );

    expect(result.channels.reasoningDurationSec).toBeCloseTo(1670.7160335, 5);
    expect(result.channels.reasoningDurationKind).toBe("inferred");
    expect(note?.durationSec).toBeCloseTo(17.351527, 5);
    expect(note?.durationKind).toBe("inferred");
    expect(stage?.durationSec).toBeCloseTo(17.351527, 5);
    expect(result.channels.reasoning).toContain("总思考时间：≈1670.7s");
  });

  it("does not infer an open reasoning tail while the transport is still streaming", () => {
    const result = merged(
      [
        add(
          assistant(
            "completed",
            110,
            "all",
            {
              reasoning_start_time: 100,
              reasoning_end_time: 110,
              finished_duration_sec: 10,
              reasoning_status: "reasoning_ended",
            },
            { content_type: "reasoning_recap", content: "思考了 10s" },
            null,
          ),
        ),
        add(
          commentary("open", 120, "仍在继续", {
            reasoning_start_time: 115,
            reasoning_title: "继续",
          }),
        ),
      ],
      { endedAtMs: 130000, streamStatus: "streaming" },
    );

    expect(result.channels.reasoningDurationSec).toBe(10);
    expect(result.channels.reasoningDurationKind).toBe("measured");
  });

  it("prefers a server-closed latest session over the transport boundary", () => {
    const result = merged(
      [
        add(
          assistant(
            "closed",
            125,
            "all",
            {
              reasoning_start_time: 115,
              reasoning_end_time: 125,
              finished_duration_sec: 10,
              reasoning_status: "reasoning_ended",
            },
            { content_type: "reasoning_recap", content: "思考了 10s" },
            null,
          ),
        ),
      ],
      { endedAtMs: 130000, streamStatus: "error", closeReason: "error" },
    );

    expect(result.channels.reasoningDurationSec).toBe(10);
    expect(result.channels.reasoningDurationKind).toBe("measured");
    expect(result.channels.reasoning).toContain("总思考时间：10s");
  });
});

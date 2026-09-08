// src/task-create-tools.ts
var name = "task-console-task-create-tools";
var inject = ["tools", "taskConsole"];
async function apply(ctx) {
  const defineTool = process.env.NODE_ENV === "test" ? (x) => x : (await import("@deepseek-ai/dsh-tools")).defineTool;
  const specs = [
    {
      name: "task_create_context",
      description: "\u8BFB\u53D6\u771F\u5B9E Agent \u80FD\u529B\u540D\u518C\u548C\u53EF\u590D\u7528\u5DE5\u4F5C\u6D41\u3002\u521B\u5EFA\u524D\u5FC5\u987B\u8BFB\u53D6\uFF0C\u4E0D\u80FD\u51ED\u7A7A\u7F16\u9020\u89D2\u8272\u3002",
      parameters: {},
      execute: () => ctx.get("taskConsole").creator.context()
    },
    {
      name: "task_create_submit",
      description: "\u4E3A\u6700\u65B0\u4E00\u6761\u771F\u5B9E\u7528\u6237\u8BF7\u6C42\u7EC4\u88C5\u5DE5\u4F5C\u6D41\u5E76\u6267\u884C\u3002plan \u662F JSON\uFF1Adecision create/reuse, reason\uFF1Bcreate \u8FD8\u9700 title, brief(\u53EF\u590D\u7528\u76EE\u6807\uFF0C\u4E0D\u5199 IP/\u5BC6\u7801), participants:[{agentId,brief}], graphMode static-chain(\u4E1A\u52A1\u89D2\u8272\u987A\u5E8F)\u6216 dynamic-rounds(\u4E25\u683C\u89C4\u5212/\u6267\u884C/\u8BC4\u4F30\u4E09\u4EBA)\u3002reuse \u9700 taskId\u3002\u4E0D\u8981\u5728 plan \u4E2D\u5305\u542B\u51ED\u636E\u3002\u540C\u4E00\u7528\u6237\u6D88\u606F\u91CD\u590D\u8C03\u7528\u4E0D\u91CD\u590D\u521B\u5EFA\u3002",
      parameters: { plan: { type: "string", required: true } },
      execute: (args, exec) => ctx.get("taskConsole").creator.submit(JSON.parse(args.plan), exec, exec.agent.session.header?.cwd)
    },
    {
      name: "task_create_status",
      description: "\u67E5\u8BE2\u67D0\u6B21 Task \u6267\u884C\u7684\u771F\u5B9E\u72B6\u6001\u3001\u89D2\u8272\u4F1A\u8BDD\u548C\u4EA4\u63A5\u7ED3\u679C\uFF1B\u8FD4\u56DE running \u4E0D\u80FD\u5BA3\u5E03\u5B8C\u6210\u3002",
      parameters: { taskId: { type: "string", required: true }, batchId: { type: "string", required: true } },
      execute: (args) => ctx.get("taskConsole").creator.status(args.taskId, args.batchId)
    }
  ];
  for (const spec of specs) {
    const tool = defineTool({ ...spec, output: { schema: { type: "object", additionalProperties: true }, render: (_, value) => [{ type: "text", text: JSON.stringify(value) }] } });
    ctx.effect(() => ctx.tools.register(tool));
  }
}
export {
  apply,
  inject,
  name
};

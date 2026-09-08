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
      description: '\u4E3A\u6700\u65B0\u771F\u5B9E\u7528\u6237\u8BF7\u6C42\u7EC4\u88C5\u5DE5\u4F5C\u6D41\u5E76\u6267\u884C\u3002plan \u662F JSON\u3002\u4F18\u5148\u4F7F\u7528\u5339\u914D\u7684\u53D7\u7BA1\u914D\u65B9\uFF1A{decision:"create",reason,recipe:{id:"fleet-base-v1",login:"preserve"\u6216"provision-gemini"}}\uFF0C\u4E0D\u80FD\u540C\u65F6\u4F20 title/brief/participants/graphMode\uFF0C\u89D2\u8272\u8FB9\u754C\u7531\u7248\u672C\u5316\u914D\u65B9\u56FA\u5B9A\u3002\u65E0\u9002\u7528\u914D\u65B9\u65F6 create \u9700 title,brief,participants:[{agentId,brief}],graphMode\uFF1Breuse \u9700 taskId\u3002\u6BCF\u6B21\u5148\u8BFB context \u771F\u5B9E\u540D\u518C\u548C\u914D\u65B9\uFF1B\u4E0D\u5F97\u589E\u52A0\u6743\u9650\u6216\u5305\u542B\u51ED\u636E\u3002\u540C\u4E00\u6D88\u606F\u91CD\u590D\u8C03\u7528\u4E0D\u91CD\u590D\u521B\u5EFA\u3002',
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

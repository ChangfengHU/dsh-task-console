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
      description: '\u53EA\u751F\u6210\u5E76\u4FDD\u5B58\u5F85\u5BA1\u67E5\u8BA1\u5212\uFF0C\u4E0D\u542F\u52A8 Task\u3002plan \u662F JSON\uFF0C\u5FC5\u987B\u542B design:{scope,branches:[{id,when,action,evidence}],coordination,failurePolicy:{isolateItems,maxAttempts,stopConditions:[]},acceptance:[]}\u3002\u5B9A\u65F6\u4EFB\u52A1\u540C\u65F6\u4F20 trigger:{kind:"cron",expr:"0 * * * *",timeZone:"Asia/Shanghai"}\uFF1B\u5BA1\u6279\u540E\u65F6\u95F4\u8868\u6682\u505C\uFF1B\u5148\u624B\u52A8\u6267\u884C\u901A\u8FC7\u4E1A\u52A1\u548C\u901A\u77E5\u9A8C\u6536\uFF0C\u518D\u542F\u7528\u5B9A\u65F6\u3002\u7701\u7565\u4E3A\u4E00\u6B21\u6027\u4EFB\u52A1\u3002dynamic-rounds \u7684 maxAttempts \u662F\u7A0B\u5E8F\u5F3A\u5236\u7684\u6700\u5927\u8F6E\u6B21\u3002\u4E0D\u80FD\u628A\u6807\u9898\u4E0E\u89D2\u8272\u6E05\u5355\u5F53\u5B8C\u6574\u8BBE\u8BA1\u3002\u5339\u914D\u53D7\u7BA1\u914D\u65B9\u65F6\u63D0\u4EA4 decision=create,reason,recipe,design\uFF0C\u4E0D\u540C\u65F6\u4F20 title/brief/participants/graphMode\u3002\u65E0\u5339\u914D\u914D\u65B9\u65F6 create \u9700 title,brief,participants:[{agentId,brief}],graphMode,design\uFF1Breuse \u9700 taskId,reason,design \u4E14\u8BBE\u8BA1\u4E0E\u539F\u6D41\u7A0B\u76F8\u540C\uFF0C\u4E0D\u53EF\u6539\u65F6\u95F4\u8868\u3002\u6BCF\u6B21\u5148\u8BFB context \u771F\u5B9E\u540D\u518C\uFF0C\u4E0D\u80FD\u7F16\u9020\u80FD\u529B\u3001\u589E\u52A0\u6743\u9650\u6216\u5305\u542B\u51ED\u636E\u3002\u8FD4\u56DE\u5BA1\u67E5\u5165\u53E3\u540E\u7B49\u5F85\u72EC\u7ACB\u653E\u884C\uFF1B\u521B\u5EFA Agent \u6CA1\u6709\u6279\u51C6\u5DE5\u5177\u3002',
      parameters: { plan: { type: "string", required: true } },
      execute: (args, exec) => ctx.get("taskConsole").creator.prepare(JSON.parse(args.plan), exec, exec.agent.session.header?.cwd)
    },
    {
      name: "task_create_plan_status",
      description: "\u67E5\u8BE2\u81EA\u5DF1\u751F\u6210\u7684\u8BA1\u5212\u548C\u72EC\u7ACB\u5BA1\u67E5\u610F\u89C1\uFF1B\u4E0D\u6279\u51C6\u3001\u4E0D\u542F\u52A8\u6267\u884C\u3002",
      parameters: { planId: { type: "string", required: true } },
      execute: (args) => ctx.get("taskConsole").creator.plan(args.planId)
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

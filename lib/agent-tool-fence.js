// src/agent-tool-fence.ts
var name = "task-console-agent-tool-fence";
var inject = ["tools"];
function apply(ctx, config) {
  if (!Array.isArray(config?.deny) || !config.deny.length) throw new Error("agent-tool-fence: deny must be a non-empty array");
  ctx.tools.restrict({ deny: [...new Set(config.deny)] });
}
export {
  apply,
  inject,
  name
};

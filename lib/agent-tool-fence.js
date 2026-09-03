// src/agent-tool-fence.ts
var name = "task-console-agent-tool-fence";
var inject = ["tools"];
function apply(ctx, config) {
  if (Array.isArray(config?.allow)) {
    ctx.tools.restrict({ allow: [...new Set(config.allow)] });
    return;
  }
  if (Array.isArray(config?.deny) && config.deny.length) {
    ctx.tools.restrict({ deny: [...new Set(config.deny)] });
    return;
  }
  throw new Error("agent-tool-fence: expected allow (empty is valid) or a non-empty legacy deny");
}
export {
  apply,
  inject,
  name
};

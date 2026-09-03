// src/agent-tool-fence.ts
var name = "task-console-agent-tool-fence";
var inject = ["tools"];
function apply(ctx, config) {
  if (Array.isArray(config?.selected)) {
    const selected = new Set(config.selected);
    const inherited = ctx.tools.schemas().map((schema) => schema.name);
    const deny = inherited.filter((name2) => !selected.has(name2));
    if (deny.length) ctx.tools.restrict({ deny });
    ctx.tools.guard((exec) => selected.has(exec.name) ? void 0 : "This Agent has not been granted that tool.");
    return;
  }
  if (Array.isArray(config?.allow)) {
    ctx.tools.restrict({ allow: [...new Set(config.allow)] });
    return;
  }
  if (Array.isArray(config?.deny) && config.deny.length) {
    ctx.tools.restrict({ deny: [...new Set(config.deny)] });
    return;
  }
  throw new Error("agent-tool-fence: expected selected, allow, or a non-empty legacy deny");
}
export {
  apply,
  inject,
  name
};

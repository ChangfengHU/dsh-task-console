// src/workflow-tool-grants.ts
var KEY = Symbol.for("dsh-task-console.workflow-tool-grants.v1");
var grants = globalThis[KEY] ??= globalThis[KEY] = /* @__PURE__ */ new Set();
function hasWorkflowToolGrant(exec) {
  const id = exec?.agent?.session?.id;
  if (!id) return false;
  for (const grant of grants) if (grant.sessionId === id && grant.name === exec.name) {
    try {
      if (grant.active()) return true;
    } catch {
    }
  }
  return false;
}

// src/agent-tool-fence.ts
var CAPABILITY_TOOLS = ["session_capabilities", "environment_capabilities"];
var name = "task-console-agent-tool-fence";
var inject = ["tools"];
function deniedToolGuidance(name2, selected) {
  const base = "This Agent has not been granted that tool.";
  if (name2 === "read_image" && selected.has("studio_character_image")) return base + " For the locked studio character, call studio_status and then studio_character_image with an exact characterReferences[].id. This denial does not mean image inspection is unavailable." + (selected.has("studio_preview_image") ? " Production specialists can inspect an existing project image with studio_preview_image({path}); that tool still enforces its role and project scope." : "");
  return base;
}
function apply(ctx, config) {
  if (Array.isArray(config?.selected)) {
    const selected = /* @__PURE__ */ new Set([...config.selected, ...CAPABILITY_TOOLS]);
    const inherited = ctx.tools.schemas().map((schema) => schema.name);
    const deny = inherited.filter((name2) => !selected.has(name2));
    if (deny.length) ctx.tools.restrict({ deny });
    ctx.tools.guard((exec) => selected.has(exec.name) || config.workflowRunTools === true && hasWorkflowToolGrant(exec) ? void 0 : deniedToolGuidance(exec.name, selected));
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
  deniedToolGuidance,
  inject,
  name
};

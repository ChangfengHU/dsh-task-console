// src/image-generation-tools.ts
import z from "@deepseek-ai/schemastery";

// src/image-policy.ts
var DEFAULT_IMAGE_POLICY = {
  defaultBackend: "codex",
  allowedBackends: ["codex"],
  allowOverride: false,
  fallback: "none",
  maxRequestsPerSession: 12
};
function imagePolicy(value) {
  if (value === void 0) return { ...DEFAULT_IMAGE_POLICY, allowedBackends: ["codex"] };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("\u751F\u56FE\u914D\u7F6E\u5FC5\u987B\u662F\u5BF9\u8C61");
  const p = value;
  if (Object.keys(p).some((k) => !["defaultBackend", "allowedBackends", "allowOverride", "fallback", "maxRequestsPerSession"].includes(k))) throw Error("\u751F\u56FE\u914D\u7F6E\u542B\u672A\u77E5\u5B57\u6BB5\uFF1B\u51ED\u636E\u53EA\u80FD\u914D\u7F6E\u5728\u5BBF\u4E3B");
  if (!["codex", "gemini"].includes(p.defaultBackend)) throw Error("\u751F\u56FE\u9ED8\u8BA4\u540E\u7AEF\u65E0\u6548");
  if (!Array.isArray(p.allowedBackends) || !p.allowedBackends.length || p.allowedBackends.some((b) => b !== "codex" && b !== "gemini")) throw Error("\u751F\u56FE\u5141\u8BB8\u540E\u7AEF\u65E0\u6548");
  const allowedBackends = [...new Set(p.allowedBackends)];
  if (!allowedBackends.includes(p.defaultBackend)) throw Error("\u9ED8\u8BA4\u751F\u56FE\u540E\u7AEF\u5FC5\u987B\u5728\u5141\u8BB8\u5217\u8868\u5185");
  if (typeof p.allowOverride !== "boolean" || !["none", "unavailable-only"].includes(p.fallback)) throw Error("\u751F\u56FE\u5207\u6362\u7B56\u7565\u65E0\u6548");
  if (!Number.isSafeInteger(p.maxRequestsPerSession) || p.maxRequestsPerSession < 1 || p.maxRequestsPerSession > 100) throw Error("\u751F\u56FE\u4F1A\u8BDD\u9884\u7B97\u5FC5\u987B\u4E3A 1\u2013100");
  return { defaultBackend: p.defaultBackend, allowedBackends, allowOverride: p.allowOverride, fallback: p.fallback, maxRequestsPerSession: p.maxRequestsPerSession };
}

// src/image-generation-tools.ts
var name = "task-console-native-image-tools";
var inject = ["tools", "nativeImages"];
var Config = z.object({
  defaultBackend: z.union(["codex", "gemini"]).default("codex"),
  allowedBackends: z.array(z.union(["codex", "gemini"])).default(["codex"]),
  allowOverride: z.boolean().default(false),
  fallback: z.union(["none", "unavailable-only"]).default("none"),
  maxRequestsPerSession: z.natural().min(1).max(100).default(12)
});
function sessionImageRefs(session) {
  const refs = /* @__PURE__ */ new Map();
  function visit(value) {
    if (!value || typeof value !== "object") return;
    if (value.type === "image" && value.attachment?.attachmentId) refs.set(String(value.attachment.attachmentId), value.attachment);
    if (Array.isArray(value)) for (const v of value) visit(v);
    else if (value.type === "tool-result") visit(value.content);
  }
  for (const event of session.events || []) if (event.type === "user/message" || event.type === "assistant/message" || event.type === "tool/result") visit(event.data?.message?.content);
  return refs;
}
async function apply(ctx, config = {}) {
  const policy = imagePolicy(Object.keys(config).length ? config : void 0);
  const { defineTool } = await import("@deepseek-ai/dsh-tools");
  const jobs = () => {
    const j = ctx.get("nativeImages")?.jobs;
    if (!j) throw Error("\u5BBF\u4E3B\u672A\u542F\u7528\u5185\u7F6E\u751F\u56FE\u670D\u52A1");
    return j;
  };
  const session = (exec) => {
    if (!exec.agent?.session?.id) throw Error("\u771F\u5B9E Agent \u4F1A\u8BDD\u5FC5\u9700");
    exec.signal?.throwIfAborted();
    return exec.agent.session;
  };
  const specs = [
    {
      name: "image_generate",
      description: `DSH \u5BBF\u4E3B\u5185\u7F6E\u3001\u9ED8\u8BA4\u4F18\u5148\u7684\u751F\u56FE\u5DE5\u5177\u3002\u9ED8\u8BA4 ${policy.defaultBackend}\uFF1B\u5141\u8BB8 ${policy.allowedBackends.join("/")}\u3002\u65E0\u9700\u521B\u5EFA\u751F\u56FE Agent\uFF0C\u4E0D\u901A\u8FC7 MCP\u3002\u7528\u6237\u660E\u786E\u6307\u5B9A MCP \u65F6\u5C0A\u91CD\u9009\u62E9\uFF1B\u672C\u673A\u672A\u5B89\u88C5\u6216\u660E\u786E\u63D0\u4EA4\u524D\u4E0D\u53EF\u7528\u65F6\u624D\u8003\u8651\u5DF2\u6388\u6743 MCP\u3002\u6BCF\u6B21\u751F\u6210/\u7F16\u8F91\u4E00\u5F20\u56FE\u7247\uFF0C\u53C2\u8003\u56FE\u4EC5\u7528\u5F53\u524D\u4F1A\u8BDD attachmentId\u3002\u7ACB\u5373\u8FD4\u56DE jobId\u3002\u5FC5\u987B\u7528 image_generate_status \u7B49\u5F85 completed \u540E\u4EA4\u4ED8\uFF1B\u4E0D\u5F97\u91CD\u590D\u63D0\u4EA4\uFF0C\u91CD\u8BD5\u540C\u4E00\u8BF7\u6C42\u5FC5\u987B\u590D\u7528 requestId\u3002\u540E\u7AEF\u8D85\u65F6/\u6267\u884C\u4E0D\u660E\u4E0D\u81EA\u52A8\u5207\u6362\u6216\u8865\u53D1 MCP\u3002`,
      parameters: { prompt: { type: "string", required: true }, requestId: { type: "string", required: true }, backend: { type: "string" }, referenceAttachmentIds: { type: "array", items: { type: "string" } } },
      execute: (args, exec) => {
        const s = session(exec), refs = sessionImageRefs(s);
        for (const [id, ref] of jobs().references(String(s.id))) refs.set(id, ref);
        const ids = args.referenceAttachmentIds ?? [];
        if (!Array.isArray(ids) || ids.length > 4) throw Error("\u6700\u591A\u56DB\u5F20\u53C2\u8003\u56FE");
        const references = ids.map((id) => {
          const ref = refs.get(id);
          if (!ref) throw Error("\u53C2\u8003\u56FE\u4E0D\u5C5E\u4E8E\u5F53\u524D\u4F1A\u8BDD\uFF1B\u5148\u8BFB\u53D6\u6216\u4E0A\u4F20\u56FE\u7247");
          return ref;
        });
        return jobs().start(String(s.id), { requestId: args.requestId, prompt: args.prompt, ...args.backend ? { backend: args.backend } : {}, references }, policy);
      }
    },
    { name: "image_generate_status", description: "\u67E5\u8BE2\u5F53\u524D\u4F1A\u8BDD\u81EA\u5DF1\u7684\u751F\u56FE\u56DE\u6267\uFF0C\u9ED8\u8BA4\u6700\u591A\u7B49\u5F85 15 \u79D2\u540E\u8FD4\u56DE\u3002running \u4E0D\u4EE3\u8868\u6210\u529F\uFF1B\u6309 pollAfterMs \u95F4\u9694\u67E5\u8BE2\uFF0C\u4E0D\u91CD\u590D image_generate\u3002completed \u8FD4\u56DE\u56FE\u7247\u8D44\u4EA7\u5143\u6570\u636E\uFF0C\u4E0D\u5411\u804A\u5929\u6A21\u578B\u9644\u56FE\uFF1B\u7528\u6237\u53EF\u5728 Images \u9875\u67E5\u770B\u3002\u53D6\u6D88\u7B49\u5F85\u4E0D\u4F1A\u64A4\u9500\u5DF2\u53D7\u7406\u4EFB\u52A1\uFF0C\u9700\u8981\u53D6\u6D88\u65F6\u7528 image_generate_cancel\u3002", parameters: { jobId: { type: "string", required: true }, waitMs: { type: "integer" } }, timeoutMs: 2e4, execute: (a, e) => jobs().waitStatus(String(session(e).id), a.jobId, a.waitMs ?? 15e3, e.signal) },
    { name: "image_generate_cancel", description: "\u53D6\u6D88\u5F53\u524D\u4F1A\u8BDD\u81EA\u5DF1\u7684\u751F\u56FE\u4EFB\u52A1\uFF1B\u53D6\u6D88\u4E0D\u4FDD\u8BC1\u4E0A\u6E38\u672A\u6263\u989D\u5EA6\uFF0C\u4E0D\u81EA\u52A8\u91CD\u53D1\u3002", parameters: { jobId: { type: "string", required: true } }, execute: (a, e) => jobs().cancel(String(session(e).id), a.jobId) }
  ];
  for (const spec of specs) ctx.effect(() => ctx.tools.register(defineTool({ ...spec, output: { schema: { type: "object", additionalProperties: true }, render: (_, value) => [{ type: "text", text: JSON.stringify(value) }] } })));
}
export {
  Config,
  apply,
  inject,
  name,
  sessionImageRefs
};

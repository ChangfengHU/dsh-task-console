// src/wire.ts
import { z } from "zod";
var PKG = "dsh-task-console";
var NAMESPACE = "taskConsole";
function jsonParam(name) {
  return Object.freeze({
    name,
    wire: name,
    source: "json",
    codec: Object.freeze({ mode: "strict", typeSymbol: `${PKG}/types#Json`, schema: z.string() })
  });
}
var JSON_RESULT = Object.freeze({ mode: "strict", typeSymbol: `${PKG}/types#Json`, schema: z.string() });
function descriptor(method, argc) {
  return Object.freeze({
    id: `${PKG}#${NAMESPACE}/${method}`,
    service: NAMESPACE,
    namespace: NAMESPACE,
    method,
    invocation: Object.freeze({ kind: "direct" }),
    parameters: Object.freeze(argc === 1 ? [jsonParam("payload")] : []),
    result: JSON_RESULT,
    sourceLocation: Object.freeze({ file: "src/wire.ts", line: 1, column: 1 })
  });
}
var METHODS = [
  ["catalog", 0],
  ["agents", 0],
  ["previewAgent", 1],
  ["saveAgent", 1],
  ["deleteAgent", 1],
  ["tryRun", 1],
  ["startAgentSession", 1],
  ["sessionTurns", 1],
  ["board", 0],
  ["tasks", 0],
  ["createTask", 1],
  ["setTaskEnabled", 1],
  ["deleteTask", 1],
  ["fireTask", 1],
  ["cancelRun", 1],
  ["taskEvents", 1],
  ["taskSnapshot", 1],
  ["taskGraph", 1],
  ["taskArtifacts", 1],
  ["artifactContent", 1],
  ["publishArtifact", 1],
  ["reviewCard", 1],
  ["unblockCard", 1],
  ["agentActivity", 1]
];
var CONSOLE_INVOCATIONS = Object.freeze(METHODS.map(([method, argc]) => descriptor(method, argc)));

// src/typert.host.ts
var TYPERT = Object.freeze({
  package: PKG,
  face: "host",
  schemas: Object.freeze([]),
  invocations: CONSOLE_INVOCATIONS,
  model: Object.freeze({
    services: Object.freeze([]),
    events: Object.freeze([]),
    objects: Object.freeze([])
  })
});
export {
  TYPERT
};

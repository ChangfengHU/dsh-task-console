# Standard Agent: inherit by default, exclude explicitly

User-authorized correction: installing the console must not reduce the native
standard Agent capability surface unless the administrator explicitly excludes a
Skill, MCP server or tool. Specialized roles and Task permissions stay unchanged.

- Removed the hardcoded browser/sessionId restriction from standard chat.
- Added three empty-by-default plugin configuration exclusion lists and displayed
  their effective values in the existing conversation Capabilities panel.
- Shared filtering across model schemas, execution guards and metadata; native
  slash Skill instructions/catalogs filtered by an outermost pre-step listener.
- Native runtime tests cover inherit/exclude/remove, server/tool scope, original
  permissions, slash-injection ordering, unchanged specialized roles and disposal.
- No SSH, browser create/delete/login, token rotation, Task or schedule mutation.
- Native remote identity checks remain. This release does not grant a standard
  Session the identity of browser-manager or guarantee every remote operation.
- Historical Skill bodies remain history; exclusions do not replace file/shell
  permissions and cannot certify a CLI's private loader isolation.

Deployment, final suite and browser evidence are recorded below after verification.

- Final suite: 313 passed, zero skipped, 39.78s with supported Node22 and explicit
  DSH_INSTALL_ROOT (`/tmp/dsh-inheritance-tests-final.log`). Earlier run without
  that environment skipped three native integration tests; it is not final evidence.
- Built and restarted only after native session and Task Run counts both zero.
- Real `session-inheritance-acceptance-20260915`: Flash initially fabricated a
  directory-shaped answer without a tool call, retained as failure evidence.
  Same test Session switched to Qwen Plus, actual session_capabilities call only,
  normal turn/end after 22.176s. No business tool dispatched.
- Live snapshot: 89 registered tools, 89 actual model request tools, no missing
  tools or excluded items. Browser create included. Both Skill/MCP inherit values
  confirmed. No implicit role restriction was substituted.
- Task specs, schedule bindings and Action catalog hashes exactly equal pre-change
  baselines. No dependency installs or temporary candidate build directories.
- First browser run blocked native automatic session.create and therefore failed
  the strict read-only assertion (zero JS errors). Retesting after the model turn
  ended; do not silently allow that mutation to make the test green.
- The same background blank-create request recurred. The test still aborts it,
  reports its count separately, and fails on any other requested mutation. This
  corrects the prior counter that mislabeled aborted requests as business writes;
  no native session.create request was allowed. One later test process exited 143
  without a result and is not counted as passed.
- Final public browser check passed at 1440/390px: 18.51s, two capability reads,
  zero page errors, zero business writes, one blocked native blank-create request.
  Empty exclusion fields verified by opening the policy disclosure. Screenshots
  retained at `/tmp/dsh-capabilities-live-{1440,390}.png` and visually inspected.

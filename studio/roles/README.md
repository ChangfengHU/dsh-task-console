# Studio role pack v1

Six public, authored AgentSpec templates for the existing `studio-video-v1` Task protocol. The main participants are director → editor → quality; storyboard → visual/sound are three separate `studioStages`. The Task runner creates real dependency links. These are not six standalone chats that happen to share a name.

`loadStudioRolePack()` reads and validates the package manifest, exact template hashes, canonical `readSpec`/`validateSpec` contracts, distinct role identities, minimal MCP grants and required skill gates. `inspectStudioRoleDependencies(pack, inventory)` reports missing versus unverified inventory entries. Neither function installs anything, probes a provider, approves quality or overwrites an existing Agent.

Empty `model` and `effort` fields use DSH's supported inherited default. An authorized setup flow may bind a private provider/model outside this public pack, then use the normal preset writer and lock generation. This pack contains no account, character ID, reference video URL, credentials or machine path. Six template Agent IDs are versioned public role identifiers, not user character identities.

The dependency manifest lists exact required Skills, raw MCP tool names and host tool/capability requirements. The Studio host tool group is broad at schema-discovery level; actual operations are still scoped by current Task role and runtime gates. Bash is necessary for visual asset processing, audio preparation and editing; prompts do not make it an OS sandbox. Reviewer has no Bash, file writer, paid generation, asset mutation, vault access or social publishing tools.

Skills, authenticated MCP transports, rendering dependencies, genuine observation/calibration and the public preview upload adapter must be supplied separately. The upload adapter is a host capability, not a made-up Studio tool. Optional platform-specific research must be added through validated installed capabilities when the user's source requires it; these templates do not pretend to provide every social platform. Source-only music cards require actual permitted source acquisition, not repeated archive downloads or SFX relabeling.

Use the ordinary Task Creator contract to construct a task with the resolved character, approved reference hash, budgets and `executionBinding: "agent-runtime-v1"`. Loading this pack does not provide a one-click recipe, launch a task, update old agents or authorize publication.

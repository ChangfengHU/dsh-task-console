# Apps static prototype

Scope: user requested an interactive public prototype and plugin ownership advice,
not real package installation or a replacement of existing DSH pages.

Recommendation: enhance `dsh-skill-mcp-console` with an Apps aggregate view. Its
existing Skill roots/install and MCP registry/config views remain authoritative.
Native DSH Plugins stay distinct. This prototype lives beside the existing DSH
UI work for review; no Apps runtime was added to Task Console.

Preserved: Agent, Board, Settings, native Plugins, Skill/MCP management, sessions,
folders, pinned/favorites. Added: Apps list/detail, source parsing preview,
install simulation, connection states, Skill policy simulation, commands to draft,
management/uninstall preview. Existing-page buttons explain preservation instead
of navigating to real production pages. No real credentials or mutations.

Source inspected 2026-09-15: public ChangfengHU/cartoon-video-skills main,
plugins/cartoon-video-studio/.codex-plugin/plugin.json (0.7.2), skills directory
(29), and .mcp.json (8 server names). Manifest does not declare hooks. File views
are explicitly summaries; operational connection/install state is demo data.
Reference UI: user-provided plugin-ui-* images on resource.vyibc.com and existing
DSH sidebar screenshot. No full interface redesign or runtime version change.

Public artifact:
https://resource.vyibc.com/dsh-apps-prototype-v1-20260915.html

29,449 bytes; SHA256 f8adcfc02d584965ffda8f4d9a6ebba7e48d04be183afedcceb383873293ac79.
Upload configuration resolved from Vault service:suqu-api in process. Exact
destination verified, target absent before upload, public GET bytes identical.

Validation: python3 scripts/test-apps-prototype.py [public URL]. Chrome tests
six tabs, simulated install, connection, Skill exclusion, draft insertion,
uninstall, source preview, Escape, 1440/390 overflow, theme; no JS errors.
Desktop/mobile screenshots visually inspected. Browser assets are self-contained;
no dependency installation, build, service restart, task/session writes or actual
App installation. Screenshots in /tmp/dsh-apps-*-v1*.png retained for UI review.

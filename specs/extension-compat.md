# Extension Compatibility Matrix

Newhorse is a fork of OpenCode and keeps the upstream extension surface. This
spec records what third-party extensions are expected to keep working, what is
deliberately restricted, and how compatibility is enforced.

## Extension kinds

| Kind | Load path | Personal workspace gating |
|---|---|---|
| Plugin (`.ts`/`.js` under `plugin/` or `plugins/`) | `ConfigPlugin.load` + `Plugin.Service` | `ConfigPlugin.allowedInPersonalWorkspace` (opt-in via `personal: true`) |
| Plugin-provided tools | `ToolRegistry` `fromPlugin` | `tool.load` content-flow decision (Personal opt-in required) |
| Skill (markdown under `skills/`, external dirs) | `Skill` discovery | `skill.load` content-flow decision (`skills.personal` opt-in) |
| MCP server | `MCP` connection | `mcp.connect` content-flow decision (`personal: true` per server) |
| Custom tool (`.ts`/`.js` under `tool/` or `tools/`) | `ToolRegistry` config-dir scan | Restricted config directories in Personal workspaces |

## Compatibility levels

- **Runtime-compatible**: the opencode plugin/skill/MCP SDK surface loads and
  runs unchanged. This is the default expectation for extensions built against
  the upstream SDK (`@newhorse/plugin` provides the fork's plugin SDK).
- **Content-scope restricted**: extensions that would load project/global
  tooling into a Personal workspace are denied unless the extension declares a
  Personal opt-in (`personal: true` on the plugin/MCP entry, or a Personal
  workspace-local location).
- **Not supported**: extensions that require upstream-hosted services
  (`opencode.ai` gateways, upstream install URLs) are out of scope; the fork
  never routes install/upgrade to upstream endpoints.

## Enforcement

1. **Config-level filter** (`Config.get`): in a Personal workspace, `plugin`
   sources are filtered to local-scope or `allowedInPersonalWorkspace` plugins,
   and config directories are restricted to the workspace directory.
2. **Content-flow decision** (`TrustPolicy.decide`): `tool.load`, `skill.load`,
   and `mcp.connect` run through the central policy matrix with
   `extension_personal_opt_in_required` for Personal scope without opt-in.
   Every decision is recorded in the content-free `policy_audit` trail.
3. **Registry gate** (`ToolRegistry.state`): custom/plugin tool loading is
   audited and gated by `tool.load` before a tool is registered.

## Test coverage

- Trust Policy matrix tests (`test/trust-policy.test.ts`) cover the opt-in
  rules for `extension.load`/`tool.load`/`skill.load`/`mcp.connect`.
- Personal workspace tests (`test/control-plane/personal-code-capability.test.ts`,
  `test/mcp/personal-workspace.test.ts`) cover scope filtering.
- Config merge/precedence tests (`test/config/config.test.ts`) cover plugin and
  permission merging and precedence.

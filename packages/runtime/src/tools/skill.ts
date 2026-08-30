import type { Tool, ToolCtx } from "@newhorse/core"
import type { SkillDisclosure } from "@newhorse/plugin"

/**
 * Skill loader tool (three-level disclosure, agent-browser style): the catalog
 * is light (name + description); the model asks for a skill by name and gets
 * the SKILL.md body (level 2); references/scripts (level 3) are on-demand.
 * The tool never eagerly loads a body — context stays bounded.
 */

/** Lazy catalog loader (discoverSkills of a plugin dir, or a static array). */
export type SkillCatalogLoader = () => Promise<SkillDisclosure[]>

/** Build the skill loader tool over a lazily-resolved catalog. */
export function createSkillTool(loadCatalog: SkillCatalogLoader): Tool {
  return {
    name: "skill",
    description: "Inspect or load a skill by name. Args: { name, load?: true to fetch the full SKILL.md body, full?: true to also note references/scripts }. Listing (no args) returns the catalog (name + description only).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name to load." },
        load: { type: "boolean", description: "Fetch the full body (level 2)." },
        full: { type: "boolean", description: "Also note references/scripts (level 3) availability." },
      },
    },
    execute: async (input: unknown, _ctx?: ToolCtx) => {
      const { name, load, full } = (input ?? {}) as { name?: string; load?: boolean; full?: boolean }
      const all = await loadCatalog()
      if (!name) return { skills: all.map((s) => ({ name: s.name, description: s.description })) }
      const skill = all.find((s) => s.name === name)
      if (!skill) return { error: `skill "${name}" not found`, available: all.map((s) => s.name) }
      if (!load && !full) {
        // Level 1: metadata only (the model decides whether to load).
        return { name: skill.name, description: skill.description, hint: 'call skill { name, load: true } for the full body' }
      }
      // Level 2 (+ optional level-3 note). Level 3 (references/scripts on disk)
      // is flagged but not eagerly inlined — context stays bounded.
      return { name: skill.name, description: skill.description, body: skill.body, referencesAvailable: full ? true : undefined }
    },
  }
}

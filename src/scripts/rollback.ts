import path from 'node:path';
import type { ToolRegistry } from './registry';
import { listSkillVersions, listToolVersions, restoreSkill, restoreToolVersion } from './versions';

const SKILLS = ['DECIDE', 'INVESTIGATE', 'PLAN', 'CREATE', 'VERIFY'];

/** `tools.rollback`: lists or restores a kept version of a packaged tool or a brain skill. */
export async function registerRollbackTool(registry: ToolRegistry): Promise<void> {
  await registry.registerInline(
    {
      id: 'tools.rollback',
      version: 1,
      description:
        'Rolls a packaged tool or a brain skill back to a kept earlier version (every tools.repair and skills.save keeps the one it replaced, tagged with the wake and gap). list=true shows the kept versions. The current version is kept too, so a rollback can be undone.',
      whenToUse: ['A repaired tool or a changed skill works worse than before and the earlier version should come back', 'You want to see what earlier versions of a tool or skill exist'],
      effect: 'write',
      requiresApproval: false,
      // Every rollback keeps the version it replaced, so it can itself be rolled back.
      reversible: true,
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['tool', 'skill'] },
          id: { type: 'string', description: 'Tool id (kind=tool) or skill name DECIDE, INVESTIGATE, PLAN, CREATE or VERIFY (kind=skill)' },
          version: { type: 'string', description: 'Version name from list=true (default: the newest kept version)' },
          list: { type: 'boolean', description: 'Only list the kept versions; change nothing' },
        },
        required: ['kind', 'id'],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      const id = String(input.id).trim();
      const tag = { at: ctx.now, reason: 'tools.rollback', ...(ctx.wakeId ? { wakeId: ctx.wakeId } : {}), ...(ctx.gapId ? { gapId: ctx.gapId } : {}) };
      const version = typeof input.version === 'string' && input.version.trim() ? input.version.trim() : undefined;
      if (input.kind === 'skill') {
        const state = id.toUpperCase();
        if (!SKILLS.includes(state)) return { ok: false, summary: `Unknown skill "${id}". Use one of ${SKILLS.join(', ')}.`, error: 'unknown skill' };
        const dir = path.join(ctx.workspaceDir, 'skills');
        if (input.list === true) {
          const versions = await listSkillVersions(dir, state);
          return { ok: true, summary: `${versions.length} kept version(s) of ${state}.`, data: versions };
        }
        const res = await restoreSkill(dir, state, tag, version);
        if ('error' in res) return { ok: false, summary: res.error, error: res.error };
        return { ok: true, summary: `Rolled skills/${state}.md back to ${res.restored}.${res.kept ? ` The version it replaced is kept as ${res.kept}.` : ''}`, changes: [`skill_rolled_back:${state}:${res.restored}`] };
      }
      const entry = registry.get(id);
      if (registry.isReserved(id)) return { ok: false, summary: `${id} is a built-in tool; it changes only with the engine code.`, error: 'built-in' };
      if (!entry?.toolDir) return { ok: false, summary: `No packaged tool "${id}".`, error: 'unknown tool' };
      if (input.list === true) {
        const versions = await listToolVersions(entry.toolDir);
        return { ok: true, summary: `${versions.length} kept version(s) of ${id}.`, data: versions };
      }
      // The version being replaced keeps its rungs too, so undoing this rollback brings them back.
      const rungsNow = await registry.rungsOf(id);
      const res = await restoreToolVersion(entry.toolDir, { ...tag, ...(rungsNow ? { rungs: rungsNow } : {}) }, version);
      if ('error' in res) return { ok: false, summary: res.error, error: res.error };
      const reloaded = await registry.reloadPackaged(id);
      if (!reloaded.ok) return { ok: false, summary: `Restored ${id} files to ${res.restored}, but it failed to load: ${reloaded.error}`, error: reloaded.error ?? 'reload failed' };
      // That version's code comes back with the rungs it had earned (trust follows the code it was earned by).
      const rungs = (await registry.restoreRungs(id, res.rungs)) ? Object.entries(res.rungs ?? {}).map(([k, v]) => `${k}=${v}`).join(', ') || 'its default rung' : '';
      return {
        ok: true,
        summary: `Rolled ${id} back to ${res.restored}.${rungs ? ` Its trust is back to what that version had: ${rungs}.` : ' That version recorded no rungs, so its trust is unchanged.'}${res.kept ? ` The version it replaced is kept as ${res.kept}.` : ''}`,
        changes: [`tool_rolled_back:${id}:${res.restored}`, ...(rungs ? [`trust_restored:${id}`] : [])],
      };
    },
  );
}

import type { ToolDefinition } from './tools';
import { cancelMission, createMission, describeMission, isActiveMission, listMissions, type MissionStatus } from '../unified/missions';

/**
 * v22 mission tools, so chat can hand deep research or prep to the background ("research X and get back to me"):
 *
 *   mission.start  { goal, context?, maxSteps?, urgent? }   queues a mission; `rufus start` runs it and pings you
 *   mission.list   { status? }                              read-only: what is running and what finished lately
 *   mission.cancel { id }                                   stops a queued or running mission
 *
 * `mission.start` and `mission.cancel` only touch your private local workspace (`missions/`), so they are `local`: the
 * Chief of Staff runs them right away when you ask. The mission itself can only ever read (see `runMission`).
 */

export const MISSION_START_TOOL = 'mission.start';
export const MISSION_LIST_TOOL = 'mission.list';
export const MISSION_CANCEL_TOOL = 'mission.cancel';

export function missionTools(): ToolDefinition<Record<string, unknown>, unknown>[] {
  return [
    {
      name: MISSION_START_TOOL,
      description:
        'Start a background mission for deep multi-step research or prep that takes a while ("research X and get back to me", "prep a brief for tomorrow\'s meeting"). It only reads (web, calendar, mail) and pings them when done. args: {"goal":"...","context"?:"what they said that matters","maxSteps"?:6}',
      readOnly: false,
      local: true,
      async execute(args, ctx) {
        const m = await createMission(
          ctx.dir,
          {
            goal: typeof args.goal === 'string' ? args.goal : '',
            ...(typeof args.context === 'string' ? { context: args.context } : {}),
            ...(typeof args.maxSteps === 'number' ? { maxSteps: args.maxSteps } : {}),
            ...(args.urgent === true ? { urgent: true } : {}),
          },
          ctx.now,
        );
        return { id: m.id, status: m.status, goal: m.goal, note: 'Queued: it runs in the background and they get a message when it is done. Tell them you are on it.' };
      },
    },
    {
      name: MISSION_LIST_TOOL,
      description: 'List background missions: what is running and what finished lately. args: {"status"?:"running"}',
      readOnly: true,
      async execute(args, ctx) {
        const status = typeof args.status === 'string' ? (args.status as MissionStatus) : undefined;
        const all = await listMissions(ctx.dir, { ...(status ? { status } : {}), limit: 10 });
        return all.map((m) => ({ id: m.id, goal: m.goal, status: m.status, steps: m.steps.length, active: isActiveMission(m), line: describeMission(m) }));
      },
    },
    {
      name: MISSION_CANCEL_TOOL,
      description: 'Cancel a queued or running background mission. args: {"id":"m-..."}',
      readOnly: false,
      local: true,
      async execute(args, ctx) {
        const id = typeof args.id === 'string' ? args.id : '';
        const r = await cancelMission(ctx.dir, id, ctx.now);
        return { id: r.record.id, status: r.record.status, cancelled: r.cancelled };
      },
    },
  ];
}

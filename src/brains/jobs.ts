import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { brainJobPath, type BrainJob } from '../events/watches';

async function writeJob(workspaceDir: string, job: BrainJob): Promise<void> {
  const file = brainJobPath(workspaceDir, job.id);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(job, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
}

/**
 * Starts a brain as a tracked background job, so Decide keeps moving while it runs. The job file records it;
 * a `brain_job` watch on the gap wakes Rufus when it finishes (or is lost), like a T3 thread finishing.
 * Returns once the job is recorded; `done` settles when the work does (tests await it).
 */
export async function startBrainJob(opts: {
  workspaceDir: string;
  toolId: string;
  gapId?: string;
  label: string;
  timeoutMs: number;
  now: Date;
  work: () => Promise<{ summary: string; data?: unknown }>;
}): Promise<{ job: BrainJob; done: Promise<BrainJob> }> {
  const job: BrainJob = {
    id: `job_${randomUUID().slice(0, 8)}`,
    toolId: opts.toolId,
    ...(opts.gapId ? { gapId: opts.gapId } : {}),
    label: opts.label,
    status: 'running',
    pid: process.pid,
    startedAt: opts.now.toISOString(),
    timeoutMs: opts.timeoutMs,
  };
  await writeJob(opts.workspaceDir, job);
  const done = (async (): Promise<BrainJob> => {
    let end: BrainJob;
    try {
      const out = await opts.work();
      end = { ...job, status: 'finished', finishedAt: new Date().toISOString(), summary: out.summary, ...(out.data !== undefined ? { data: out.data } : {}) };
    } catch (err) {
      end = { ...job, status: 'failed', finishedAt: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) };
    }
    await writeJob(opts.workspaceDir, end).catch(() => undefined);
    return end;
  })();
  return { job, done };
}

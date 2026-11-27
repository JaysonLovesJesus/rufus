import path from 'node:path';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function plist(body: Array<[string, string]>): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    ...body.map(([k, v]) => `  <key>${esc(k)}</key>${v}`),
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

const str = (s: string) => `<string>${esc(s)}</string>`;
const arr = (xs: string[]) => `\n  <array>\n${xs.map((x) => `    ${str(x)}`).join('\n')}\n  </array>`;
const dict = (env: Record<string, string>) =>
  `\n  <dict>\n${Object.entries(env)
    .map(([k, v]) => `    <key>${esc(k)}</key>${str(v)}`)
    .join('\n')}\n  </dict>`;

export interface PlistPaths {
  home: string;
  node: string;
  workspaceDir: string;
  releasesDir: string;
  sourceDir: string;
  /** PATH for the job (claude, git, pnpm, ffmpeg). */
  pathEnv: string;
}

/**
 * The daemon runs `<releases>/current` (a promoted, checked build), from the workspace folder (never a git repo),
 * and knows its source repo so self-upgrades land there rather than in the release checkout.
 */
export function daemonPlist(p: PlistPaths & { label?: string; heartbeatMs?: number }): string {
  const current = path.join(p.releasesDir, 'current');
  return plist([
    ['Label', str(p.label ?? 'com.rufus.daemon')],
    ['ProgramArguments', arr([p.node, path.join(current, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(current, 'src', 'cli.ts'), 'start'])],
    ['WorkingDirectory', str(p.workspaceDir)],
    [
      'EnvironmentVariables',
      dict({
        HOME: p.home,
        RUFUS_DIR: p.workspaceDir,
        RUFUS_HEARTBEAT_MS: String(p.heartbeatMs ?? 5000),
        RUFUS_SOURCE_DIR: p.sourceDir,
        RUFUS_RELEASES_DIR: p.releasesDir,
        PATH: p.pathEnv,
      }),
    ],
    ['RunAtLoad', '<true/>'],
    ['KeepAlive', '<true/>'],
    ['ThrottleInterval', '<integer>15</integer>'],
    ['ProcessType', str('Interactive')],
    ['StandardOutPath', str(path.join(p.workspaceDir, 'logs', 'daemon.log'))],
    ['StandardErrorPath', str(path.join(p.workspaceDir, 'logs', 'daemon.log'))],
  ]);
}

/**
 * The dead-man watchdog: a separate job every 5 minutes. It runs one self-contained file with plain node
 * (no tsx, no node_modules), so a broken build can't take it down with the daemon.
 */
export function watchdogPlist(p: PlistPaths & { label?: string; intervalSec?: number }): string {
  return plist([
    ['Label', str(p.label ?? 'com.rufus.watchdog')],
    ['ProgramArguments', arr([p.node, path.join(p.releasesDir, 'current', 'src', 'ops', 'watchdog.ts')])],
    ['WorkingDirectory', str(p.workspaceDir)],
    ['EnvironmentVariables', dict({ HOME: p.home, RUFUS_DIR: p.workspaceDir, PATH: p.pathEnv })],
    ['StartInterval', `<integer>${p.intervalSec ?? 300}</integer>`],
    ['RunAtLoad', '<true/>'],
    ['ProcessType', str('Background')],
    ['StandardOutPath', str(path.join(p.workspaceDir, 'logs', 'watchdog.log'))],
    ['StandardErrorPath', str(path.join(p.workspaceDir, 'logs', 'watchdog.log'))],
  ]);
}

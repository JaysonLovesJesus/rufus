import path from 'node:path';
import type { RufusConfig } from '../types';
import { createBeeperChannel } from './beeper';
import type { LiveChannel } from './bridge';
import { createTelegramChannel } from './telegram';

export type ChannelName = 'telegram' | 'beeper';

/** Which chat app is set up: Telegram (env token or `config.telegram`) and/or Beeper (`config.beeper` or env). */
export function configuredChannels(config: RufusConfig, env: NodeJS.ProcessEnv = process.env): ChannelName[] {
  const found: ChannelName[] = [];
  if (env.RUFUS_TELEGRAM_TOKEN || config.telegram) found.push('telegram');
  if (config.beeper || env.RUFUS_BEEPER_TOKEN || env.RUFUS_BEEPER_CHAT_ID) found.push('beeper');
  return found;
}

/**
 * Picks the channel for `rufus bridge`. `--channel` wins. Otherwise whichever one is configured;
 * with both configured it asks you to choose, and with neither it falls back to Beeper's setup error.
 */
export function selectChannel(
  config: RufusConfig,
  opts: { channel?: string; workspaceDir: string; env?: NodeJS.ProcessEnv },
): { name: ChannelName; channel: LiveChannel } {
  const env = opts.env ?? process.env;
  let name: ChannelName;
  if (opts.channel !== undefined) {
    if (opts.channel !== 'telegram' && opts.channel !== 'beeper') throw new Error(`Unknown --channel "${opts.channel}". Use telegram or beeper.`);
    name = opts.channel;
  } else {
    const found = configuredChannels(config, env);
    if (found.length > 1) throw new Error(`Both ${found.join(' and ')} are configured. Pick one with --channel ${found.join(' | ')}.`);
    name = found[0] ?? 'beeper';
  }
  if (name === 'telegram') {
    return { name, channel: createTelegramChannel(config.telegram, env, { stateFile: path.join(opts.workspaceDir, 'telegram-state.json') }) };
  }
  return { name, channel: createBeeperChannel(config.beeper, env) };
}

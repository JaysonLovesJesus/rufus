import http from 'node:http';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { ApprovalStore, ToolRegistry } from '../src';
import { isMcpToolReadOnly, registerMcpTools } from '../src/scripts/mcp-bridge';
import { tempDir } from './helpers';

const NOW = new Date('2026-11-27T12:00:00Z');

describe('MCP bridge through the Trust Ladder', () => {
  it('classifies read-only vs write MCP tools accurately', () => {
    expect(isMcpToolReadOnly({ name: 'do_thing', annotations: { readOnlyHint: true } })).toBe(true);
    expect(isMcpToolReadOnly({ name: 'get_items', annotations: { readOnlyHint: false } })).toBe(false);
    expect(isMcpToolReadOnly({ name: 'list_tabs' })).toBe(true);
    expect(isMcpToolReadOnly({ name: 'send_email' })).toBe(false);
    expect(isMcpToolReadOnly({ name: 'delete_record', annotations: { destructiveHint: true } })).toBe(false);
  });

  it('registers HTTP MCP tools with reads quiet and writes at draft, and handles unreachable servers gracefully', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: number; method: string; params?: Record<string, unknown> };
      res.setHeader('content-type', 'application/json');
      if (body.method === 'initialize') {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'demo', version: '1.0' } } }));
        return;
      }
      if (body.method === 'notifications/initialized') {
        res.statusCode = 202;
        res.end();
        return;
      }
      if (body.method === 'tools/list') {
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              tools: [
                { name: 'list_notes', description: 'List saved notes', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
                { name: 'post_note', description: 'Publish a note', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
              ],
            },
          }),
        );
        return;
      }
      if (body.method === 'tools/call') {
        const name = String(body.params?.name ?? '');
        const args = (body.params?.arguments ?? {}) as Record<string, unknown>;
        calls.push({ name, args });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: `ran:${name}:${JSON.stringify(args)}` }] } }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;

    try {
      const dir = await tempDir('rufus-mcp-');
      const approvals = new ApprovalStore(dir);
      const registry = new ToolRegistry({ toolsDir: path.join(dir, 'tools') });
      registry.useTrust(approvals);
      const handle = await registerMcpTools({
        registry,
        servers: {
          demo: { type: 'http', url: `http://127.0.0.1:${port}/mcp` },
          offline: { type: 'http', url: 'http://127.0.0.1:1/mcp' },
        },
      });
      try {
        expect(handle.registered.sort()).toEqual(['mcp.demo.list_notes', 'mcp.demo.post_note']);
        expect(handle.failed).toHaveLength(1);
        expect(handle.failed[0]?.server).toBe('offline');

        // Read-only MCP tool runs quietly without approval
        const readRec = await registry.call('mcp.demo.list_notes', { q: 'hi' }, { workspaceDir: dir, now: NOW });
        expect(readRec.status).toBe('ok');
        expect(readRec.summary).toContain('ran:list_notes');

        // Write MCP tool starts at draft -> queued for owner approval, does not execute yet
        const writeRec = await registry.call('mcp.demo.post_note', { text: 'hello' }, { workspaceDir: dir, now: NOW });
        expect(writeRec.status).toBe('pending_approval');
        expect(calls.filter((c) => c.name === 'post_note')).toHaveLength(0);

        // Once approved, it executes
        const approvedRec = await registry.call('mcp.demo.post_note', { text: 'hello' }, { workspaceDir: dir, now: NOW, approved: true });
        expect(approvedRec.status).toBe('ok');
        expect(calls.filter((c) => c.name === 'post_note')).toHaveLength(1);
      } finally {
        handle.close();
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('registers stdio MCP tools and executes them over JSON-RPC stdio', async () => {
    const dir = await tempDir('rufus-mcp-stdio-');
    const script = path.join(dir, 'fake-mcp.mjs');
    await writeFile(
      script,
      `
      import readline from 'node:readline';
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'stdio', version: '1.0' } } }) + '\\n');
        } else if (msg.method === 'tools/list') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'get_status', description: 'Check status', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: {} } }] } }) + '\\n');
        } else if (msg.method === 'tools/call') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'all-good' }] } }) + '\\n');
        }
      });
      `,
      'utf8',
    );
    const approvals = new ApprovalStore(dir);
    const registry = new ToolRegistry({ toolsDir: path.join(dir, 'tools') });
    registry.useTrust(approvals);
    const handle = await registerMcpTools({
      registry,
      servers: { local: { type: 'stdio', command: process.execPath, args: [script] } },
    });
    try {
      expect(handle.registered).toEqual(['mcp.local.get_status']);
      const rec = await registry.call('mcp.local.get_status', {}, { workspaceDir: dir, now: NOW });
      expect(rec.status).toBe('ok');
      expect(rec.summary).toContain('all-good');
    } finally {
      handle.close();
    }
  });
});

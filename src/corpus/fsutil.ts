import { promises as fs } from 'node:fs';
import path from 'node:path';

/** `p` itself when it is a file, else the files directly inside it (sorted) whose extension is in `exts`. Throws a clear error when `p` does not exist. */
export async function inputFiles(p: string, exts: string[]): Promise<string[]> {
  const abs = path.resolve(p);
  let st;
  try {
    st = await fs.stat(abs);
  } catch {
    throw new Error(`Path not found: ${p}`);
  }
  if (st.isFile()) return [abs];
  const names = (await fs.readdir(abs)).filter((n) => !n.startsWith('.') && exts.includes(path.extname(n).toLowerCase())).sort();
  return names.map((n) => path.join(abs, n));
}

/** First `bytes` of a file as a Buffer (never reads a huge file whole). */
export async function readHead(file: string, bytes: number): Promise<Buffer> {
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

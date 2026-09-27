/**
 * `/files` — list, read and write inside the workspace root, for the UI's file browser.
 *
 *   GET  /files?dir=<rel>          -> { dir, absolutePath, entries: [{name, kind, size, mtime}] }
 *   GET  /files/read?path=<rel>    -> the file's bytes
 *   PUT  /files/write?path=<rel>   -> writes the request body (parents created); 204
 *
 * Paths are relative to the root; absolute paths are accepted only inside it, and symlinks are
 * resolved and must stay inside it.
 */
import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export class FilesError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function inside(root: string, p: string): boolean {
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Resolve `requested` against `root`; throws `FilesError(403)` if it escapes (lexically or by symlink). */
export async function resolveInRoot(root: string, requested: string | null | undefined): Promise<string> {
  const rootAbs = resolve(root);
  const rootReal = await realpath(root).catch(() => rootAbs);
  let target: string;
  if (requested && isAbsolute(requested)) {
    const r = resolve(requested);
    if (inside(rootAbs, r)) target = resolve(rootReal, relative(rootAbs, r) || ".");
    else if (inside(rootReal, r)) target = r;
    else throw new FilesError(403, `path escapes the workspace root: ${requested}`);
  } else {
    target = resolve(rootReal, requested || ".");
  }
  if (!inside(rootReal, target)) throw new FilesError(403, `path escapes the workspace root: ${requested}`);
  // Resolve symlinks of the deepest existing ancestor.
  let probe = target;
  const missing: string[] = [];
  for (;;) {
    const real = await realpath(probe).catch(() => null);
    if (real !== null) {
      const full = resolve(real, ...missing.reverse());
      if (!inside(rootReal, full)) throw new FilesError(403, `path escapes the workspace root through a link: ${requested}`);
      return full;
    }
    const parent = dirname(probe);
    if (parent === probe) return target;
    missing.push(probe.slice(parent.length + 1));
    probe = parent;
  }
}

export interface FileEntry {
  name: string;
  kind: "dir" | "file";
  size: number;
  mtime: string;
}

export async function listDir(root: string, dir: string | null): Promise<{ dir: string; absolutePath: string; entries: FileEntry[] }> {
  const abs = await resolveInRoot(root, dir);
  const st = await stat(abs).catch(() => null);
  if (!st) throw new FilesError(404, `no such directory: ${dir ?? "."}`);
  if (!st.isDirectory()) throw new FilesError(400, `not a directory: ${dir}`);
  const entries: FileEntry[] = [];
  for (const e of await readdir(abs, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const s = await stat(resolve(abs, e.name)).catch(() => null);
    if (!s) continue;
    entries.push({ name: e.name, kind: s.isDirectory() ? "dir" : "file", size: s.size, mtime: s.mtime.toISOString() });
  }
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
  const rootReal = await realpath(root).catch(() => resolve(root));
  return { dir: relative(rootReal, abs) || ".", absolutePath: abs, entries };
}

export async function handleFiles(req: Request, url: URL, root: string, headers: Record<string, string>): Promise<Response> {
  const json = (data: unknown, status = 200) => Response.json(data, { status, headers });
  try {
    if (url.pathname === "/files" && req.method === "GET") return json(await listDir(root, url.searchParams.get("dir")));
    if (url.pathname === "/files/read" && req.method === "GET") {
      const abs = await resolveInRoot(root, url.searchParams.get("path"));
      const st = await stat(abs).catch(() => null);
      if (!st?.isFile()) throw new FilesError(404, `no such file: ${url.searchParams.get("path")}`);
      return new Response(Bun.file(abs), { headers: { ...headers, "content-type": "application/octet-stream", "x-file-path": abs } });
    }
    if (url.pathname === "/files/write" && req.method === "PUT") {
      const path = url.searchParams.get("path");
      if (!path) throw new FilesError(400, "missing ?path=");
      const abs = await resolveInRoot(root, path);
      await mkdir(dirname(abs), { recursive: true });
      await Bun.write(abs, new Uint8Array(await req.arrayBuffer()));
      return new Response(null, { status: 204, headers: { ...headers, "x-file-path": abs } });
    }
    return json({ error: "not found" }, 404);
  } catch (e) {
    if (e instanceof FilesError) return json({ error: e.message }, e.status);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}

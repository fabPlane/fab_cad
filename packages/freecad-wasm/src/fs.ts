/**
 * MEMFS helpers: getting documents into the module's file system and results back out.
 *
 * The in-memory helpers (`mkdirTree`, `writeFile`, `readFile`, `exists`, `listFiles`, `remove`)
 * run anywhere. `mountFile` / `mountDirectory` read the host disk and are Bun/Node only (they
 * import `node:fs` lazily, so a browser bundle that never calls them does not pull it in).
 */
import type { FreeCadWasmFS } from "./index";

/** The part of a loaded module these helpers need (so a bare `{ FS }` works too). */
export interface HasFS {
  readonly FS: FreeCadWasmFS;
}

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

function join(a: string, b: string): string {
  return a.endsWith("/") ? `${a}${b}` : `${a}/${b}`;
}

/** Create `path` and every missing parent. Existing directories are left alone. */
export function mkdirTree(fs: FreeCadWasmFS, path: string): void {
  if (!path || path === "/") return;
  if (typeof fs.mkdirTree === "function") {
    try {
      fs.mkdirTree(path);
      return;
    } catch {
      /* fall through to the manual walk */
    }
  }
  let cur = "";
  for (const part of path.split("/")) {
    if (!part) continue;
    cur += `/${part}`;
    try {
      fs.mkdir(cur);
    } catch {
      /* already there */
    }
  }
}

/** Write bytes (or text) into MEMFS, creating parent directories. */
export function writeFile(instance: HasFS, path: string, data: Uint8Array | string): void {
  mkdirTree(instance.FS, dirname(path));
  instance.FS.writeFile(path, typeof data === "string" ? new TextEncoder().encode(data) : data);
}

/** Read a MEMFS file as bytes. */
export function readFile(instance: HasFS, path: string): Uint8Array {
  return instance.FS.readFile(path, { encoding: "binary" });
}

export function readTextFile(instance: HasFS, path: string): string {
  return new TextDecoder().decode(readFile(instance, path));
}

export function exists(instance: HasFS, path: string): boolean {
  const fs = instance.FS;
  if (typeof fs.analyzePath === "function") return fs.analyzePath(path).exists;
  try {
    fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Every file under `path` (recursively), as absolute MEMFS paths, sorted. */
export function listFiles(instance: HasFS, path: string): string[] {
  const fs = instance.FS;
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of fs.readdir(dir)) {
      if (name === "." || name === "..") continue;
      const p = join(dir, name);
      const st = fs.stat(p);
      if (fs.isDir(st.mode)) walk(p);
      else out.push(p);
    }
  };
  if (exists(instance, path)) walk(path);
  return out.sort();
}

/** Delete a file, or a directory tree. Missing paths are ignored. */
export function remove(instance: HasFS, path: string): void {
  const fs = instance.FS;
  if (!exists(instance, path)) return;
  const st = fs.stat(path);
  if (!fs.isDir(st.mode)) {
    fs.unlink(path);
    return;
  }
  for (const name of fs.readdir(path)) if (name !== "." && name !== "..") remove(instance, join(path, name));
  fs.rmdir?.(path);
}

/** Copy one host file into MEMFS (Bun/Node). Returns the number of bytes. */
export async function mountFile(instance: HasFS, hostPath: string, memfsPath: string = hostPath): Promise<number> {
  const { readFile: hostRead } = await import("node:fs/promises");
  const data = new Uint8Array(await hostRead(hostPath));
  writeFile(instance, memfsPath, data);
  return data.byteLength;
}

export interface MountResult {
  files: number;
  bytes: number;
  memfsDir: string;
}

/** Copy a host directory into MEMFS, recursively (Bun/Node). `memfsDir` defaults to `hostDir`. */
export async function mountDirectory(instance: HasFS, hostDir: string, memfsDir: string = hostDir): Promise<MountResult> {
  const { readdir, readFile: hostRead } = await import("node:fs/promises");
  const { join: hostJoin } = await import("node:path");
  mkdirTree(instance.FS, memfsDir);
  let files = 0;
  let bytes = 0;
  const walk = async (host: string, memfs: string): Promise<void> => {
    for (const e of await readdir(host, { withFileTypes: true })) {
      const h = hostJoin(host, e.name);
      const m = join(memfs, e.name);
      if (e.isDirectory()) {
        mkdirTree(instance.FS, m);
        await walk(h, m);
      } else if (e.isFile()) {
        const data = new Uint8Array(await hostRead(h));
        instance.FS.writeFile(m, data);
        files++;
        bytes += data.byteLength;
      }
    }
  };
  await walk(hostDir, memfsDir);
  return { files, bytes, memfsDir };
}

/** Copy a MEMFS file out to the host disk (Bun/Node), e.g. after `SaveDocumentAs` into MEMFS. */
export async function exportFile(instance: HasFS, memfsPath: string, hostPath: string): Promise<number> {
  const { mkdir, writeFile: hostWrite } = await import("node:fs/promises");
  const { dirname: hostDirname } = await import("node:path");
  const data = readFile(instance, memfsPath);
  await mkdir(hostDirname(hostPath), { recursive: true });
  await hostWrite(hostPath, data);
  return data.byteLength;
}

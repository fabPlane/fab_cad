/**
 * Meshes keyed by `(document, object, revision)`. The server bumps an object's `revision` whenever
 * its shape changes, so a cached mesh is valid for exactly that revision; undo can bring an old
 * revision back, which is why a few are kept per object rather than only the latest.
 */
import type { Tessellation } from "@fab-cad/protocol";

export interface TessellationCacheOptions {
  /** Most meshes kept in total (least recently used go first). Default 512. */
  maxEntries?: number;
  /** Most revisions kept per object. Default 4. */
  maxRevisionsPerObject?: number;
}

const key = (doc: string, object: string, revision: number | string) => `${doc}\u0000${object}\u0000${revision}`;

export class TessellationCache {
  private readonly entries = new Map<string, Tessellation>();
  private readonly latestRevision = new Map<string, number | string>();
  private readonly maxEntries: number;
  private readonly maxPerObject: number;

  constructor(opts: TessellationCacheOptions = {}) {
    this.maxEntries = opts.maxEntries ?? 512;
    this.maxPerObject = opts.maxRevisionsPerObject ?? 4;
  }

  get size(): number {
    return this.entries.size;
  }

  get(doc: string, object: string, revision: number | string): Tessellation | undefined {
    const k = key(doc, object, revision);
    const t = this.entries.get(k);
    if (t) {
      // refresh LRU position
      this.entries.delete(k);
      this.entries.set(k, t);
    }
    return t;
  }

  /** The mesh of the most recently stored revision of an object. */
  latest(doc: string, object: string): Tessellation | undefined {
    const rev = this.latestRevision.get(`${doc}\u0000${object}`);
    return rev === undefined ? undefined : this.entries.get(key(doc, object, rev));
  }

  put(doc: string, t: Tessellation): void {
    const k = key(doc, t.object, t.revision);
    this.entries.delete(k);
    this.entries.set(k, t);
    this.latestRevision.set(`${doc}\u0000${t.object}`, t.revision);
    const prefix = `${doc}\u0000${t.object}\u0000`;
    const mine = [...this.entries.keys()].filter((e) => e.startsWith(prefix));
    for (const old of mine.slice(0, Math.max(0, mine.length - this.maxPerObject))) this.entries.delete(old);
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }

  /** Drop every revision of an object (it was deleted). */
  evictObject(doc: string, object: string): void {
    const prefix = `${doc}\u0000${object}\u0000`;
    for (const k of [...this.entries.keys()]) if (k.startsWith(prefix)) this.entries.delete(k);
    this.latestRevision.delete(`${doc}\u0000${object}`);
  }

  evictDocument(doc: string): void {
    const prefix = `${doc}\u0000`;
    for (const k of [...this.entries.keys()]) if (k.startsWith(prefix)) this.entries.delete(k);
    for (const k of [...this.latestRevision.keys()]) if (k.startsWith(prefix)) this.latestRevision.delete(k);
  }

  clear(): void {
    this.entries.clear();
    this.latestRevision.clear();
  }
}

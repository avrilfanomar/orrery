// The append-only event log, one JSON event per line. It is the only state
// the platform keeps; everything else is a projection of it (ADR 0001).
//
// What it keeps when things go wrong (ADR 0008): every line it loads or writes
// passes the log contract (checkLogEntry); an event is remembered only once it
// is written and flushed; a write that fails is cut back, so the file holds
// exactly what was acknowledged; a seed or a reset replaces the file in one
// step; and one process at a time writes a log. A reset keeps the log it
// replaces (ADR 0009): nothing it does destroys the record.
import { closeSync, constants, copyFileSync, existsSync, fsyncSync, ftruncateSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { checkLogEntry, type NewEvent, type OrreryEvent } from '@orrery/core';

/**
 * A crash during a write can leave the last line cut short. That line was
 * never acknowledged, but removing it is the operator's call, not the store's
 * (ADR 0007): the message names the line and says what to do.
 */
function parseLine(line: string, where: () => string, isLast: boolean): unknown {
  try {
    return JSON.parse(line);
  } catch (err) {
    const hint = isLast ? ' The last write was probably cut short: back up the file, then delete that line.' : '';
    throw new Error(`${where()}: not a complete JSON event — ${(err as Error).message}.${hint}`);
  }
}

/** Holds events to the contract in order after `prev`, and returns them as a reload would read them. */
function checked(events: readonly unknown[], prev: OrreryEvent | undefined, where: (i: number) => string): OrreryEvent[] {
  const out: OrreryEvent[] = [];
  events.forEach((raw, i) => {
    const r = checkLogEntry(raw, out.at(-1) ?? prev);
    if (!r.ok) throw new Error(`${where(i)}: the event ${r.problem}`);
    out.push(r.event);
  });
  return out;
}

interface Loaded {
  events: OrreryEvent[];
  bytes: number;
  /** The file ends without a line break: a crash between an event and its newline. */
  endsOpen: boolean;
}

function load(file: string): Loaded {
  if (!existsSync(file)) return { events: [], bytes: 0, endsOpen: false };
  const buf = readFileSync(file);
  const lines = buf.toString('utf8').split('\n');
  let last = lines.length - 1;
  while (last > 0 && !lines[last]!.trim()) last--;
  const events: OrreryEvent[] = [];
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const where = () => `${file}:${i + 1}`;
    // A log that breaks the contract is corrupted history; refusing to start beats silently rewriting the past.
    const r = checkLogEntry(parseLine(line, where, i === last), events[events.length - 1]);
    if (!r.ok) throw new Error(`${where()}: the event ${r.problem}`);
    events.push(r.event);
  });
  return { events, bytes: buf.length, endsOpen: buf.length > 0 && buf[buf.length - 1] !== 0x0a };
}

const line = (e: OrreryEvent) => `${JSON.stringify(e)}\n`;

function writeAll(fd: number, data: Buffer): void {
  for (let done = 0; done < data.length; ) done += writeSync(fd, data, done);
}

/** Makes a rename survive a power cut. Where a directory cannot be opened (Windows), the rename is as durable as the OS makes it. */
function syncDir(dir: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    // nothing more this platform offers
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Keeps the file at `path` as `keep`: a second name for the same bytes, or a
 * copy where the file system has no hard links. Never over an existing file.
 */
function keepAs(path: string, keep: string): void {
  try {
    linkSync(path, keep);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw err;
    copyFileSync(path, keep, constants.COPYFILE_EXCL);
    const fd = openSync(keep, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

// ---------------------------------------------------------------------------
// One writer per log
// ---------------------------------------------------------------------------

/** Lock files this process holds; removed on exit, short of a kill. */
const held = new Set<string>();
let releasesOnExit = false;

/** Whether another live process has this pid. Our own pid in a lock we don't hold is a lock left by an earlier life (a container restarts as pid 1). */
function otherProcessRuns(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function createLock(path: string): boolean {
  try {
    writeFileSync(path, `${process.pid}\n`, { flag: 'wx' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return false;
  }
}

const lockOwner = (path: string) => Number.parseInt(existsSync(path) ? readFileSync(path, 'utf8') : '', 10);

/**
 * A second writer would hand out the same sequence numbers, and the next start
 * would refuse the log. The lock file names its writer; one whose writer is
 * gone (a kill, a power cut) is taken over, so a crash never needs a hand.
 */
function lock(file: string): string {
  const path = `${file}.lock`;
  if (held.has(path)) throw new Error(`${file} is already open for writing in this process`);
  mkdirSync(dirname(file), { recursive: true });
  if (!createLock(path)) {
    const pid = lockOwner(path);
    if (otherProcessRuns(pid)) throw new Error(`${file} is being written by another process (pid ${pid}). Stop it first; if no such process runs, delete ${path}.`);
    rmSync(path, { force: true }); // its writer is gone
    if (!createLock(path)) throw new Error(`${file}: another process took the lock while a stale one was cleared. Try again.`);
  }
  held.add(path);
  if (!releasesOnExit) {
    releasesOnExit = true;
    process.once('exit', () => held.forEach(unlock));
  }
  return path;
}

function unlock(path: string): void {
  held.delete(path);
  if (lockOwner(path) === process.pid) rmSync(path, { force: true });
}

// ---------------------------------------------------------------------------

export interface OpenOptions {
  /** Load without taking the writer's lock; writing is refused. For a log another process may own, and frozen fixtures. */
  readOnly?: boolean;
  /**
   * Take the lock without reading the log, to replace it: `reset`, whose log
   * may be the very thing that is broken. The old file stays until
   * `replaceAll` renames the new one over it.
   */
  fresh?: boolean;
}

export class EventStore {
  private events: OrreryEvent[] = [];
  private fd: number | null = null;
  /** The file's size after the last acknowledged write: a failed write is cut back to it. */
  private bytes = 0;
  private endsOpen = false;
  private lockPath: string | null = null;
  /** Why writing stopped, once it has. */
  private refusal: string | null = null;
  /** Opened `fresh`: the file on disk is not what this store holds until `replaceAll`. */
  private replacing = false;

  private constructor(private readonly file: string | null) {}

  /** Opens (or starts) a log, taking its writer's lock unless `readOnly`. `null` keeps it in memory, which the tests use. */
  static open(file: string | null, opts: OpenOptions = {}): EventStore {
    const store = new EventStore(file);
    if (!file) return store;
    if (opts.readOnly) store.refusal = 'it was opened read-only';
    else store.lockPath = lock(file);
    store.replacing = opts.fresh ?? false;
    try {
      const loaded = store.replacing ? { events: [], bytes: 0, endsOpen: false } : load(file);
      store.events = loaded.events;
      store.bytes = loaded.bytes;
      store.endsOpen = loaded.endsOpen;
    } catch (err) {
      store.close();
      throw err;
    }
    return store;
  }

  all(): readonly OrreryEvent[] {
    return this.events;
  }

  get isEmpty(): boolean {
    return this.events.length === 0;
  }

  /**
   * Appends events, giving each the next sequence number. An event is never
   * stamped earlier than its predecessor, which keeps the log ordered by time
   * and lets projection stop at the first event past an `asOf` horizon. They
   * are remembered only after they are on disk, so a failed write leaves the
   * store, the file and every answer as they were.
   */
  append(newEvents: readonly NewEvent[]): OrreryEvent[] {
    const prev = this.events.at(-1);
    let lastAt = prev?.at ?? '';
    const stamped = newEvents.map((e, i) => {
      const at = e.at < lastAt ? lastAt : e.at;
      lastAt = at;
      return { ...e, at, seq: this.events.length + i + 1 };
    });
    // The contract the log is loaded against, so the server never writes a line it would refuse at its next start.
    const stored = checked(stamped, prev, (i) => `Refused to write event ${stamped[i]!.seq}`);
    if (stored.length) this.write(stored.map(line).join(''));
    for (const e of stored) this.events.push(e);
    return stored;
  }

  /**
   * Replaces the whole log — only for seeding an empty or reset store. It is
   * written beside the log and renamed over it, so a crash leaves the old log
   * or the new one, never part of one. With `keep`, a log that holds anything
   * stays at that path; the result says whether one was kept.
   */
  replaceAll(events: readonly OrreryEvent[], keep?: string): { kept: string | null } {
    let kept: string | null = null;
    const next = checked(events, undefined, (i) => `Refused to write event ${i + 1} of a new log`);
    if (this.file) {
      this.assertWritable();
      const data = Buffer.from(next.map(line).join(''));
      const tmp = `${this.file}.${process.pid}.tmp`;
      const fd = openSync(tmp, 'w');
      try {
        writeAll(fd, data);
        fsyncSync(fd);
        closeSync(fd);
        if (keep && existsSync(this.file) && statSync(this.file).size > 0) {
          keepAs(this.file, keep);
          kept = keep;
        }
        renameSync(tmp, this.file);
      } catch (err) {
        try {
          closeSync(fd);
        } catch {
          // already closed: the rename failed
        }
        rmSync(tmp, { force: true });
        throw err;
      }
      syncDir(dirname(this.file));
      this.release(); // the append handle points at the file just replaced
      this.bytes = data.length;
      this.endsOpen = false;
    }
    this.events = next;
    this.replacing = false;
    return { kept };
  }

  /** Releases the file and the writer's lock. Reads still answer; writes are refused. */
  close(): void {
    this.release();
    if (this.lockPath) unlock(this.lockPath);
    this.lockPath = null;
    this.refusal ??= 'it was closed';
  }

  private release(): void {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
  }

  private assertWritable(): void {
    if (this.refusal) throw new Error(`${this.file} cannot be written: ${this.refusal}`);
  }

  /** Appends and flushes `text`, or leaves the file as it was. */
  private write(text: string): void {
    if (!this.file) return;
    this.assertWritable();
    if (this.replacing) throw new Error(`${this.file} was opened to be replaced; replace it before appending`);
    const data = Buffer.from(this.endsOpen ? `\n${text}` : text);
    this.fd ??= openSync(this.file, 'a');
    try {
      writeAll(this.fd, data);
      fsyncSync(this.fd);
    } catch (err) {
      this.cutBack(err as Error);
      throw err;
    }
    this.bytes += data.length;
    this.endsOpen = false;
  }

  /** Removes what a failed write left. If even that fails, the store stops writing: its next start names any damaged line. */
  private cutBack(cause: Error): void {
    try {
      ftruncateSync(this.fd!, this.bytes);
      fsyncSync(this.fd!);
    } catch (err) {
      this.refusal = `a write failed (${cause.message}) and could not be undone (${(err as Error).message}). Restart the server`;
    }
  }
}

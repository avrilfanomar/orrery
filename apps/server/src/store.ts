// The append-only event log, one JSON event per line. It is the only state
// the platform keeps; everything else is a projection of it (ADR 0001).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { EventSchema, type NewEvent, type RuEvent } from '@ru/core';

/**
 * A crash during a write can leave the last line cut short. That line was
 * never acknowledged, but removing it is the operator's call, not the store's
 * (ADR 0007): the message names the line and says what to do.
 */
function parseLine(line: string, where: string, isLast: boolean): unknown {
  try {
    return JSON.parse(line);
  } catch (err) {
    const hint = isLast ? ' The last write was probably cut short: back up the file, then delete that line.' : '';
    throw new Error(`${where}: not a complete JSON event — ${(err as Error).message}.${hint}`);
  }
}

export class EventStore {
  private readonly events: RuEvent[] = [];

  private constructor(private readonly file: string | null) {}

  /** Opens (or starts) a log. `null` keeps it in memory, which the tests use. */
  static open(file: string | null): EventStore {
    const store = new EventStore(file);
    if (file && existsSync(file)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      let last = lines.length - 1;
      while (last > 0 && !lines[last]!.trim()) last--;
      lines.forEach((line, i) => {
        if (!line.trim()) return;
        // A log that does not parse is corrupted history; refusing to start beats silently rewriting the past.
        const parsed = EventSchema.safeParse(parseLine(line, `${file}:${i + 1}`, i === last));
        if (!parsed.success) throw new Error(`${file}:${i + 1}: invalid event — ${parsed.error.issues[0]?.message}`);
        store.events.push(parsed.data);
      });
    }
    return store;
  }

  all(): readonly RuEvent[] {
    return this.events;
  }

  get isEmpty(): boolean {
    return this.events.length === 0;
  }

  /**
   * Appends events, giving each the next sequence number. An event is never
   * stamped earlier than its predecessor, which keeps the log ordered by time
   * and lets projection stop at the first event past an `asOf` horizon.
   */
  append(newEvents: readonly NewEvent[]): RuEvent[] {
    const stored: RuEvent[] = [];
    let lastAt = this.events.at(-1)?.at ?? '';
    for (const e of newEvents) {
      const at = e.at < lastAt ? lastAt : e.at;
      const ev = { ...e, at, seq: this.events.length + 1 } as RuEvent;
      this.events.push(ev);
      stored.push(ev);
      lastAt = at;
    }
    if (this.file && stored.length) {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, stored.map((e) => JSON.stringify(e)).join('\n') + '\n');
    }
    return stored;
  }

  /** Replaces the whole log — only for seeding an empty or reset store. */
  replaceAll(events: readonly RuEvent[]): void {
    this.events.length = 0;
    this.events.push(...events);
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
    }
  }
}

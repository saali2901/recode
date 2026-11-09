/** One server-sent message. `id` increases monotonically per log. */
export interface LogEntry {
  id: number;
  type: 'job' | 'event' | 'log';
  data: unknown;
}

/** Bounded in-memory event history with live subscription; allows clients to reconnect and replay. */
export class EventLog {
  private nextId = 1;
  private readonly entries: LogEntry[] = [];
  private readonly listeners = new Set<(entry: LogEntry) => void>();

  constructor(private readonly capacity = 3000) {}

  push(type: LogEntry['type'], data: unknown): LogEntry {
    const entry: LogEntry = { id: this.nextId++, type, data };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.shift();
    for (const listener of this.listeners) listener(entry);
    return entry;
  }

  /** Entries with an id greater than `afterId`. */
  since(afterId: number): LogEntry[] {
    return this.entries.filter((entry) => entry.id > afterId);
  }

  subscribe(listener: (entry: LogEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

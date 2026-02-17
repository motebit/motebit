import type { EventLogEntry } from "@motebit/sdk";
import type { EventStoreAdapter, EventFilter } from "@motebit/event-log";

export interface HttpAdapterConfig {
  baseUrl: string;
  motebitId: string;
  authToken?: string;
}

/**
 * EventStoreAdapter that calls the Motebit API's sync endpoints over HTTP.
 * Used by the CLI to push/pull events to/from a remote server.
 */
export class HttpEventStoreAdapter implements EventStoreAdapter {
  private baseUrl: string;
  private motebitId: string;
  private authToken: string | undefined;

  constructor(config: HttpAdapterConfig) {
    // Strip trailing slash from baseUrl
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.motebitId = config.motebitId;
    this.authToken = config.authToken;
  }

  async append(entry: EventLogEntry): Promise<void> {
    const url = `${this.baseUrl}/sync/${this.motebitId}/push`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ events: [entry] }),
    });
    if (!res.ok) {
      throw new Error(`Push failed: ${res.status} ${res.statusText}`);
    }
  }

  async query(filter: EventFilter): Promise<EventLogEntry[]> {
    const afterClock = filter.after_version_clock ?? 0;
    const url = `${this.baseUrl}/sync/${this.motebitId}/pull?after_clock=${afterClock}`;
    const res = await fetch(url, {
      method: "GET",
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`Pull failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as { events: EventLogEntry[] };
    return body.events;
  }

  async getLatestClock(_motebitId: string): Promise<number> {
    const url = `${this.baseUrl}/sync/${this.motebitId}/clock`;
    const res = await fetch(url, {
      method: "GET",
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`Clock failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as { latest_clock: number };
    return body.latest_clock;
  }

  async tombstone(_eventId: string, _motebitId: string): Promise<void> {
    // No-op for MVP — tombstoning is a local operation
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.authToken) {
      h["Authorization"] = `Bearer ${this.authToken}`;
    }
    return h;
  }
}

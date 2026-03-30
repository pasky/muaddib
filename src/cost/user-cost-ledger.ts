import {
  appendFileSync,
  mkdirSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface UserCostLedgerRow {
  ts: string;
  cost: number;
  byok: boolean;
  arc: string;
  model: string;
}

export interface LogUserCostInput {
  ts?: string;
  cost: number;
  byok: boolean;
  arc: string;
  model: string;
}

export interface GetUserCostInWindowOptions {
  now?: Date;
  byok?: boolean;
}

export class UserCostLedger {
  private readonly createdCostDirs = new Set<string>();

  constructor(private readonly muaddibHome: string) {}

  async logUserCost(userArc: string, input: LogUserCostInput): Promise<void> {
    const row: UserCostLedgerRow = {
      ts: input.ts ?? new Date().toISOString(),
      cost: input.cost,
      byok: input.byok,
      arc: input.arc,
      model: input.model,
    };

    const date = row.ts.slice(0, 10);
    const dirPath = this.dirPath(userArc);
    if (!this.createdCostDirs.has(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
      this.createdCostDirs.add(dirPath);
    }

    appendFileSync(this.filePath(userArc, date), JSON.stringify(row) + "\n", "utf-8");
  }

  async getUserCostInWindow(
    userArc: string,
    windowHours: number,
    options: GetUserCostInWindowOptions = {},
  ): Promise<number> {
    const now = options.now ?? new Date();
    const cutoffMs = now.getTime() - windowHours * 3_600_000;
    let total = 0;

    for (const date of eachUtcDateBetween(new Date(cutoffMs), now)) {
      for (const row of await this.readRows(this.filePath(userArc, date))) {
        const rowMs = Date.parse(row.ts);
        if (!Number.isFinite(rowMs) || rowMs < cutoffMs) {
          continue;
        }
        if (options.byok !== undefined && row.byok !== options.byok) {
          continue;
        }
        total += row.cost;
      }
    }

    return total;
  }

  private dirPath(userArc: string): string {
    return join(this.muaddibHome, "users", userArc, "cost");
  }

  private filePath(userArc: string, date: string): string {
    return join(this.dirPath(userArc), `${date}.jsonl`);
  }

  private async readRows(path: string): Promise<UserCostLedgerRow[]> {
    let raw: string;
    try {
      raw = await readFile(path, "utf-8");
    } catch {
      return [];
    }

    const rows: UserCostLedgerRow[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        rows.push(JSON.parse(trimmed) as UserCostLedgerRow);
      } catch {
        // skip malformed rows
      }
    }
    return rows;
  }
}

function eachUtcDateBetween(start: Date, end: Date): string[] {
  const dates: string[] = [];
  let cursor = Date.UTC(
    start.getUTCFullYear(),
    start.getUTCMonth(),
    start.getUTCDate(),
  );
  const endDay = Date.UTC(
    end.getUTCFullYear(),
    end.getUTCMonth(),
    end.getUTCDate(),
  );

  while (cursor <= endDay) {
    dates.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += 86_400_000;
  }

  return dates;
}

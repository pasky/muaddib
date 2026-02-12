import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { inspect } from "node:util";

type LogLevel = "DEBUG" | "INFO" | "WARNING" | "ERROR";

export interface RuntimeLogger {
  debug(message: string, ...data: unknown[]): void;
  info(message: string, ...data: unknown[]): void;
  warn(message: string, ...data: unknown[]): void;
  error(message: string, ...data: unknown[]): void;
  child(name: string): RuntimeLogger;
}

interface RuntimeLogWriterOptions {
  muaddibHome: string;
  nowProvider?: () => Date;
  stdout?: NodeJS.WriteStream;
}

export class RuntimeLogWriter {
  private readonly nowProvider: () => Date;
  private readonly stdout: NodeJS.WriteStream;

  constructor(private readonly options: RuntimeLogWriterOptions) {
    this.nowProvider = options.nowProvider ?? (() => new Date());
    this.stdout = options.stdout ?? process.stdout;
  }

  getLogger(name: string): RuntimeLogger {
    return new StructuredRuntimeLogger(name, this);
  }

  write(level: LogLevel, loggerName: string, message: string, data: unknown[]): void {
    const now = this.nowProvider();
    const renderedMessage = renderMessage(message, data);
    const line = `${formatTimestamp(now)} - ${loggerName} - ${level} - ${renderedMessage}\n`;

    if (level !== "DEBUG") {
      this.stdout.write(line);
    }

    const path = this.getSystemLogPath(now);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, line, { encoding: "utf-8" });
  }

  getSystemLogPath(now: Date = this.nowProvider()): string {
    const date = now.toISOString().slice(0, 10);
    return join(this.options.muaddibHome, "logs", date, "system.log");
  }
}

class StructuredRuntimeLogger implements RuntimeLogger {
  constructor(
    private readonly name: string,
    private readonly writer: RuntimeLogWriter,
  ) {}

  debug(message: string, ...data: unknown[]): void {
    this.writer.write("DEBUG", this.name, message, data);
  }

  info(message: string, ...data: unknown[]): void {
    this.writer.write("INFO", this.name, message, data);
  }

  warn(message: string, ...data: unknown[]): void {
    this.writer.write("WARNING", this.name, message, data);
  }

  error(message: string, ...data: unknown[]): void {
    this.writer.write("ERROR", this.name, message, data);
  }

  child(name: string): RuntimeLogger {
    if (!name) {
      return this;
    }
    return new StructuredRuntimeLogger(`${this.name}.${name}`, this.writer);
  }
}

export function createConsoleLogger(name: string): RuntimeLogger {
  return {
    debug: (message: string, ...data: unknown[]) => {
      console.debug(`${name} - ${message}`, ...data);
    },
    info: (message: string, ...data: unknown[]) => {
      console.info(`${name} - ${message}`, ...data);
    },
    warn: (message: string, ...data: unknown[]) => {
      console.warn(`${name} - ${message}`, ...data);
    },
    error: (message: string, ...data: unknown[]) => {
      console.error(`${name} - ${message}`, ...data);
    },
    child: (childName: string) => createConsoleLogger(`${name}.${childName}`),
  };
}

function renderMessage(message: string, data: unknown[]): string {
  if (data.length === 0) {
    return message;
  }

  return `${message} ${data.map((value) => serializeLogValue(value)).join(" ")}`;
}

function serializeLogValue(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }

  if (typeof value === "string") {
    return value;
  }

  return inspect(value, {
    depth: 8,
    breakLength: Infinity,
    compact: true,
  });
}

function formatTimestamp(date: Date): string {
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1, 2);
  const day = pad(date.getDate(), 2);
  const hour = pad(date.getHours(), 2);
  const minute = pad(date.getMinutes(), 2);
  const second = pad(date.getSeconds(), 2);
  const millis = pad(date.getMilliseconds(), 3);
  return `${year}-${month}-${day} ${hour}:${minute}:${second},${millis}`;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

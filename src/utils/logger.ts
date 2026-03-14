export class Logger {
  constructor(private module: string) {}

  private format(level: string, msg: string): string {
    const ts = new Date().toISOString();
    return `[${ts}] [${level}] [${this.module}] ${msg}`;
  }

  info(msg: string, ...args: unknown[]) {
    console.log(this.format('INFO', msg), ...args);
  }

  warn(msg: string, ...args: unknown[]) {
    console.warn(this.format('WARN', msg), ...args);
  }

  error(msg: string, ...args: unknown[]) {
    console.error(this.format('ERROR', msg), ...args);
  }

  debug(msg: string, ...args: unknown[]) {
    if (process.env.DEBUG) {
      console.debug(this.format('DEBUG', msg), ...args);
    }
  }
}

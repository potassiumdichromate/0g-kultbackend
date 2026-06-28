import pino from "pino";

/**
 * Both existing repos log via plain console.log/console.error with no levels or structure
 * (flagged as an anti-pattern in the repo analysis). Every new service uses this instead.
 */
export function createLogger(serviceName: string) {
  return pino({
    name: serviceName,
    level: process.env.LOG_LEVEL || "info",
    transport:
      process.env.NODE_ENV === "production"
        ? undefined
        : { target: "pino-pretty", options: { colorize: true } },
  });
}

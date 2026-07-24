import type { INestApplicationContext, Type } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Logger } from "pino-nestjs";

/**
 * Boot a headless (no HTTP listener) Nest context wired to the pino logger —
 * the shared half of the dispatcher and runner bootstraps. bufferLogs holds
 * init logs until pino takes over, so nothing goes through Nest's default
 * console logger. Shutdown wiring stays with the caller: the dispatcher
 * enables shutdown hooks, the runner drains on SIGTERM and closes explicitly.
 */
export async function createHeadlessContext(
  module: Type,
): Promise<INestApplicationContext> {
  const ctx = await NestFactory.createApplicationContext(module, {
    bufferLogs: true,
  });
  ctx.useLogger(ctx.get(Logger));
  return ctx;
}

import { DatabaseModule, dbConfig } from "@crystallize/database";
import { mongoConfig } from "@crystallize/mongo";
import { pinoLoggerConfig } from "@crystallize/shared";
import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { LoggerModule as PinoLoggerModule } from "pino-nestjs";

import { runnerConfig } from "./config/runner.config";
import { ExecutionModule } from "./execution.module";

/**
 * Root module for the one-shot runner process. It builds its single runner
 * through RUNNER_FACTORY (exported by ExecutionModule) rather than resolving a
 * RunnerService provider, so main.ts owns exactly one instance for the run.
 */
@Module({
  imports: [
    // The runner is one-shot and single-task: bake the task id (argv[2], same
    // value main.ts reads) into the logger name so every line of this process
    // is attributable when several runners' stdout interleave.
    PinoLoggerModule.forRoot(
      pinoLoggerConfig(`runner-${process.argv[2] ?? "unknown"}`),
    ),
    ConfigModule.forRoot({
      isGlobal: true,
      load: [runnerConfig, dbConfig, mongoConfig],
    }),
    DatabaseModule,
    ExecutionModule,
  ],
})
export class RunnerModule {}

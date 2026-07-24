import { DatabaseModule, dbConfig } from "@crystallize/database";
import { mongoConfig } from "@crystallize/mongo";
import { pinoLoggerConfig } from "@crystallize/shared";
import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { LoggerModule as PinoLoggerModule } from "pino-nestjs";

import { runnerConfig } from "../runner/config/runner.config";
import { dispatchConfig } from "./dispatch/config/dispatch.config";
import { DispatchModule } from "./dispatch/dispatch.module";
import { sweepConfig } from "./sweep/config/sweep.config";
import { SweepModule } from "./sweep/sweep.module";

/**
 * Root module for the dispatcher process, wiring its two halves: consume
 * (DispatchModule — poll, claim, route heavy to a spawned runner / light to
 * the inline path) and recover (SweepModule — reclaim stale claims,
 * dead-letter). The runner and mongo config namespaces are loaded for the
 * inline path; the Mongo client connects lazily, so a dispatcher that never
 * sees a light task never opens that connection.
 */
@Module({
  imports: [
    PinoLoggerModule.forRoot(pinoLoggerConfig("dispatcher")),
    ConfigModule.forRoot({
      isGlobal: true,
      load: [dispatchConfig, sweepConfig, dbConfig, runnerConfig, mongoConfig],
    }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    DispatchModule,
    SweepModule,
  ],
})
export class AppModule {}

import { DatabaseModule, dbConfig } from "@crystallize/database";
import { pinoLoggerConfig } from "@crystallize/shared";
import { TaskModule } from "@crystallize/tasks";
import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { LoggerModule as PinoLoggerModule } from "pino-nestjs";

import { appConfig } from "./config/app.config";
import { TasksController } from "./controllers/tasks.controller";
import { TaskIngestionService } from "./services/task-ingestion.service";

/**
 * Root module for the API process. The app is a single feature (the tasks
 * endpoint), so controller and services are declared here directly — a feature
 * module would only add an indirection until a second resource exists.
 */
@Module({
  imports: [
    PinoLoggerModule.forRoot(pinoLoggerConfig("api")),
    ConfigModule.forRoot({ isGlobal: true, load: [appConfig, dbConfig] }),
    DatabaseModule,
    TaskModule,
  ],
  controllers: [TasksController],
  providers: [TaskIngestionService],
})
export class AppModule {}

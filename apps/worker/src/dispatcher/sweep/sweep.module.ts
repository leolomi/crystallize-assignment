import { TaskModule } from "@crystallize/tasks";
import { Module } from "@nestjs/common";

import { StaleSweeper } from "./services/stale-sweeper.service";

/** The recovery half of the process: reclaim stale claims, dead-letter. */
@Module({
  imports: [TaskModule],
  providers: [StaleSweeper],
})
export class SweepModule {}

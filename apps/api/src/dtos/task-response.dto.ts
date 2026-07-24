import { TaskKind, TaskStatus, TaskWeight } from "@crystallize/tasks";
import { ApiProperty } from "@nestjs/swagger";

export class TaskCreatedDto {
  @ApiProperty({ format: "uuid" })
  id!: string;

  @ApiProperty({ enum: TaskKind })
  kind!: TaskKind;

  @ApiProperty({ enum: [TaskStatus.PENDING] })
  status!: TaskStatus.PENDING;

  @ApiProperty({ example: 3 })
  totalRows!: number;

  @ApiProperty({
    enum: TaskWeight,
    description:
      "Threshold routing: light tasks run inline in the dispatcher, heavy ones get a runner process",
  })
  weight!: TaskWeight;
}

export class TaskDetailsDto {
  @ApiProperty({ format: "uuid" })
  id!: string;

  @ApiProperty({ enum: TaskKind })
  kind!: TaskKind;

  @ApiProperty({ enum: TaskStatus })
  status!: TaskStatus;

  @ApiProperty({ enum: TaskWeight })
  weight!: TaskWeight;

  @ApiProperty()
  totalRows!: number;

  @ApiProperty()
  processedRows!: number;

  @ApiProperty({ description: "processedRows / totalRows, in [0..1]" })
  progress!: number;

  @ApiProperty({ type: String, nullable: true })
  error!: string | null;

  @ApiProperty({ type: Number, nullable: true })
  runnerPid!: number | null;

  @ApiProperty({ type: Date, nullable: true })
  heartbeatAt!: Date | null;

  @ApiProperty({ type: Date })
  createdAt!: Date;

  @ApiProperty({ type: Date, nullable: true })
  startedAt!: Date | null;

  @ApiProperty({ type: Date, nullable: true })
  finishedAt!: Date | null;
}

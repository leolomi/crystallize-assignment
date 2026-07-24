import { TaskStatus } from "@crystallize/tasks";
import { ApiProperty } from "@nestjs/swagger";
import { z } from "zod";

/** Pagination of the dead-letter listing. */
export const deadLetterQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(1000).default(100),
  offset: z.coerce.number().int().nonnegative().default(0),
});

export class DeadLetterRowDto {
  @ApiProperty({ example: 42 })
  rowIndex!: number;

  @ApiProperty({ type: Object, example: { id: "prod-42", price: 9.99 } })
  payload!: Record<string, unknown>;

  @ApiProperty({ type: String, nullable: true, example: "injected failure" })
  error!: string | null;

  @ApiProperty({ example: 3 })
  attempts!: number;
}

export class DeadLettersDto {
  @ApiProperty({ format: "uuid" })
  taskId!: string;

  @ApiProperty({ type: [DeadLetterRowDto] })
  rows!: DeadLetterRowDto[];
}

export class RetryResultDto {
  @ApiProperty({ format: "uuid" })
  id!: string;

  @ApiProperty({ enum: [TaskStatus.PENDING] })
  status!: TaskStatus.PENDING;

  @ApiProperty({
    description: "How many dead-lettered rows went back to pending",
    example: 3,
  })
  retriedRows!: number;
}

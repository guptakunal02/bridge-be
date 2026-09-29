import { ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

/**
 * Wholesale reorder — the FE sends the complete list of team ids in
 * the new evaluation order. Service assigns priority = 0, 1, 2… in
 * that order. Ids that don't exist are skipped, ids not present in
 * the list keep their current priority.
 */
export class ReorderTeamsDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('all', { each: true })
  orderedIds!: string[];
}

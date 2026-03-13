import { Haikus } from './tables/haikus';

export interface DeleteHaikuInput {
  id: string;
}

export interface DeleteHaikuOutput {
  success: boolean;
}

export async function deleteHaiku(
  input: DeleteHaikuInput,
): Promise<DeleteHaikuOutput> {
  await Haikus.remove(input.id);
  return { success: true };
}

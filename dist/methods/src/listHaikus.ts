import { Haikus, Haiku } from './tables/haikus';

export interface ListHaikuOutput {
  haikus: Haiku[];
}

export async function listHaikus(): Promise<ListHaikuOutput> {
  const haikus = await Haikus.sortBy((h) => h.created_at).reverse();
  return { haikus };
}

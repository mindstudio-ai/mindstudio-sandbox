import { db } from '@mindstudio-ai/agent';

export interface Haiku {
  id: string;
  created_at: number;
  updated_at: number;
  last_updated_by: string;

  topic: string;
  text: string;
}

export const Haikus = db.defineTable<Haiku>('haikus');

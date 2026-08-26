/**
 * Citation shape returned by the Knowledge retrieval layer and rendered by
 * the conversation UI. Defined here because it is the cross-cutting contract
 * between `modules/knowledge`, `modules/conversations` and the SSE layer.
 */
export interface Citation {
  chunkId: string;
  title: string;
  chapter: string;
  content: string;
  score: number;
  documentId?: string;
  documentName?: string;
  chunkIndex?: number;
  heading?: string;
  distance?: number;
  category: string;
  type: string;
  source: string;
}
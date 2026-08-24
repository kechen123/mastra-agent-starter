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

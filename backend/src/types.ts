export type KnowledgeType = 'scripture' | 'commentary' | 'historical' | 'research' | 'document';

export interface WorkMetadata {
  title: string;
  author?: string;
  dynasty?: string;
  category: string;
  version?: string;
  type: KnowledgeType;
  originalWork?: string;
  commentator?: string;
  source: string;
}

export interface Citation extends WorkMetadata {
  chunkId: string;
  chapter: string;
  content: string;
  score: number;
  documentId?: string;
  documentName?: string;
  chunkIndex?: number;
  heading?: string;
  distance?: number;
}

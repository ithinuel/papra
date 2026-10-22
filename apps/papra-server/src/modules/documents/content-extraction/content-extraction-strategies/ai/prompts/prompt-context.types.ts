export type PromptContext = {
  file: {
    name: string;
    mimeType: string;
    size: number;
  };
  document: {
    id: string;
    name: string;
  };
  tags: Array<{
    name: string;
    slug: string;
    color: string;
    description?: string | null;
  }>;
  customProperties: Array<{
    key: string;
    label: string;
    description?: string | null;
    type: string;
    options: Array<{
      label: string;
      value: string;
    }>;
  }>;
  pageCount: number;
  batch: {
    pageCount: number;
    firstPageNumber: number;
  };
  ai: {
    canCreateNewTags: boolean;
    maxTags: number;
  };
};

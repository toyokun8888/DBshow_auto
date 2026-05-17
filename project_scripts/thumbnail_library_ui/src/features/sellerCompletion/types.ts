export type SellerSummary = {
  sellerId: string;
  sellerName: string;
  totalProducts: number;
  ownedProducts: number;
  missingProducts: number;
  completionRate: number;
};

export type MissingProduct = {
  sellerId: string;
  sellerName: string;
  productId: string;
  title: string;
  thumbnailPath: string;
  thumbnailStatus: string;
  isOwned: boolean;
  isLibraryOwned: boolean;

  // Rapidgator 連携
  hasRapidgator: boolean;
  hasMp4: boolean;
  hasRar: boolean;

  rapidgatorMp4Url: string;
  rapidgatorPageUrl: string;

  rapidgatorMp4Title: string;
  rapidgatorMp4Size: string;

  rapidgatorTotalRecords: number;
  rapidgatorMp4Count: number;
  rapidgatorRarCount: number;
  rapidgatorAllUrls: string[];

  // ローカル実ファイル候補
  localFileExists: boolean;
  localFileCount: number;
  localFileName: string;
  localFullPath: string;
  localFileSize: string;
  localLastWriteTime: string;
};

export type SellerSummaryResponse = {
  ok: boolean;
  sellers: SellerSummary[];
  message?: string;
};

export type SellerMissingResponse = {
  ok: boolean;
  sellerId: string;
  items: MissingProduct[];
  message?: string;
};

export type SellerSummarySort =
  | "missing_asc"
  | "missing_desc"
  | "owned_desc"
  | "total_desc";

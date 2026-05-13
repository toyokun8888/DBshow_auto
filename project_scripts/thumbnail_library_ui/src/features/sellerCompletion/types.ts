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
  productId: string;
  title: string;
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
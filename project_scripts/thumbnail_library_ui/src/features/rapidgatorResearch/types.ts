export type RapidgatorGroupSummary = {
  groupKey: string;
  groupRule: string;

  totalRecords: number;
  uniqueTitles: number;

  mp4Count: number;
  rarCount: number;

  totalSizeText: string;

  fileExtList: string[];
};

export type RapidgatorGroupItem = {
  baseTitle: string;

  fileTitle: string;

  fileExt: string;

  fileSize: string;

  hasMp4: boolean;
  hasRar: boolean;

  mp4Count: number;
  rarCount: number;

  rapidgatorMp4Url: string;
  rapidgatorPageUrl: string;

  rapidgatorAllUrls: string[];

  totalRecords: number;
};

export type RapidgatorGroupSummaryResponse = {
  ok: boolean;
  groups: RapidgatorGroupSummary[];

  message?: string;
};

export type RapidgatorGroupItemsResponse = {
  ok: boolean;

  groupKey: string;

  items: RapidgatorGroupItem[];

  message?: string;
};
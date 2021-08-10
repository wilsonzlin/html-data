type Namespace = 'html' | 'svg'

type AttrConfig = {
  boolean?: boolean;
  caseInsensitive?: boolean;
  collapse?: boolean;
  defaultValue?: string;
  redundantIfEmpty?: boolean;
  trim?: boolean;
};

declare const _data: {
  tags: {
    [ns in Namespace]: string[]
  },
  attributes: {
    [attr: string]: {
      [ns in Namespace]: {
        [tag: string]: AttrConfig,
      }
    }
  }
};

export = _data;

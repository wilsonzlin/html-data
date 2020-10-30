type Namespace = 'html' | 'svg'

type AttrConfig = {
  boolean: boolean;
  redundantIfEmpty: boolean;
  collapseAndTrim: boolean;
  defaultValue?: string;
};

type Data = {
  [attr: string]: {
    [ns in Namespace]: {
      [tag: string]: AttrConfig,
    }
  }
};

export = Data;

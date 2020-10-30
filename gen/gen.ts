import mapValue from 'extlib/js/mapValue';
import {readFileSync, writeFileSync} from 'fs';
import {join} from 'path';
import ts, {Node, SourceFile, SyntaxKind} from 'typescript';

type Namespace = 'html' | 'svg'

type AttrConfig = {
  boolean: boolean;
  redundantIfEmpty: boolean;
  collapseAndTrim: boolean;
  defaultValue?: string;
};

// TODO Consider and check behaviour when value matches case insensitively, after trimming whitespace, numerically (for number values), etc.
// TODO This file is currently manually sourced and written. Try to get machine-readable spec and automate.
const defaultAttributeValues: {
  [attr: string]: {
    tags: string[];
    defaultValue: string;
    isPositiveInteger?: boolean;
  }[];
} = JSON.parse(readFileSync(join(__dirname, 'attrs.json'), 'utf8'));

const tagNameNormalised = {
  'anchor': 'a',
};

const attrNameNormalised = {
  'classname': 'class',
};

const reactSpecificAttributes = [
  'defaultchecked', 'defaultvalue', 'suppresscontenteditablewarning', 'suppresshydrationwarning',
];

const collapsibleAndTrimmable = {
  'class': ['html:*'],
  'd': ['svg:*'],
};

// TODO Is escapedText the API for getting name?
const getNameOfNode = (n: any) => n.name.escapedText;
const normaliseName = (name: string, norms: { [name: string]: string }) => mapValue(name.toLowerCase(), n => norms[n] || n);
const prettyJson = (val: any) => JSON.stringify(val, null, 2);

const processReactTypeDeclarations = (source: SourceFile) => {
  const nodes: Node[] = [source];
  // Use index-based loop to keep iterating as nodes array grows.
  for (let i = 0; i < nodes.length; i++) {
    // forEachChild doesn't work if return value is number (e.g. return value of Array.prototype.push).
    nodes[i].forEachChild(c => void nodes.push(c));
  }
  const attributeNodes = nodes
    .filter(n => n.kind === ts.SyntaxKind.InterfaceDeclaration)
    .map(n => [/^([A-Za-z]*)(HTML|SVG)Attributes/.exec(getNameOfNode(n)), n])
    .filter(([matches]) => !!matches)
    .map(([matches, node]) => [matches![2].toLowerCase(), normaliseName(matches![1], tagNameNormalised), node])
    .filter(([namespace, tagName]) => namespace !== 'html' || !['all', 'webview'].includes(tagName))
    .map(([namespace, tag, node]) => ({namespace, tag, node}))
    .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.tag.localeCompare(b.tag));

  // Process global HTML attributes first as they also appear on some specific HTML tags but we don't want to keep the specific ones if they're global.
  if (attributeNodes[0].namespace !== 'html' || attributeNodes[0].tag !== '') {
    throw new Error(`Global HTML attributes is not first to be processed`);
  }

  // Map structure: attr => namespace => tag => config.
  const attributes: {
    [attr: string]: {
      [ns in Namespace]: {
        [tag: string]: AttrConfig,
      }
    }
  } = {};

  for (const {namespace, tag, node} of attributeNodes) {
    const fullyQualifiedTagName = [namespace, tag || '*'].join(':');
    for (const n of node.members.filter((n: Node) => n.kind === ts.SyntaxKind.PropertySignature)) {
      const attrName = normaliseName(getNameOfNode(n), attrNameNormalised);
      if (reactSpecificAttributes.includes(attrName)) {
        continue;
      }

      const types: SyntaxKind[] = n.type.kind === ts.SyntaxKind.UnionType
        ? n.type.types.map((t: Node) => t.kind)
        : [n.type.kind];

      const boolean = types.includes(ts.SyntaxKind.BooleanKeyword);
      // If types includes boolean and string, make it a boolean attr to prevent it from being removed if empty value.
      const redundantIfEmpty = !boolean && types.some(t => t === ts.SyntaxKind.StringKeyword || t === ts.SyntaxKind.NumberKeyword);
      const defaultValues = (defaultAttributeValues[attrName] || [])
        .filter(a => a.tags.includes(fullyQualifiedTagName))
        .map(a => a.defaultValue);
      const collapseAndTrim = (collapsibleAndTrimmable[attrName] || []).includes(fullyQualifiedTagName);
      if (defaultValues.length > 1) {
        throw new Error(`Tag-attribute combination <${fullyQualifiedTagName} ${attrName}> has multiple default values: ${defaultValues}`);
      }
      const attr: AttrConfig = {
        boolean,
        redundantIfEmpty,
        collapseAndTrim,
        defaultValue: defaultValues[0],
      };

      const namespacesForAttribute = attributes[attrName] ??= {html: {}, svg: {}};
      const tagsForNsAttribute = namespacesForAttribute[namespace] ?? {};
      if (tagsForNsAttribute.hasOwnProperty(tag)) {
        throw new Error(`Duplicate tag-attribute combination: <${fullyQualifiedTagName} ${attrName}>`);
      }

      const globalAttr = tagsForNsAttribute['*'];
      if (globalAttr) {
        if (globalAttr.boolean !== attr.boolean
          || globalAttr.redundantIfEmpty !== attr.redundantIfEmpty
          || globalAttr.collapseAndTrim !== attr.collapseAndTrim
          || globalAttr.defaultValue !== attr.defaultValue) {
          throw new Error(`Global and tag-specific attributes conflict: ${prettyJson(globalAttr)} ${prettyJson(attr)}`);
        }
      } else {
        tagsForNsAttribute[tag || '*'] = attr;
      }
    }
  }

  return attributes;
};

const reactDeclarations = readFileSync(require.resolve('@types/react/index.d.ts'), 'utf8');
const source = ts.createSourceFile('react.d.ts', reactDeclarations, ts.ScriptTarget.ES2020);
writeFileSync(join(__dirname, '..', 'data', 'data.json'), prettyJson(processReactTypeDeclarations(source)));

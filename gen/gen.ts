import assertExists from 'extlib/js/assertExists';
import mapValue from 'extlib/js/mapValue';
import {readFileSync, writeFileSync} from 'fs';
import {join} from 'path';
import {
  createSourceFile,
  InterfaceDeclaration,
  Node,
  PropertySignature,
  QualifiedName,
  ScriptTarget,
  SourceFile,
  SyntaxKind,
  TypeReferenceNode,
  UnionTypeNode,
} from 'typescript';
import type Data from '../data/data';

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

const getAsKind = <K extends SyntaxKind, T extends Node & { kind: K }> (n: Node | undefined, k: K): T | undefined =>
  n?.kind !== k ? undefined : n as T;

const processReactTypeDeclarations = (source: SourceFile): Data => {
  const data: Data = {
    attributes: {},
    tags: {html: [], svg: []},
  };

  const nodes: Node[] = [source];
  // Use index-based loop to keep iterating as nodes array grows.
  for (let i = 0; i < nodes.length; i++) {
    // forEachChild doesn't work if return value is number (e.g. return value of Array.prototype.push).
    nodes[i].forEachChild(c => void nodes.push(c));
  }

  const rawAttrData = [];
  for (const unknownNode of nodes) {
    const n = getAsKind<SyntaxKind.InterfaceDeclaration, InterfaceDeclaration>(unknownNode, SyntaxKind.InterfaceDeclaration);
    if (!n) {
      continue;
    }
    const typeName = getNameOfNode(n);
    if (typeName === 'IntrinsicElements') {
      for (const unknownMember of n.members) {
        const m = getAsKind<SyntaxKind.PropertySignature, PropertySignature>(unknownMember, SyntaxKind.PropertySignature);
        if (!m) {
          continue;
        }
        const name = getNameOfNode(m) ?? '';
        if (!/^[a-zA-Z]+$/.test(name)) {
          continue;
        }
        const type = assertExists(getAsKind<SyntaxKind.TypeReference, TypeReferenceNode>(m.type, SyntaxKind.TypeReference));
        const typeName = assertExists(getAsKind<SyntaxKind.QualifiedName, QualifiedName>(type.typeName, SyntaxKind.QualifiedName));
        const namespace = typeName.right.text.includes('HTML') ? 'html' : 'svg';
        data.tags[namespace].push(name);
      }
      continue;
    }
    const matches = /^([A-Za-z]*)(HTML|SVG)Attributes/.exec(typeName);
    if (!matches) {
      continue;
    }
    const namespace = matches[2].toLowerCase();
    const tag = normaliseName(matches[1], tagNameNormalised);
    if (['all', 'webview'].includes(tag)) {
      continue;
    }
    rawAttrData.push({namespace, tag, node: n});
  }
  rawAttrData.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.tag.localeCompare(b.tag));
  // Process global HTML attributes first as they also appear on some specific HTML tags but we don't want to keep the specific ones if they're global.
  if (rawAttrData[0].namespace !== 'html' || rawAttrData[0].tag !== '') {
    throw new Error(`Global HTML attributes is not first to be processed`);
  }

  data.tags.html.sort();
  data.tags.svg.sort();

  for (const {namespace, tag, node} of rawAttrData) {
    const fullyQualifiedTagName = [namespace, tag || '*'].join(':');
    for (const unknownNode of node.members) {
      if (unknownNode.kind !== SyntaxKind.PropertySignature) {
        continue;
      }
      const n = unknownNode as PropertySignature;
      const attrName = normaliseName(getNameOfNode(n), attrNameNormalised);
      if (reactSpecificAttributes.includes(attrName)) {
        continue;
      }

      const unionTypes = getAsKind<SyntaxKind.UnionType, UnionTypeNode>(n.type, SyntaxKind.UnionType);
      const types: SyntaxKind[] = unionTypes
        ? unionTypes.types.map((t: Node) => t.kind)
        : [assertExists(n.type).kind];

      const boolean = types.includes(SyntaxKind.BooleanKeyword);
      // If types includes boolean and string, make it a boolean attr to prevent it from being removed if empty value.
      const redundantIfEmpty = !boolean && types.some(t => t === SyntaxKind.StringKeyword || t === SyntaxKind.NumberKeyword);
      const defaultValues = (defaultAttributeValues[attrName] || [])
        .filter(a => a.tags.includes(fullyQualifiedTagName))
        .map(a => a.defaultValue);
      const collapseAndTrim = (collapsibleAndTrimmable[attrName] || []).includes(fullyQualifiedTagName);
      if (defaultValues.length > 1) {
        throw new Error(`Tag-attribute combination <${fullyQualifiedTagName} ${attrName}> has multiple default values: ${defaultValues}`);
      }
      const attr = {
        boolean,
        redundantIfEmpty,
        collapseAndTrim,
        defaultValue: defaultValues[0],
      };

      const namespacesForAttribute = data.attributes[attrName] ??= {html: {}, svg: {}};
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

  return data;
};

const reactDeclarations = readFileSync(require.resolve('@types/react/index.d.ts'), 'utf8');
const source = createSourceFile('react.d.ts', reactDeclarations, ScriptTarget.ES2020);
writeFileSync(join(__dirname, '..', 'data', 'data.json'), prettyJson(processReactTypeDeclarations(source)));

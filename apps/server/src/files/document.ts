import { inflateRawSync } from 'node:zlib';
import { SaxesParser } from 'saxes';
import { ApiError } from '../errors.js';

export function validateDocument(content: unknown, maxBytes: number): asserts content is string {
  if (typeof content !== 'string') throw new ApiError('INVALID_DOCUMENT');
  if (Buffer.byteLength(content, 'utf8') > maxBytes) throw new ApiError('DOCUMENT_TOO_LARGE');
  let budget = Math.min(maxBytes * 8, 64 * 1024 * 1024);
  const parse = (xml: string, page = false) => {
    budget -= Buffer.byteLength(xml, 'utf8');
    if (budget < 0 || /<!DOCTYPE/i.test(xml)) throw new Error('XML resource limit');
    const parser = new SaxesParser();
    const stack: string[] = [];
    let root = ''; let pages = 0; let model = false; let graphRoot = false; let pageModel = false; let text = ''; let nodes = 0;
    parser.on('error', error => { throw error; });
    parser.on('doctype', () => { throw new Error('DOCTYPE forbidden'); });
    parser.on('opentag', tag => {
      if (++nodes > 200_000 || stack.length >= 128) throw new Error('XML resource limit');
      if (!stack.length) root = tag.name;
      if (stack.length === 1 && root === 'mxfile') {
        if (tag.name !== 'diagram' || ++pages > 1000) throw new Error('Invalid page');
        pageModel = false; graphRoot = false; text = '';
      }
      if (stack.at(-1) === 'diagram' && (tag.name !== 'mxGraphModel' || pageModel)) throw new Error('Invalid page model');
      if (tag.name === 'mxGraphModel') { model = true; if (stack.at(-1) === 'diagram') pageModel = true; }
      if (tag.name === 'root' && stack.at(-1) === 'mxGraphModel') graphRoot = true;
      stack.push(tag.name);
    });
    parser.on('text', value => { if (stack.at(-1) === 'diagram') text += value; else if (!stack.length && value.trim()) throw new Error('Outside root'); });
    parser.on('cdata', value => { if (stack.at(-1) === 'diagram') text += value; });
    parser.on('closetag', tag => {
      if (tag.name === 'diagram') {
        if (!pageModel) {
          const encoded = text.trim();
          if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4) throw new Error('Invalid compressed page');
          const decoded = inflateRawSync(Buffer.from(encoded, 'base64'), { maxOutputLength: Math.max(1, budget) }).toString('utf8');
          parse(decodeURIComponent(decoded), true);
        } else if (text.trim() || !graphRoot) throw new Error('Invalid page content');
      }
      stack.pop();
    });
    parser.write(xml).close();
    if (root === 'mxGraphModel') { if (!model || !graphRoot) throw new Error('Invalid graph'); }
    else if (root !== 'mxfile' || page || !pages) throw new Error('Invalid drawing');
  };
  try { parse(content); } catch (cause) { throw new ApiError('INVALID_DOCUMENT', { cause }); }
}

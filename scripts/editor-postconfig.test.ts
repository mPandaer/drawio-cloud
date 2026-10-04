import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, test } from 'vitest';

function setup() {
  const handlers: Record<string, (event: unknown) => void> = {};
  const attributes: Record<string, string> = {};
  const node = { getAttribute: (key: string) => attributes[key] ?? null, setAttribute: (key: string, value: unknown) => { attributes[key] = String(value); } };
  class Graph {
    createViewState(_node?: unknown) { return { scale: 1 }; }
    saveViewState(_state?: unknown, _node?: unknown) {}
  }
  class Editor { getGraphXml() { return node; } }
  class EditorUi {
    graph = { view: { scale: 1, translate: { x: 600, y: 700 }, setScale(scale: number) { this.scale = scale; } }, container: { scrollLeft: 0, scrollTop: 0 } };
    editor = { graph: this.graph };
    init() {}
    createLoadMessage(_event?: string) { return { scale: this.graph.view.scale }; }
  }
  const parent = {};
  const window = { location: { origin: 'https://draw.example' }, parent, addEventListener: (name: string, handler: (event: unknown) => void) => { handlers[name] = handler; } };
  runInNewContext(readFileSync(new URL('./editor-postconfig.js', import.meta.url), 'utf8'), {
    Graph, Editor, EditorUi, window, mxUtils: { parseXml: () => ({ getElementsByTagName: () => [node] }) },
  });
  return { handlers, attributes, parent, node, EditorUi, Graph };
}

test('load restores saved zoom and model viewport after official initialization', () => {
  const app = setup();
  Object.assign(app.attributes, { cloudViewScale: '1.5', cloudViewX: '288', cloudViewY: '384' });
  app.handlers.message({ origin: 'https://draw.example', source: app.parent, data: JSON.stringify({ action: 'load', xml: '<mxfile/>' }) });
  const ui = new app.EditorUi();
  expect(ui.createLoadMessage()).toEqual({ scale: 1 });
  ui.createLoadMessage.call(ui, 'load');
  expect(ui.graph.view.scale).toBe(1.5);
  expect(ui.graph.container.scrollLeft).toBe((600 + 288) * 1.5);
  expect(ui.graph.container.scrollTop).toBe((700 + 384) * 1.5);
});

test('page serialization preserves zoom and viewport in model coordinates', () => {
  const app = setup();
  const graph = new app.Graph();
  graph.saveViewState.call(graph, { scale: 0.75, scrollLeft: 90, scrollTop: 150 }, app.node);
  expect(app.attributes).toEqual({ cloudViewScale: '0.75', cloudViewX: '120', cloudViewY: '200' });
  expect(graph.createViewState.call(graph, app.node)).toEqual({ scale: 0.75, scrollLeft: 90, scrollTop: 150 });
});

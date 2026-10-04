/* Product view persistence layered over the official editor. */
(function () {
  var createViewState = Graph.prototype.createViewState;
  Graph.prototype.createViewState = function (node) {
    var state = createViewState.apply(this, arguments);
    var scale = Number(node.getAttribute('cloudViewScale'));
    var x = Number(node.getAttribute('cloudViewX'));
    var y = Number(node.getAttribute('cloudViewY'));
    if (scale > 0 && isFinite(scale) && isFinite(x) && isFinite(y)) {
      state.scale = scale;
      state.scrollLeft = x * scale;
      state.scrollTop = y * scale;
    }
    return state;
  };

  var saveViewState = Graph.prototype.saveViewState;
  Graph.prototype.saveViewState = function (state, node) {
    saveViewState.apply(this, arguments);
    if (state && state.scale > 0 && isFinite(state.scrollLeft) && isFinite(state.scrollTop)) {
      node.setAttribute('cloudViewScale', state.scale);
      node.setAttribute('cloudViewX', state.scrollLeft / state.scale);
      node.setAttribute('cloudViewY', state.scrollTop / state.scale);
    }
  };

  var getGraphXml = Editor.prototype.getGraphXml;
  Editor.prototype.getGraphXml = function () {
    var node = getGraphXml.apply(this, arguments);
    var state = this.graph.getViewState();
    node.setAttribute('cloudViewScale', state.scale);
    node.setAttribute('cloudViewX', state.scrollLeft / state.scale);
    node.setAttribute('cloudViewY', state.scrollTop / state.scale);
    return node;
  };

  var pendingView;
  window.addEventListener('message', function (event) {
    if (event.origin !== window.location.origin || event.source !== window.parent) return;
    try {
      var data = JSON.parse(event.data);
      if (data.action !== 'load' || typeof data.xml !== 'string') return;
      var doc = mxUtils.parseXml(data.xml);
      var node = doc.getElementsByTagName('mxGraphModel')[0];
      if (!node) {
        var diagram = doc.getElementsByTagName('diagram')[0];
        if (diagram) node = mxUtils.parseXml(Graph.decompress(mxUtils.getTextContent(diagram))).documentElement;
      }
      pendingView = node && Number(node.getAttribute('cloudViewScale')) > 0 ? {
        scale: Number(node.getAttribute('cloudViewScale')),
        x: Number(node.getAttribute('cloudViewX')),
        y: Number(node.getAttribute('cloudViewY'))
      } : null;
    } catch (error) { pendingView = null; }
  }, true);

  var createLoadMessage = EditorUi.prototype.createLoadMessage;
  EditorUi.prototype.createLoadMessage = function (event) {
    var graph = this.editor.graph;
    var saved = event === 'load' ? pendingView : null;
    if (saved && isFinite(saved.scale) && isFinite(saved.x) && isFinite(saved.y)) {
      graph.view.setScale(saved.scale);
      graph.container.scrollLeft = (graph.view.translate.x + saved.x) * saved.scale;
      graph.container.scrollTop = (graph.view.translate.y + saved.y) * saved.scale;
    }
    if (event === 'load') {
      pendingView = null;
      this.__cloudViewLoaded = true;
    }
    return createLoadMessage.apply(this, arguments);
  };

  var init = EditorUi.prototype.init;
  EditorUi.prototype.init = function () {
    init.apply(this, arguments);
    var ui = this;
    var graph = this.editor.graph;
    var lastView;
    var capture = function () {
      if (!ui.__cloudViewLoaded || !ui.currentPage) return;
      var state = graph.getViewState();
      var view = JSON.stringify([ui.currentPage.id, state.scale,
        Math.round(state.scrollLeft), Math.round(state.scrollTop)]);
      if (lastView === view) return;
      lastView = view;
      var target = ui.embedMessageSource || window.parent;
      target.postMessage(JSON.stringify({ event: 'autosave', xml: ui.getFileData() }), window.location.origin);
    };
    this.editor.addListener('fileLoaded', function () {
      lastView = undefined;
      requestAnimationFrame(capture);
    });
    graph.container.addEventListener('scroll', capture);
    graph.view.addListener(mxEvent.SCALE, capture);
    graph.view.addListener(mxEvent.TRANSLATE, capture);
    graph.view.addListener(mxEvent.SCALE_AND_TRANSLATE, capture);
    window.addEventListener('pagehide', capture);
  };
})();

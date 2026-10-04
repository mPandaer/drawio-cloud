/* Product configuration copied over the official webapp's PreConfig.js. */
(function () {
  var base = new URL('./', window.location.href);
  var asset = function (path) { return new URL(path, base).href; };

  window.DRAWIO_PUBLIC_BUILD = true;
  window.DRAWIO_BASE_URL = base.href.replace(/\/$/, '');
  window.DRAWIO_SERVER_URL = base.href;
  window.DRAWIO_VIEWER_URL = asset('js/viewer.min.js');
  window.DRAWIO_LIGHTBOX_URL = base.href;
  window.EXPORT_URL = null;
  window.DRAW_MATH_URL = asset('math4/es5');
  window.RESOURCES_PATH = asset('resources');
  window.RESOURCE_BASE = asset('resources/dia');
  window.STENCIL_PATH = asset('stencils');
  window.SHAPES_PATH = asset('shapes');
  window.IMAGE_PATH = asset('images');
  window.GRAPH_IMAGE_PATH = asset('img');
  window.STYLE_PATH = asset('styles');
  window.CSS_PATH = asset('styles');
  window.TEMPLATE_PATH = asset('templates');
  window.mxBasePath = asset('mxgraph');
  window.mxImageBasePath = asset('mxgraph/images');
  window.mxLanguage = 'zh';
  window.DRAWIO_CONFIG = null;

  // These optional official services are not provided by the product API.
  window.ICON_SERVICE_PATH = 'https://app.diagrams.net/api/icons';
  window.ICONSEARCH_PATH = 'https://app.diagrams.net/iconSearch2';
  window.PROXY_URL = 'https://app.diagrams.net/proxy';

  urlParams.embed = '1';
  urlParams.proto = 'json';
  urlParams.keepmodified = '1';
  urlParams.lang = 'zh';
  urlParams.ui = 'kennedy';
  urlParams.sync = 'manual';
  urlParams.pwa = '0';
  urlParams.plugins = '0';
  ['gapi', 'picker', 'db', 'od', 'gh', 'gl', 'tr', 'ms365'].forEach(function (key) {
    urlParams[key] = '0';
  });
})();

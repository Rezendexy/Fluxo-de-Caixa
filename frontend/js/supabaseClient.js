(function (global) {
  "use strict";

  var cfg = global.SUPABASE_CONFIG || {};
  var isConfigured = !!(cfg.url && cfg.anonKey && cfg.url.indexOf("COLE_AQUI") === -1);

  var client = isConfigured
    ? global.supabase.createClient(cfg.url, cfg.anonKey)
    : null;

  global.DB = {
    isConfigured: isConfigured,
    client: client
  };
})(window);

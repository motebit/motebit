// Anti-flash: apply the saved theme before first paint. A classic (non-module)
// blocking script so it runs synchronously in <head> before the body renders —
// module scripts are deferred and would flash. Externalized from index.html's
// former inline <script> so the desktop CSP can forbid inline script
// (`script-src 'self'`, the XSS→RCE backstop). Served from public/ at the dist
// root, so it loads under 'self'. Mirrors apps/web — sibling-boundary rule.
(function () {
  var t = localStorage.getItem("motebit-theme");
  var d = t === "dark" || (t !== "light" && matchMedia("(prefers-color-scheme:dark)").matches);
  if (d) document.documentElement.dataset.theme = "dark";
})();

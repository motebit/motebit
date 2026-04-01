// No-op shim for Node.js built-ins that are imported but never called on mobile.
// MCP stdio transport, shell-exec, DNS discovery — all dead code paths on mobile.
var noop = function () {};
var identity = function (x) {
  return x;
};
var obj = {
  // util
  promisify: identity,
  inherits: noop,
  deprecate: identity,
  // crypto (Node module — Web Crypto API is polyfilled by react-native-quick-crypto)
  createHash: function () {
    return { update: identity, digest: noop };
  },
  randomBytes: function (n) {
    return new Uint8Array(n);
  },
  // path
  resolve: identity,
  join: function () {
    return Array.prototype.join.call(arguments, "/");
  },
  // child_process
  exec: noop,
  execFile: noop,
  spawn: noop,
  // http/https/net
  createServer: noop,
  request: noop,
  get: noop,
  connect: noop,
  Socket: noop,
  // fs
  createReadStream: noop,
  createWriteStream: noop,
  readFileSync: noop,
  writeFileSync: noop,
  existsSync: function () {
    return false;
  },
  mkdirSync: noop,
  realpathSync: identity,
  statSync: noop,
  // process
  platform: "ios",
  env: {},
  cwd: function () {
    return "/";
  },
  argv: [],
  exit: noop,
  // events (fallback — real polyfill used for bare 'events' imports)
  on: noop,
  once: noop,
  emit: noop,
  removeListener: noop,
  // stream (fallback — real polyfill used for bare 'stream' imports)
  Readable: noop,
  Writable: noop,
  Transform: noop,
  PassThrough: noop,
  pipeline: noop,
  // dns
  resolveTxt: noop,
  resolve4: noop,
};
obj.default = obj;
module.exports = obj;

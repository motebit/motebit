// Shim for Node.js built-ins not available in React Native.
// Node-only code paths (MCP stdio, shell-exec, DNS discovery) import these
// at the top level but are never called on mobile.
var noop = function () {};
var identity = function (fn) {
  return fn;
};
var obj = {
  promisify: identity,
  inherits: noop,
  deprecate: identity,
  createHash: function () {
    return { update: identity, digest: noop };
  },
  randomBytes: function (n) {
    return new Uint8Array(n);
  },
  resolve: identity,
  join: function () {
    return Array.prototype.join.call(arguments, "/");
  },
  exec: noop,
  execFile: noop,
  spawn: noop,
  createServer: noop,
  request: noop,
  get: noop,
  connect: noop,
  Socket: noop,
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
  platform: "ios",
  env: {},
  cwd: function () {
    return "/";
  },
  argv: [],
  exit: noop,
  on: noop,
  once: noop,
  emit: noop,
  removeListener: noop,
  Readable: noop,
  Writable: noop,
  Transform: noop,
  PassThrough: noop,
  pipeline: noop,
};
obj.default = obj;
module.exports = obj;

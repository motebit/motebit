module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    plugins: [
      [
        "@babel/plugin-transform-runtime",
        {
          // Inline helpers instead of importing from @babel/runtime
          // Avoids pnpm symlink resolution issues with Metro
          helpers: false,
        },
      ],
    ],
  };
};

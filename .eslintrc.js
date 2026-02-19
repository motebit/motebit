module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint", "import"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:@typescript-eslint/recommended-requiring-type-checking",
  ],
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
    project: true,
  },
  settings: {
    "import/resolver": {
      typescript: {
        project: [
          "packages/*/tsconfig.json",
          "apps/*/tsconfig.json",
          "services/*/tsconfig.json",
        ],
      },
    },
  },
  rules: {
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-unused-vars": [
      "error",
      { argsIgnorePattern: "^_" },
    ],
    "@typescript-eslint/strict-boolean-expressions": "warn",
    "no-console": "warn",
    "import/no-extraneous-dependencies": ["error", {
      devDependencies: ["**/__tests__/**", "**/*.test.ts", "**/*.spec.ts"],
      packageDir: ".",
    }],
    "import/no-relative-packages": "error",
    "no-restricted-imports": ["error", {
      patterns: [{
        group: ["@motebit/*/dist/*", "@motebit/*/src/*"],
        message: "Import from the package entry point (e.g., @motebit/sdk), not internal paths.",
      }],
    }],
  },
  overrides: [
    {
      // Ban direct generateKeypair usage in app surfaces.
      // Identity bootstrap (keypair generation + device registration) must go
      // through bootstrapIdentity() from @motebit/core-identity.
      // See packages/core-identity/README.md for rationale.
      files: ["apps/*/src/**/*.ts", "services/*/src/**/*.ts"],
      rules: {
        "no-restricted-imports": ["error", {
          patterns: [
            {
              group: ["@motebit/*/dist/*", "@motebit/*/src/*"],
              message: "Import from the package entry point (e.g., @motebit/sdk), not internal paths.",
            },
          ],
          paths: [
            {
              name: "@motebit/crypto",
              importNames: ["generateKeypair"],
              message: "Use bootstrapIdentity() from @motebit/core-identity instead of generating keypairs per-surface. See packages/core-identity/README.md.",
            },
          ],
        }],
      },
    },
  ],
  ignorePatterns: ["dist/", "node_modules/", "*.js", "*.mjs"],
};

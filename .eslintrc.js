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
        project: ["packages/*/tsconfig.json", "apps/*/tsconfig.json", "services/*/tsconfig.json"],
      },
    },
  },
  rules: {
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-unused-vars": [
      "error",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
    ],
    "@typescript-eslint/strict-boolean-expressions": [
      "warn",
      {
        allowString: true,
        allowNumber: true,
        allowNullableObject: true,
        allowNullableBoolean: true,
        allowNullableString: true,
        allowNullableNumber: false,
        allowNullableEnum: false,
        allowAny: false,
      },
    ],
    "no-console": "warn",
    // Disabled: eslint-plugin-import@2.32.0 crashes with minimatch 10.x
    // (minimatch removed default export, plugin uses _minimatch2.default)
    // Re-enable after upgrading to eslint-plugin-import@2.33+ or pinning minimatch@9
    "import/no-extraneous-dependencies": "off",
    "import/no-relative-packages": "error",
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: ["@motebit/*/dist/*", "@motebit/*/src/*"],
            message:
              "Import from the package entry point (e.g., @motebit/sdk), not internal paths.",
          },
        ],
      },
    ],
  },
  overrides: [
    {
      // Test files: relax type-safety rules for mocks/stubs
      files: ["**/__tests__/**", "**/*.test.ts", "**/*.spec.ts"],
      rules: {
        "@typescript-eslint/require-await": "off",
        "@typescript-eslint/no-unsafe-member-access": "off",
        "@typescript-eslint/no-unsafe-assignment": "off",
        "@typescript-eslint/no-unsafe-argument": "off",
        "@typescript-eslint/no-unsafe-return": "off",
        "@typescript-eslint/no-unsafe-call": "off",
        "@typescript-eslint/unbound-method": "off",
        "@typescript-eslint/no-explicit-any": "off",
        "@typescript-eslint/no-unsafe-enum-comparison": "off",
        "@typescript-eslint/no-unnecessary-type-assertion": "off",
        "require-yield": "off",
        "@typescript-eslint/no-unused-vars": [
          "error",
          { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
        ],
      },
    },
    {
      // CLI is a terminal app — console is the interface.
      // Workspace deps are devDependencies because tsup bundles them.
      files: ["apps/cli/src/**/*.ts"],
      rules: {
        "no-console": "off",
        // Matches global disable — see note above
        "import/no-extraneous-dependencies": "off",
      },
    },
    {
      // Services are server entry points — console is the logging interface.
      files: ["services/*/src/**/*.ts"],
      rules: {
        "no-console": "off",
      },
    },
    {
      // Ban direct generateKeypair usage in app surfaces.
      // Identity bootstrap (keypair generation + device registration) must go
      // through bootstrapIdentity() from @motebit/core-identity.
      // See packages/core-identity/README.md for rationale.
      files: ["apps/*/src/**/*.ts", "services/*/src/**/*.ts"],
      excludedFiles: ["**/__tests__/**", "**/*.test.ts", "**/*.spec.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                group: ["@motebit/*/dist/*", "@motebit/*/src/*"],
                message:
                  "Import from the package entry point (e.g., @motebit/sdk), not internal paths.",
              },
            ],
            paths: [
              {
                name: "@motebit/crypto",
                importNames: ["generateKeypair"],
                message:
                  "Use bootstrapIdentity() from @motebit/core-identity instead of generating keypairs per-surface. See packages/core-identity/README.md.",
              },
            ],
          },
        ],
      },
    },
  ],
  ignorePatterns: ["dist/", "node_modules/", "*.js", "*.mjs"],
};

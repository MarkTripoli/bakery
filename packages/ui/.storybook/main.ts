import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  stories: [
    "../src/**/*.stories.@(js|jsx|mjs|ts|tsx)",
    "../../../apps/web/src/fixtures/**/*.stories.@(js|jsx|mjs|ts|tsx)",
  ],
  addons: ["@storybook/addon-a11y"],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  // loro-crdt's default entry needs a wasm loader; its base64 entry does not, and
  // it is the one build every importer must share.
  viteFinal: (viteConfig) => ({
    ...viteConfig,
    resolve: {
      ...viteConfig.resolve,
      alias: [
        ...(Array.isArray(viteConfig.resolve?.alias)
          ? viteConfig.resolve.alias
          : []),
        { find: /^loro-crdt$/, replacement: "loro-crdt/base64" },
      ],
    },
  }),
  staticDirs: ["../../../apps/web/public"],
};

export default config;

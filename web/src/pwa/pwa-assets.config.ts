import {
  defineConfig,
  minimal2023Preset,
} from "@vite-pwa/assets-generator/config";

const brandBackground = { fit: "contain" as const, background: "#17202b" };

export default defineConfig({
  preset: {
    ...minimal2023Preset,
    maskable: {
      ...minimal2023Preset.maskable,
      padding: 0.1,
      resizeOptions: brandBackground,
    },
    apple: {
      ...minimal2023Preset.apple,
      padding: 0.1,
      resizeOptions: brandBackground,
    },
  },
  images: ["public/icon.svg"],
});

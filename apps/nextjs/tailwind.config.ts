import type { Config } from "tailwindcss"

import { unPriceTailwindPreset } from "@unprice/tailwind-config"

const config: Config = {
  content: [
    "src/**/*.{ts,tsx}",
    "components/**/*.{ts,tsx}",
    "../../internal/ui/src/**/*.{ts,tsx}",
    // SQLRooms packages content paths
    "./node_modules/@sqlrooms/**/dist/**/*.js",
  ],
  darkMode: "class",
  presets: [unPriceTailwindPreset],
}

export default config

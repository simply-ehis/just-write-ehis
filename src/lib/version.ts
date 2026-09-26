/**
 * version — single source for the app version fallback.
 *
 * The desktop shell reports its real version via @tauri-apps/api/app;
 * this constant is only the fallback (browser preview + keychain-less
 * shells). Bump alongside package.json / tauri.conf.json.
 */
export const APP_VERSION = "0.2.1";

// Reaching the phone's native plugins (storage, calendar, status bar).
// The native bridge only injects the list of plugins; the page registers the ones it uses through
// Capacitor's small core runtime (capacitor-core.js, loaded before the app). In a plain browser,
// or in tests, a plugin that was put on Capacitor.Plugins by hand is used instead.
const cache = {};
export function plugin(name) {
  const C = globalThis.Capacitor, X = globalThis.capacitorExports;
  if (C?.Plugins?.[name]) return C.Plugins[name];
  const reg = X?.registerPlugin || C?.registerPlugin;
  const cap = X?.Capacitor || C;
  if (!reg || !cap?.isNativePlatform?.()) return null;
  // only plugins this phone really has: on Android the iPhone-only ones (ShivoNative, Live Activities) are missing, and
  // the screens then use their web fallbacks instead of calling something that isn't there
  if (cap.isPluginAvailable && !cap.isPluginAvailable(name)) return null;
  try { return (cache[name] ||= reg(name)); } catch { return null; }
}

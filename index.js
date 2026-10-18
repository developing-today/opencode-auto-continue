// OpenCode v2 loads local directory plugins by resolving <directory>/index
// (Host.resolve does not consult package.json main/exports for directory
// targets). This root entry re-exports the compiled plugin from dist/ so the
// repository checkout itself can be configured directly:
//   { "plugins": ["../opencode-auto-continue"] }
export { default } from "./dist/index.js";

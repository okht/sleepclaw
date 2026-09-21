# Open-source notices

SleepClaw integrates Pi (MIT), Electron and Electron Forge (MIT), React (MIT), assistant-ui (MIT), i18next/react-i18next (MIT), sax (BlueOak-1.0.0), and yauzl (MIT).

Sleep/health sample statistics additionally use simple-statistics 7.12.0 (ISC). The standalone host plugin uses Model Context Protocol TypeScript SDK 1.30.0 (MIT); it is independent of the Pi conversation runtime. Plugin builds include dependency versions and original licenses in `plugins/sleepclaw/runtime`.

Dependency license files are retained in distributed runtime dependencies (inside runtime.asar). Bundled UI dependency license texts are collected as THIRD_PARTY_NOTICES.txt at the root of that archive, and at runtime/THIRD_PARTY_NOTICES.txt in a source build. SleepClaw's owl and CSS typography tokens originate from the user's SleepClaw design system; its original LICENSE is included both in that notice bundle and in src/renderer/assets/DESIGN-SYSTEM-LICENSE. The application LICENSE covers this new pi-app implementation; historical source outside pi-app keeps its original terms.

Source repositories and architecture decisions are documented in ../docs/architecture/pi-desktop.md. SleepClaw is not affiliated with these projects. The legacy Grok/ClawCode runtimes are not part of this application build.

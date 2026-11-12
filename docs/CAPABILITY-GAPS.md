# Browser control routes

Checked on 5 October 2026. The user's extension is now paired with the local bridge. The 0.3.0 build requires one Chrome extension reload; pairing is retained and the bridge identifies an older worker before dispatch. Broad access and named groups were already tested in the user's previous build. This chat has no enabled computer/browser surface for loading an unpacked extension into that profile. The Chromium validation profile is disposable and is not the user's signed-in profile.

| Need                                                  | Implemented route                                                                                        | Validation or remaining step                                                                                       |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Work across websites without repeated per-site grants | Required HTTP(S) host permissions with default persistent read/interact access; optional advanced access | Chromium default-access and revocation tests; Chrome approves installation/update permissions once                 |
| Visible named tab groups                              | Default purple JEV Browser group; list, create/join, rename/color, collapse/expand and ungroup MCP tools | Chromium integration passes; reload the extension once for the 0.3 worker                                          |
| Nested/cross-site iframe controls                     | Frame snapshots plus refs/selectors, isolated geometry translation and trusted native input              | Same-site and nested cross-site scaled layouts tested; rotated/perspective layouts use screenshots                 |
| Browser window/layout controls                        | `browser_window`                                                                                         | Window resize tested; focus/minimize/maximize/fullscreen/restore use Chrome's window API                           |
| Tab placement and state                               | `browser_tab_manage`                                                                                     | Pin/unpin/mute tested; unmute/move use Chrome's tab API                                                            |
| Download without a Save dialog                        | `browser_download` plus `browser_downloads`                                                              | Start/completion and ownership checks tested; pause/resume/cancel/reveal are named download API operations         |
| File chooser                                          | `browser_upload`                                                                                         | Existing scoped local-file attachment avoids the native chooser; main-document inputs tested                       |
| Existing signed-in sites                              | Loaded extension uses the user's actual Chrome tabs                                                      | Already paired in the user profile; 0.3 worker reload remains; no API key needed for direct MCP actions            |
| Existing credentials supplied for a login             | Normal typing into the intended service                                                                  | Planner no longer treats every password field as a blanket stop; new credentials/security changes remain a handoff |
| Long conversations and interrupted workflows          | Persistent sessions/checkpoints and explicit reusable facts                                              | Restart and compaction tests pass; follow-up tasks observe current browser state                                   |
| Protected browser pages and browser-owned prompts     | Named Chrome APIs where available, otherwise enabled browser/desktop interaction or user handoff         | No enabled computer-use surface exists in this chat; no native desktop companion is shipped                        |
| CAPTCHA/2FA/security warnings                         | Preserve tab/conversation and give a precise user handoff                                                | No automatic warning bypass, challenge bypass, or fabrication of authentication codes                              |

`browser_capabilities` reports detected APIs, granted host patterns, effective broad access and alternatives. API detection does not guarantee that enterprise policy allows debugger attachment to every target.

Chrome documents both debugger domain restrictions and enterprise attachment restrictions. Chrome window and download APIs provide supported routes for several tasks that cannot be performed through a webpage DOM. An extension cannot promise unrestricted access to every browser-owned surface. [Chrome debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger), [Chrome windows](https://developer.chrome.com/docs/extensions/reference/api/windows), [Chrome downloads](https://developer.chrome.com/docs/extensions/reference/api/downloads).

For future desktop integration, native messaging can connect an extension to a separately installed local application. That is a transport, not an existing OS-control implementation in this project. A desktop companion would need window-scoped input, screenshots, clear ownership, platform packaging and its own tests. [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).

## Connect the current build

1. Load `dist/extension` through `chrome://extensions` → Developer mode → Load unpacked, or reload its existing card.
2. Pair in the JEV side panel with `http://127.0.0.1:19847` and the token in `.local/config.json`.
3. Accept Chrome's installation/update permission request and ensure Site access is **On all sites**. All HTTP(S) sites are enabled automatically. The advanced checkbox separately exposes JavaScript, response-body reads and scoped uploads.
4. Restart/reconnect the local Codex MCP client. Direct MCP tools use the host model; leave Jev/provider keys unset if the built-in planner is not needed.
5. Check `browser_status`, then `browser_capabilities` and `browser_tabs` to verify the live connection.

## New in 0.2.0 and still incomplete

Scoped observations and role/name filtering, native multi-field preflight/verification, action/wait/observe compounds, structured text/table/link/image metadata, download terminal-state waiting, opener IDs, progressive provider tools and durable dispatch ledgers are implemented and tested. The fixture corpus independently grades submissions and covers six tabs concurrently.

Original image bytes/PDF reading, full child-target DevTools diagnostics, OS/browser-owned dialog input, native keychain/installers, Windows/macOS validation, website-native WebMCP discovery, semantic task graders, live-provider reasoning comparisons and long-duration resource-leak soaks remain future work. The current 100-form corpus is not a general benchmark of agent intelligence. Conversation memory has finite checkpoint/context limits; larger task budgets do not remove provider limits.

## Optimization release 0.3.0

The same 49-tool inventory now supports scoped combined waits, hidden/attached/detached states, unchanged form values with an explicit event-emission override, optional frame-metadata omission, and lossless PNG/optional JPEG screenshots. Native typing removes a redundant main-frame DOM injection and skips select-all only for empty fields, preserving nonempty replacement and framed ancestor checks. Provider schema caching is immutable and contains no access/session data. Protocol 3 prevents earlier workers from receiving incompatible arguments.

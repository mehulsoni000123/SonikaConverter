# Sonika Converter

Free Windows 11 file converter on a radial wheel: video to audio, transcripts, PDF tools, Word/Office to PDF, video and image tools. Works fully offline.

**Download:** go to the [Releases page](../../releases/latest), download `Sonika-Converter-1.0.0-win-x64.zip`, unzip it anywhere and run `Sonika Converter.exe`.
Windows may show a SmartScreen warning because the app is not code-signed: click **More info**, then **Run anyway**.

**Needs (optional, per tool):** FFmpeg for video/audio tools, the [Handy](https://github.com/cjpais/Handy) app for transcripts, Microsoft Office for Word/Excel/PowerPoint to PDF. Set their locations in Settings (gear icon).

---

A Windows 11 desktop app for everyday file conversions, built around a radial wheel menu:
video to audio, transcripts with Handy, PDF tools, Word/Office to PDF, video and image tools.
Works fully offline.

## Using it

- **Wheel (home screen):** point the mouse toward a slot to highlight it, scroll (or press Left/Right)
  to switch tools inside that slot, click (or Enter) to choose. Keys 1-6 jump to a slot, Up/Down move
  between slots.
- **Tool first:** choose a tool, set its options (remembered per tool), drop files or press
  *Choose files*, then *Start*.
- **Files first:** drag files anywhere onto the window. Slots that can use them stay lit. Drop on a
  slot to open its tool with those files. With *Instant mode* on (default), a video dropped straight
  onto **AUDIO** starts at once with your saved options.
- **Hotkey wheel:** press the shortcut (default `Ctrl+Alt+Space`; if another app already uses it the
  app picks a free one such as `Alt+Shift+Space` and says so in Settings) anywhere in Windows. The wheel
  pops over your work; pick a tool, choose files, and progress shows in a small card at the bottom right.
- **Explorer:** right-click a file > *Show more options* > *Sonika Converter* (after install).
- **Jobs:** live progress, Cancel, Show in folder, Open, Copy text for transcripts, Try again.
- **Settings (gear):** output location, Handy and FFmpeg location, shortcut, Instant mode,
  close-to-tray, Start with Windows (off by default).

## Command line

```
"Sonika Converter.exe" --tool <toolId> [--opt key=value] <file>...   run a tool with saved options
"Sonika Converter.exe" <file>...                                     open the window with these files
"Sonika Converter.exe" --wheel                                       show the wheel
"Sonika Converter.exe" --hidden                                      start in the tray
```

A second launch hands its arguments to the running app. Files arriving within about 300 ms are
treated as one batch (Explorer starts one process per selected file).

## Development

```
npm.cmd start            # run the app from source
npm.cmd test             # engine tests (test/*.test.js) + interface scenario under Electron
node test/run-all.js --ui-only   # interface scenario only
npm.cmd run pack         # build dist\Sonika Converter-win32-x64
node assets/build-icon.js        # rebuild the icon set from code
```

Install for the current user (no admin): 
`powershell -NoProfile -ExecutionPolicy Bypass -File packaging\install.ps1` (add `-DryRun` to only
print what it would do). Remove with `packaging\uninstall.ps1` (`-RemoveSettings` also deletes settings).

## Layout

```
src/main/       main.js (windows, tray, hotkey, IPC), preload.js (narrow bridge), queue.js (2 jobs at a time),
                engine-host.js + engine-client.js (engine in a utility process), settings.js, cli.js
src/renderer/   index.html + app.js (main window), wheel.js (the wheel), overlay.* (hotkey wheel),
                toast.* (progress card), icons.js (line icons), styles.css, fonts/ (Poppins)
src/engine/     conversion tools (registry in index.js)
assets/         icon.svg, icon.ico, PNG sizes, tray icons, build-icon.js
packaging/      pack.js, install.ps1, uninstall.ps1
test/           run-all.js, app.scenario.js, screens/ (screenshots from the scenario)
```

Security: context isolation on, Node integration off, sandboxed renderers, a content security policy
on every page, and all network requests are blocked.

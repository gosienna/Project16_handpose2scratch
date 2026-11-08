# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Handpose2Scratch is a Scratch 3 extension that exposes webcam hand tracking (ml5 `handpose`) as Scratch blocks. It is **not a standalone project**: there is no `package.json`, and nothing builds or runs from this directory. The repo is an overlay of files that `install.sh` copies and patches into a checkout of `LLK/scratch-gui`. Paths under `scratch-vm/` and `scratch-gui/` mirror where the files land in that checkout.

## Development commands

There is no test suite and no lint or build script in this repo. `.eslintrc.js` extends `eslint-config-scratch`, which this repo does not install. Behaviour can only be verified by running Scratch in a browser with a webcam.

Clone this repo *inside* a scratch-gui checkout, and run `install.sh` from the scratch-gui root (its paths are relative to it):

```sh
git clone --depth 1 --branch v3.6.18 git@github.com:LLK/scratch-gui.git   # v3.6.18 is the version CI builds against
cd scratch-gui
npm install
git clone git@github.com:champierre/handpose2scratch.git
sh handpose2scratch/install.sh
npm start     # http://localhost:8601/
```

The README clones scratch-gui's default branch instead; only `v3.6.18` is what CI verifies.

**Do not re-run `install.sh` on an already-installed checkout.** It is not idempotent: it moves the patched files over the `_orig` backups and applies the `sed` again, which duplicates the imports in `src/lib/libraries/extensions/index.jsx` and loses the pristine copy. To pick up changes to the extension, copy just the file:

```sh
cp handpose2scratch/scratch-vm/src/extensions/scratch3_handpose2scratch/index.js \
   node_modules/scratch-vm/src/extensions/scratch3_handpose2scratch/
```

To change anything `install.sh` generates, first restore `index.jsx` and `extension-manager.js` from their `_orig` copies.

## Architecture

**`install.sh` is the integration layer.** From the scratch-gui root it:
- installs `ml5@0.12.2` into `node_modules/scratch-vm` (the version is pinned here, since there is no manifest);
- copies the extension into `node_modules/scratch-vm/src/extensions/` and uses `sed` to register it in `builtinExtensions` in `extension-manager.js`;
- copies the icons and uses `sed` to prepend the library entry to `src/lib/libraries/extensions/index.jsx`.

The extension's GUI metadata (name, description, `featured`, `helpLink`, etc.) therefore lives in `install.sh`, not in the extension source. The id `handpose2scratch` must stay consistent across `EXTENSION_ID`, the directory and icon filenames, and `getInfo().id`.

**`scratch-vm/src/extensions/scratch3_handpose2scratch/index.js` is all of the runtime code.** Line 8 is a very long base64 icon, so read the file with an offset or grep it rather than loading that line.

- The constructor enables video and starts `ml5.handpose` on Scratch's video element. The `predict` handler stores results in `this.landmarks`; reporter blocks only read that state. If several hands are detected, the last one wins, and values persist after a hand leaves the frame.
- Reporters take a 1-based landmark number (1–21, as shown in the menu) and index a 0-based array, returning `""` until data exists.
- Coordinates convert from video pixels to the Scratch stage: `x = 240 - px * ratio`, `y = 180 - py * ratio`, with `x` negated when `video.mirror === false` (the "on-flipped" menu option). `z` is returned raw and is not affected by `ratio`.
- Each switch of the video block to on calls `detectHand` again, creating another `ml5.handpose` instance and showing the blocking "please wait" `alert`.

**Localization** uses the in-file `Message` table instead of Scratch's translation pipeline. A new language needs its code in `AvailableLocales` and a string in every `Message` entry, including all 21 `landmarks`; a locale missing from `AvailableLocales` falls back to `en`. The exception is `setVideoTransparency`, which reuses Scratch's built-in `videoSensing.setVideoTransparency` message.

`Message.setInterval` and `intervalMenu` are defined, but no block uses them.

Opcodes and menu values are stored in saved `.sb3` projects, such as `sample_projects/handpose.sb3`, so renaming them breaks existing projects.

## Deployment

Every push to `main` triggers `.github/workflows/deploy.yml`, which checks out `LLK/scratch-gui@v3.6.18`, runs `install.sh`, builds, and publishes to GitHub Pages. There is no staging step, so merging to `main` ships to the live site.

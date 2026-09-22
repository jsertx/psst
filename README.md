# Pssst

Drop files anywhere on the window → pick a public key → `file.ext.gpg` is written next to the original.

## Run

    brew install gnupg   # if you don't have gpg yet
    npm install
    npm start

Build a `.app`/`.dmg`: `npm run dist` (output in `dist/`).

## Multiple files & folders

Drop several files (or any folder) and you get a choice: **Zip into one file** (default, with an editable name → `Archive.zip.gpg`) or **Encrypt each file separately**. Folders always zip.

Zipping runs in a private temp folder (`$TMPDIR/pssst-*`, mode 0700) with a byte-level progress bar and a Cancel button. The plaintext zip is deleted as soon as encryption finishes, fails or is cancelled; any leftovers from a crash are swept on next launch. The `.zip.gpg` lands in the folder of the first dropped item.

## Notes

- You can also drop files on the Dock icon (or Finder → Open With → Pssst). This only works in the built app (`npm run dist`, then move it to /Applications); in `npm start` the Dock icon belongs to the generic Electron app, which doesn't declare that it accepts files.

- Keys come from `gpg --list-keys --with-colons`; revoked, expired and sign-only keys are shown greyed out.
- Encryption uses `--trust-model always`, since you're picking the recipient explicitly.
- If the output already exists, it writes `file.ext (1).gpg` rather than overwriting.
- gpg is looked up in `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/local/MacGPG2/bin` (Finder-launched apps don't get your shell PATH).
# psst

# Stemlab

A Windows desktop app that splits a song into its parts (vocals, guitar, piano, bass, drums, everything else) so you can hear each one alone, then change the key, steady the tempo, tighten sloppy timing, and edit individual notes.

## Install

1. Run `Stemlab-Setup-1.2.0.exe`. Windows SmartScreen may say "Windows protected your PC" because the installer isn't code-signed. Click **More info → Run anyway**.
2. On first launch Stemlab downloads its audio engine and the splitting model (about 1 GB, or about 3 GB with the NVIDIA option). This happens once and needs an internet connection.

Everything runs on your computer. Songs and projects are kept in `%APPDATA%\Stemlab\data`.

## What it does

**Add a song**: drop in an audio or video file, paste a YouTube link, or paste a Spotify song link. Spotify audio is DRM-protected, so Stemlab reads the song's title and artist from the link and downloads the matching song from YouTube instead.

**Hear each part**: every part gets a lane with mute (M), solo (S) and volume. Ctrl-click S to solo more than one part. Drag across the bar ruler to loop a section.

**Key**: transpose up or down 12 semitones, optionally correct the whole song to A440 tuning. Drums stay at their pitch by default.

**Tempo**: set any BPM, and use "Steady the beat" to pull a drifting tempo onto a fixed grid (0% keeps the human feel, 100% locks every beat). All parts are warped together so they stay in sync.

**Tighten parts**: per part, pull notes that are slightly early or late onto the nearest 8th or 16th note. Notes that are far off the grid (triplets, deliberate pushes) are left alone.

Press **Apply changes** to render; then switch between **Original** and **Edited** to compare.

**Notes**: click **Notes** on any part except drums. Stemlab finds each note, shows them on a piano roll, and lets you:
- drag a note up/down to change its pitch, or sideways to move it (snaps to the beat grid; turn off "Snap to beat" for free placement)
- drag a note's right edge to make it longer or shorter
- double-click empty space to add a new note made from the selected note's sound, shifted to the new pitch
- Delete to remove, ↑/↓ to change pitch (Shift = octave), Ctrl+Z to undo, Ctrl+A to select all
- click a piano key to hear that pitch

Edits are rendered into the part as you make them, so you hear them straight away. "This part" / "Whole song" chooses what plays. Note editing works best on parts that play one note at a time (vocals, bass, a guitar or synth line).

**Notes screen**: switch the song from **Mix** to **Notes** at the top. Every track is shown across the top, as note blocks once it has notes, otherwise as a waveform; click a track to edit it in the piano roll below. Everything shares one timeline and playhead.

**Synth parts**: in Mix, click **Add a synth part**. Draw notes by double-clicking in the piano roll, or copy the notes from another part (for example the vocal melody, an octave up). Sounds: Lead, Pluck, Electric keys, Pad, Synth bass, Retro square. Synth parts have mute, solo and volume like any track, and are included in exports. Synth notes are placed in seconds, so if you change the tempo later, move them to match.

**Export**: pick the Original or Edited version, which parts, and whether you want a file per part or one mixed file at your mixer levels. WAV, MP3 (320 kbps) or FLAC. Note edits are included.

## Keyboard

| Key | Action |
| --- | --- |
| Space | Play / pause |
| ← / → | Back / forward 5 seconds |
| Home | Back to the start (or loop start) |

## Speed

Splitting a 4-minute song takes roughly 3 to 6 minutes on a typical CPU, well under a minute with an NVIDIA GPU. Tempo and key changes take about a minute. Finding notes in one part takes 1 to 2 minutes.

## How it's built

- `app/`: Electron shell and interface (plain HTML/CSS/JS, Web Audio for synced multi-part playback)
- `engine/`: local Python engine, started by the app on 127.0.0.1 with a random access token
  - Demucs `htdemucs_6s` for 6-part separation
  - librosa for beat tracking, key and tuning detection, onset detection and pYIN pitch tracking
  - Rubber Band (via Spotify's pedalboard) for high-quality pitch shifting and variable time-stretching, with a click-track calibration pass that keeps every part within a few milliseconds of the target grid
  - yt-dlp for links, ffmpeg (imageio-ffmpeg) for decoding and MP3 encoding
- `build/python`: a standalone Windows Python bundled into the installer; the engine packages are installed into `%APPDATA%\Stemlab\engine-env` on first run

### Run from source

```
npm install
npm start
```

On Windows without the bundled Python, the app uses `python` from your PATH (3.11 recommended).

### Build the installer

Put a Windows `python-build-standalone` 3.11 "install_only" build in `build/python`, then:

```
npm run dist:win
```

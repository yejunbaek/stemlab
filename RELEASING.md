# Publishing an update

Every installed copy of Stemlab checks this repository's GitHub releases when it opens (and every
4 hours). When a newer version is published, it shows an update bar; one click downloads it and
restarts into the new version.

To publish a new version:

1. Write what changed in `build/release-notes.md`. This becomes the "What's new" text in the app.
2. Raise `"version"` in `package.json` (for example 1.3.0 to 1.4.0). It must go up, or installed
   copies won't see it as newer.
3. Commit and push to `main`.

GitHub Actions (`.github/workflows/release.yml`) sees a version that hasn't been released yet,
builds the Windows installer and publishes the release as `v1.4.0`. It takes about 10 minutes;
follow it on the repository's **Actions** tab. Pushes that don't change the version build nothing.
Pushing a `v1.4.0` tag, or running the workflow by hand from the Actions tab, works too.

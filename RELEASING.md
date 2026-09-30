# Publishing an update

Every installed copy of Stemlab checks this repository's GitHub releases when it opens (and every
4 hours). When a newer version is published, it shows an update bar; one click downloads it and
restarts into the new version.

To publish a new version:

1. Write what changed in `build/release-notes.md`. This becomes the "What's new" text in the app.
2. Commit your changes.
3. Tag the commit with the new version number and push the tag:

   ```
   git tag v1.4.0
   git push origin main v1.4.0
   ```

GitHub Actions (`.github/workflows/release.yml`) builds the Windows installer and publishes the
release. It takes about 10 minutes; follow it on the repository's **Actions** tab. Version numbers
must go up (1.4.0 after 1.3.0), or installed copies won't see it as newer.

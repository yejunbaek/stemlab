"""Getting audio into a project: local files, YouTube (and other yt-dlp sites), Spotify track lookup."""
import html
import json
import os
import re
import shutil
import urllib.request

import audio_io

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0 Safari/537.36")

SPOTIFY_RE = re.compile(r"open\.spotify\.com/(?:intl-[a-z]+/)?(track|album|playlist|artist|episode)/([A-Za-z0-9]+)")


class SourceError(Exception):
    pass


def classify(url):
    u = url.strip()
    if "spotify.com" in u or u.startswith("spotify:"):
        return "spotify"
    return "web"


def _http_get(url, timeout=15):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "en"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def spotify_lookup(url):
    """Read a Spotify track's title and artist from its public page. Returns (title, artist)."""
    u = url.strip()
    if u.startswith("spotify:track:"):
        u = "https://open.spotify.com/track/" + u.split(":")[-1]
    m = SPOTIFY_RE.search(u)
    if not m:
        raise SourceError("That doesn't look like a Spotify link.")
    kind, tid = m.groups()
    if kind != "track":
        raise SourceError("Paste a link to a single Spotify song (not an album, playlist or artist).")
    page_url = "https://open.spotify.com/track/" + tid
    title = artist = None
    try:
        page = _http_get(page_url)
        t = re.search(r"<title>(.*?)</title>", page, re.S)
        if t:
            full = html.unescape(t.group(1)).strip()
            mm = re.match(r"(.+?) - song(?: and lyrics)? by (.+?) \| Spotify", full)
            if mm:
                title, artist = mm.group(1), mm.group(2)
        if not title:
            og = re.search(r'<meta property="og:title" content="([^"]+)"', page)
            desc = re.search(r'<meta property="og:description" content="([^"]+)"', page)
            if og:
                title = html.unescape(og.group(1))
            if desc:
                artist = html.unescape(desc.group(1)).split("·")[0].strip()
    except Exception:
        pass
    if not title:
        try:
            data = json.loads(_http_get("https://open.spotify.com/oembed?url=" + page_url))
            title = data.get("title")
        except Exception:
            pass
    if not title:
        raise SourceError("Couldn't read that Spotify song's details. Try a YouTube link or a file instead.")
    return title, artist


def _ydl_opts(dest_dir, progress_cb, js_runtime):
    def hook(d):
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            if total:
                progress_cb(min(0.99, d.get("downloaded_bytes", 0) / total))
    opts = {
        "format": "bestaudio/best",
        "outtmpl": os.path.join(dest_dir, "download.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "progress_hooks": [hook],
        "ffmpeg_location": audio_io.ffmpeg_exe(),
    }
    if js_runtime:
        opts["js_runtimes"] = {"node": {"path": js_runtime}}
    return opts


def download(query_or_url, dest_dir, progress_cb, js_runtime=None):
    """Download audio with yt-dlp. Returns (path, title, artist)."""
    import yt_dlp
    try:
        with yt_dlp.YoutubeDL(_ydl_opts(dest_dir, progress_cb, js_runtime)) as ydl:
            info = ydl.extract_info(query_or_url, download=True)
    except Exception as e:
        msg = str(e).replace("ERROR: ", "")
        raise SourceError("Download failed: " + msg[:300])
    if info and info.get("entries"):
        info = info["entries"][0]
    files = [f for f in os.listdir(dest_dir) if f.startswith("download.")]
    if not files:
        raise SourceError("Nothing was downloaded from that link.")
    title = (info or {}).get("track") or (info or {}).get("title") or "Untitled"
    artist = (info or {}).get("artist") or (info or {}).get("uploader")
    return os.path.join(dest_dir, files[0]), title, artist


def fetch(kind, value, project_dir, progress_cb, js_runtime=None):
    """Brings the source into project_dir/original.wav. Returns dict(title, artist, source)."""
    out = os.path.join(project_dir, "original.wav")
    if kind == "file":
        if not os.path.isfile(value):
            raise SourceError("File not found: " + value)
        progress_cb(0.3)
        audio_io.to_wav(value, out)
        name = os.path.splitext(os.path.basename(value))[0]
        artist = None
        if " - " in name:
            artist, name = name.split(" - ", 1)
        return {"title": name, "artist": artist, "source": {"type": "file", "path": value}}

    url = value.strip()
    tmp = os.path.join(project_dir, "dl")
    os.makedirs(tmp, exist_ok=True)
    try:
        if classify(url) == "spotify":
            title, artist = spotify_lookup(url)
            q = f"ytsearch1:{artist + ' - ' if artist else ''}{title} audio"
            path, _, _ = download(q, tmp, progress_cb, js_runtime)
            src = {"type": "spotify", "url": url, "matched_via": "youtube"}
        else:
            path, title, artist = download(url, tmp, progress_cb, js_runtime)
            src = {"type": "link", "url": url}
        audio_io.to_wav(path, out)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return {"title": title, "artist": artist, "source": src}

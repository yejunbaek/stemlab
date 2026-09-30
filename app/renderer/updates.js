'use strict';
/* Update bar: shows when a newer version is published, downloads it, restarts into it. */

let upd = { status: 'idle' };
let dismissed = null; // version the person chose "Later" for

function paintUpdate() {
  const bar = $('#updateBar');
  const s = upd;
  const show = (s.status === 'available' && dismissed !== s.version) || s.status === 'downloading' || s.status === 'ready';
  bar.hidden = !show;
  bar.classList.toggle('error', false);
  $('#updateProgress').hidden = s.status !== 'downloading';
  $('#updateNotesBtn').hidden = !s.notes || s.status === 'downloading';
  $('#updateLaterBtn').hidden = s.status !== 'available';
  $('#updateGoBtn').hidden = s.status === 'downloading';
  if (s.status === 'available') {
    $('#updateText').textContent = `Stemlab ${s.version} is available.`;
    $('#updateGoBtn').textContent = 'Update now';
  } else if (s.status === 'downloading') {
    $('#updateText').textContent = `Downloading Stemlab ${s.version || ''}… ${s.percent || 0}%`;
    $('#updateFill').style.width = `${s.percent || 0}%`;
  } else if (s.status === 'ready') {
    $('#updateText').textContent = `Stemlab ${s.version} is ready. Restart to finish updating.`;
    $('#updateGoBtn').textContent = 'Restart now';
  }
}

stemlab.onUpdate((s) => {
  const wasChecking = upd.manual;
  upd = { ...s, manual: wasChecking && s.status === 'checking' };
  if (wasChecking && s.status === 'current') toast("You're on the latest version.");
  if (s.status === 'error') {
    if (wasChecking) toast("Couldn't check for updates: " + s.error);
    upd.version && (upd.status = 'available');
  }
  paintUpdate();
});

$('#updateGoBtn').onclick = () => {
  if (upd.status === 'ready') {
    if (player.playing) player.pause();
    stemlab.installUpdate();
  } else if (upd.status === 'available') {
    upd.status = 'downloading'; upd.percent = 0;
    paintUpdate();
    stemlab.downloadUpdate();
  }
};
$('#updateLaterBtn').onclick = () => { dismissed = upd.version; paintUpdate(); };
$('#updateNotesBtn').onclick = () => {
  $('#notesTitle').textContent = `What's new in ${upd.version}`;
  $('#notesBody').textContent = upd.notes || 'No notes for this version.';
  $('#notesDialog').showModal();
};
$('#checkUpdateBtn').onclick = async () => {
  const st = await stemlab.updateState();
  if (!st.enabled) { toast('Updates are only checked in the installed app.'); return; }
  if (upd.status === 'available' || upd.status === 'ready') { dismissed = null; paintUpdate(); return; }
  upd.manual = true;
  $('#checkUpdateBtn').textContent = 'Checking…';
  await stemlab.checkForUpdate();
  $('#checkUpdateBtn').textContent = 'Check for updates';
};

(async () => {
  $('#versionLabel').textContent = `Version ${await stemlab.appVersion()}`;
  const st = await stemlab.updateState();
  upd = st;
  paintUpdate();
})();

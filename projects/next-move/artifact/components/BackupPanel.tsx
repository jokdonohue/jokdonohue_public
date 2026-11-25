/** Export ("Export my progress", item i) and Site-backup import, on the Progress page. */
import { useState } from 'react';
import type { SaveFile } from '@/src/contract/store';

export default function BackupPanel({ saveFile, makeBackup, importBackup }: {
  /** `downloads.save`; null hides the export button. */
  saveFile: SaveFile | null;
  makeBackup: () => { filename: string; text: string };
  /** Imports a Site backup's text; resolves a one-line summary. Absent: the import control is hidden. */
  importBackup?: (text: string) => Promise<string>;
}) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function exportNow() {
    if (!saveFile) return;
    setBusy(true); setMessage('');
    try {
      const { filename, text } = makeBackup();
      const result = await saveFile({ filename, data: text });
      setMessage(result.status === 'saved' ? `Saved ${filename}.` : `${filename} was handed to your device.`);
    } catch { setMessage('The file was not saved. Try again.'); } finally { setBusy(false); }
  }
  async function importFile(file: File | undefined) {
    if (!file || !importBackup) return;
    setBusy(true); setMessage('Reading the backup…');
    try { setMessage(await importBackup(await file.text())); }
    catch (e) { setMessage(e instanceof Error ? e.message : 'This backup could not be read. Your saved progress is unchanged.'); }
    finally { setBusy(false); }
  }
  if (!saveFile && !importBackup) return null;
  return <div className="surface backup-panel">
    <h2>Backup</h2>
    <p className="small">Your progress lives in this page's storage. A file copy protects it if the page is ever removed.</p>
    <div className="backup-actions">
      {saveFile && <button type="button" className="secondary" disabled={busy} onClick={() => void exportNow()}>Export my progress</button>}
      {importBackup && <label className="secondary file-button">Import a Site backup
        <input id="site-backup-file" type="file" accept="application/json,.json" disabled={busy} onChange={e => { void importFile(e.target.files?.[0]); e.target.value = ''; }}/>
      </label>}
    </div>
    {message && <p className="small" role="status">{message}</p>}
  </div>;
}

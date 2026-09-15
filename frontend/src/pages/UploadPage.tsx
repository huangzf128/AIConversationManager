import { useState } from 'react';
import { Link } from 'react-router-dom';
import './UploadPage.css';
import { UploadIcon } from '../components/Icons';

type Platform = 'chatgpt' | 'gemini' | 'claude' | 'deepseek';

const PLATFORMS: { value: Platform; label: string }[] = [
  { value: 'chatgpt', label: 'ChatGPT' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'claude', label: 'Claude' },
  { value: 'deepseek', label: 'DeepSeek' },
];

const PLATFORM_EXPORT_HINTS: Record<Platform, string> = {
  chatgpt: 'conversations.json',
  gemini: 'Gemini Takeout export (.zip or .json)',
  claude: 'conversations.json',
  deepseek: 'exported conversations (.json)',
};

function UploadPage() {
  const [platform, setPlatform] = useState<Platform>('gemini');
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<{ type: 'info' | 'success' | 'error'; text: string } | null>(null);
  const [uploading, setUploading] = useState(false);

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true);
    setStatus({ type: 'info', text: 'Uploading…' });

    const formData = new FormData();
    formData.append('file', file);
    formData.append('platform', platform);

    try {
      const res = await fetch('http://localhost:3000/conversations/upload', {
        method: 'POST',
        body: formData,
      });

      const body = await res.json().catch(() => null);

      if (!res.ok) {
        setStatus({
          type: 'error',
          text: body?.message ?? 'Upload failed. Please check the file and try again.',
        });
        return;
      }

      setStatus({ type: 'success', text: `Imported ${body?.imported ?? 0} conversation(s).` });
    } catch {
      setStatus({ type: 'error', text: 'Upload failed. Is the backend running?' });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="upload-page">
      <header className="upload-header">
        <Link to="/mypage" className="upload-back">
          &larr; Back to Archive
        </Link>
        <h1 className="upload-title">Import conversations</h1>
        <p className="upload-subtitle">
          Upload an export for one platform. Re-importing updates existing conversations in place instead of
          duplicating them, so manual hide/show choices are preserved.
        </p>
      </header>

      <div className="upload-card">
        <label className="upload-field">
          <span className="upload-label">Platform</span>
          <div className="upload-select-wrap">
            <select
              className="upload-select"
              value={platform}
              onChange={(e) => setPlatform(e.target.value as Platform)}
            >
              {PLATFORMS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <span className="upload-hint">Expected format: {PLATFORM_EXPORT_HINTS[platform]}</span>
        </label>

        <label className={`upload-dropzone ${file ? 'upload-dropzone-has-file' : ''}`}>
          <UploadIcon />
          <span className="upload-dropzone-main">{file ? file.name : 'Choose or drop your export (.json or .zip)'}</span>
          <span className="upload-dropzone-sub">
            {file ? `${(file.size / 1024).toFixed(1)} KB` : `Supported platform: ${platform}`}
          </span>
          <input
            type="file"
            accept=".json,.zip,application/json,application/zip"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>

        <div className="upload-actions">
          <button className="upload-button" onClick={handleUpload} disabled={!file || uploading}>
            {uploading ? 'Uploading…' : 'Import file'}
          </button>
        </div>

        {status && <p className={`upload-status upload-status-${status.type}`}>{status.text}</p>}
      </div>
    </div>
  );
}

export default UploadPage;
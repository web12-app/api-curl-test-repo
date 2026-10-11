// The in-app preview dialog. Media renders with native tags: <img> for images, <video>
// for videos, <audio> for audio, an iframe for the PDF viewer, and a <pre> for text.
// Every kind also has an "Open in new tab" action: the preview endpoint sends the bytes
// inline with a sandboxed policy, so the browser tab renders the file itself.
import React, { useEffect, useRef, useState } from 'react';

const IMAGE = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
const VIDEO = ['.mp4', '.webm', '.mov', '.mkv'];
const AUDIO = ['.mp3', '.wav', '.ogg', '.m4a'];
const TEXT = ['.txt', '.md', '.log', '.csv', '.json'];
const MAX_TEXT_BYTES = 512 * 1024;

export function extensionOf(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(name || '');
  return m ? '.' + m[1].toLowerCase() : '';
}

export function kindOf(name) {
  const ext = extensionOf(name);
  if (IMAGE.includes(ext)) return 'image';
  if (VIDEO.includes(ext)) return 'video';
  if (AUDIO.includes(ext)) return 'audio';
  if (ext === '.pdf') return 'pdf';
  if (TEXT.includes(ext)) return 'text';
  return null;
}

export function PreviewModal({ file, onClose }) {
  const dialogRef = useRef(null);
  const [text, setText] = useState(null);
  const [textTooBig, setTextTooBig] = useState(false);
  const kind = file ? kindOf(file.name) : null;
  const url = file ? '/api/files/' + file.id + '/preview' : 'about:blank';

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (file && typeof dialog.showModal === 'function') dialog.showModal();
    if (!file && dialog.open) dialog.close();
  }, [file]);

  useEffect(() => {
    setText(null);
    setTextTooBig(false);
    if (!file || kind !== 'text') return undefined;
    if (file.size > MAX_TEXT_BYTES) {
      setTextTooBig(true);
      return undefined;
    }
    let live = true;
    fetch(url, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => {
        if (live) setText(t);
      })
      .catch(() => {
        if (live) setText(null);
      });
    return () => {
      live = false;
    };
  }, [file, kind, url]);

  function close() {
    if (dialogRef.current && dialogRef.current.open) dialogRef.current.close();
    onClose();
  }

  return (
    <dialog ref={dialogRef} className="preview" aria-labelledby="preview-title" onClose={onClose}>
      {file ? (
        <>
          <div className="preview-bar">
            <span id="preview-title">{file.name}</span>
            <span className="preview-bar-actions">
              <a className="button" href={url} target="_blank" rel="noopener">
                Open in new tab
              </a>
              <a className="button" href={'/api/files/' + file.id + '/download'} download={file.name}>
                Download
              </a>
              <button type="button" id="preview-close" onClick={close}>
                Close
              </button>
            </span>
          </div>
          <div className="preview-body">
            {kind === 'image' ? <img className="preview-media" src={url} alt={'Preview of ' + file.name} /> : null}
            {kind === 'video' ? (
              <video className="preview-media" src={url} controls playsInline preload="metadata">
                Your browser cannot play this video. Use “Open in new tab” or download it.
              </video>
            ) : null}
            {kind === 'audio' ? (
              <div className="preview-audio">
                <audio src={url} controls preload="metadata">
                  Your browser cannot play this audio. Use “Open in new tab” or download it.
                </audio>
              </div>
            ) : null}
            {kind === 'pdf' ? <iframe className="preview-inner-frame" src={url} title={'Preview of ' + file.name} /> : null}
            {kind === 'text' ? (
              textTooBig ? (
                <p className="hint" style={{ padding: '1rem' }}>
                  This text file is too large to show here. Use “Open in new tab” or download it.
                </p>
              ) : (
                <pre className="preview-text">{text === null ? 'Loading…' : text}</pre>
              )
            ) : null}
            {kind === null ? (
              <p className="hint" style={{ padding: '1rem' }}>
                This file type cannot be previewed. Download it instead.
              </p>
            ) : null}
          </div>
        </>
      ) : (
        <div className="preview-bar">
          <span id="preview-title" />
          <button type="button" onClick={close}>
            Close
          </button>
        </div>
      )}
    </dialog>
  );
}

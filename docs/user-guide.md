# User guide

This guide explains the dashboard, for people who use the app, not the code.

## Accounts

- **Sign up** at `/signup`: a username (3 to 32 letters, digits, or underscores; capitals are stored in lowercase) and a password (8 to 256 characters).
- **Log in** at `/login`. Too many wrong passwords for one account (5 in 15 minutes) or too many attempts from one address (30 in 15 minutes) are refused for a while.
- **Log out** with the button in the top bar. It ends the session on the server, so a copied session cookie stops working too.
- Sessions last 12 hours by default.

Signed out, `/dashboard` sends you to `/login`.

## The dashboard

The dashboard has four parts.

### 1. Usage line

Shows how many files you have, for example `5 files`. There is no storage total and no file count limit by default; if a count limit is ever configured it reads `5 of 200 files`.

### 2. Upload

- Drag files onto the dashboard drop area, or click **Choose files**.
- You can send several files at once. Each one appears in the **Uploads** queue with a progress bar.
- **Any file type is accepted.** The size ceiling is **2 GB per file** (GitHub's own release-asset limit). Files of 4 MB and more are sent in pieces automatically, so a dropped connection never restarts from zero.
- Known types (listed in [Which files can I upload](#which-files-can-i-upload)) are checked: the file's first bytes must match its extension. A renamed file is refused with *The file contents do not match its type*.
- Unknown types are stored and can only be **downloaded**. They never open in the browser.
- A failed upload stays in the queue with a **Retry** link. Retrying is safe: the server stores a file once even if the first attempt partly worked.
- Files of **4 MB or more** are sent in pieces, and the queue shows the percentage. If the connection drops, **Retry** continues from the pieces that arrived. If you reload the page, choose the same file again to resume it. The browser remembers the upload for that file, so only the missing pieces are sent. A cancelled upload is removed.
- **Cancel** stops an upload while it is being sent. Once the server starts saving the file, Cancel is no longer offered, and the file is stored.

### 2a. Upload from URL

- Paste a direct link to a file into **Upload from URL**, then press **Import**. Every link shape works: `http://` or `https://` on any port, an IP address instead of a name, a `user:password@host/link` address for servers that need a sign-in, or a `data:` link whose bytes travel inside the link itself. The download runs in the background: you can keep using the app, close the tab, or reload the page — the import keeps going, and the page re-attaches to it when you come back. The ceiling is the same 2 GB per file. Addresses on the server's own network (loopback, private ranges, internal names) are refused unless the server sets `IMPORT_ALLOW_PRIVATE=1`.
- The server downloads the file in the background. The queue shows the state: waiting, downloading, saving, imported, or failed.
- **Cancel** works while the import is waiting or downloading. A failed import keeps its **Retry** link.
- The link is cleared from the box when you press Import, and the server does not keep it after the import finishes. Only the host name is shown.
- Links that redirect are followed, up to three times, and each new address must also be public. Links to private or local addresses are refused unless the server sets `IMPORT_ALLOW_PRIVATE=1`.

### 3. Files

The list shows name, type, size, upload time, and actions.

| Control | What it does |
| --- | --- |
| Search | Filters by file name as you type. |
| Type filter | Images, Documents, Archives, Video, Audio, Other, or All. |
| **Preview** | Opens the file in a dialog: images render as `<img>`, video as `<video>`, audio as `<audio>`, PDFs in the built-in viewer, and text as plain text. Shown only for previewable types. |
| **Open tab** | Opens the file in a new browser tab, where the browser renders it itself. Shown only for previewable types. |
| **Download** | Downloads the original bytes as an attachment. |
| **Share** / **Stop sharing** | Makes the file public through a link, or turns the link off. See [Sharing](#sharing-a-file). |
| **Delete** | Removes the file after you confirm. This cannot be undone. |

Badges next to a name:

- **Private** (default) or **Public** (the file has an active share link).
- **From upload link** if someone else uploaded it through one of your upload links.
- **Deleting…** if a delete is still running. Use **Retry delete** if it stops.

### 4. Upload links

An upload link lets someone **without an account** send you one file at a time. See [Upload links](#upload-links).

## Which files can I upload

Any name with an extension works. These types get a content check (the first bytes must match the type):

| Category | Extensions | Previewable |
| --- | --- | --- |
| Images | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp` | yes |
| Documents | `.pdf` | yes |
| Text | `.txt`, `.md`, `.log`, `.csv`, `.json` | yes (shown as plain text) |
| Archives | `.zip` | no |
| Video | `.mp4`, `.mov`, `.webm`, `.mkv` | yes |
| Audio | `.mp3`, `.wav`, `.ogg`, `.m4a` | yes |
| Other | everything else | no, download only |

Notes:

- Text files must be valid UTF-8 with no NUL bytes.
- `.mkv` is accepted by the content check; playback depends on your browser.
- `.html` and `.svg` are **not previewable**, even though they can be uploaded. They are stored as downloads.
- Video **seeking** may not work in the preview. The server does not support byte-range requests yet.
- Empty files are refused.

## Previewing a file

Click **Preview**. Images, PDFs, text, video, and audio open in a dialog, rendered with the browser's own elements (`<img>`, `<video controls>`, `<audio controls>`, the PDF viewer, and plain text). The dialog also has **Open in new tab**, which opens `/api/files/<id>/preview` in a new tab so the browser renders the file full-page; and **Download**.

The preview is served by this site and runs in a sandbox: a previewed file cannot run scripts or reach the page around it. Video and audio responses carry a `media-src 'self'` policy so a browser tab can play them.

## Sharing a file

Files are **private** by default. Only you can see them.

1. Click **Share**. The file is now **Public**, and a link appears under its row, for example `https://your-host/s/<token>`.
2. Copy the link and send it to anyone. The recipient needs **no login**. The page shows the file name, size, and type, a preview if the type allows one, and a **Download** button.
3. Click **Stop sharing** to turn the link off. The old link returns *not found* at once.
4. If you click **Share** again, you get a **new** link. The old link stays off.
5. Deleting the file also turns its link off.

There is **no public listing**. Nobody can browse your files; they need the exact link. Links are long random strings, but anyone who has a link can open it, so only send links to people you trust.

## Tube

Tube is a YouTube-style layer over your videos. Everything on it is behind login, like the rest of the app.

### Your channel

- Open **Tube** in the top menu. If you have no channel yet, press **Create channel**: a name (up to 80 characters), an optional description (up to 500 characters), and an optional logo image. The logo is stored like any other file you uploaded.
- **Edit channel** changes the name, description, or logo at any time. Your publish date on existing videos is kept.

### Publishing a video

1. Upload a video file (`.mp4`, `.webm`, `.mov`, `.mkv`) under **Explore** as usual. While the upload runs, the app quietly captures one frame and stores it as `<video name>.thumb.jpg` when the browser can decode the video, so a suggested thumbnail is waiting for you.
2. Press **Publish** on the video's row. Pick a title (up to 120 characters), an optional description (up to 2000 characters), and a thumbnail from your own image files - the auto-captured one is pre-selected. Press **Publish** again to save.
3. Published rows show a green **Published** badge that links to the watch page. **Unpublish** removes a video from Tube; the file itself stays in Explore and stays private.
4. Publishing needs a channel; the video keeps its original publish date if you edit its details later.

### Watching

- The **Tube** page lists every published video, newest first, with a search box over titles and channels.
- A video card opens the watch page: a native player, the title, the channel (which links to the channel's page), the description, and the publish date.
- **Who can watch:** every signed-in user can stream a published video, its thumbnail, and channel logos. Unpublished files keep the normal rules - only you (and your share links) can open them. Nothing on Tube is public to the whole internet.

### Channels

- `/tube/channel/<username>` shows a channel's logo, description, and videos. There is no listing of all channels; you reach channels from the feed or from a watch page.

## Model chat

**Chat** in the top menu talks to a real open-weights model (Qwen Q2_K) running on the server itself with llama.cpp. There is no external AI service: every word you see was generated on this machine.

- The status bar shows what the runtime is doing. When the server is still downloading or loading the model you will see the current step; the page flips to **Model ready** on its own, usually a few minutes after a fresh deployment.
- Type a message and press **Send** (or Enter). The reply appears while the model is still writing; a blue cursor marks the unfinished text. If the model shows its reasoning, it collapses into a **Model reasoning** section you can open.
- Replies are slow on purpose: the model is a 27-billion-parameter file quantized to Q2_K running on CPU, roughly 1-2 tokens per second. **Stop** cancels a generation you no longer want.
- The last 10 exchanges are sent as context, nothing is stored on the server beyond the 30-minute job list in memory, and each user can run at most two generations at once.

## Upload links

An upload link is a page that lets anyone with the link upload **one file at a time** into **your** account, with no login.

### Create one

1. In **Upload links**, type an optional label (for example `Trip photos`). The label is shown to people who use the link.
2. Click **Create upload link**. The full link appears, with **Copy link**. Copy it now; you can copy it again later from the list while the link is open.
3. Send the link to the people you want to upload.

### What uploaders see

They open the link and see a page with a **Choose file** button and an **Upload** button. They need no account. After a successful upload they see "*name* was stored" and a link to upload another file. They cannot see your files or your account.

### Your view

Each link in the list shows its label, status (**Open** or **Revoked**), how many files it has brought in and their total size, and when it was created. Files that came through a link are in your normal file list with the **From upload link** badge. You can preview, download, share, or delete them like any other file.

### Limits per link

| Limit | Value |
| --- | --- |
| Files per link | 20 |
| Total size per link | 500 MB |
| Size per file | 2 GB |
| Active links per account | 20 |

Files from links count toward your account's file list, and the per-file 2 GB ceiling applies to them too. If a file-count limit is ever configured for the account and it is reached, a link upload is refused and the uploader is told.

### Revoke a link

Click **Revoke** and confirm. The link stops working immediately: the page returns *not found*, and uploads through it are refused. Files that were already uploaded stay in your account.

## Errors you may see

| Message | Meaning | What to do |
| --- | --- | --- |
| *Too large. The limit is 2 GB.* | The file is over the per-file ceiling (GitHub's asset limit). | Store the file another way. |
| *The file is empty.* | Zero bytes. | Choose another file. |
| *The file contents do not match its type.* | The extension says one type, the bytes are another. | Export the file again, or rename it to its real type. |
| *Preview is not available for this type.* | The type is not previewable. | Use **Download**. |
| *You can keep up to 200 files.* | A configured file-count limit was reached (none by default). | Delete files. |
| *This upload link has reached its file limit* / *size limit* | The link is full. | Create a new link, or revoke this one. |
| *This upload link is no longer active.* | The link was revoked. | Ask the owner for a new link. |
| *The server is busy with other uploads.* | Too many uploads at once. | Wait a moment and retry. |
| *Too many uploads. Try again later.* | Hourly upload limit (60 per account, or 30 per address through links). | Try later. |
| *The data changed. Try again.* | Two changes collided. | Refresh and try again. |
| *Your session has ended.* | Signed out, or the session expired. | Log in again. |

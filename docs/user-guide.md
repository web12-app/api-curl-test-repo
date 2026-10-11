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

Shows how many files you have, for example `5 of 200 files`. There is no storage total: the only limit is the file count.

### 2. Upload

- Drag files onto the dashboard drop area, or click **Choose files**.
- You can send several files at once. Each one appears in the **Uploads** queue with a progress bar.
- **Any file type is accepted.** The size limit is **25 MB per file**. Larger files are refused before they are sent.
- Known types (listed in [Which files can I upload](#which-files-can-i-upload)) are checked: the file's first bytes must match its extension. A renamed file is refused with *The file contents do not match its type*.
- Unknown types are stored and can only be **downloaded**. They never open in the browser.
- A failed upload stays in the queue with a **Retry** link. Retrying is safe: the server stores a file once even if the first attempt partly worked.
- Files of **4 MB or more** are sent in pieces, and the queue shows the percentage. If the connection drops, **Retry** continues from the pieces that arrived. If you reload the page, choose the same file again to resume it. The browser remembers the upload for that file, so only the missing pieces are sent. A cancelled upload is removed.
- **Cancel** stops an upload while it is being sent. Once the server starts saving the file, Cancel is no longer offered, and the file is stored.

### 2a. Upload from URL

- Paste a direct link to a file into **Upload from URL**, then press **Import**. The link must start with `https://`, point to a public host, and lead to a file of at most 25 MB.
- The server downloads the file in the background. The queue shows the state: waiting, downloading, saving, imported, or failed.
- **Cancel** works while the import is waiting or downloading. A failed import keeps its **Retry** link.
- The link is cleared from the box when you press Import, and the server does not keep it after the import finishes. Only the host name is shown.
- Links that redirect are followed, up to three times, and each new address must also be public. Links to private or local addresses, and links with a user name or password, are refused.

### 3. Files

The list shows name, type, size, upload time, and actions.

| Control | What it does |
| --- | --- |
| Search | Filters by file name as you type. |
| Type filter | Images, Documents, Archives, Video, Audio, Other, or All. |
| **Preview** | Opens the file in a dialog. Shown only for previewable types. |
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

Click **Preview**. Images, PDFs, text, video, and audio open in a dialog. The preview is served by this site and runs in a sandbox: a previewed file cannot run scripts or reach the page around it.

## Sharing a file

Files are **private** by default. Only you can see them.

1. Click **Share**. The file is now **Public**, and a link appears under its row, for example `https://your-host/s/<token>`.
2. Copy the link and send it to anyone. The recipient needs **no login**. The page shows the file name, size, and type, a preview if the type allows one, and a **Download** button.
3. Click **Stop sharing** to turn the link off. The old link returns *not found* at once.
4. If you click **Share** again, you get a **new** link. The old link stays off.
5. Deleting the file also turns its link off.

There is **no public listing**. Nobody can browse your files; they need the exact link. Links are long random strings, but anyone who has a link can open it, so only send links to people you trust.

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
| Size per file | 25 MB |
| Active links per account | 20 |

Files from links count toward your account's 200-file limit as well. If the account limit is reached, a link upload is refused and the uploader is told.

### Revoke a link

Click **Revoke** and confirm. The link stops working immediately: the page returns *not found*, and uploads through it are refused. Files that were already uploaded stay in your account.

## Errors you may see

| Message | Meaning | What to do |
| --- | --- | --- |
| *Too large. The limit is 25 MB.* | The file is over the per-file limit. | Send a smaller file. |
| *The file is empty.* | Zero bytes. | Choose another file. |
| *The file contents do not match its type.* | The extension says one type, the bytes are another. | Export the file again, or rename it to its real type. |
| *Preview is not available for this type.* | The type is not previewable. | Use **Download**. |
| *You can keep up to 200 files.* | Account limit reached. | Delete files. |
| *This upload link has reached its file limit* / *size limit* | The link is full. | Create a new link, or revoke this one. |
| *This upload link is no longer active.* | The link was revoked. | Ask the owner for a new link. |
| *The server is busy with other uploads.* | Too many uploads at once. | Wait a moment and retry. |
| *Too many uploads. Try again later.* | Hourly upload limit (60 per account, or 30 per address through links). | Try later. |
| *The data changed. Try again.* | Two changes collided. | Refresh and try again. |
| *Your session has ended.* | Signed out, or the session expired. | Log in again. |

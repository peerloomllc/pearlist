# Photos on list items

**Status:** proposed
**Tier:** T2 - one new additive field on the EXISTING `item:` rows, the same shape
as `category`, `ord` and `url`. No new Hyperbee namespace, no new op, no merge
rule, no pairing or crypto change. The new local cleanup deletes only this
device's copies of photo bytes, never Autobase data.
**Date:** 2026-09-23
**Issue:** #195

## The ask

A user who shops in countries whose language they do not read wants to attach a
photo of the exact product to a shopping item, so whoever does the shopping can
match the brand by sight. OurGroceries has this and the requester relied on it.

## Requirements

1. **Text on a label must stay readable.** The reason for the photo is often a
   brand name or a label in a foreign script. Compress, but not below the point
   where small print is legible when zoomed.
2. **Storage stays small.** Photos must not go into the append-only Autobase
   log, where every edit of an item would copy them again and nothing can ever
   be removed.
3. **Storage stays small OVER TIME.** Items and whole lists are deleted all the
   time, and a deleted item's photo must stop taking up space on every phone.
4. **Old app versions keep working.** They keep the new field and do not show
   the photo.

## What already exists

Avatars solved requirement 2 on 2026-07-01 (DECISIONS.md, "animated avatars").
`@peerloom/core` exposes `ctx.blobs` (`engine.js`), a Hyperblobs core per
device named `blobs`. `blobs.put(bytes)` returns `{ key, id }`, a reference small
enough to put in a row. `blobs.get(ref)` fetches from this device's core or from a
peer's core by key, with a timeout. The member row holds only the reference plus a
content hash, and `profile:set` dedupes by hash through `localDb` `blobref:{hash}`.
The UI turns the bytes back into a data URL only when displaying them.

Photos reuse that path. **The bytes are stored as raw binary, not base64.** Base64
is about 4/3 the size. It exists only as a data URL on the IPC bridge and in the
WebView, the way avatars already do it.

What does NOT exist yet is any removal. Nothing ever clears a block from the
`blobs` core. That is fine for one avatar per person and wrong for photos.

## Design

### Row shape

One optional field on the item row:

```
photo?: {
  key, id,            // full-size image in the author's blob core
  tkey, tid,          // thumbnail in the same core
  hash,               // BLAKE2b of the full-size bytes, hex (dedupe + cache key)
  type: 'image/jpeg',
  w, h                // pixel size, so the UI can reserve space before load
}
```

About 250 bytes, so the Autobase log grows by a few hundred bytes per edit. It
rides through `applyOps` as a plain signed field like `category`. Old peers store
it verbatim and ignore it. Removing a photo writes the row without the field.

v1 allows one photo per item. Note lists (`kind: 'note'`) do not offer photos.

### Compression (in the WebView, before the bytes reach the worklet)

- **Full size:** scale down so the long edge is at most **1600 px**, then JPEG at
  **quality 0.85**. Expected size is 200 to 400 KB for a product photo. 1600 px
  keeps small print readable at 2x zoom on a phone screen. The test plan fixes
  these numbers by measuring real photos.
- **Thumbnail:** long edge **192 px**, JPEG quality 0.75, about 8 to 15 KB. The
  list row shows this, so scrolling a list never decodes full photos.
- **JPEG on both platforms, not WebP.** WKWebView's `canvas.toBlob` cannot encode
  WebP and silently falls back to PNG, which is several times larger for a
  photo.
- **Re-encoding through a canvas drops EXIF,** GPS location included. That is
  wanted: a shopping photo should not tell the household where the phone was.
  Current WebViews apply EXIF orientation when drawing to a canvas, so photos do
  not come out rotated. Verify on both platforms.
- iOS hands a file input HEIC photos as JPEG. Verify on the Simulator.
- `compressToAvatar` in `src/ui/App.jsx` already does this at 256 px. Generalise
  it into a helper that takes a size and a quality and returns a Blob.

### Worklet methods

- `item:setPhoto { groupId, listId, itemId, photo, thumb }`. `photo` and `thumb`
  are base64 data URLs. Rejects if the decoded full image is over **1 MB** or the
  thumbnail is over **64 KB**, as a guard against a UI bug. Dedupes by hash
  through `blobref:{hash}` like `profile:set`. Writes both blobs, then the row.
  Records `photoref:{hash}` in `localDb` (see Cleanup).
- `item:setPhoto { ..., photo: null }` removes the field.
- `item:getPhoto { groupId, listId, itemId, size: 'thumb' | 'full' }` returns a data
  URL or null. Null means the blob is not reachable yet, and the UI shows a
  placeholder that says so.
- `item:getAll` passes `photo` through unchanged. The UI asks for thumbnails
  lazily, the way `resolveAvatarCached` works.
- The in-memory cache is an **LRU**, capped at about 40 thumbnails and 6 full
  images. The avatar cache is an unbounded `Map`, which is fine for a dozen
  avatars and would not be for hundreds of photos.

### Getting the photo to the other phones

A peer can fetch a blob only while a device that holds it is online. The shopper
is often in a shop and the person who took the photo is often at home, so the
photo has to be on the shopper's phone before they leave.

- **Download eagerly.** When a live item has a `photo` this device does not
  hold, fetch the thumbnail and then the full image in the background, one at a
  time. Photos of deleted items are never fetched.
- **Any phone that holds a photo can send it on.** Hypercore replication serves
  a core's blocks from any peer that has them, not only the author. So after one
  housemate's phone has a photo, another can get it from them. The photo
  stays available if its author's phone is off or the author left.
- Record `photoref:{hash}` on fetch too, so Cleanup knows about it.

### Cleanup (requirement 3)

The storage that grows over time is the blocks in this device's `blobs` core
plus the blocks it downloaded from peers' blob cores. `hyperblobs` 2.12.1 has
`clear(id)`, which calls `core.clear()` on exactly that range of blocks. The
2026-07-01 retention proposal already verified that `core.clear()` removes
block data safely, and that the file on disk shrinks only when RocksDB compacts,
so disk space is freed some time after the delete.

**A sweep runs at most once an hour, starting a minute after launch:**

1. Build the LIVE set: every `photo.hash` on an item that is not deleted, in a
   list that is not deleted, in a space that is still joined. Check both
   tombstones. `list:delete` marks only the list row, so its items still read as
   `deleted: false`.
2. Go through `photoref:*` in `localDb`. Each entry records the `{key, id}` and
   `{tkey, tid}` this device holds for that hash, plus a `deadSince` timestamp.
3. A hash that is in the live set: clear its `deadSince` if it has one.
4. A hash that is not live: set `deadSince` if it is not set yet. Once
   `deadSince` is older than the grace period, `clear()` both ranges, then remove
   the `photoref` and `blobref` entries.

**The sweep clears only what it recorded in `photoref:*`.** It never walks the
`blobs` core itself, so it cannot clear an avatar, which lives in the same core,
or anything a later feature puts there.

**Grace period.** Tombstones are final (the no-resurrection rule), so an item
that is deleted, or sits in a deleted list, can be cleared on the next sweep.
A photo that was REPLACED or REMOVED on a live item waits **7 days**. Last
writer wins on the whole row, so a housemate's concurrent edit made from the
older row can put the old reference back. Without the wait, the author could
have already cleared the only copy.

**Leaving or deleting a space** drops it from the joined set, so all of its
photos become dead and are cleared on the next sweep. Photos are the one part of
a left space's data this can reclaim. Autobase data still waits on upstream
`purge()` (retention proposal P3).

**The 1.0.9 failure cannot happen here.** 1.0.9 cleared a phone's only copy of
its own Autobase input core, and startup blocked on those blocks. Photos are not
in any Autobase core, and nothing at startup reads a blob. The worst this sweep
can do is show a "photo unavailable" placeholder. The tests prove that anyway
(see Test plan).

### Storage budget

| Household behaviour | Without cleanup | With cleanup |
| --- | --- | --- |
| 50 photos a month, ~350 KB each | +17 MB a month on every phone, forever | only the live photos: 30 photos on open items is about 10 MB |

The Settings storage line gains "Photos: N, X MB", read from `photoref:*`. v1
has no space-wide quota. Add one if real use shows a household keeping hundreds
of live photos.

### UI

- Item detail sheet: "Add photo" opens a sheet with **Take photo** and **Choose
  from library**. When a photo is set: a preview, tap to open full screen with
  pinch zoom, **Replace** and **Remove**.
- List row: the thumbnail as a small square beside the text, only for items
  that have a photo. Tapping it opens the full-screen viewer.
- While a photo has not arrived, a camera outline with "Waiting for photo".
- **Take photo** uses `<input type="file" accept="image/*" capture="environment">`.
  iOS WKWebView supports this natively, and the QR scanner already declares the
  camera usage string. The Android WebView needs the file chooser to launch the
  camera. Check this first, since it could force a small native change.

### Templates and suggestions

Templates are local to one device and copy item text. **In v1 they do not copy
photos.** A template holding a reference would have to count as live for the
sweep, on a device whose templates the author's phone cannot see. Suggestions
cover text only and are unchanged.

## Not in v1

- More than one photo per item.
- Photos on lists or notes.
- A space-wide storage quota.
- Annotating or cropping inside the app. The system picker's crop is enough.

## Risks

- **Android camera capture from the WebView** may need native file-chooser
  wiring. Check it before building the UI. Library choose already works (the
  avatar picker).
- **The photo does not arrive before the shopper leaves**, if no phone holding
  it was online. Eager download makes this rare. The placeholder says what is
  going on.
- **Bridge size.** A 400 KB JPEG is about 540 KB as base64 over IPC. Avatars
  already pass up to 2 MB this way.
- **Storage frees up later than expected**, because RocksDB compaction is lazy.
  The Settings line counts logical bytes, so it drops straight away while the
  file on disk shrinks later.

## Test plan

- **Compression numbers:** 10 real product photos, including small-print labels
  and non-Latin scripts. Encode at long edge 1400, 1600 and 2000 px and quality
  0.80, 0.85 and 0.90. Record the sizes in a table and judge readability at 2x
  zoom. Choose the settings from that table.
- **Unit (mock view):** the row round-trips `photo`. Old apply rules store it
  verbatim. `item:setPhoto` rejects oversized input and dedupes by hash.
- **Real Autobase harness** (per the existing two-writer harness):
  - A photo added on A is fetched by B.
  - After A goes offline, a third peer C still gets it from B.
  - An item delete clears the photo on the next sweep on both A and B.
  - A list delete does the same for all of its items.
  - A replaced photo survives the 7-day grace period (fake the clock) and is
    then cleared.
  - A replace racing a concurrent edit that restores the old reference: the
    sweep does not clear it.
  - Leaving a space clears that space's photos.
  - Avatars in the same `blobs` core are never cleared.
  - Cold start with no peer after a sweep: the space opens, the items load and
    cleared photos show the placeholder.
- **Emulator plus TCL** (two peers, per rule 15): add a photo on one and see it
  on the other. Delete it and see storage drop on both.
- **iOS Simulator:** HEIC comes in as JPEG, orientation is right and camera
  capture works.

## Phasing

1. Measure the compression settings and check Android camera capture. This
   decides the numbers and whether native work is needed.
2. Worklet: row field, `item:setPhoto` and `item:getPhoto`, the LRU cache,
   eager fetch and the sweep, with the harness tests.
3. UI: the detail sheet, the row thumbnail, the viewer and the Settings storage
   line.

## Open questions

1. Whether to keep 7 days as the grace period for replaced photos.
2. Whether eager download should run on mobile data, or on Wi-Fi only with a
   setting. Doing it on mobile data costs up to about 400 KB per photo, and not
   doing it means a shopper away from Wi-Fi may not have the photo.

# Keep-style notes and cards

**Status:** draft, for Tim.
**Tier:** T2. Four additive fields on the existing `list:` rows and one
Android share target. No new namespace, op, merge rule, pairing or crypto
change.
**Date:** 2026-10-29

## The ask

A PearOffice tester wants a replacement for Google Keep: shopping lists and
food recommendations sent back and forth, with pictures, that they can look
over at a glance. They tried PearList and found it "text only" and less
integrated than Keep.

PearList already has most of Keep: checklists, free-text notes (note lists,
proposals/2026-07-20-note-lists.md), photos on items, reminders, sharing with
everyone in a space and backup to the PeerLoom Seeder. What it lacks is how
Keep looks and a few small things on each note.

## What changes

1. **Cards.** The Lists page can show every list and note as a card in a
   grid, two columns on phones: the name, a preview (a note's first lines,
   a list's first unticked items with their ticks, item counts) and the
   first photo, tinted by the card's colour. Pinned cards come first, in
   their own group. A button at the top switches between Cards and the
   current rows; the choice is remembered on the device.
2. **Colour.** `color` on a list row: one of eight names (`default`,
   `red`, `orange`, `yellow`, `green`, `teal`, `blue`, `purple`), each with
   a light and a dark shade, so both themes stay readable. Shared with the
   space. Set from the list's menu.
3. **Labels.** `labels` on a list row: up to 10 names, up to 30 characters,
   shared with the space. Picked or typed from the list's menu; the label
   names in use show as pills above the cards and filter them (several
   pills: lists with all of them).
4. **Pinning.** `pinned: true` on a list row, shared with the space, from
   the list's menu or a long press on a card.
5. **Photos on notes.** `photos` on a note list's row: up to 10 references
   in the shape items already use (proposals/2026-09-23-item-photos.md),
   stored and compressed the same way and cleared by the same sweep when
   the note is deleted. Shown in a row above the note's text, opened in the
   existing full-screen viewer. Checklists keep their photos on items.
6. **Share into PearList (Android).** PearList appears in the share sheet
   for text, links and pictures. A short sheet asks which space (if more
   than one) and offers "New note" or an existing note or list; the last
   pick is preselected. Text and links become note lines (or an item, with
   the link in its existing `url` field, when a list is picked); a picture
   becomes a note photo or an item photo. This is the open TODO item "Share
   INTO PearList from other apps". iOS needs a Share Extension, a second
   build target, and follows separately.

## Old versions

All four fields ride the `list:` row. applyListOp stores rows verbatim and
`list:rename`, `list:assign` and the rest spread the existing row, so an
older build keeps the fields when it changes a list and simply does not
show them. An older build shows a note's photos as nothing.

## Out of scope

Drawings, voice notes, reminders on a whole note (reminders stay on items),
turning a note into a checklist, and links to PearOffice files and PearCal
days (a separate, small plan once this lands).

## Verify

- Unit (listWire, pure): the fields kept through rename, assign and delete;
  bad colours, too many labels and long names cleaned on read; photo
  references checked as item photos are.
- Engines: a colour, label, pin and note photo set on one phone show on
  another; an older-shaped rename keeps them.
- Emulator first (suite rule 15): the cards grid, filters, pinning, a note
  photo, sharing text and a picture into PearList. Then the TCL for share
  sheet behaviour from real apps.
- The repo's canonical verify.

## Rollback

Revert, but keep the sweep change, so note photos already added are still
cleared when their note is deleted. The fields stay on rows as ignored data.

## Open questions

1. Cards or rows by default on the Lists page?
2. Labels and pins shared with everyone in the space (as written), or
   personal to each person?

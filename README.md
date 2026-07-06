# 🍐✅ PearList

**Shared household lists for Android and iOS.**

PearList keeps a household's shared lists in sync across everyone's phones - groceries, to-dos, chores - with no accounts, no servers, no subscriptions. Your lists live only on the devices you share them with.

---

## Features

- **Shared lists per household** - one space holds many lists; anyone in it can add, check off, rename, assign and delete items, and every change syncs to everyone
- **Multiple spaces** - one identity, many private groups (family, roommates, a trip crew); switch between them, and no one sees your other spaces
- **Assign items and lists** - assign an item or a whole list to a person, so any list doubles as a shared chore board
- **Quantities, notes and links** - set a quantity, add a note, or attach a store link to any item
- **Check off like paper** - checked items get a felt-tip marker strike; swipe a row to delete with a quick undo
- **Join by QR or link** - scan a code or tap an invite to join a space; no account, no email
- **Local notifications** - get a heads-up when someone assigns you an item or joins your space (opt-in, off by default)
- **No accounts** - your identity is a cryptographic key pair generated on your device; nothing is tied to an email or phone number
- **No data collection** - PeerLoom, Google, Apple, and no third party ever sees your lists

---

## How It Works

PearList uses **peer-to-peer technology** powered by [Hypercore Protocol](https://hypercore-protocol.org) to sync your lists directly between the devices in your household.

### No servers
Most shared-list apps route your lists through a central server. The app company can read your data, sell it, get hacked, go down, or shut down. PearList has no central server. Your lists never leave your devices.

### How sync works
When devices in the same space are online at the same time - whether on the same Wi-Fi network or anywhere on the internet - they find each other using a distributed hash table (DHT), a technology similar to how BitTorrent works. Once connected, they sync directly, device to device, with no middleman.

### Encrypted and signed
All sync traffic is encrypted in transit. Every change to a list is cryptographically signed by the device that made it. Other members only apply changes they can verify came from someone in the space.

### Pairing
You join a space via a one-time invite link or QR code. The link encodes the cryptographic address of the space - there's no server involved. After joining, every device in the space remembers every other one and can sync directly.

---

## Privacy

- No accounts or sign-up required
- No analytics, tracking, or telemetry
- No third-party SDKs
- All sync traffic is encrypted end-to-end
- Your lists stay on the devices in your spaces - never uploaded anywhere

See the [full privacy policy](https://peerloomllc.com/pearlist/privacy) and a [plain-language explainer](https://peerloomllc.com/pearlist/docs/privacy-p2p) of how the peer-to-peer design protects your data.

---

## Permissions

- **Camera** - used to scan the invite QR code when you join a space. Nothing from the camera is stored or transmitted.
- **Notifications** - used to deliver local alerts such as an item assigned to you or a new member joining. Off by default. Notification data never leaves the device.
- **Network and local network** - used exclusively for peer-to-peer connections between the devices in your space, including directly over your Wi-Fi. No data is sent to external servers. On iOS, the first-launch Local Network prompt lets same-Wi-Fi peers connect directly.

---

## Known Limitations

- **Both devices must be online at the same time** to sync in real time - you can always read and edit your own copy offline, and changes replicate the next time members' devices can reach each other
- **Background sync depends on the OS** - on Android, PearList can keep syncing while closed (a foreground service, opt-in in Settings). iOS pauses apps in the background, so an all-iPhone space only syncs when someone has PearList open; keep an Android device in the space for always-on background sync
- **No web dashboard or desktop client** - PearList is mobile-only, because there is no server to back a web view

---

## Feedback & Bug Reports

Please open an [issue](../../issues) on GitHub. Include your platform (Android or iOS), OS version, and a description of what happened.

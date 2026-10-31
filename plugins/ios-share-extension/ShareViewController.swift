import UIKit
import UniformTypeIdentifiers

// PearList's iOS Share Extension (proposals/2026-10-29-keep-style-notes.md, part 6).
//
// iOS runs this on its own, inside the app the user is sharing from. The main app and
// its sync engine are not running, so this only saves what was shared into the App
// Group folder both can read, then opens PearList, which shows the same "Save to
// PearList" sheet as Android (modules/share-intent reads the folder).
//
// Layout of the folder, one share at a time (a newer share replaces an older one
// that was never filed):
//   <group>/share/payload.json   { text, subject, images: ["0.jpg", ...] }
//   <group>/share/0.jpg ...      JPEG, at most MAX_EDGE px on a side
//
// Copied into ios/PearListShare/ by plugins/with-ios-share-extension.js. Edit it here.

private let MAX_EDGE: CGFloat = 2048
private let MAX_IMAGES = 10

class ShareViewController: UIViewController {
  private let label = UILabel()

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = UIColor.black.withAlphaComponent(0.35)
    let card = UIView()
    card.backgroundColor = .secondarySystemBackground
    card.layer.cornerRadius = 14
    card.translatesAutoresizingMaskIntoConstraints = false
    label.text = "Saving to PearList…"
    label.font = .systemFont(ofSize: 17)
    label.textAlignment = .center
    label.numberOfLines = 0
    label.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(card)
    card.addSubview(label)
    NSLayoutConstraint.activate([
      card.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      card.centerYAnchor.constraint(equalTo: view.centerYAnchor),
      card.widthAnchor.constraint(equalToConstant: 260),
      label.topAnchor.constraint(equalTo: card.topAnchor, constant: 22),
      label.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -22),
      label.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 16),
      label.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -16),
    ])
    Task { await collectAndSave() }
  }

  // The main app's bundle id is this one's minus the last part (com.pearlist.share
  // -> com.pearlist), and the App Group is named after it.
  private var groupId: String {
    let me = Bundle.main.bundleIdentifier ?? "com.pearlist.share"
    return "group." + me.split(separator: ".").dropLast().joined(separator: ".")
  }

  private func collectAndSave () async {
    var texts: [String] = []
    var subject: String? = nil
    var images: [UIImage] = []
    let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
    for item in items {
      if subject == nil, let t = item.attributedTitle?.string, !t.isEmpty { subject = t }
      if let t = item.attributedContentText?.string, !t.isEmpty { texts.append(t) }
      for provider in item.attachments ?? [] {
        if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
          if images.count < MAX_IMAGES, let img = await loadImage(provider) { images.append(img) }
        } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
          if let u = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL, !u.isFileURL {
            let s = u.absoluteString
            if !texts.contains(where: { $0.contains(s) }) { texts.append(s) }
          }
        } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
          if let s = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String, !s.isEmpty,
             !texts.contains(s) { texts.append(s) }
        }
      }
    }
    let text = texts.joined(separator: "\n")
    let saved = !(text.isEmpty && images.isEmpty) && save(text: text, subject: subject, images: images)
    await MainActor.run {
      label.text = saved ? "Saved. Opening PearList…" : "Nothing PearList can save was shared."
    }
    if saved { openApp() }
    try? await Task.sleep(nanoseconds: saved ? 600_000_000 : 1_400_000_000)
    await MainActor.run { extensionContext?.completeRequest(returningItems: nil) }
  }

  // A shared picture can arrive as a file URL, raw data or a UIImage, depending on
  // the app it came from.
  private func loadImage (_ provider: NSItemProvider) async -> UIImage? {
    guard let item = try? await provider.loadItem(forTypeIdentifier: UTType.image.identifier) else { return nil }
    if let img = item as? UIImage { return img }
    if let data = item as? Data { return UIImage(data: data) }
    if let url = item as? URL, let data = try? Data(contentsOf: url) { return UIImage(data: data) }
    return nil
  }

  // Drawing into a new context applies the photo's orientation, and the JPEG made
  // from it carries no EXIF, so no location either.
  private func jpeg (_ img: UIImage) -> Data? {
    let edge = max(img.size.width, img.size.height)
    let scale = edge > MAX_EDGE ? MAX_EDGE / edge : 1
    let size = CGSize(width: max(1, (img.size.width * scale).rounded()), height: max(1, (img.size.height * scale).rounded()))
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    let out = UIGraphicsImageRenderer(size: size, format: format).image { _ in img.draw(in: CGRect(origin: .zero, size: size)) }
    return out.jpegData(compressionQuality: 0.9)
  }

  private func save (text: String, subject: String?, images: [UIImage]) -> Bool {
    guard let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: groupId) else { return false }
    let dir = root.appendingPathComponent("share", isDirectory: true)
    let fm = FileManager.default
    try? fm.removeItem(at: dir)
    do {
      try fm.createDirectory(at: dir, withIntermediateDirectories: true)
      var names: [String] = []
      for (i, img) in images.enumerated() {
        guard let data = jpeg(img) else { continue }
        let name = "\(i).jpg"
        try data.write(to: dir.appendingPathComponent(name), options: .atomic)
        names.append(name)
      }
      var payload: [String: Any] = ["text": text, "images": names]
      if let s = subject { payload["subject"] = s }
      let json = try JSONSerialization.data(withJSONObject: payload)
      // Written last, so the app never reads a payload whose pictures are missing.
      try json.write(to: dir.appendingPathComponent("payload.json"), options: .atomic)
      return true
    } catch {
      return false
    }
  }

  // An extension may not open its app directly, and Xcode will not compile a call to
  // UIApplication.open in one. Walking the responder chain to the UIApplication and
  // calling openURL:options:completionHandler: through the Objective-C runtime is the
  // usual way round it. The link is pearlist://, PearList's own scheme: Keet also
  // answers pear://, and iOS then asks which app to open. If iOS refuses, the share still waits in the folder and the
  // sheet shows the next time PearList comes to the front.
  private func openApp () {
    guard let url = URL(string: "pearlist://share") else { return }
    DispatchQueue.main.async {
      let sel = NSSelectorFromString("openURL:options:completionHandler:")
      var r: UIResponder? = self
      while let cur = r {
        if cur.isKind(of: NSClassFromString("UIApplication") ?? NSNull.self), cur.responds(to: sel), let imp = cur.method(for: sel) {
          typealias Open = @convention(c) (AnyObject, Selector, NSURL, NSDictionary, AnyObject?) -> Void
          unsafeBitCast(imp, to: Open.self)(cur, sel, url as NSURL, NSDictionary(), nil)
          return
        }
        r = cur.next
      }
    }
  }
}
